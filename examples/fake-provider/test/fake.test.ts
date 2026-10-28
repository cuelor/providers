import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import { parseWav, pngMetadata, sniffMediaType, TRANSCRIPT_MEDIA_TYPE, validateCatalog, validateTranscript } from "@cuelor/provider-sdk";
import { CATALOG } from "../src/catalog.ts";
import { FakeUpstream, TIMINGS } from "../src/fake-upstream.ts";
import { solidPng } from "../src/png.ts";
import { embeddedText, fakeTranscript, splitUnits } from "../src/transcribe.ts";
import { SAMPLE_MP4_BASE64 } from "../src/video-sample.ts";
import { SAMPLES, tempDir } from "./helpers.ts";

test("the catalog passes the SDK's catalog rules", () => {
  assert.deepEqual(validateCatalog(CATALOG), []);
  // The shapes of section 3.3 are exercised, not only empty lists.
  const params = CATALOG.models.flatMap((m) => m.parameters);
  assert.ok(CATALOG.models.some((m) => (m.parameter_rules ?? []).length > 0), "a parameter rule");
  assert.ok(params.some((p) => p.widget !== undefined), "a widget");
  assert.ok(params.some((p) => p.visible_when !== undefined), "a visible_when");
});

test("image2video takes one image as the first frame (v1.md section 3.3)", () => {
  const route = CATALOG.models.find((m) => m.id === "example/fake-video")!.routes.find((r) => r.id === "image2video")!;
  assert.deepEqual(route.input.slots.map((s) => [s.role, s.modality, s.min_artifacts, s.max_artifacts]), [["first_frame", "image", 1, 1]]);
});

test("solidPng writes a valid PNG", () => {
  const png = solidPng(3, 2, [10, 20, 30]);
  assert.equal(sniffMediaType(png), "image/png");
  assert.deepEqual(pngMetadata(png), { width: 3, height: 2 });
  // Walk the chunks and check every CRC.
  let offset = 8;
  const types: string[] = [];
  let idat = Buffer.alloc(0);
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(Buffer.concat([type, data])) >>> 0);
    types.push(type.toString("latin1"));
    if (type.toString("latin1") === "IDAT") idat = Buffer.concat([idat, data]);
    offset += 12 + length;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
  const raw = inflateSync(idat);
  assert.equal(raw.length, 2 * (1 + 3 * 3));
  assert.deepEqual([...raw.subarray(1, 4)], [10, 20, 30]);
});

test("the embedded video is an MP4", () => {
  assert.equal(sniffMediaType(Buffer.from(SAMPLE_MP4_BASE64, "base64")), "video/mp4");
});

test("units: words for English, characters for Chinese, no punctuation", () => {
  assert.deepEqual(splitUnits("Hello, world! It's fine."), { unit: "word", units: ["Hello", "world", "It's", "fine"] });
  assert.deepEqual(splitUnits("你好，世界。"), { unit: "character", units: ["你", "好", "世", "界"] });
});

for (const [name, language, unit] of [["en.wav", "en", "word"], ["zh.wav", "zh", "character"]] as const) {
  test(`fake transcript of ${name} is valid and carries the known text`, () => {
    const wav = readFileSync(new URL(name, SAMPLES));
    const known = embeddedText(wav)!;
    assert.equal(known.language, language);
    const durationMs = parseWav(wav)!.durationMs;
    const t = fakeTranscript(wav, { language: "auto", timestamps: "word" });
    assert.deepEqual(validateTranscript(t, { durationMs }), []);
    assert.equal(t.language, language);
    assert.equal(t.unit, unit);
    assert.equal(t.text, known.text);
    const units = t.segments[0]!.timed_text_units!;
    assert.deepEqual(units.map((u) => u.text), splitUnits(known.text).units);
    assert.ok(units[0]!.start_ms >= durationMs * 0.04);
    assert.ok(units.at(-1)!.end_ms <= durationMs);
  });
}

test("unknown audio gives an empty transcript", () => {
  const t = fakeTranscript(Buffer.from("not audio"), {});
  assert.equal(t.text, "");
  assert.deepEqual(validateTranscript(t), []);
});

test("fake upstream: states follow the clock and survive a new instance", async () => {
  const dir = tempDir();
  let now = 1_000_000;
  const up = new FakeUpstream({ dir, now: () => now });
  const id = await up.submit({ clientReference: "ref-1", kind: "image", model: "example/fake-image", route: "text2image", parameters: { prompt: "a red square" }, inputs: [] });
  assert.match(id, /^up_[0-9a-f]{20}$/);
  assert.equal((await up.status(id)).status, "queued");
  now += TIMINGS.image.queued;
  assert.equal((await up.status(id)).status, "running");
  now += TIMINGS.image.total;
  const again = new FakeUpstream({ dir, now: () => now });
  const done = await again.status(id);
  assert.equal(done.status, "succeeded");
  const out = done.outputs![0]!;
  assert.equal(out.mediaType, "image/png");
  assert.deepEqual(pngMetadata(out.data as Buffer), { width: 64, height: 64 });
  assert.equal(await again.findByClientReference("ref-1"), id);
  assert.equal(await again.findByClientReference("ref-2"), null);
  assert.equal((await again.status("up_" + "0".repeat(20))).status, "failed");
});

test("fake upstream: markers, approval and cancel", async () => {
  let now = 0;
  const up = new FakeUpstream({ dir: tempDir(), now: () => now });
  const submit = (prompt: string, kind: "image" | "video" = "image") =>
    up.submit({ clientReference: prompt, kind, model: "m", route: "r", parameters: { prompt }, inputs: [] });
  const fail = await submit("x [fail]");
  const moderate = await submit("x [moderate]");
  const approval = await submit("x [approval]");
  const cancel = await submit("x", "video");
  assert.equal((await up.status(approval)).status, "pending_approval");
  assert.ok((await up.status(approval)).approval?.policy);
  now = 500;
  await up.cancel(cancel);
  assert.equal((await up.status(cancel)).status, "cancelled");
  now = 10_000;
  assert.equal((await up.status(fail)).status, "failed");
  const r = await up.status(moderate);
  assert.equal(r.status, "rejected");
  assert.equal(r.error?.code, "content_moderated");
  assert.equal((await up.status(approval)).status, "succeeded");
  assert.equal((await up.status(cancel)).status, "cancelled");
});

test("fake upstream: transcription reads the stored input", async () => {
  let now = 0;
  const up = new FakeUpstream({ dir: tempDir(), now: () => now });
  const wav = readFileSync(new URL("en.wav", SAMPLES));
  const id = await up.submit({ clientReference: "r", kind: "transcription", model: "example/fake-asr", route: "audio2text", parameters: { timestamps: "word" }, inputs: [{ bytes: wav, media_type: "audio/wav" }] });
  now = 60_000;
  const state = await up.status(id);
  const out = state.outputs![0]!;
  assert.equal(out.role, "transcript");
  assert.equal(out.mediaType, TRANSCRIPT_MEDIA_TYPE);
  assert.equal(JSON.parse(Buffer.from(out.data as Buffer).toString()).text, embeddedText(wav)!.text);
});
