// A mock of the parts of OpenRouter the plugin uses, written from OpenRouter's public documentation
// (see VALIDATION.md for what was documented and what was assumed). It listens on 127.0.0.1 only and
// never contacts anything. Prompt markers choose outcomes:
//
// | marker             | images                                   | video                                   |
// |--------------------|------------------------------------------|-----------------------------------------|
// | [moderate]         | 403 with metadata.reasons                | the job fails with "Content policy violation" |
// | [moderate-submit]  |                                          | 403 refusal at submission               |
// | [policy-text]      | 403 whose message only reads like moderation |                                     |
// | [fail]             | 502                                      | the job fails with "Generation failed"  |
// | [error200]         | HTTP 200 with an error object            | HTTP 200 with an error object at submission |
// | [budget]           | 402 + Retry-After (in-flight budget) once, then success | the same, at submission  |
// | [credits]          | 402 without Retry-After                  | the same, at submission                 |
// | [ratelimit]        | 429 + Retry-After once, then success     | 429 at submission                       |
// | [reject400]        | 400                                      | 400 at submission                       |
// | [black]            | an all-black PNG                         |                                         |
// | [multi]            | two images                               | two output URLs                         |
// | [expire]/[cancel]  |                                          | the job ends expired / cancelled        |
// | [gone]             |                                          | completed, but the content is 404       |
// | [slow]             | answers after 4 s                        |                                         |
//
// Transcription reads the known text of the conformance samples from their WAV LIST/INFO/ICMT chunk,
// like the example plugin, and answers like Whisper (language names) or Scribe (ISO 639-3, sound
// events), with overlapping word times to exercise the plugin's fixes.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseWav } from "@cuelor/provider-sdk";
import { MP4_BASE64, solidPng } from "./mock-media.ts";

export interface MockRequest {
  method: string;
  path: string;
  host: string;
  authorized: boolean;
}

/** A canned failure for the next request to a path: `status` 200 puts `code` inside the body. */
export interface Failure {
  status: number;
  code?: number;
  message?: string;
  retryAfter?: number;
}

interface VideoJob {
  id: string;
  prompt: string;
  model: string;
  duration: number;
  /** What OpenRouter will bill once it completes (videoCost). */
  cost: number;
  created: number;
}

export interface MockOptions {
  /** Keys the mock accepts. Default: one random key, `testKey`. */
  keys?: string[];
  /** Video timing: pending for `pendingMs`, then in progress until `totalMs`. */
  video?: { pendingMs: number; totalMs: number };
  /** How long an image takes. */
  imageMs?: number;
}

export const MOCK_USER_ID = "user_mock_0001";

export class MockOpenRouter {
  readonly requests: MockRequest[] = [];
  readonly keys: Set<string>;
  readonly testKey: string;
  /** Bodies of the generation requests, in order. */
  readonly bodies: { path: string; body: unknown }[] = [];
  private readonly videos = new Map<string, VideoJob>();
  private readonly codes = new Map<string, { challenge: string; method: string }>();
  private readonly once = new Set<string>();
  private readonly failures = new Map<string, Failure[]>();
  private readonly o: Required<Omit<MockOptions, "keys">>;
  private server: http.Server | undefined;
  url = "";

  constructor(o: MockOptions = {}) {
    // Built at run time and in no known key format (CONTRIBUTING.md, "Never commit secrets").
    this.testKey = o.keys?.[0] ?? "mock-openrouter-" + randomBytes(16).toString("hex");
    this.keys = new Set(o.keys ?? [this.testKey]);
    this.o = { video: o.video ?? { pendingMs: 300, totalMs: 2000 }, imageMs: o.imageMs ?? 800 };
  }

  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => this.send(res, 500, { error: { code: 500, message: String(err) } }));
    });
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  private error(res: http.ServerResponse, status: number, message: string, metadata?: Record<string, unknown>, headers: Record<string, string> = {}): void {
    this.send(res, status, { error: { code: status, message, metadata: metadata ?? null }, user_id: null }, headers);
  }

  /** The next POST to `path` answers with `f` instead of doing its work. */
  failNext(path: string, f: Failure): void {
    const queue = this.failures.get(path) ?? [];
    queue.push(f);
    this.failures.set(path, queue);
  }

  /** True the first time `name` is asked for. */
  private first(name: string): boolean {
    if (this.once.has(name)) return false;
    this.once.add(name);
    return true;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const authorized = auth !== undefined && this.keys.has(auth);
    this.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, host: req.headers.host ?? "", authorized });
    const body = await readBody(req);
    const p = url.pathname;
    const failure = req.method === "POST" ? this.failures.get(p)?.shift() : undefined;
    if (failure) {
      const headers: Record<string, string> = failure.retryAfter !== undefined ? { "Retry-After": String(failure.retryAfter) } : {};
      const code = failure.code ?? failure.status;
      return this.send(res, failure.status, { error: { code, message: failure.message ?? `mock failure ${code}`, metadata: null } }, headers);
    }

    // Public: model lists and OAuth.
    if (req.method === "GET" && p === "/api/v1/images/models") return this.send(res, 200, { data: IMAGE_MODELS });
    if (req.method === "GET" && p === "/api/v1/videos/models") return this.send(res, 200, { data: VIDEO_MODELS });
    if (req.method === "GET" && p === "/api/v1/models" && url.searchParams.get("output_modalities") === "transcription") {
      return this.send(res, 200, { data: TRANSCRIPTION_MODELS });
    }
    if (req.method === "GET" && p === "/auth") return this.authorize(url, res);
    if (req.method === "POST" && p === "/api/v1/auth/keys") return this.exchange(body, res);

    if (!authorized) return this.error(res, 401, auth ? "User not found." : "Missing Authentication header");
    if (req.method === "GET" && p === "/api/v1/key") return this.send(res, 200, { data: { label: "mock key", limit: null, usage: 0, is_free_tier: false, creator_user_id: MOCK_USER_ID } });
    if (req.method === "POST" && p === "/api/v1/images") return this.image(json(body), res);
    if (req.method === "POST" && p === "/api/v1/videos") return this.submitVideo(json(body), res);
    const video = /^\/api\/v1\/videos\/([^/]+)(\/content)?$/.exec(p);
    if (req.method === "GET" && video) return video[2] ? this.content(video[1]!, res) : this.pollVideo(video[1]!, res);
    if (req.method === "POST" && p === "/api/v1/audio/transcriptions") return this.transcribe(req, body, res);
    return this.error(res, 404, "Not Found");
  }

  private authorize(url: URL, res: http.ServerResponse): void {
    const callback = url.searchParams.get("callback_url");
    const challenge = url.searchParams.get("code_challenge");
    if (!callback || !challenge) return this.error(res, 400, "callback_url and code_challenge are required");
    // The user "approves" at once.
    const code = randomBytes(12).toString("hex");
    this.codes.set(code, { challenge, method: url.searchParams.get("code_challenge_method") ?? "plain" });
    const target = new URL(callback);
    target.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { Location: target.toString() });
    res.end();
  }

  private exchange(body: Buffer, res: http.ServerResponse): void {
    const b = json(body) as { code?: string; code_verifier?: string; code_challenge_method?: string };
    const entry = b.code ? this.codes.get(b.code) : undefined;
    if (!entry || !b.code_verifier) return this.error(res, 403, "Invalid code or code_verifier");
    if (b.code_challenge_method !== entry.method) return this.error(res, 400, "Invalid code_challenge_method");
    const computed = createHash("sha256").update(b.code_verifier).digest("base64url");
    if (computed !== entry.challenge) return this.error(res, 403, "Invalid code or code_verifier");
    this.codes.delete(b.code!);
    const key = "mock-oauth-" + randomBytes(16).toString("hex");
    this.keys.add(key);
    this.send(res, 200, { key, user_id: MOCK_USER_ID });
  }

  /** Shared submission errors, by prompt marker. */
  private submissionError(kind: string, prompt: string, res: http.ServerResponse): boolean {
    if (prompt.includes("[reject400]")) return this.error(res, 400, "Invalid request parameters"), true;
    if (prompt.includes("[credits]")) return this.error(res, 402, "Insufficient credits. Add more using https://openrouter.ai/credits"), true;
    if (prompt.includes("[budget]") && this.first(`${kind}:budget:${prompt}`)) {
      return this.error(res, 402, "In-flight budget exceeded", { limit_source: "openrouter_in_flight_budget" }, { "Retry-After": "1" }), true;
    }
    if (prompt.includes("[ratelimit]") && (kind === "video" || this.first(`${kind}:rate:${prompt}`))) {
      return this.error(res, 429, "Rate limit exceeded", undefined, { "Retry-After": "1" }), true;
    }
    if (prompt.includes("[error200]")) return this.send(res, 200, { error: { code: 502, message: "Provider returned error", metadata: { provider_name: "mock" } } }), true;
    return false;
  }

  private async image(b: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    this.bodies.push({ path: "/api/v1/images", body: b });
    const prompt = String(b.prompt ?? "");
    if (this.submissionError("image", prompt, res)) return;
    if (prompt.includes("[moderate]")) {
      return this.error(res, 403, "Input was flagged by the content filter", { reasons: ["sexual"], flagged_input: "…", provider_name: "mock", model_slug: b.model });
    }
    if (prompt.includes("[policy-text]")) return this.error(res, 403, "Your request was rejected by the safety system");
    // As the real service answered on 2026-10-28, though its list offers 1K.
    if (b.model === "bytedance-seed/seedream-4.5" && b.resolution === "1K") {
      return this.error(res, 400, 'bytedance-seed/seedream-4.5 requires at least 3,686,400 output pixels; size "1024x1024" is 1,048,576. Use a larger resolution such as "2K", or omit resolution to use the default.');
    }
    await sleep(prompt.includes("[slow]") ? 4000 : this.o.imageMs);
    if (prompt.includes("[fail]")) return this.error(res, 502, "Generation did not complete");
    const h = createHash("sha256").update(prompt + "|" + String(b.seed ?? "")).digest();
    const rgb: [number, number, number] = prompt.includes("[black]") ? [0, 0, 0] : [h[0]! | 1, h[1]!, h[2]!];
    const one = { b64_json: solidPng(64, 64, rgb).toString("base64"), media_type: "image/png" };
    const data = prompt.includes("[multi]") ? [one, { ...one, b64_json: solidPng(64, 64, [9, 9, 9]).toString("base64") }] : [one];
    this.send(res, 200, { created: Math.floor(Date.now() / 1000), data, usage: { cost: 0.04 * data.length, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  }

  private submitVideo(b: Record<string, unknown>, res: http.ServerResponse): void {
    this.bodies.push({ path: "/api/v1/videos", body: b });
    const prompt = String(b.prompt ?? "");
    if (this.submissionError("video", prompt, res)) return;
    if (prompt.includes("[moderate-submit]")) return this.error(res, 403, "The model refused this request", { error_type: "refusal", provider_name: "mock" });
    const model = VIDEO_MODELS.find((m) => m.id === b.model);
    if (!model) return this.error(res, 400, `model ${String(b.model)} is not a video model`);
    const duration = Number(b.duration ?? model.supported_durations[0]);
    if (!model.supported_durations.includes(duration)) return this.error(res, 400, `duration must be one of ${model.supported_durations.join(", ")}`);
    const id = `gen-vid-${Math.floor(Date.now() / 1000)}-${randomBytes(10).toString("hex").slice(0, 20)}`;
    this.videos.set(id, { id, prompt, model: model.id, duration, cost: videoCost(model, b, duration), created: Date.now() });
    this.send(res, 202, { id, polling_url: `/api/v1/videos/${id}`, status: "pending" });
  }

  private pollVideo(id: string, res: http.ServerResponse): void {
    const job = this.videos.get(id);
    if (!job) return this.error(res, 404, "Not Found");
    const elapsed = Date.now() - job.created;
    const base = { id, polling_url: `/api/v1/videos/${id}`, generation_id: id };
    if (elapsed < this.o.video.pendingMs) return this.send(res, 200, { ...base, status: "pending" });
    if (elapsed < this.o.video.totalMs) return this.send(res, 200, { ...base, status: "in_progress" });
    const p = job.prompt;
    if (p.includes("[moderate]")) return this.send(res, 200, { ...base, status: "failed", error: "Content policy violation" });
    if (p.includes("[fail]")) return this.send(res, 200, { ...base, status: "failed", error: "Generation failed" });
    if (p.includes("[expire]")) return this.send(res, 200, { ...base, status: "expired" });
    if (p.includes("[cancel]")) return this.send(res, 200, { ...base, status: "cancelled" });
    const n = p.includes("[multi]") ? 2 : 1;
    const unsigned = Array.from({ length: n }, (_, i) => `${this.url}/api/v1/videos/${id}/content?index=${i}`);
    const signed = Array.from({ length: n }, (_, i) => `${this.url}/signed/${id}/${i}?sig=${randomBytes(16).toString("hex")}`);
    this.send(res, 200, { ...base, status: "completed", unsigned_urls: unsigned, urls: signed, expires_at: Math.floor(Date.now() / 1000) + 3600, usage: { cost: job.cost, is_byok: false } });
  }

  private content(id: string, res: http.ServerResponse): void {
    const job = this.videos.get(id);
    if (!job || Date.now() - job.created < this.o.video.totalMs || job.prompt.includes("[gone]")) return this.error(res, 404, "Not Found");
    const bytes = Buffer.from(MP4_BASE64, "base64");
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    res.end(bytes);
  }

  private async transcribe(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): Promise<void> {
    let form: FormData;
    try {
      form = await new Request("http://mock.invalid/", { method: "POST", headers: { "content-type": req.headers["content-type"] ?? "" }, body: new Uint8Array(body) }).formData();
    } catch {
      return this.error(res, 400, "expected multipart/form-data");
    }
    const model = String(form.get("model") ?? "");
    const file = form.get("file");
    this.bodies.push({ path: "/api/v1/audio/transcriptions", body: { model, response_format: form.get("response_format"), timestamp_granularities: form.getAll("timestamp_granularities[]"), language: form.get("language") } });
    if (!TRANSCRIPTION_MODELS.some((m) => m.id === model)) return this.error(res, 400, `unknown model ${model}`);
    if (!(file instanceof Blob)) return this.error(res, 400, "file is required");
    const format = String(form.get("response_format") ?? "json");
    if (format === "verbose_json" && model === "openai/gpt-4o-mini-transcribe") return this.error(res, 400, "response_format verbose_json is not supported by this model");
    await sleep(300);
    const wav = new Uint8Array(await file.arrayBuffer());
    const info = parseWav(wav);
    let known: { language: string; text: string } = { language: "en", text: "" };
    try {
      if (info?.info.ICMT) known = JSON.parse(info.info.ICMT);
    } catch {
      // Not one of the samples: silence.
    }
    const seconds = (info?.durationMs ?? 0) / 1000;
    const usage = { cost: Math.round(0.006 * (seconds / 60) * 1e6) / 1e6, seconds };
    if (format !== "verbose_json") return this.send(res, 200, { text: known.text, usage });
    const scribe = model.startsWith("elevenlabs/");
    const language = form.get("language")
      ? String(form.get("language"))
      : scribe
        ? ({ en: "eng", zh: "cmn" } as Record<string, string>)[known.language] ?? known.language
        : ({ en: "english", zh: "chinese" } as Record<string, string>)[known.language] ?? known.language;
    const cjk = /[\p{Script=Han}]/u.test(known.text);
    const units = cjk ? [...known.text].filter((c) => !/[\p{P}\s]/u.test(c)) : known.text.split(/\s+/).filter(Boolean);
    const start = seconds * 0.05;
    const slot = units.length > 0 ? (seconds * 0.9) / units.length : 0;
    // Each word ends 40 ms after the next one starts: an overlap the plugin has to fix.
    const words: { word: string; start: number; end: number; type?: string }[] = units.map((w, i) => ({ word: w, start: start + i * slot, end: start + (i + 1) * slot + 0.04 }));
    if (scribe && words.length > 0) words.splice(1, 0, { word: "(laughter)", start: words[0]!.end, end: words[0]!.end, type: "audio_event" });
    const timestamps = form.getAll("timestamp_granularities[]").map(String);
    this.send(res, 200, {
      task: "transcribe",
      text: known.text,
      language,
      duration: seconds,
      segments: [{ id: 0, start, end: start + seconds * 0.9, text: known.text }],
      ...(timestamps.includes("word") ? { words } : {}),
      usage,
    });
  }
}

const IMAGE_MODELS = [
  {
    id: "bytedance-seed/seedream-4.5",
    name: "Seedream 4.5",
    description: "A text-to-image model.",
    created: 1692901234,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
    supported_parameters: {
      aspect_ratio: { type: "enum", values: ["auto", "1:1", "16:9", "9:16", "4:3"] },
      resolution: { type: "enum", values: ["1K", "2K", "4K"] },
      seed: { type: "boolean" },
      input_references: { type: "range", min: 0, max: 10 },
    },
    supports_streaming: false,
    endpoints: "/api/v1/images/models/bytedance-seed/seedream-4.5/endpoints",
  },
  {
    id: "google/gemini-2.5-flash-image",
    name: "Gemini 2.5 Flash Image",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
    supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9", "9:16"] } },
  },
  // Not in the plugin's table: not offered.
  { id: "example/unlisted-image", name: "Unlisted", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, supported_parameters: {} },
];

/**
 * The mock's bill for a video, from its own pricing_skus: per second by sound, or per video token at
 * W×H, 24 frames per second plus a frame (the real service billed 97 frames for 4 s). Without SKUs,
 * 0.07 USD per second.
 */
function videoCost(model: (typeof VIDEO_MODELS)[number], b: Record<string, unknown>, duration: number): number {
  const skus: Record<string, string> = (model as { pricing_skus?: Record<string, string> }).pricing_skus ?? {};
  const audio = b.generate_audio === true;
  const bySecond = Number(skus[audio ? "duration_seconds_with_audio" : "duration_seconds_without_audio"]);
  if (bySecond > 0) return round6(bySecond * duration);
  const perToken = Number(skus.video_tokens);
  const short = Number(String(b.resolution ?? "480p").replace(/p$/, ""));
  const [w, h] = String(b.aspect_ratio ?? "16:9").split(":").map(Number);
  const size = ((model as { supported_sizes?: string[] }).supported_sizes ?? [])
    .map((s) => s.split("x").map(Number) as [number, number])
    .find(([x, y]) => Math.min(x, y) === short && Math.abs(x / y - (w ?? 16) / (h ?? 9)) < 0.03);
  if (perToken > 0 && size) return round6(((size[0] * size[1] * (24 * duration + 1)) / 1024) * perToken);
  return round6(0.07 * duration);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const VIDEO_MODELS = [
  {
    id: "bytedance/seedance-2.0-fast",
    canonical_slug: "bytedance/seedance-2.0-fast",
    name: "Seedance 2.0 Fast",
    supported_durations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    supported_resolutions: ["720p", "480p"],
    supported_aspect_ratios: ["16:9", "9:16", "1:1"],
    supported_sizes: ["854x480", "480x854", "480x480", "1280x720", "720x1280", "720x720"],
    generate_audio: true,
    // The shapes of OpenRouter's pricing_skus on 2026-10-28: per video token here, per second by sound for Veo.
    pricing_skus: { video_tokens: "0.0000042", video_tokens_without_audio: "0.0000042", video_tokens_with_video_input: "0.000002475" },
    allowed_passthrough_parameters: [],
  },
  {
    id: "google/veo-3.1",
    canonical_slug: "google/veo-3.1",
    name: "Veo 3.1",
    supported_durations: [4, 6, 8],
    supported_resolutions: ["720p", "1080p"],
    supported_aspect_ratios: ["16:9", "9:16"],
    generate_audio: true,
    pricing_skus: { duration_seconds_with_audio: "0.40", duration_seconds_without_audio: "0.20" },
    allowed_passthrough_parameters: ["output_config"],
  },
  // Irregular durations: offered as an integer with enum_values.
  {
    id: "bytedance/seedance-2.0",
    name: "Seedance 2.0",
    supported_durations: [5, 10, 12],
    supported_resolutions: ["1080p"],
    supported_aspect_ratios: ["16:9"],
    generate_audio: false,
    pricing_skus: {},
  },
  { id: "example/unlisted-video", name: "Unlisted", supported_durations: [5], supported_resolutions: ["720p"], supported_aspect_ratios: ["16:9"] },
];

const TRANSCRIPTION_MODELS = [
  { id: "openai/whisper-1", name: "OpenAI: Whisper", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } },
  { id: "openai/gpt-4o-mini-transcribe", name: "OpenAI: GPT-4o mini Transcribe", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } },
  { id: "elevenlabs/scribe-v2", name: "ElevenLabs: Scribe", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } },
];

function json(body: Buffer): Record<string, unknown> {
  try {
    const v = JSON.parse(body.toString("utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
