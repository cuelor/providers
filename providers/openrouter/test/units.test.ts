// Unit tests of the translation parts: catalog, transcript, errors, black images, the client.
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { NotSubmittedError, ProviderError, validateCatalog, validateTranscript } from "@cuelor/provider-sdk";
import { buildCatalog, durationParameter, enumParameter, videoPrice, videoSize, type UpstreamLists } from "../src/catalog.ts";
import { OpenRouterClient, UpstreamHttpError, UpstreamNetworkError } from "../src/client.ts";
import { baseUrlFromEnv, checkBaseUrl, DEFAULT_BASE_URL } from "../src/config.ts";
import { backgroundFailure, isRetryable, moderationOf, submissionError } from "../src/errors.ts";
import { isBlackPng } from "../src/png.ts";
import { translatePrompt } from "../src/provider.ts";
import { findSpec, type VideoModelSpec } from "../src/models.ts";
import { toBcp47, toTranscript } from "../src/transcript.ts";
import { allowBlocked } from "./helpers.ts";
import { solidPng } from "./mock-media.ts";
import { MockOpenRouter } from "./mock-openrouter.ts";

async function mockLists(): Promise<UpstreamLists> {
  const mock = new MockOpenRouter();
  const url = await mock.start();
  try {
    const get = async (p: string) => ((await (await fetch(url + p)).json()) as { data: never[] }).data;
    return { images: await get("/api/v1/images/models"), videos: await get("/api/v1/videos/models"), transcription: await get("/api/v1/models?output_modalities=transcription") };
  } finally {
    await mock.close();
  }
}

test("catalog: only models that are in the plugin's table and in the upstream's lists", async () => {
  const catalog = buildCatalog(await mockLists());
  assert.deepEqual(validateCatalog(catalog), []);
  const ids = catalog.models.map((m) => m.id);
  assert.deepEqual(ids.sort(), [
    "bytedance-seed/seedream-4.5",
    "bytedance/seedance-2.0",
    "bytedance/seedance-2.0-fast",
    "elevenlabs/scribe-v2",
    "google/gemini-2.5-flash-image",
    "google/veo-3.1",
    "openai/gpt-4o-mini-transcribe",
    "openai/whisper-1",
  ]);
  // Sora 2 Pro is in the table but gone upstream; the unlisted models are upstream but not in the table.
  assert.ok(!ids.includes("openai/sora-2-pro"));
  assert.ok(!ids.some((id) => id.startsWith("example/")));
});

test("catalog: image parameters and reference limits come from supported_parameters, else the table", async () => {
  const catalog = buildCatalog(await mockLists());
  const seedream = catalog.models.find((m) => m.id === "bytedance-seed/seedream-4.5")!;
  assert.deepEqual(seedream.parameters.map((p) => p.name), ["prompt", "ratio", "resolution", "seed"]);
  const ratio = seedream.parameters.find((p) => p.name === "ratio")!;
  assert.deepEqual(ratio.enum_values, ["1:1", "16:9", "9:16", "4:3"], "auto is not offered");
  assert.equal(ratio.default, "1:1");
  // n is never declared: one output per job.
  assert.ok(!seedream.parameters.some((p) => p.name === "n"));
  const i2i = seedream.routes.find((r) => r.id === "image2image")!;
  assert.equal(i2i.input.slots[0]!.max_artifacts, 10, "the upstream's range");
  const gemini = catalog.models.find((m) => m.id === "google/gemini-2.5-flash-image")!;
  assert.equal(gemini.routes.find((r) => r.id === "image2image")!.input.slots[0]!.max_artifacts, 3, "the table's value");
  assert.match(i2i.description!, /image 2/);
});

test("catalog: video reference slots come from the table; unsupported inputs get no slot", async () => {
  const catalog = buildCatalog(await mockLists());
  const route = (model: string, id: string) => catalog.models.find((m) => m.id === model)!.routes.find((r) => r.id === id);
  const seedance = route("bytedance/seedance-2.0-fast", "multimodal2video")!;
  assert.deepEqual(seedance.input.slots.map((s) => [s.role, s.max_artifacts]), [["reference", 9], ["video_track", 3], ["audio_track", 3]]);
  assert.equal(seedance.input.max_total_artifacts, 15);
  const veo = route("google/veo-3.1", "multimodal2video")!;
  assert.deepEqual(veo.input.slots.map((s) => s.role), ["reference"], "Veo ignores audio and video references, so it has no slots for them");
  assert.deepEqual(route("google/veo-3.1", "image2video")!.input.slots.map((s) => [s.id, s.role, s.min_artifacts, s.max_artifacts]), [["first_frame", "first_frame", 1, 1]], "image2video: one first frame (v1.md section 3.3)");
  assert.ok(route("google/veo-3.1", "frames2video"));
  const fast = catalog.models.find((m) => m.id === "bytedance/seedance-2.0-fast")!;
  assert.equal(fast.parameters.find((p) => p.name === "video_resolution")!.default, "480p", "the cheapest resolution");
  assert.equal(fast.parameters.find((p) => p.name === "duration")!.default, 4, "the shortest duration");
  assert.equal(fast.parameters.find((p) => p.name === "audio")!.default, false);
  assert.equal(seedance.output!.audio, "optional");
  assert.equal(seedance.pricing!.amount, 0.0404, "from the video-token price at 854x480 without sound");
  const plain = catalog.models.find((m) => m.id === "bytedance/seedance-2.0")!;
  assert.equal(plain.routes[0]!.output!.audio, "none");
  assert.equal(plain.routes[0]!.pricing!.amount, 0.07, "the table's price when the upstream has none");
  assert.equal(route("google/veo-3.1", "text2video")!.pricing!.amount, 0.2, "Veo without sound");
});

test("catalog: durations become a range when evenly spaced, else a list of integers", () => {
  assert.deepEqual(durationParameter([8, 4, 6]), { name: "duration", kind: "integer", default: 4, unit: "s", label: "Duration", min: 4, max: 8, step: 2, widget: "slider" });
  assert.deepEqual(durationParameter([5]), { name: "duration", kind: "integer", default: 5, unit: "s", label: "Duration", min: 5, max: 5, step: 1 });
  // Uneven durations: an integer parameter that lists its values (v1.md section 3.3).
  assert.deepEqual(durationParameter([5, 10, 12]), { name: "duration", kind: "integer", default: 5, unit: "s", label: "Duration", enum_values: [5, 10, 12] });
  assert.equal(durationParameter([]), undefined);
});

test("catalog: a parameter with no values to list is left out, never sent with an empty enum_values", () => {
  assert.equal(enumParameter("ratio", "Aspect ratio", [], ["1:1"]), undefined);
  assert.equal(enumParameter("ratio", "Aspect ratio", ["", 5 as unknown as string], []), undefined, "every value filtered out");
  assert.equal(durationParameter([]), undefined);
  assert.equal(durationParameter([0, -3, 2.5]), undefined, "every duration filtered out");
  const kept = enumParameter("ratio", "Aspect ratio", ["", "1:1", "1:1"], []);
  assert.deepEqual(kept?.enum_values, ["1:1"]);
});

test("catalog: no parameter of any built model has an empty enum_values", async () => {
  const lists = await mockLists();
  for (const m of buildCatalog(lists).models) for (const p of m.parameters) assert.ok(p.enum_values === undefined || p.enum_values.length > 0, `${m.id}.${p.name}`);
});

test("catalog: transcription timestamps follow the table's whitelist", async () => {
  const catalog = buildCatalog(await mockLists());
  const ts = (id: string) => catalog.models.find((m) => m.id === id)!.parameters.find((p) => p.name === "timestamps")!;
  assert.deepEqual(ts("openai/whisper-1").enum_values, ["none", "segment", "word"]);
  assert.equal(ts("openai/whisper-1").default, "word");
  assert.deepEqual(ts("openai/gpt-4o-mini-transcribe").enum_values, ["none"]);
  assert.equal(ts("openai/gpt-4o-mini-transcribe").default, "none");
});

test("prompt references become words; other @ stay", () => {
  assert.equal(translatePrompt("@image1 walks into @video1, then @image2; mail me@example.com @image"), "image 1 walks into video 1, then image 2; mail me@example.com @image");
});

test("language: ISO 639-3 and English names become BCP 47", () => {
  assert.equal(toBcp47("eng"), "en");
  assert.equal(toBcp47("english"), "en");
  assert.equal(toBcp47("cmn"), "zh");
  assert.equal(toBcp47("Chinese"), "zh");
  assert.equal(toBcp47("jpn"), "ja");
  assert.equal(toBcp47("zh-hans"), "zh-Hans");
  assert.equal(toBcp47("pt-br"), "pt-BR");
  assert.equal(toBcp47("fil"), "fil", "a 639-3 code without a 639-1 code stays");
  assert.equal(toBcp47("not a language"), undefined);
  assert.equal(toBcp47(undefined), undefined);
});

test("transcript: overlaps fixed, sound events dropped, characters for Chinese", () => {
  const t = toTranscript(
    {
      text: "今天 下雨",
      language: "cmn",
      words: [
        { word: "今", start: 0.0, end: 0.3 },
        { word: "(laughter)", start: 0.3, end: 0.5, type: "audio_event" },
        { word: "天", start: 0.25, end: 0.6 },
        { word: "，", start: 0.6, end: 0.6 },
        { word: "下", start: 0.7, end: 0.9 },
        { word: "雨", start: 0.85, end: 1.2 },
      ],
    },
    { timestamps: "word", model: "elevenlabs/scribe-v2", durationMs: 1150 },
  );
  assert.equal(t.language, "zh");
  assert.equal(t.unit, "character");
  const units = t.segments[0]!.timed_text_units!;
  assert.deepEqual(units.map((u) => u.text), ["今", "天", "下", "雨"]);
  assert.deepEqual(units.map((u) => [u.start_ms, u.end_ms]), [[0, 300], [300, 600], [700, 900], [900, 1150]]);
  assert.deepEqual(validateTranscript(t, { durationMs: 1150 }), []);
});

test("transcript: words go to their segments; a requested language wins", () => {
  const t = toTranscript(
    {
      text: "one two three",
      language: "english",
      segments: [{ start: 0, end: 1, text: "one two" }, { start: 1, end: 2, text: "three" }],
      words: [{ word: "one", start: 0, end: 0.5 }, { word: "two", start: 0.5, end: 1 }, { word: "three", start: 1.1, end: 1.9 }],
    },
    { timestamps: "word", requestedLanguage: "en-GB", model: "openai/whisper-1" },
  );
  assert.equal(t.language, "en-GB");
  assert.equal(t.unit, "word");
  assert.deepEqual(t.segments.map((s) => s.timed_text_units!.map((u) => u.text)), [["one", "two"], ["three"]]);
  const none = toTranscript({ text: "one two" }, { timestamps: "none", model: "openai/gpt-4o-mini-transcribe" });
  assert.deepEqual(none.segments, [{ text: "one two" }]);
});

test("errors at submission: 4xx only when nothing was created", () => {
  const http = (status: number, message: string, extra: Partial<ConstructorParameters<typeof UpstreamHttpError>[0]> = {}) => new UpstreamHttpError({ status, code: status, message, ...extra });
  let invalidKey = 0;
  const map = (err: unknown) => submissionError(err, () => invalidKey++);
  const inflight = map(http(402, "In-flight budget exceeded", { metadata: { limit_source: "openrouter_in_flight_budget" }, retryAfter: 7 })) as ProviderError;
  assert.equal(inflight.status, 429, "the in-flight budget is temporary");
  assert.equal(inflight.code, "rate_limited");
  assert.equal(inflight.headers?.["Retry-After"], "7");
  const credits = map(http(402, "Insufficient credits")) as ProviderError;
  assert.deepEqual([credits.status, credits.code], [402, "insufficient_credits"]);
  const moderated = map(http(403, "refused", { metadata: { error_type: "refusal" } })) as ProviderError;
  assert.deepEqual([moderated.status, moderated.code, moderated.params], [422, "content_moderated", { stage: "input", source: "upstream", category: "refusal" }]);
  const region = map(http(403, "This model is not available in your region")) as ProviderError;
  assert.deepEqual([region.status, region.code, region.reason], [403, "forbidden", "region_restricted"]);
  assert.deepEqual([(map(http(401, "User not found")) as ProviderError).code, invalidKey], ["provider_not_ready", 1]);
  assert.equal((map(http(400, "bad")) as ProviderError).status, 400);
  assert.equal((map(http(404, "no such model")) as ProviderError).reason, "model_unavailable");
  // Unknown results are plain errors (the SDK answers 502 and never submits again).
  for (const err of [http(500, "boom"), http(503, "no provider"), http(200, "Provider returned error", { code: 502, inBody: true }), new UpstreamNetworkError("reset", false)]) {
    const mapped = map(err);
    assert.ok(!(mapped instanceof ProviderError) && !(mapped instanceof NotSubmittedError), `${err.message} is unknown`);
  }
  assert.ok(map(new UpstreamNetworkError("refused", true)) instanceof NotSubmittedError);
  // An error inside HTTP 200 leaves the result unknown, whatever its code: the request was taken and
  // generation may have started (and be charged). Never 4xx, so the client keeps the key and never resubmits.
  for (const code of [400, 402, 403, 422, 429, 502]) {
    const err = http(200, "Provider returned error", { code, inBody: true, retryAfter: 1, metadata: code === 402 ? { limit_source: "openrouter_in_flight_budget" } : undefined });
    const mapped = map(err);
    assert.ok(!(mapped instanceof ProviderError) && !(mapped instanceof NotSubmittedError), `in-body ${code} is unknown`);
    assert.equal(isRetryable(err), false, `in-body ${code} is never retried`);
  }
});

test("errors in the background become job states", () => {
  const http = (status: number, message: string, extra: Partial<ConstructorParameters<typeof UpstreamHttpError>[0]> = {}) => new UpstreamHttpError({ status, code: status, message, ...extra });
  const f = (err: unknown) => backgroundFailure(err, () => undefined);
  assert.deepEqual(f(http(402, "x", { retryAfter: 1 })).error.reason, "not_submitted");
  assert.equal(f(http(402, "x")).error.code, "insufficient_credits");
  assert.equal(f(http(400, "x")).error.code, "invalid_input");
  // Gateway errors: OpenRouter may still be generating, and charging.
  for (const [status, reason] of [[408, "gateway_timeout"], [504, "gateway_timeout"], [524, "gateway_timeout"], [502, "gateway_error"]] as const) {
    const e = f(http(status, "x")).error;
    assert.deepEqual([e.code, e.reason, e.params?.upstream_status], ["submission_unknown", reason, status], `HTTP ${status}`);
  }
  assert.equal(f(http(500, "x")).error.code, "upstream_failed");
  // An error inside HTTP 200: unknown, whatever its code.
  for (const code of [400, 402, 429, 502]) {
    const e = f(http(200, "x", { code, inBody: true, retryAfter: 1 })).error;
    assert.deepEqual([e.code, e.reason, e.params?.upstream_code], ["submission_unknown", "error_in_body", code], `in-body ${code}`);
  }
  assert.deepEqual(f(new UpstreamNetworkError("refused", true)).error.reason, "not_submitted");
  assert.equal(f(new UpstreamNetworkError("reset", false)).error.code, "submission_unknown");
  const typed = f(http(403, "Input was flagged", { metadata: { reasons: ["violence"] } }));
  assert.deepEqual([typed.status, typed.error.code, typed.error.params], ["rejected", "content_moderated", { stage: "input", source: "upstream", category: "violence" }]);
  const inferred = moderationOf(http(403, "Your request was rejected by the safety system"));
  assert.deepEqual(inferred, { stage: "input", source: "upstream", inferred: true });
  assert.equal(moderationOf(http(403, "Only management keys can perform this operation")), undefined);
  // Words alone count only on 403 and 422: a plain 400 is an invalid request.
  assert.equal(moderationOf(http(400, "parameter 'safety_tolerance' is unsafe for this model")), undefined);
  assert.equal(f(http(400, "parameter 'safety_tolerance' is unsafe for this model")).error.code, "invalid_input");
  assert.deepEqual(moderationOf(http(422, "Prompt flagged as unsafe")), { stage: "input", source: "upstream", inferred: true });
  assert.equal(moderationOf(http(400, "x", { code: "content_policy_violation" }))?.category, "content_policy_violation", "a typed code still counts on 400");
});

test("black PNGs are detected with every filter and with alpha; others are not", () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    assert.equal(isBlackPng(solidPng(8, 4, [0, 0, 0], { filter })), true, `filter ${filter}`);
    assert.equal(isBlackPng(solidPng(8, 4, [0, 0, 0], { filter, alpha: 255 })), true, `filter ${filter}, alpha`);
    assert.equal(isBlackPng(solidPng(8, 4, [1, 0, 0], { filter })), false, `filter ${filter}, not black`);
    assert.equal(isBlackPng(solidPng(8, 4, [0, 0, 2], { filter, alpha: 255 })), false, `filter ${filter}, alpha, not black`);
  }
  assert.equal(isBlackPng(Buffer.from("not a png")), false);
});

test("base URL: only https or 127.0.0.1 origins; the default is openrouter.ai", () => {
  assert.equal(baseUrlFromEnv({}), DEFAULT_BASE_URL);
  assert.equal(checkBaseUrl("http://127.0.0.1:5000"), "http://127.0.0.1:5000");
  assert.equal(checkBaseUrl("https://proxy.example.com/"), "https://proxy.example.com");
  for (const bad of ["http://example.com", "http://localhost:5000", "http://127.0.0.1", "https://x.example.com/api", "https://u:p@x.example.com", "ftp://x"]) {
    assert.throws(() => checkBaseUrl(bad), Error, bad);
  }
});

test("client: never leaves its origin; errors inside HTTP 200 are errors", async () => {
  const seen: string[] = [];
  const fake = (async (url: URL) => {
    seen.push(url.toString());
    return new Response(JSON.stringify({ error: { code: 502, message: "Provider returned error" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = new OpenRouterClient({ baseUrl: "http://127.0.0.1:9", key: () => "k", fetch: fake });
  assert.throws(() => client.url("https://openrouter.ai/api/v1/videos/x/content"), /outside/);
  assert.throws(() => client.url("//evil.example.com/x"), /outside/);
  await assert.rejects(client.request("GET", "https://storage.example.com/video.mp4"), /outside/);
  await assert.rejects(client.json("GET", "/api/v1/key"), (err: unknown) => err instanceof UpstreamHttpError && err.inBody && err.effectiveStatus === 502);
  assert.deepEqual(seen, ["http://127.0.0.1:9/api/v1/key"]);
  // A refused connection is "not sent".
  const closed = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
  const refused = new OpenRouterClient({ baseUrl: `http://127.0.0.1:${closed}`, key: () => "k" });
  await assert.rejects(refused.request("GET", "/x"), (err: unknown) => err instanceof UpstreamNetworkError && err.notSent);
});

test("the offline guard stops a request to the real OpenRouter", async () => {
  allowBlocked(1);
  const client = new OpenRouterClient({ baseUrl: DEFAULT_BASE_URL, key: () => "k" });
  await assert.rejects(client.json("GET", "/api/v1/videos/models", { auth: false }), UpstreamNetworkError);
});

test("video prices from each shape of OpenRouter's pricing_skus", () => {
  const spec = findSpec("google/veo-3.1") as VideoModelSpec;
  const veo = { id: spec.id, pricing_skus: { duration_seconds_with_audio: "0.40", duration_seconds_without_audio: "0.20", duration_seconds_with_audio_4k: "0.60" } };
  assert.equal(videoPrice(veo, spec, { resolution: "720p", audio: false }).perSecond, 0.2);
  assert.equal(videoPrice(veo, spec, { resolution: "720p", audio: true }).perSecond, 0.4);
  assert.equal(videoPrice(veo, spec, { resolution: "4K", audio: true }).perSecond, 0.6);
  assert.equal(videoPrice(veo, spec, { resolution: "4K", audio: false }).perSecond, 0.2, "no 4K price without sound: the plain one");
  const tokens = { id: spec.id, supported_sizes: ["854x480", "1920x1080", "1080x1920"], pricing_skus: { video_tokens: "0.000007", video_tokens_1080p: "0.0000077" } };
  assert.equal(videoPrice(tokens, spec, { resolution: "480p", ratio: "16:9" }).perSecond, (854 * 480 * 24 * 0.000007) / 1024);
  assert.equal(videoPrice(tokens, spec, { resolution: "1080p", ratio: "9:16" }).perSecond, (1080 * 1920 * 24 * 0.0000077) / 1024);
  assert.equal(videoPrice({ id: spec.id, pricing_skus: { "per-video-second": "0.3" } }, spec, {}).perSecond, 0.3);
  assert.equal(videoPrice({ id: spec.id }, spec, {}).perSecond, spec.pricePerSecond);
  assert.deepEqual(videoSize("720p", "1:1", []), { width: 720, height: 720 });
  assert.deepEqual(videoSize("480p", "9:16", []), { width: 480, height: 853 });
  assert.equal(videoSize(undefined, "16:9", []), undefined);
});

test("catalog: an image resolution the model refuses is not offered", async () => {
  const catalog = buildCatalog(await mockLists());
  const res = catalog.models.find((m) => m.id === "bytedance-seed/seedream-4.5")!.parameters.find((p) => p.name === "resolution")!;
  assert.deepEqual([res.enum_values, res.default], [["2K", "4K"], "2K"]);
});
