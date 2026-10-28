// The plugin's own table of the models it offers. OpenRouter's model lists say which models exist now
// and some of their parameters, but not everything the protocol's catalog needs: the video list has no
// reference inputs or their limits, and no list says which recognisers return word timestamps. Those
// facts live here. A model is offered only when it is both in this table and in the upstream's list
// (VALIDATION.md, "Catalog").
//
// Limits marked "conservative" are not documented by OpenRouter; they are set low on purpose.
//
// Checked against OpenRouter's lists on 2026-10-28: Seedream 4.5 lists `1K` but refuses it ("requires
// at least 3,686,400 output pixels"), hence `minResolution`.

export interface ImageModelSpec {
  kind: "image";
  id: string;
  label: string;
  maker: string;
  /** Reference images accepted, used when the upstream list does not say. */
  maxReferences: number;
  /** USD per image, for the price hint and estimates. */
  pricePerImage: number;
  /** The lowest `resolution` the model takes, when the upstream list offers lower ones it refuses. */
  minResolution?: string;
}

export interface VideoModelSpec {
  kind: "video";
  id: string;
  label: string;
  maker: string;
  /** `frame_images` with `first_frame` (route image2video) and `last_frame` (route frames2video). */
  firstFrame: boolean;
  lastFrame: boolean;
  /** `input_references` by type (route multimodal2video). Only Seedance 2.0 and later honour audio and video. */
  referenceImages: number;
  referenceVideos: number;
  referenceAudios: number;
  /** USD per second, used when the upstream list has no price the plugin can read (catalog.ts, videoPrice). */
  pricePerSecond: number;
}

export type Timestamps = "none" | "segment" | "word";

export interface TranscriptionModelSpec {
  kind: "transcription";
  id: string;
  label: string;
  maker: string;
  /** What `timestamps` may be. OpenRouter has no flag for it; requesting words from a model without them is a 400. */
  timestamps: Timestamps[];
  /** USD per minute of audio. */
  pricePerMinute: number;
}

export type ModelSpec = ImageModelSpec | VideoModelSpec | TranscriptionModelSpec;

export const MODEL_TABLE: readonly ModelSpec[] = [
  { kind: "image", id: "bytedance-seed/seedream-4.5", label: "Seedream 4.5", maker: "ByteDance", maxReferences: 4, pricePerImage: 0.04, minResolution: "2K" },
  { kind: "image", id: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", maker: "Google", maxReferences: 3, pricePerImage: 0.04 },
  {
    kind: "video",
    id: "bytedance/seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    maker: "ByteDance",
    firstFrame: true,
    lastFrame: true,
    referenceImages: 9,
    referenceVideos: 3,
    referenceAudios: 3,
    pricePerSecond: 0.045,
  },
  {
    kind: "video",
    id: "bytedance/seedance-2.0",
    label: "Seedance 2.0",
    maker: "ByteDance",
    firstFrame: true,
    lastFrame: true,
    referenceImages: 9,
    referenceVideos: 3,
    referenceAudios: 3,
    pricePerSecond: 0.07,
  },
  {
    kind: "video",
    id: "google/veo-3.1",
    label: "Veo 3.1",
    maker: "Google",
    firstFrame: true,
    lastFrame: true,
    referenceImages: 3,
    referenceVideos: 0,
    referenceAudios: 0,
    pricePerSecond: 0.2,
  },
  // Removed from OpenRouter on 2026-09-24. Kept to show that a model missing upstream is not offered.
  {
    kind: "video",
    id: "openai/sora-2-pro",
    label: "Sora 2 Pro",
    maker: "OpenAI",
    firstFrame: true,
    lastFrame: false,
    referenceImages: 0,
    referenceVideos: 0,
    referenceAudios: 0,
    pricePerSecond: 0.5,
  },
  { kind: "transcription", id: "openai/whisper-1", label: "Whisper", maker: "OpenAI", timestamps: ["none", "segment", "word"], pricePerMinute: 0.006 },
  { kind: "transcription", id: "openai/gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe", maker: "OpenAI", timestamps: ["none"], pricePerMinute: 0.003 },
  { kind: "transcription", id: "elevenlabs/scribe-v2", label: "Scribe v2", maker: "ElevenLabs", timestamps: ["none", "word"], pricePerMinute: 0.0037 },
];

/** Accepted inputs. OpenRouter documents only the 25 MB limit of transcription uploads; the others are conservative. */
export const LIMITS = {
  /** The largest finished video the plugin downloads (held in memory once; the SDK stores it). */
  videoOutputBytes: 512 * 1024 * 1024,
  image: { mediaTypes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 10 * 1024 * 1024 },
  video: { mediaTypes: ["video/mp4"], maxBytes: 20 * 1024 * 1024, maxDurationMs: 15_000 },
  audio: { mediaTypes: ["audio/mpeg", "audio/wav"], maxBytes: 15 * 1024 * 1024, maxDurationMs: 15_000 },
  transcription: {
    mediaTypes: ["audio/wav", "audio/mpeg", "audio/mp4", "audio/flac", "audio/ogg", "audio/webm"],
    maxBytes: 25 * 1024 * 1024,
  },
} as const;

export function findSpec(id: string): ModelSpec | undefined {
  return MODEL_TABLE.find((m) => m.id === id);
}
