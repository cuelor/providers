// The plugin in this process against the mock OpenRouter: submissions, states, downloads, errors,
// moderation, transcription and the crash window. No network, no real key.
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { solidPng } from "./mock-media.ts";
import { MockOpenRouter } from "./mock-openrouter.ts";
import { SAMPLES, startPlugin, submit, upload, waitForEnd, type Plugin } from "./helpers.ts";

const T2I = (prompt: string, extra: Record<string, unknown> = {}) => ({ model: "bytedance-seed/seedream-4.5", route: "text2image", input: { artifacts: [] }, parameters: { prompt, ...extra } });
const T2V = (prompt: string, model = "bytedance/seedance-2.0-fast") => ({ model, route: "text2video", input: { artifacts: [] }, parameters: { prompt } });

function lastBody(p: Plugin, path: string): any {
  return [...p.mock.bodies].reverse().find((b) => b.path === path)?.body;
}

test("image: accepted at once, generated in the background, one output", async () => {
  const p = await startPlugin();
  const started = Date.now();
  const res = await submit(p, T2I("a red square"));
  assert.equal(res.status, 201);
  assert.ok(["queued", "running"].includes(res.json.status));
  assert.ok(Date.now() - started < 250, "the synchronous upstream call does not hold up the answer");
  const job = await waitForEnd(p, res.json.id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.outputs.length, 1);
  assert.equal(job.outputs[0].media_type, "image/png");
  assert.deepEqual(job.usage, { amount: 0.04, unit: "USD", basis: "billed" });
  const body = lastBody(p, "/api/v1/images");
  assert.equal(body.n, 1, "asks for exactly one image");
  assert.equal(body.aspect_ratio, "1:1", "the catalog default is applied");
  assert.equal(body.resolution, "2K", "Seedream 4.5 refuses the 1K its list offers");
  const content = await p.call("GET", `/v1/artifacts/${job.outputs[0].artifact_id}/content`);
  assert.equal(content.status, 200);
});

test("image: references go in position order as data URLs, and @imageN becomes words", async () => {
  const p = await startPlugin();
  const a = await upload(p, solidPng(4, 4, [200, 0, 0]), "image/png");
  const b = await upload(p, solidPng(4, 4, [0, 200, 0]), "image/png");
  const res = await submit(p, {
    model: "bytedance-seed/seedream-4.5",
    route: "image2image",
    input: { artifacts: [{ artifact_id: b.id, role: "reference", position: 1 }, { artifact_id: a.id, role: "reference", position: 0 }] },
    parameters: { prompt: "put @image2 next to @image1" },
  });
  assert.equal(res.status, 201, res.text);
  await waitForEnd(p, res.json.id);
  const body = lastBody(p, "/api/v1/images");
  assert.equal(body.prompt, "put image 2 next to image 1");
  const urls = body.input_references.map((r: any) => r.image_url.url);
  assert.equal(urls[0], `data:image/png;base64,${solidPng(4, 4, [200, 0, 0]).toString("base64")}`, "position 0 first");
  assert.equal(urls[1], `data:image/png;base64,${solidPng(4, 4, [0, 200, 0]).toString("base64")}`);
});

test("image: several results keep the first and warn; a black image is a moderation rejection", async () => {
  const p = await startPlugin();
  const multi = await waitForEnd(p, (await submit(p, T2I("two [multi]"))).json.id);
  assert.equal(multi.status, "succeeded");
  assert.equal(multi.outputs.length, 1);
  assert.deepEqual(multi.warnings.map((w: any) => w.code), ["outputs_dropped"]);
  const black = await waitForEnd(p, (await submit(p, T2I("night [black]"))).json.id);
  assert.equal(black.status, "rejected");
  assert.equal(black.error.code, "content_moderated");
  assert.deepEqual(black.error.params, { stage: "output", source: "upstream", inferred: true });
  assert.deepEqual(black.outputs, []);
});

test("image: upstream errors end the job with the right state", async () => {
  const p = await startPlugin();
  const end = async (prompt: string) => waitForEnd(p, (await submit(p, T2I(prompt))).json.id);
  const moderated = await end("[moderate]");
  assert.deepEqual([moderated.status, moderated.error.code, moderated.error.params], ["rejected", "content_moderated", { stage: "input", source: "upstream", category: "sexual" }]);
  const inferred = await end("[policy-text]");
  assert.deepEqual([inferred.status, inferred.error.params.inferred], ["rejected", true]);
  const in200 = await end("[error200]");
  assert.deepEqual([in200.status, in200.error.code, in200.error.reason], ["failed", "submission_unknown", "error_in_body"], "an error inside HTTP 200 is not a success, and its result is unknown");
  const credits = await end("[credits]");
  assert.deepEqual([credits.status, credits.error.code], ["failed", "insufficient_credits"]);
  const bad = await end("[reject400]");
  assert.deepEqual([bad.status, bad.error.code], ["failed", "invalid_input"]);
  assert.deepEqual(bad.usage, { amount: 0, unit: "USD", basis: "estimate" }, "a failed generation is not charged");
  // 502 "Generation did not complete": OpenRouter says nothing was charged, but a gateway error cannot
  // prove the generation stopped, so the result is unknown (VALIDATION.md, Errors).
  const failed = await end("[fail]");
  assert.deepEqual([failed.status, failed.error.code, failed.error.reason], ["failed", "submission_unknown", "gateway_error"]);
  p.mock.failNext("/api/v1/images", { status: 500 });
  const internal = await end("plain 500");
  assert.deepEqual([internal.status, internal.error.code, internal.usage.amount], ["failed", "upstream_failed", 0]);
  // The in-flight budget (402 + Retry-After) and 429 are retried after Retry-After, then succeed.
  assert.equal((await end("[budget]")).status, "succeeded");
  assert.equal((await end("[ratelimit]")).status, "succeeded");
  assert.equal(p.mock.bodies.filter((b) => (b.body as any).prompt === "[budget]").length, 2, "one retry");
});

test("video: 202 job id, queued -> running -> succeeded, downloaded with the key, usage billed", async () => {
  const p = await startPlugin();
  const res = await submit(p, T2V("a blue sky"));
  assert.equal(res.status, 201, res.text);
  const states = new Set<string>([res.json.status]);
  let job = res.json;
  while (!["succeeded", "failed"].includes(job.status)) {
    await new Promise((r) => setTimeout(r, 40));
    job = (await p.call("GET", `/v1/jobs/${res.json.id}`)).json;
    states.add(job.status);
  }
  assert.deepEqual([...states], ["queued", "running", "succeeded"]);
  assert.equal(job.outputs[0].media_type, "video/mp4");
  // The mock bills Seedance by video tokens: 854x480, 97 frames.
  assert.deepEqual(job.usage, { amount: Math.round(((854 * 480 * 97) / 1024) * 0.0000042 * 1e6) / 1e6, unit: "USD", basis: "billed" });
  const body = lastBody(p, "/api/v1/videos");
  assert.deepEqual([body.duration, body.resolution, body.aspect_ratio, body.generate_audio], [4, "480p", "16:9", false]);
  const downloads = p.mock.requests.filter((r) => r.path.includes("/content"));
  assert.equal(downloads.length, 1);
  assert.ok(downloads[0]!.authorized, "the content URL is fetched with the key");
  assert.ok(!p.mock.requests.some((r) => r.path.startsWith("/signed/")), "the signed URLs are never used");
  // The signed URLs never reach the client or the log.
  const everything = JSON.stringify(job) + p.logs.join("\n");
  assert.ok(!everything.includes("sig="));
  assert.ok(!everything.includes(p.mock.testKey));
});

test("video: status mapping for failures, moderation text, expiry and cancellation", async () => {
  const p = await startPlugin();
  const end = async (prompt: string) => waitForEnd(p, (await submit(p, T2V(prompt))).json.id);
  const moderated = await end("[moderate]");
  assert.deepEqual([moderated.status, moderated.error.code, moderated.error.params], ["rejected", "content_moderated", { stage: "input", source: "upstream", inferred: true }]);
  const failed = await end("[fail]");
  assert.deepEqual([failed.status, failed.error.code, failed.error.message], ["failed", "upstream_failed", "Generation failed"]);
  assert.equal(failed.usage.amount, 0);
  const expired = await end("[expire]");
  assert.deepEqual([expired.status, expired.error.code, expired.error.reason], ["failed", "timed_out", "upstream_expired"]);
  const cancelled = await end("[cancel]");
  assert.deepEqual([cancelled.status, cancelled.error.code], ["cancelled", "cancelled"]);
  const gone = await end("[gone]");
  assert.deepEqual([gone.status, gone.error.reason], ["failed", "output_unavailable"]);
  const multi = await end("[multi]");
  assert.deepEqual([multi.status, multi.outputs.length, multi.warnings[0].code], ["succeeded", 1, "outputs_dropped"]);
});

test("video: submission errors are answered at once, 4xx only when nothing was created", async () => {
  const p = await startPlugin();
  const budget = await submit(p, T2V("[budget]"));
  assert.equal(budget.status, 429, "the in-flight budget's 402 is a temporary 429");
  assert.equal(budget.json.error.code, "rate_limited");
  assert.equal(budget.headers.get("retry-after"), "1");
  const credits = await submit(p, T2V("[credits]"));
  assert.deepEqual([credits.status, credits.json.error.code], [402, "insufficient_credits"]);
  const moderated = await submit(p, T2V("[moderate-submit]"));
  assert.deepEqual([moderated.status, moderated.json.error.code, moderated.json.error.params.stage], [422, "content_moderated", "input"]);
  const rejected = await submit(p, T2V("[reject400]"));
  assert.deepEqual([rejected.status, rejected.json.error.code], [400, "invalid_request"]);
  // An error inside HTTP 200 at submission: unknown whether the job exists.
  const key = "video-error200";
  const unknown = await submit(p, T2V("[error200]"), key);
  assert.equal(unknown.status, 502);
  const replay = await submit(p, T2V("[error200]"), key);
  assert.deepEqual([replay.status, replay.json.status, replay.json.error.code], [200, "failed", "submission_unknown"]);
  assert.equal(p.mock.bodies.filter((b) => (b.body as any).prompt === "[error200]").length, 1, "never submitted again");
});

test("a finished video larger than the limit is not downloaded in full", async () => {
  const p = await startPlugin({ options: { maxVideoBytes: 100 } });
  const job = await waitForEnd(p, (await submit(p, T2V("big"))).json.id);
  assert.deepEqual([job.status, job.error.code, job.error.reason], ["failed", "upstream_failed", "output_too_large"]);
  assert.equal(job.usage.basis, "billed", "OpenRouter charged it");
});

test("inputs a model does not take are rejected, not dropped", async () => {
  const p = await startPlugin();
  const clip = await upload(p, readFileSync(new URL("video.mp4", SAMPLES)), "video/mp4");
  const res = await submit(p, { model: "google/veo-3.1", route: "multimodal2video", input: { artifacts: [{ artifact_id: clip.id, role: "video_track", position: 0 }] }, parameters: { prompt: "like @video1" } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, "invalid_request");
  assert.equal(p.mock.bodies.length, 0, "nothing was sent");
  // Seedance 2.0 takes video references: they are sent as video_url references in order.
  const ok = await submit(p, { model: "bytedance/seedance-2.0-fast", route: "multimodal2video", input: { artifacts: [{ artifact_id: clip.id, role: "video_track", position: 0 }] }, parameters: { prompt: "like @video1" } });
  assert.equal(ok.status, 201, ok.text);
  const body = lastBody(p, "/api/v1/videos");
  assert.equal(body.prompt, "like video 1");
  assert.equal(body.input_references[0].type, "video_url");
  assert.match(body.input_references[0].video_url.url, /^data:video\/mp4;base64,/);
});

test("image2video sends the image as the first frame", async () => {
  const p = await startPlugin();
  const img = await upload(p, solidPng(4, 4, [10, 20, 30]), "image/png");
  const input = (role: string) => ({ artifacts: [{ artifact_id: img.id, role, position: 0 }] });
  const res = await submit(p, { model: "google/veo-3.1", route: "image2video", input: input("first_frame"), parameters: { prompt: "it moves" } });
  assert.equal(res.status, 201, res.text);
  const body = lastBody(p, "/api/v1/videos");
  assert.equal(body.frame_images.length, 1);
  assert.equal(body.frame_images[0].frame_type, "first_frame");
  assert.equal(body.input_references, undefined);
  // The role is first_frame; a reference image belongs to multimodal2video.
  const posts = p.mock.requests.filter((r) => r.path === "/api/v1/videos").length;
  const old = await submit(p, { model: "google/veo-3.1", route: "image2video", input: input("reference"), parameters: { prompt: "it moves" } });
  assert.equal(old.status, 400, old.text);
  assert.equal(p.mock.requests.filter((r) => r.path === "/api/v1/videos").length, posts, "nothing was sent");
});

for (const [model, language, expectedLanguage] of [["openai/whisper-1", undefined, "en"], ["elevenlabs/scribe-v2", undefined, "en"], ["openai/whisper-1", "en-US", "en-US"]] as const) {
  test(`transcription with ${model}${language ? `, language ${language}` : ""}: words, BCP 47, no overlaps`, async () => {
    const p = await startPlugin();
    const audio = await upload(p, readFileSync(new URL("en.wav", SAMPLES)), "audio/wav");
    const res = await submit(p, { model, route: "audio2text", input: { artifacts: [{ artifact_id: audio.id, role: "audio", position: 0 }] }, parameters: language ? { language } : {} });
    assert.equal(res.status, 201, res.text);
    const job = await waitForEnd(p, res.json.id);
    assert.equal(job.status, "succeeded", JSON.stringify(job.error));
    const t = (await p.call("GET", `/v1/artifacts/${job.outputs[0].artifact_id}/content`)).json;
    assert.equal(t.language, expectedLanguage);
    assert.equal(t.text, "Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do.");
    const units = t.segments.flatMap((s: any) => s.timed_text_units);
    assert.equal(units.length, 21, "the sound event is not a unit");
    for (let i = 1; i < units.length; i++) assert.ok(units[i].start_ms >= units[i - 1].end_ms, "no overlap");
    const sent = lastBody(p, "/api/v1/audio/transcriptions");
    assert.deepEqual([sent.response_format, sent.timestamp_granularities, sent.language], ["verbose_json", ["word"], language ? "en" : null]);
  });
}

test("transcription: a model without word timestamps asks for plain text", async () => {
  const p = await startPlugin();
  const audio = await upload(p, readFileSync(new URL("zh.wav", SAMPLES)), "audio/wav");
  const words = await submit(p, { model: "openai/gpt-4o-mini-transcribe", route: "audio2text", input: { artifacts: [{ artifact_id: audio.id, role: "audio", position: 0 }] }, parameters: { timestamps: "word" } });
  assert.equal(words.status, 400, "word is not offered for this model");
  const res = await submit(p, { model: "openai/gpt-4o-mini-transcribe", route: "audio2text", input: { artifacts: [{ artifact_id: audio.id, role: "audio", position: 0 }] }, parameters: { language: "zh" } });
  const job = await waitForEnd(p, res.json.id);
  assert.equal(job.status, "succeeded", JSON.stringify(job.error));
  assert.equal(lastBody(p, "/api/v1/audio/transcriptions").response_format, "json");
  const t = (await p.call("GET", `/v1/artifacts/${job.outputs[0].artifact_id}/content`)).json;
  assert.deepEqual([t.language, t.segments.length, t.segments[0].timed_text_units], ["zh", 1, undefined]);
});

test("estimates: per image, per second of video, per minute of audio", async () => {
  const p = await startPlugin();
  const est = async (body: unknown) => (await p.call("POST", "/v1/estimates", { body })).json.estimate;
  assert.equal((await est(T2I("x"))).amount, 0.04);
  assert.equal((await est({ ...T2V("x", "google/veo-3.1"), parameters: { prompt: "x", duration: 8 } })).amount, 1.6, "without sound");
  assert.equal((await est({ ...T2V("x", "google/veo-3.1"), parameters: { prompt: "x", duration: 8, audio: true } })).amount, 3.2, "with sound");
  // Seedance: video tokens, 854x480 at 24 frames per second.
  assert.equal((await est(T2V("x"))).amount, Math.round(((854 * 480 * 24 * 0.0000042) / 1024) * 4 * 1e6) / 1e6);
  const audio = await upload(p, readFileSync(new URL("en.wav", SAMPLES)), "audio/wav");
  const stt = await est({ model: "openai/whisper-1", route: "audio2text", input: { artifacts: [{ artifact_id: audio.id, role: "audio", position: 0 }] }, parameters: {} });
  assert.ok(stt.amount > 0 && stt.amount < 0.001);
  assert.equal(p.mock.bodies.length, 0, "estimates submit nothing");
});

test("crash window, images: a finished result survives, a call cut short ends submission_unknown", async () => {
  const mock = new MockOpenRouter({ imageMs: 200 });
  await mock.start();
  after(() => mock.close());
  const p = await startPlugin({ mock });
  const done = await submit(p, T2I("survives"), "crash-done");
  await (p.definition.local(p.runtime.ctx)).idle();
  // Simulate a crash before the SDK recorded the upstream id: its record says "submitting".
  const file = path.join(p.dataDir, "jobs", `${done.json.id}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  delete record.upstream_id;
  record.submission = "submitting";
  await fs.writeFile(file, JSON.stringify(record));
  await p.close();
  // A new process with the same data directory: the replay finds the local job by its client reference.
  const q = await startPlugin({ mock, dataDir: p.dataDir });
  const replay = await submit(q, T2I("survives"), "crash-done");
  assert.equal(replay.json.id, done.json.id);
  const job = await waitForEnd(q, done.json.id);
  assert.equal(job.status, "succeeded", "the result written before the crash is kept");
  assert.equal(mock.bodies.length, 1, "not generated twice");

  // A call that is still running when the process dies.
  const slow = await submit(q, T2I("[slow] cut short"), "crash-running");
  await q.close();
  const r = await startPlugin({ mock, dataDir: p.dataDir });
  const ended = await waitForEnd(r, slow.json.id);
  assert.deepEqual([ended.status, ended.error.code, ended.error.reason], ["failed", "submission_unknown", "interrupted"]);
  assert.deepEqual(ended.usage, { amount: 0.04, unit: "USD", basis: "estimate" }, "it may have been charged: the estimate");
  const again = await submit(r, T2I("[slow] cut short"), "crash-running");
  assert.equal(again.json.id, slow.json.id, "the same key returns the same job");
  assert.equal(mock.bodies.filter((b) => (b.body as any).prompt === "[slow] cut short").length, 1, "never submitted again");
});

test("crash window, video: an id OpenRouter returned but the plugin did not record ends submission_unknown", async () => {
  const mock = new MockOpenRouter({ video: { pendingMs: 100, totalMs: 300 } });
  await mock.start();
  after(() => mock.close());
  const p = await startPlugin({ mock });
  // The plugin "dies" after OpenRouter accepted the job and before the id was recorded.
  const submitReal = p.definition.upstream.submit.bind(p.definition.upstream);
  p.definition.upstream.submit = async (ctx) => {
    await submitReal(ctx);
    throw new Error("crashed before recording the id");
  };
  const first = await submit(p, T2V("lost id"), "video-crash");
  assert.equal(first.status, 502);
  const replay = await submit(p, T2V("lost id"), "video-crash");
  assert.deepEqual([replay.json.status, replay.json.error.code], ["failed", "submission_unknown"]);
  assert.equal(mock.bodies.filter((b) => b.path === "/api/v1/videos").length, 1, "OpenRouter has one job, and the plugin did not submit a second");
});

test("every upstream request went to the mock, and none needed the key to be in a URL", async () => {
  const p = await startPlugin();
  await waitForEnd(p, (await submit(p, T2I("check"))).json.id);
  assert.ok(p.mock.requests.length > 0);
  for (const r of p.mock.requests) {
    assert.equal(r.host, new URL(p.mock.url).host);
    assert.ok(!r.path.includes(p.mock.testKey));
  }
});

// An error inside HTTP 200 (rework item 1): OpenRouter took the request, so generation may have started
// and been charged. Whatever the body's code, the result is unknown: never a 4xx (the client would drop
// the key and resubmit), never a retry in the background.
const posts = (p: Plugin, path: string) => p.mock.requests.filter((r) => r.method === "POST" && r.path === path).length;

for (const code of [402, 429, 400]) {
  test(`an error inside HTTP 200 with code ${code}: video unknown, image and transcription not retried`, async () => {
    const p = await startPlugin();
    p.mock.failNext("/api/v1/videos", { status: 200, code, retryAfter: 1 });
    const key = `in-body-${code}`;
    const first = await submit(p, T2V("in body"), key);
    assert.equal(first.status, 502, "unknown, not 4xx");
    const replay = await submit(p, T2V("in body"), key);
    assert.deepEqual([replay.json.status, replay.json.error.code], ["failed", "submission_unknown"]);
    assert.equal(posts(p, "/api/v1/videos"), 1, "never submitted again");

    p.mock.failNext("/api/v1/images", { status: 200, code, retryAfter: 1 });
    const image = await waitForEnd(p, (await submit(p, T2I("in body"))).json.id);
    assert.deepEqual([image.status, image.error.code, image.error.reason], ["failed", "submission_unknown", "error_in_body"]);
    assert.deepEqual(image.usage, { amount: 0.04, unit: "USD", basis: "estimate" }, "it may have been charged");
    assert.equal(posts(p, "/api/v1/images"), 1, "not retried");

    const audio = await upload(p, readFileSync(new URL("en.wav", SAMPLES)), "audio/wav");
    p.mock.failNext("/api/v1/audio/transcriptions", { status: 200, code, retryAfter: 1 });
    const stt = await waitForEnd(p, (await submit(p, { model: "openai/whisper-1", route: "audio2text", input: { artifacts: [{ artifact_id: audio.id, role: "audio", position: 0 }] }, parameters: {} })).json.id);
    assert.deepEqual([stt.status, stt.error.code, stt.error.reason], ["failed", "submission_unknown", "error_in_body"]);
    assert.ok(stt.usage.amount > 0);
    assert.equal(posts(p, "/api/v1/audio/transcriptions"), 1, "not retried");
  });
}

// A gateway timeout during a background call (rework item 4): OpenRouter may still be generating.
for (const [status, reason] of [[504, "gateway_timeout"], [524, "gateway_timeout"], [408, "gateway_timeout"], [502, "gateway_error"]] as const) {
  test(`HTTP ${status} during an image call ends submission_unknown with the estimate`, async () => {
    const p = await startPlugin();
    p.mock.failNext("/api/v1/images", { status });
    const job = await waitForEnd(p, (await submit(p, T2I("gateway"))).json.id);
    assert.deepEqual([job.status, job.error.code, job.error.reason, job.error.params.upstream_status], ["failed", "submission_unknown", reason, status]);
    assert.deepEqual(job.usage, { amount: 0.04, unit: "USD", basis: "estimate" });
    assert.equal(posts(p, "/api/v1/images"), 1);
  });
}
