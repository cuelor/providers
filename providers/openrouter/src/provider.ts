import path from "node:path";
import {
  replacePromptReferences,
  sniffMediaType,
  TRANSCRIPT_MEDIA_TYPE,
  type Estimate,
  type EstimateContext,
  type KeychainOptions,
  type ProviderContext,
  type ProviderDefinition,
  type ResolvedInput,
  type SubmitContext,
  type UpstreamState,
  type Usage,
  type Warning,
} from "@cuelor/provider-sdk";
import { Credentials } from "./account.ts";
import { DownloadTooLargeError, OpenRouterClient, UpstreamHttpError } from "./client.ts";
import { baseUrlFromEnv, PROVIDER_ID, PROVIDER_NAME, PROVIDER_VERSION } from "./config.ts";
import { backgroundFailure, isRetryable, looksModerated, submissionError } from "./errors.ts";
import { LocalJobs, type Outcome } from "./local-jobs.ts";
import { findSpec, LIMITS } from "./models.ts";
import { videoPrice } from "./catalog.ts";
import { isBlackPng } from "./png.ts";
import { SetupPages } from "./setup.ts";
import { toTranscript, upstreamLanguage, type UpstreamTranscription } from "./transcript.ts";
import { CatalogSource } from "./upstream-catalog.ts";

export interface OpenRouterOptions {
  /** Default: `OPENROUTER_BASE_URL`, else https://openrouter.ai. */
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  keychain?: KeychainOptions;
  platform?: string;
  /** Background retries of a call OpenRouter did not take (429, in-flight budget). */
  retry?: { attempts?: number; maxDelayMs?: number };
  now?: () => number;
  /** The largest finished video downloaded. Default `LIMITS.videoOutputBytes`. */
  maxVideoBytes?: number;
}

/** OpenRouter's video job, `GET /api/v1/videos/{id}`. */
interface UpstreamVideo {
  id: string;
  status: string;
  error?: string;
  unsigned_urls?: string[];
  urls?: string[];
  usage?: { cost?: number | null };
}

interface UpstreamImages {
  data?: { b64_json?: string; media_type?: string }[];
  usage?: { cost?: number | null };
}

const VIDEO_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The provider definition and the parts tests reach into. */
export function buildProvider(options: OpenRouterOptions = {}): ProviderDefinition & { local: (ctx: ProviderContext) => LocalJobs; credentials: Credentials } {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl ?? baseUrlFromEnv(env);
  const credentials = new Credentials({ env, keychain: options.keychain, platform: options.platform });
  const client = new OpenRouterClient({ baseUrl, key: () => credentials.current(), fetch: options.fetch });
  const catalogs = new CatalogSource(client, options.now);
  const attempts = options.retry?.attempts ?? 3;
  const maxDelayMs = options.retry?.maxDelayMs ?? 30_000;
  // Signed download URLs are secrets (OpenRouter's documentation). The plugin never uses them; any seen
  // are still redacted from messages.
  const signedUrls: string[] = [];
  let localJobs: LocalJobs | undefined;
  const local = (ctx: ProviderContext) => (localJobs ??= new LocalJobs({ dir: path.join(ctx.dataDir, "openrouter-jobs"), now: options.now, log: ctx.log }));
  let dataDirSeen = "";
  const rejectKey = () => void (dataDirSeen && credentials.markRejected(dataDirSeen).catch(() => undefined));
  const setup = new SetupPages({ credentials, client, baseUrl, fetch: options.fetch, now: options.now });

  /** A call OpenRouter did not take is retried after `Retry-After` (capped), a few times. */
  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= attempts || !isRetryable(err)) throw err;
        const seconds = err instanceof UpstreamHttpError ? (err.retryAfter ?? 2) : 2;
        await sleep(Math.min(Math.max(seconds, 1) * 1000, maxDelayMs));
      }
    }
  }

  const definition: ProviderDefinition & { local: typeof local; credentials: Credentials } = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    version: PROVIDER_VERSION,
    repository: "https://github.com/cuelor/providers",
    capabilities: { generation: ["image", "video"], transcription: true, cancel: false, estimate: true, webhook: false, setup: true },
    billingUnit: "USD",
    local,
    credentials,
    // The largest slot: transcription audio, OpenRouter's documented 25 MB.
    maxUploadBytes: LIMITS.transcription.maxBytes,
    async account(ctx) {
      dataDirSeen = ctx.dataDir;
      return credentials.account(ctx.dataDir);
    },
    catalog: () => catalogs.catalog(),
    secrets: () => [credentials.current() ?? "", ...signedUrls].filter((s) => s.length >= 8),
    setup: async (ctx) => setup.create(ctx.port),
    extraRoutes: (req, res, url, ctx) => setup.handle(req, res, url, ctx),
    upstream: {
      async submit(ctx) {
        dataDirSeen = ctx.dataDir;
        const spec = findSpec(ctx.model.id);
        if (!spec) throw new Error(`model ${ctx.model.id} is not in the plugin's table`);
        if (spec.kind === "image") {
          const body = await imageBody(ctx);
          return { upstreamId: await local(ctx).start("image", ctx.clientReference, () => runImage(body, ctx), asUsage(await estimateFor(ctx))) };
        }
        if (spec.kind === "transcription") {
          const form = await transcriptionForm(ctx);
          return { upstreamId: await local(ctx).start("transcription", ctx.clientReference, () => runTranscription(form, ctx), asUsage(await estimateFor(ctx))) };
        }
        const body = await videoBody(ctx);
        let res: { body: { id?: unknown } };
        try {
          res = await client.json<{ id?: unknown }>("POST", "/api/v1/videos", { json: body, signal: ctx.signal, timeoutMs: 120_000 });
        } catch (err) {
          throw submissionError(err, rejectKey);
        }
        const id = res.body.id;
        // Accepted without an id: the job may exist upstream, so the result stays unknown.
        if (typeof id !== "string" || !VIDEO_ID.test(id)) throw new Error("OpenRouter accepted the video without a usable id");
        return { upstreamId: id };
      },
      async poll(upstreamId, ctx) {
        if (LocalJobs.isLocalId(upstreamId)) return local(ctx).state(upstreamId);
        return pollVideo(upstreamId);
      },
      // Only the plugin's own records can be searched: OpenRouter cannot find a video by a client field.
      lookup: (clientReference, ctx) => local(ctx).find(clientReference),
      estimate: (ctx) => estimateFor(ctx),
    },
  };

  async function estimateFor(ctx: EstimateContext): Promise<Estimate> {
    const pricing = ctx.route.pricing;
    if (!pricing) return { amount: 0, unit: "USD", basis: "estimate", note: "no price known" };
    const param = (name: string) => ctx.request.parameters[name] ?? ctx.model.parameters.find((p) => p.name === name)?.default;
    if (pricing.unit === "second") {
      const duration = Number(param("duration") ?? 0);
      // The request's own resolution, ratio and sound, priced from OpenRouter's SKUs when the list has them.
      const spec = findSpec(ctx.model.id);
      const up = spec?.kind === "video" ? (await catalogs.get().catch(() => undefined))?.lists.videos.find((m) => m.id === spec.id) : undefined;
      const perSecond =
        spec?.kind === "video" && up
          ? videoPrice(up, spec, { resolution: param("video_resolution") as string | undefined, ratio: param("ratio") as string | undefined, audio: param("audio") === true })
          : { perSecond: pricing.amount, note: pricing.note ?? "" };
      return { amount: round(perSecond.perSecond * duration), unit: "USD", basis: "estimate", note: `${duration} s at ${round(perSecond.perSecond)} USD/s; ${perSecond.note}` };
    }
    if (pricing.unit === "minute") {
      const ms = ctx.inputs[0]?.artifact.metadata?.duration_ms;
      const minutes = ms !== undefined ? ms / 60_000 : 1;
      return { amount: round(pricing.amount * minutes), unit: "USD", basis: "estimate", note: ms !== undefined ? "by the audio's duration" : "duration unknown; one minute assumed" };
    }
    return { amount: pricing.amount, unit: "USD", basis: "estimate", note: "one image" };
  }

  /**
   * The end of a background call that failed. OpenRouter does not charge a generation that failed
   * (its pricing documentation), so usage is 0; when the call may have run (`submission_unknown`) the
   * estimate is reported instead.
   */
  function failure(err: unknown, estimate: Usage | undefined): Outcome {
    const f = backgroundFailure(err, rejectKey);
    const usage = f.error.code === "submission_unknown" ? estimate : NO_CHARGE;
    return { ...f, ...(usage ? { usage } : {}) };
  }

  async function runImage(body: Record<string, unknown>, ctx: SubmitContext): Promise<Outcome> {
    let res: UpstreamImages;
    try {
      res = (await withRetry(() => client.json<UpstreamImages>("POST", "/api/v1/images", { json: body, timeoutMs: 5 * 60_000 }))).body;
    } catch (err) {
      return failure(err, estimated(ctx.route.pricing?.amount));
    }
    const usage = billed(res.usage?.cost) ?? estimated(ctx.route.pricing?.amount);
    const images = (res.data ?? []).filter((d) => typeof d.b64_json === "string" && d.b64_json.length > 0);
    const first = images[0];
    if (!first) return { status: "failed", error: { code: "upstream_failed", message: "OpenRouter reported success without an image" }, usage };
    const bytes = Buffer.from(first.b64_json!, "base64");
    const mediaType = sniffMediaType(bytes) ?? first.media_type ?? "application/octet-stream";
    const warnings: Warning[] = [];
    // v1: one output per job (v1.md section 3.5.3). The request asks for one; more are dropped and said so.
    if (images.length > 1) warnings.push({ code: "outputs_dropped", message: `OpenRouter returned ${images.length} images; only the first is kept` });
    if (mediaType === "image/png" && isBlackPng(bytes)) {
      return {
        status: "rejected",
        error: { code: "content_moderated", message: "the upstream returned an all-black image, which is how some models report a filtered output", params: { stage: "output", source: "upstream", inferred: true } },
        usage,
      };
    }
    return { status: "succeeded", output: { bytes, mediaType }, usage, warnings };
  }

  async function runTranscription(form: { data: FormData; timestamps: string; language?: string; durationMs?: number }, ctx: SubmitContext): Promise<Outcome> {
    let res: UpstreamTranscription;
    try {
      res = (await withRetry(() => client.json<UpstreamTranscription>("POST", "/api/v1/audio/transcriptions", { form: form.data, timeoutMs: 5 * 60_000 }))).body;
    } catch (err) {
      const minutes = form.durationMs !== undefined ? form.durationMs / 60_000 : undefined;
      return failure(err, estimated(minutes !== undefined && ctx.route.pricing ? ctx.route.pricing.amount * minutes : undefined));
    }
    const minutes = form.durationMs !== undefined ? form.durationMs / 60_000 : undefined;
    const usage = billed(res.usage?.cost) ?? estimated(minutes !== undefined && ctx.route.pricing ? ctx.route.pricing.amount * minutes : undefined);
    const transcript = toTranscript(res, { requestedLanguage: form.language, timestamps: form.timestamps, durationMs: form.durationMs, model: ctx.model.id });
    const hasUnits = transcript.segments.some((s) => (s.timed_text_units?.length ?? 0) > 0);
    if (form.timestamps === "word" && transcript.text !== "" && !hasUnits) {
      return { status: "failed", error: { code: "upstream_failed", reason: "no_word_timestamps", message: "OpenRouter returned no word timestamps for this model" }, usage };
    }
    return { status: "succeeded", output: { bytes: Buffer.from(JSON.stringify(transcript)), mediaType: TRANSCRIPT_MEDIA_TYPE }, usage };
  }

  async function pollVideo(id: string): Promise<UpstreamState> {
    if (!VIDEO_ID.test(id)) return { status: "failed", error: { code: "upstream_failed", message: "the upstream id is not valid" } };
    let v: UpstreamVideo;
    try {
      v = (await client.json<UpstreamVideo>("GET", `/api/v1/videos/${encodeURIComponent(id)}`, { timeoutMs: 15_000 })).body;
    } catch (err) {
      if (err instanceof UpstreamHttpError && err.effectiveStatus === 404) {
        return { status: "failed", error: { code: "upstream_failed", reason: "upstream_job_not_found", message: "OpenRouter no longer knows this video job" } };
      }
      if (err instanceof UpstreamHttpError && err.effectiveStatus === 401) rejectKey();
      throw err; // Try again on the next query.
    }
    for (const u of v.urls ?? []) if (typeof u === "string" && !signedUrls.includes(u)) signedUrls.push(u);
    signedUrls.splice(0, Math.max(0, signedUrls.length - 50));
    // Ended without a reported cost: a failed or cancelled video is not charged.
    const usage = billed(v.usage?.cost) ?? (["failed", "cancelled", "expired"].includes(v.status ?? "") ? NO_CHARGE : undefined);
    const withUsage = usage ? { usage } : {};
    switch (v.status) {
      case "pending":
        return { status: "queued" };
      case "in_progress":
        return { status: "running" };
      case "completed": {
        // Downloaded at once with the key (the content URL), never through the signed URLs.
        let download: { bytes: Uint8Array; contentType: string | undefined };
        try {
          download = await client.bytes(`/api/v1/videos/${encodeURIComponent(id)}/content?index=0`, { timeoutMs: 10 * 60_000, maxBytes: options.maxVideoBytes ?? LIMITS.videoOutputBytes });
        } catch (err) {
          if (err instanceof DownloadTooLargeError) {
            return { status: "failed", error: { code: "upstream_failed", reason: "output_too_large", message: `the finished video is larger than the plugin accepts (${err.maxBytes} bytes)` }, ...withUsage };
          }
          // Gone for good: the job cannot succeed. Anything else is retried on the next query.
          if (err instanceof UpstreamHttpError && (err.status === 404 || err.status === 410)) {
            return { status: "failed", error: { code: "upstream_failed", reason: "output_unavailable", message: "OpenRouter no longer has the finished video" }, ...withUsage };
          }
          throw err;
        }
        const { bytes, contentType } = download;
        const mediaType = sniffMediaType(bytes) ?? contentType?.split(";")[0]?.trim() ?? "video/mp4";
        const count = Math.max(v.unsigned_urls?.length ?? 1, v.urls?.length ?? 1);
        const warnings: Warning[] = count > 1 ? [{ code: "outputs_dropped", message: `OpenRouter returned ${count} videos; only the first is kept` }] : [];
        return { status: "succeeded", outputs: [{ mediaType, data: bytes }], ...withUsage, warnings };
      }
      case "failed": {
        const message = typeof v.error === "string" && v.error.trim() !== "" ? v.error : "OpenRouter reported that the video failed";
        if (looksModerated(message)) {
          // Only free text: the classification is inferred (v1.md section 3.10).
          return { status: "rejected", error: { code: "content_moderated", message, params: { stage: "input", source: "upstream", inferred: true } }, ...withUsage };
        }
        return { status: "failed", error: { code: "upstream_failed", message }, ...withUsage };
      }
      case "cancelled":
        return { status: "cancelled", error: { code: "cancelled", message: "the job was cancelled at OpenRouter" }, ...withUsage };
      case "expired":
        // The protocol's `expired` is an approval that ran out; this is the upstream giving up.
        return { status: "failed", error: { code: "timed_out", reason: "upstream_expired", message: "OpenRouter let the video job expire" }, ...withUsage };
      default:
        return { status: "running" };
    }
  }

  return definition;
}

/** `@image2` and the like become words; the inputs keep their order (v1.md section 3.6 rule 6). */
export function translatePrompt(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return undefined;
  return replacePromptReferences(prompt, (ref) => `${ref.kind} ${ref.index}`);
}

async function dataUrl(input: ResolvedInput): Promise<string> {
  return `data:${input.artifact.media_type};base64,${(await input.read()).toString("base64")}`;
}

async function imageBody(ctx: SubmitContext): Promise<Record<string, unknown>> {
  const p = withDefaults(ctx);
  const body: Record<string, unknown> = { model: ctx.model.id, prompt: translatePrompt(p.prompt), n: 1 };
  if (p.ratio !== undefined) body.aspect_ratio = p.ratio;
  if (p.resolution !== undefined) body.resolution = p.resolution;
  if (p.seed !== undefined) body.seed = p.seed;
  const refs = ctx.inputs.filter((i) => i.role === "reference");
  if (refs.length > 0) body.input_references = await Promise.all(refs.map(async (i) => ({ type: "image_url", image_url: { url: await dataUrl(i) } })));
  return body;
}

async function videoBody(ctx: SubmitContext): Promise<Record<string, unknown>> {
  const p = withDefaults(ctx);
  const body: Record<string, unknown> = { model: ctx.model.id, prompt: translatePrompt(p.prompt), duration: p.duration };
  if (p.ratio !== undefined) body.aspect_ratio = p.ratio;
  if (p.video_resolution !== undefined) body.resolution = p.video_resolution;
  if (p.audio !== undefined) body.generate_audio = p.audio === true;
  else body.generate_audio = false;
  if (ctx.route.id === "image2video" || ctx.route.id === "frames2video") {
    // Both routes take frames: first_frame (and last_frame), v1.md section 3.3.
    body.frame_images = await Promise.all(
      ctx.inputs.map(async (i) => ({ type: "image_url", image_url: { url: await dataUrl(i) }, frame_type: i.role === "last_frame" ? "last_frame" : "first_frame" })),
    );
  } else if (ctx.inputs.length > 0) {
    const type = (i: ResolvedInput) => (i.role === "video_track" ? "video_url" : i.role === "audio_track" ? "audio_url" : "image_url");
    body.input_references = await Promise.all(ctx.inputs.map(async (i) => ({ type: type(i), [type(i)]: { url: await dataUrl(i) } })));
  }
  return body;
}

async function transcriptionForm(ctx: SubmitContext): Promise<{ data: FormData; timestamps: string; language?: string; durationMs?: number }> {
  const p = withDefaults(ctx);
  const audio = ctx.inputs[0]!;
  const timestamps = String(p.timestamps ?? "none");
  const form = new FormData();
  form.append("model", ctx.model.id);
  const ext = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/flac": "flac", "audio/ogg": "ogg", "audio/webm": "webm" }[audio.artifact.media_type] ?? "bin";
  form.append("file", new Blob([new Uint8Array(await audio.read())], { type: audio.artifact.media_type }), `audio.${ext}`);
  form.append("response_format", timestamps === "none" ? "json" : "verbose_json");
  if (timestamps !== "none") form.append("timestamp_granularities[]", timestamps);
  const language = typeof p.language === "string" && p.language !== "auto" && p.language !== "" ? p.language : undefined;
  if (language) form.append("language", upstreamLanguage(language));
  return { data: form, timestamps, language, durationMs: audio.artifact.metadata?.duration_ms };
}

/** The request's parameters with the catalog's defaults filled in (the service applies them, v1.md 3.3). */
function withDefaults(ctx: SubmitContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of ctx.route.parameter_names) {
    const value = ctx.request.parameters[name] ?? ctx.model.parameters.find((p) => p.name === name)?.default;
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function billed(cost: unknown): Usage | undefined {
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { amount: cost, unit: "USD", basis: "billed" } : undefined;
}

const NO_CHARGE: Usage = { amount: 0, unit: "USD", basis: "estimate" };

function asUsage(e: Estimate): Usage | undefined {
  return e.amount > 0 ? { amount: e.amount, unit: e.unit, basis: "estimate" } : undefined;
}

function estimated(amount: number | undefined): Usage | undefined {
  return amount !== undefined && Number.isFinite(amount) ? { amount: round(amount), unit: "USD", basis: "estimate" } : undefined;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
