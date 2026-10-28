// Turns OpenRouter's transcription answer into the protocol's transcript (v1.md section 3.7.2).

import { normalizeTimedUnits, type TimedTextUnit, type Transcript, type TranscriptSegment } from "@cuelor/provider-sdk";

/** `POST /api/v1/audio/transcriptions` with `response_format` `json` or `verbose_json`. */
export interface UpstreamTranscription {
  text: string;
  language?: string;
  duration?: number;
  language_confidence?: number;
  segments?: { start: number; end: number; text: string; speaker?: string }[];
  words?: { word: string; start: number; end: number; type?: string }[];
  usage?: { cost?: number | null; seconds?: number };
}

// ISO 639-3 codes (ElevenLabs Scribe answers with them) and English names (Whisper's verbose_json) of
// languages that have an ISO 639-1 code, mapped to that code, which is their BCP 47 tag.
const LANGUAGES: [string, string, string][] = [
  ["en", "eng", "english"],
  ["zh", "zho", "chinese"],
  ["zh", "cmn", "mandarin"],
  ["zh", "yue", "cantonese"],
  ["ja", "jpn", "japanese"],
  ["ko", "kor", "korean"],
  ["fr", "fra", "french"],
  ["de", "deu", "german"],
  ["es", "spa", "spanish"],
  ["it", "ita", "italian"],
  ["pt", "por", "portuguese"],
  ["ru", "rus", "russian"],
  ["ar", "ara", "arabic"],
  ["hi", "hin", "hindi"],
  ["nl", "nld", "dutch"],
  ["pl", "pol", "polish"],
  ["tr", "tur", "turkish"],
  ["vi", "vie", "vietnamese"],
  ["th", "tha", "thai"],
  ["id", "ind", "indonesian"],
  ["uk", "ukr", "ukrainian"],
  ["sv", "swe", "swedish"],
  ["da", "dan", "danish"],
  ["fi", "fin", "finnish"],
  ["no", "nor", "norwegian"],
  ["cs", "ces", "czech"],
  ["el", "ell", "greek"],
  ["he", "heb", "hebrew"],
  ["hu", "hun", "hungarian"],
  ["ro", "ron", "romanian"],
  ["ms", "msa", "malay"],
  ["fa", "fas", "persian"],
];
const BY_NAME = new Map<string, string>();
for (const [tag, iso3, name] of LANGUAGES) {
  BY_NAME.set(iso3, tag);
  BY_NAME.set(name, tag);
}
// 639-2/B codes that differ from 639-3.
for (const [code, tag] of [["chi", "zh"], ["fre", "fr"], ["ger", "de"], ["dut", "nl"], ["cze", "cs"], ["gre", "el"], ["per", "fa"], ["may", "ms"], ["rum", "ro"]] as const) BY_NAME.set(code, tag);

/**
 * A language as BCP 47: ISO 639-3 and English names become the two-letter code where one exists;
 * tags that are already BCP 47 keep their form (`zh-Hans`, `pt-BR`). Unknown values give `undefined`.
 */
export function toBcp47(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const lower = v.toLowerCase();
  const known = BY_NAME.get(lower);
  if (known) return known;
  const m = /^([a-zA-Z]{2,3})((?:-[a-zA-Z0-9]{1,8})*)$/.exec(v);
  if (!m) return undefined;
  const primary = m[1]!.toLowerCase();
  const subtags = (m[2] ?? "")
    .split("-")
    .filter(Boolean)
    .map((s) => (s.length === 2 ? s.toUpperCase() : s.length === 4 ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s.toLowerCase()));
  const head = primary.length === 3 ? (BY_NAME.get(primary) ?? primary) : primary;
  return [head, ...subtags].join("-");
}

/** The primary subtag, which is what OpenRouter's `language` (ISO 639-1) takes. */
export function upstreamLanguage(language: string): string {
  return language.split("-")[0]!.toLowerCase();
}

const UNIT_PER_CHARACTER = new Set(["zh", "ja", "th", "lo", "km", "my"]);

/**
 * Builds the transcript. `timestamps` is what the request asked for; `word` puts the upstream's words
 * (without sound events) into the segments they belong to, with overlaps fixed and times in integer
 * milliseconds.
 */
export function toTranscript(up: UpstreamTranscription, o: { requestedLanguage?: string; timestamps: string; durationMs?: number; model: string }): Transcript {
  const language = o.requestedLanguage && o.requestedLanguage !== "auto" ? o.requestedLanguage : toBcp47(up.language);
  const text = (up.text ?? "").trim();
  const ms = (s: number) => Math.round(s * 1000);
  let units: TimedTextUnit[] = [];
  if (o.timestamps === "word") {
    const words = (up.words ?? []).filter((w) => w.type !== "audio_event" && typeof w.word === "string");
    units = normalizeTimedUnits(
      words.map((w) => ({ text: w.word, start_ms: ms(w.start), end_ms: ms(w.end) })),
      o.durationMs !== undefined ? { durationMs: o.durationMs } : {},
    );
  }
  const primary = language?.split("-")[0];
  const characters = primary !== undefined && UNIT_PER_CHARACTER.has(primary);
  const unit: Transcript["unit"] = !characters ? "word" : units.every((u) => [...u.text].length === 1) ? "character" : "token";

  let segments: TranscriptSegment[];
  const upstreamSegments = (up.segments ?? []).filter((s) => typeof s.text === "string" && s.text.trim() !== "");
  if (text === "") {
    segments = [];
  } else if (o.timestamps === "none") {
    segments = [{ text }];
  } else if (upstreamSegments.length === 0) {
    const first = units[0];
    const last = units[units.length - 1];
    segments = [first && last ? { text, start_ms: first.start_ms, end_ms: last.end_ms, timed_text_units: units } : { text }];
  } else {
    segments = upstreamSegments.map((s) => ({ text: s.text.trim(), start_ms: ms(s.start), end_ms: Math.max(ms(s.end), ms(s.start)), ...(s.speaker ? { speaker: s.speaker } : {}) }));
    if (o.timestamps === "word") {
      // Each unit goes to the last segment that starts at or before it.
      const buckets: TimedTextUnit[][] = segments.map(() => []);
      for (const u of units) {
        let i = 0;
        while (i + 1 < segments.length && segments[i + 1]!.start_ms! <= u.start_ms) i++;
        buckets[i]!.push(u);
      }
      segments = segments.map((s, i) => ({ ...s, timed_text_units: buckets[i] }));
    }
  }
  const transcript: Transcript = { schema_version: 1, unit, text, segments, provider: { name: o.model } };
  if (language) transcript.language = language;
  if (typeof up.language_confidence === "number") transcript.language_probability = up.language_confidence;
  return transcript;
}
