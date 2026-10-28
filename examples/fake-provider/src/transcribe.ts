import { parseWav, type TimedTextUnit, type Transcript } from "@cuelor/provider-sdk";

/** The known text a sample WAV carries in its RIFF LIST/INFO/ICMT chunk. */
export interface EmbeddedText {
  language: string;
  text: string;
}

export function embeddedText(wav: Uint8Array): EmbeddedText | undefined {
  const info = parseWav(wav)?.info.ICMT;
  if (!info) return undefined;
  try {
    const value = JSON.parse(info) as Partial<EmbeddedText>;
    if (typeof value.text === "string" && typeof value.language === "string") return { language: value.language, text: value.text };
  } catch {
    // Not one of our samples.
  }
  return undefined;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PUNCTUATION = /^[\s\p{P}\p{S}]+$/u;

/** Splits text into recognition units: characters for CJK text, words otherwise. */
export function splitUnits(text: string): { unit: "word" | "character"; units: string[] } {
  if (CJK.test(text)) {
    return { unit: "character", units: [...text].filter((c) => !PUNCTUATION.test(c)) };
  }
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""))
    .filter((w) => w.length > 0);
  return { unit: "word", units: words };
}

/**
 * What the fake recogniser "hears": the embedded text spread evenly over 5 %..95 % of the audio, or an
 * empty transcript for audio it does not know.
 */
export function fakeTranscript(
  wav: Uint8Array,
  options: { language?: string; timestamps?: string },
): Transcript {
  const durationMs = parseWav(wav)?.durationMs ?? 0;
  const known = embeddedText(wav);
  const requested = options.language && options.language !== "auto" ? options.language : undefined;
  const language = requested ?? known?.language ?? "en";
  const text = known?.text ?? "";
  const { unit, units } = splitUnits(text);
  const timestamps = options.timestamps ?? "word";

  const start = Math.round(durationMs * 0.05);
  const end = Math.round(durationMs * 0.95);
  const slot = units.length > 0 ? (end - start) / units.length : 0;
  const timed: TimedTextUnit[] = units.map((u, i) => ({
    text: u,
    start_ms: Math.round(start + i * slot),
    end_ms: Math.round(start + i * slot + slot * 0.9),
  }));

  const transcript: Transcript = {
    schema_version: 1,
    language,
    language_probability: requested ? 1 : 0.99,
    unit,
    text,
    segments: [],
    provider: { name: "fake-asr" },
  };
  if (text.length > 0) {
    if (timestamps === "none") transcript.segments = [{ text }];
    else if (timestamps === "segment") transcript.segments = [{ text, start_ms: start, end_ms: end }];
    else transcript.segments = [{ text, start_ms: start, end_ms: end, timed_text_units: timed }];
  }
  return transcript;
}
