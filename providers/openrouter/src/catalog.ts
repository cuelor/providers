// Translates OpenRouter's model lists into the protocol's catalog (v1.md section 3.3).

import type { Catalog, Model, Parameter, Pricing, Route, Slot } from "@cuelor/provider-sdk";
import { LIMITS, MODEL_TABLE, type ImageModelSpec, type TranscriptionModelSpec, type VideoModelSpec } from "./models.ts";

/** One `supported_parameters` entry of `GET /api/v1/images/models`. */
export interface ParameterDescriptor {
  type?: string;
  values?: unknown[];
  min?: number;
  max?: number;
}

export interface UpstreamImageModel {
  id: string;
  name?: string;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Record<string, ParameterDescriptor>;
}

export interface UpstreamVideoModel {
  id: string;
  name?: string;
  supported_durations?: number[];
  supported_resolutions?: string[];
  supported_aspect_ratios?: string[];
  supported_sizes?: string[];
  generate_audio?: boolean;
  pricing_skus?: Record<string, string>;
}

export interface UpstreamModel {
  id: string;
  name?: string;
}

export interface UpstreamLists {
  images: UpstreamImageModel[];
  videos: UpstreamVideoModel[];
  transcription: UpstreamModel[];
}

export const REFERENCE_NOTE =
  "Prompt references such as @image2 are sent to OpenRouter as the words \"image 2\"; the inputs are sent in position order.";

const PROMPT: Parameter = { name: "prompt", kind: "text", required: true, label: "Prompt" };
const SEED: Parameter = { name: "seed", kind: "integer", min: 0, max: 2147483647, step: 1, label: "Seed" };

/** Builds the catalog: the models of the table that the upstream lists. */
export function buildCatalog(lists: UpstreamLists): Catalog {
  const models: Model[] = [];
  for (const spec of MODEL_TABLE) {
    if (spec.kind === "image") {
      const up = lists.images.find((m) => m.id === spec.id);
      if (up) models.push(imageModel(spec, up));
    } else if (spec.kind === "video") {
      const up = lists.videos.find((m) => m.id === spec.id);
      if (up) {
        const model = videoModel(spec, up);
        if (model) models.push(model);
      }
    } else {
      const up = lists.transcription.find((m) => m.id === spec.id);
      if (up) models.push(transcriptionModel(spec));
    }
  }
  return { models };
}

export function enumParameter(name: string, label: string, values: string[], preferred: string[]): Parameter | undefined {
  const unique = [...new Set(values.filter((v) => typeof v === "string" && v !== ""))];
  if (unique.length === 0) return undefined;
  const fallback = unique[0]!;
  return { name, kind: "enum", enum_values: unique, default: preferred.find((p) => unique.includes(p)) ?? fallback, label };
}

function enumValues(d: ParameterDescriptor | undefined): string[] {
  return d?.type === "enum" && Array.isArray(d.values) ? d.values.filter((v): v is string => typeof v === "string") : [];
}

function imageSlot(min: number, max: number, id = "reference", role = "reference"): Slot {
  return { id, role, modality: "image", min_artifacts: min, max_artifacts: max, media_types: [...LIMITS.image.mediaTypes], max_bytes: LIMITS.image.maxBytes };
}

function imageModel(spec: ImageModelSpec, up: UpstreamImageModel): Model {
  const sp = up.supported_parameters ?? {};
  const parameters: Parameter[] = [PROMPT];
  const ratio = enumParameter("ratio", "Aspect ratio", enumValues(sp.aspect_ratio).filter((v) => v !== "auto"), ["1:1"]);
  if (ratio) parameters.push(ratio);
  // Lowest first, as for video; values below the table's minimum are refused by the model.
  const floor = spec.minResolution ? rank(spec.minResolution) : -1;
  const resolutions = enumValues(sp.resolution).filter((r) => rank(r) >= floor).sort((a, b) => rank(a) - rank(b));
  const resolution = enumParameter("resolution", "Resolution", resolutions, []);
  if (resolution) parameters.push(resolution);
  if (sp.seed) parameters.push(SEED);
  const names = parameters.map((p) => p.name);
  const pricing: Pricing = { basis: "estimate", unit: "image", amount: spec.pricePerImage, currency: "USD", note: "plugin's price table; OpenRouter bills the model's list price" };
  const routes: Route[] = [
    { id: "text2image", label: "Text to image", input: { slots: [], max_total_artifacts: 0 }, parameter_names: names, output: { media_types: [...LIMITS.image.mediaTypes] }, pricing },
  ];
  // The upstream's own limit when it gives one, else the table's.
  const refs = sp.input_references?.type === "range" && typeof sp.input_references.max === "number" ? Math.floor(sp.input_references.max) : spec.maxReferences;
  const takesImages = up.architecture?.input_modalities ? up.architecture.input_modalities.includes("image") : true;
  if (refs > 0 && takesImages) {
    routes.push({
      id: "image2image",
      label: "Image to image",
      description: REFERENCE_NOTE,
      input: { modality: "image", slots: [imageSlot(1, refs)], max_total_artifacts: refs },
      parameter_names: names,
      output: { media_types: [...LIMITS.image.mediaTypes] },
      pricing,
    });
  }
  return { id: spec.id, label: up.name ?? spec.label, provider: spec.maker, description: up.description, available: true, output: { modality: "image" }, parameters, routes };
}

const RESOLUTION_ORDER = ["360p", "480p", "720p", "768p", "1080p", "1K", "2K", "4K"];

/**
 * `duration` as the protocol's range when the upstream's durations are evenly spaced, else as an integer
 * parameter that lists its values in `enum_values` (v1.md section 3.3).
 */
export function durationParameter(durations: number[]): Parameter | undefined {
  const values = [...new Set(durations.filter((d) => Number.isInteger(d) && d > 0))].sort((a, b) => a - b);
  if (values.length === 0) return undefined;
  const base: Parameter = { name: "duration", kind: "integer", default: values[0], unit: "s", label: "Duration" };
  if (values.length === 1) return { ...base, min: values[0], max: values[0], step: 1 };
  const step = values[1]! - values[0]!;
  if (values.every((v, i) => v === values[0]! + i * step)) return { ...base, min: values[0], max: values[values.length - 1], step, widget: "slider" };
  return { ...base, enum_values: values };
}

/** What a video request asks for, as far as the price depends on it. */
export interface VideoChoice {
  resolution?: string;
  ratio?: string;
  audio?: boolean;
}

/**
 * USD per second of video from OpenRouter's `pricing_skus`, which come in three shapes: `per-video-second`;
 * per second by sound (`duration_seconds_with_audio`, `…_without_audio`, `…_4k`, as for Veo); or per video
 * token (`video_tokens`, `video_tokens_1080p`, … as for Seedance), where one second at W×H is
 * W×H×24/1024 tokens. Otherwise the table's price. Prices with a video input are not modelled.
 */
export function videoPrice(up: UpstreamVideoModel, spec: VideoModelSpec, choice: VideoChoice): { perSecond: number; note: string } {
  const skus = up.pricing_skus ?? {};
  const sku = (...names: string[]) => names.map((n) => Number(skus[n])).find((v) => Number.isFinite(v) && v > 0);
  const res = (choice.resolution ?? "").toLowerCase();
  const listed = sku("per-video-second");
  if (listed !== undefined) return { perSecond: listed, note: "OpenRouter's per-second price" };
  const sound = choice.audio ? "with_audio" : "without_audio";
  const bySecond = sku(...(res === "4k" ? [`duration_seconds_${sound}_4k`] : []), `duration_seconds_${sound}`);
  if (bySecond !== undefined) return { perSecond: bySecond, note: `OpenRouter's per-second price ${choice.audio ? "with" : "without"} sound` };
  const perToken = sku(...(res ? [`video_tokens_${res}${choice.audio ? "" : "_without_audio"}`, `video_tokens_${res}`] : []), ...(choice.audio ? [] : ["video_tokens_without_audio"]), "video_tokens");
  const size = videoSize(choice.resolution, choice.ratio, up.supported_sizes ?? []);
  if (perToken !== undefined && size) {
    return { perSecond: (size.width * size.height * 24 * perToken) / 1024, note: `OpenRouter's video-token price at ${size.width}x${size.height}, 24 frames per second (an estimate)` };
  }
  return { perSecond: spec.pricePerSecond, note: "plugin's price table" };
}

const SHORT_SIDE: Record<string, number> = { "360p": 360, "480p": 480, "720p": 720, "768p": 768, "1080p": 1080, "1k": 1024, "2k": 1440, "4k": 2160 };

/** The frame size for a resolution and ratio: from the upstream's `supported_sizes` when one fits. */
export function videoSize(resolution: string | undefined, ratio: string | undefined, sizes: string[]): { width: number; height: number } | undefined {
  const short = resolution ? SHORT_SIDE[resolution.toLowerCase()] : undefined;
  if (!short) return undefined;
  const [a, b] = (ratio ?? "16:9").split(":").map(Number);
  const target = a && b ? a / b : 16 / 9;
  for (const s of sizes) {
    const [w, h] = s.split("x").map(Number);
    if (w && h && Math.min(w, h) === short && Math.abs(w / h - target) < 0.03) return { width: w, height: h };
  }
  const long = Math.round(short * Math.max(target, 1 / target));
  return target >= 1 ? { width: long, height: short } : { width: short, height: long };
}

function videoModel(spec: VideoModelSpec, up: UpstreamVideoModel): Model | undefined {
  const duration = durationParameter(up.supported_durations ?? []);
  if (!duration) return undefined; // Without durations the request cannot be priced or checked.
  const parameters: Parameter[] = [PROMPT, duration];
  const ratio = enumParameter("ratio", "Aspect ratio", up.supported_aspect_ratios ?? [], ["16:9"]);
  if (ratio) parameters.push(ratio);
  const resolutions = [...(up.supported_resolutions ?? [])].sort((a, b) => rank(a) - rank(b));
  // The lowest resolution is the default: it is the cheapest.
  const resolution = enumParameter("video_resolution", "Resolution", resolutions, []);
  if (resolution) parameters.push(resolution);
  if (up.generate_audio) parameters.push({ name: "audio", kind: "boolean", default: false, label: "Sound" });
  const names = parameters.map((p) => p.name);
  const output: Route["output"] = { media_types: ["video/mp4"], audio: up.generate_audio ? "optional" : "none" };
  // The hint is the price at the defaults; POST /v1/estimates prices the request's own choices.
  const price = videoPrice(up, spec, { resolution: resolution?.default as string | undefined, ratio: ratio?.default as string | undefined, audio: false });
  const pricing: Pricing = {
    basis: "estimate",
    unit: "second",
    amount: Math.round(price.perSecond * 10_000) / 10_000,
    currency: "USD",
    note: `${price.note}, at the default resolution${up.generate_audio ? " without sound" : ""}`,
  };
  const route = (id: string, label: string, slots: Slot[], description?: string): Route => ({
    id,
    label,
    ...(description ? { description } : {}),
    input: { ...(slots.length > 0 ? { modality: new Set(slots.map((s) => s.modality)).size > 1 ? "mixed" : slots[0]!.modality } : {}), slots, max_total_artifacts: slots.reduce((n, s) => n + s.max_artifacts, 0) },
    parameter_names: names,
    output,
    pricing,
  });
  const routes: Route[] = [route("text2video", "Text to video", [])];
  if (spec.firstFrame) {
    routes.push(route("image2video", "Image to video", [imageSlot(1, 1, "first_frame", "first_frame")], "The image is the first frame of the video (OpenRouter frame_images, first_frame)."));
  }
  if (spec.firstFrame && spec.lastFrame) {
    routes.push(
      route("frames2video", "First and last frame", [imageSlot(1, 1, "first_frame", "first_frame"), imageSlot(1, 1, "last_frame", "last_frame")], "OpenRouter frame_images: first_frame and last_frame."),
    );
  }
  if (spec.referenceImages > 0) {
    const slots: Slot[] = [imageSlot(0, spec.referenceImages)];
    if (spec.referenceVideos > 0) {
      slots.push({ id: "video_track", role: "video_track", modality: "video", min_artifacts: 0, max_artifacts: spec.referenceVideos, media_types: [...LIMITS.video.mediaTypes], max_bytes: LIMITS.video.maxBytes, max_duration_ms: LIMITS.video.maxDurationMs });
    }
    if (spec.referenceAudios > 0) {
      slots.push({ id: "audio_track", role: "audio_track", modality: "audio", min_artifacts: 0, max_artifacts: spec.referenceAudios, media_types: [...LIMITS.audio.mediaTypes], max_bytes: LIMITS.audio.maxBytes, max_duration_ms: LIMITS.audio.maxDurationMs });
    }
    routes.push(route("multimodal2video", "References to video", slots, `Inputs are OpenRouter input_references, which guide the video but are not exact frames. ${REFERENCE_NOTE}`));
  }
  return { id: spec.id, label: up.name ?? spec.label, provider: spec.maker, available: true, output: { modality: "video" }, parameters, routes };
}

function rank(resolution: string): number {
  const i = RESOLUTION_ORDER.indexOf(resolution);
  return i < 0 ? RESOLUTION_ORDER.length : i;
}

function transcriptionModel(spec: TranscriptionModelSpec): Model {
  const timestamps: Parameter = {
    name: "timestamps",
    kind: "enum",
    enum_values: [...spec.timestamps],
    // The protocol's default is word (v1.md section 3.7.1); a model without words defaults to what it has.
    default: spec.timestamps.includes("word") ? "word" : spec.timestamps[spec.timestamps.length - 1],
    label: "Timestamps",
  };
  return {
    id: spec.id,
    label: spec.label,
    provider: spec.maker,
    available: true,
    output: { modality: "text" },
    parameters: [{ name: "language", kind: "string", default: "auto", label: "Language" }, timestamps],
    routes: [
      {
        id: "audio2text",
        label: "Speech to text",
        input: {
          modality: "audio",
          slots: [{ id: "audio", role: "audio", modality: "audio", min_artifacts: 1, max_artifacts: 1, media_types: [...LIMITS.transcription.mediaTypes], max_bytes: LIMITS.transcription.maxBytes }],
          max_total_artifacts: 1,
        },
        parameter_names: ["language", "timestamps"],
        output: { media_types: ["application/vnd.cuelor.transcript+json"] },
        pricing: { basis: "estimate", unit: "minute", amount: spec.pricePerMinute, currency: "USD", note: "plugin's price table" },
      },
    ],
  };
}
