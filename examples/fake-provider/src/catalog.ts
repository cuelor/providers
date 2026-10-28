import type { Catalog, Pricing } from "@cuelor/provider-sdk";

const FREE: Pricing = { basis: "exact", unit: "job", amount: 0, currency: "USD", note: "fake upstream; no cost" };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** The catalog of the fake upstream. */
export const CATALOG: Catalog = {
  models: [
    {
      id: "example/fake-image",
      label: "Fake Image",
      provider: "Example",
      description: "Returns a solid-colour PNG derived from the prompt. Prompt references are removed before the fake upstream sees the prompt.",
      available: true,
      output: { modality: "image" },
      parameters: [
        { name: "prompt", kind: "text", required: true, max_length: 2000, label: "Prompt" },
        { name: "ratio", kind: "enum", default: "1:1", enum_values: ["1:1", "16:9", "9:16"], label: "Aspect ratio" },
        { name: "seed", kind: "integer", min: 0, max: 2147483647, step: 1, label: "Seed", visible_when: { name: "ratio", equals: "1:1" } },
      ],
      routes: [
        {
          id: "text2image",
          label: "Text to image",
          input: { slots: [], max_total_artifacts: 0 },
          parameter_names: ["prompt", "ratio", "seed"],
          output: { media_types: ["image/png"] },
          pricing: FREE,
        },
        {
          id: "image2image",
          label: "Image to image",
          input: {
            modality: "image",
            slots: [
              { id: "reference", role: "reference", modality: "image", min_artifacts: 1, max_artifacts: 4, media_types: IMAGE_TYPES, max_bytes: 10 * 1024 * 1024 },
            ],
            max_total_artifacts: 4,
          },
          parameter_names: ["prompt", "ratio", "seed"],
          output: { media_types: ["image/png"] },
          pricing: FREE,
        },
      ],
    },
    {
      id: "example/fake-video",
      label: "Fake Video",
      provider: "Example",
      description: "Returns the same one-second clip for every request. Prompt references are removed before the fake upstream sees the prompt.",
      available: true,
      output: { modality: "video" },
      parameters: [
        { name: "prompt", kind: "text", required: true, max_length: 2000, label: "Prompt" },
        { name: "duration", kind: "integer", default: 1, min: 1, max: 5, step: 1, unit: "s", label: "Duration", widget: "slider" },
        { name: "ratio", kind: "enum", default: "16:9", enum_values: ["16:9", "9:16", "1:1"], label: "Aspect ratio" },
      ],
      // The fake upstream itself accepts every combination; the rule is for the client.
      parameter_rules: [{ when_name: "ratio", when_values: ["9:16"], reject_name: "duration", reject_values: ["5"], message: "5 s is not available in 9:16" }],
      routes: [
        {
          id: "text2video",
          label: "Text to video",
          input: { slots: [], max_total_artifacts: 0 },
          parameter_names: ["prompt", "duration", "ratio"],
          output: { media_types: ["video/mp4"], audio: "none" },
          pricing: FREE,
        },
        {
          id: "image2video",
          label: "Image to video",
          input: {
            modality: "image",
            slots: [
              { id: "first_frame", role: "first_frame", modality: "image", min_artifacts: 1, max_artifacts: 1, media_types: IMAGE_TYPES, max_bytes: 10 * 1024 * 1024 },
            ],
            max_total_artifacts: 1,
          },
          parameter_names: ["prompt", "duration", "ratio"],
          output: { media_types: ["video/mp4"], audio: "none" },
          pricing: FREE,
        },
        {
          id: "multimodal2video",
          label: "Multimodal to video",
          input: {
            modality: "mixed",
            slots: [
              { id: "reference", role: "reference", modality: "image", min_artifacts: 0, max_artifacts: 4, media_types: IMAGE_TYPES, max_bytes: 10 * 1024 * 1024 },
              { id: "video_track", role: "video_track", modality: "video", min_artifacts: 0, max_artifacts: 2, media_types: ["video/mp4"], max_bytes: 20 * 1024 * 1024, max_duration_ms: 15000 },
              { id: "audio_track", role: "audio_track", modality: "audio", min_artifacts: 0, max_artifacts: 2, media_types: ["audio/wav", "audio/mpeg"], max_bytes: 20 * 1024 * 1024 },
            ],
            max_total_artifacts: 6,
          },
          parameter_names: ["prompt", "duration", "ratio"],
          output: { media_types: ["video/mp4"], audio: "none" },
          pricing: FREE,
        },
      ],
    },
    {
      id: "example/fake-asr",
      label: "Fake Speech Recognition",
      provider: "Example",
      description: "Returns the text stored in the WAV file's LIST/INFO comment, spread evenly over its duration.",
      available: true,
      output: { modality: "text" },
      parameters: [
        { name: "language", kind: "string", default: "auto", label: "Language" },
        { name: "timestamps", kind: "enum", default: "word", enum_values: ["none", "segment", "word"], label: "Timestamps" },
      ],
      routes: [
        {
          id: "audio2text",
          label: "Speech to text",
          input: {
            modality: "audio",
            slots: [
              { id: "audio", role: "audio", modality: "audio", min_artifacts: 1, max_artifacts: 1, media_types: ["audio/wav", "audio/mpeg"], max_bytes: 25 * 1024 * 1024, max_duration_ms: 600000 },
            ],
            max_total_artifacts: 1,
          },
          parameter_names: ["language", "timestamps"],
          output: { media_types: ["application/vnd.cuelor.transcript+json"] },
          pricing: FREE,
        },
      ],
    },
  ],
};
