import type { TimedTextUnit, Transcript } from "./types.ts";

/** How far a unit may end after the end of the audio (v1.md section 3.7.2). */
export const TRANSCRIPT_END_TOLERANCE_MS = 60;

export interface TranscriptProblem {
  path: string;
  message: string;
}

/**
 * Checks a transcript against v1.md section 3.7.2: `schema_version` 1, `text`, `segments` and `unit`
 * present, `unit` one of word/character/token, units
 * with integer times, ordered, not overlapping, `start_ms <= end_ms`, and ending at most 60 ms after
 * `durationMs` when it is given. Returns the problems found.
 */
export function validateTranscript(
  value: unknown,
  options: { durationMs?: number } = {},
): TranscriptProblem[] {
  const problems: TranscriptProblem[] = [];
  const t = value as Partial<Transcript> | null;
  if (!t || typeof t !== "object" || Array.isArray(t)) return [{ path: "", message: "transcript must be an object" }];
  if (t.schema_version !== 1) problems.push({ path: "schema_version", message: "must be 1" });
  if (typeof t.text !== "string") problems.push({ path: "text", message: "must be a string" });
  if (t.unit === undefined) {
    problems.push({ path: "unit", message: "is required" });
  } else if (!["word", "character", "token"].includes(t.unit)) {
    problems.push({ path: "unit", message: "must be word, character or token" });
  }
  if (t.language !== undefined && (typeof t.language !== "string" || !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(t.language))) {
    problems.push({ path: "language", message: "must be a BCP 47 tag" });
  }
  if (!Array.isArray(t.segments)) {
    problems.push({ path: "segments", message: "must be an array" });
    return problems;
  }
  let previousEnd = -Infinity;
  t.segments.forEach((segment, si) => {
    const sp = `segments[${si}]`;
    if (!segment || typeof segment.text !== "string") problems.push({ path: `${sp}.text`, message: "must be a string" });
    for (const key of ["start_ms", "end_ms"] as const) {
      const v = segment?.[key];
      if (v !== undefined && !(Number.isInteger(v) && v >= 0)) problems.push({ path: `${sp}.${key}`, message: "must be a non-negative integer" });
    }
    (segment?.timed_text_units ?? []).forEach((unit, ui) => {
      const up = `${sp}.timed_text_units[${ui}]`;
      if (typeof unit.text !== "string") problems.push({ path: `${up}.text`, message: "must be a string" });
      if (!Number.isInteger(unit.start_ms) || unit.start_ms < 0 || !Number.isInteger(unit.end_ms) || unit.end_ms < 0) {
        problems.push({ path: up, message: "start_ms and end_ms must be non-negative integers" });
        return;
      }
      if (unit.start_ms > unit.end_ms) problems.push({ path: up, message: "start_ms is after end_ms" });
      if (unit.start_ms < previousEnd) problems.push({ path: up, message: "overlaps or precedes the previous unit" });
      if (options.durationMs !== undefined && unit.end_ms > options.durationMs + TRANSCRIPT_END_TOLERANCE_MS) {
        problems.push({ path: up, message: `ends at ${unit.end_ms} ms, more than ${TRANSCRIPT_END_TOLERANCE_MS} ms after the audio (${options.durationMs} ms)` });
      }
      previousEnd = Math.max(previousEnd, unit.end_ms);
    });
  });
  return problems;
}

const NOT_A_WORD = /^[\s\p{P}\p{S}]*$/u;

/**
 * Fixes upstream units the way v1.md section 3.7.2 asks: rounds times to integers, drops units that are
 * only spaces, punctuation or symbols, sorts by start, moves a start that overlaps the previous unit to
 * that unit's end, and clamps ends to `durationMs` when given.
 */
export function normalizeTimedUnits(units: readonly TimedTextUnit[], options: { durationMs?: number } = {}): TimedTextUnit[] {
  const cleaned = units
    .map((u) => ({ text: u.text.trim(), start_ms: Math.max(0, Math.round(u.start_ms)), end_ms: Math.max(0, Math.round(u.end_ms)) }))
    .filter((u) => u.text.length > 0 && !NOT_A_WORD.test(u.text))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
  const out: TimedTextUnit[] = [];
  let previousEnd = 0;
  for (const u of cleaned) {
    let start = Math.max(u.start_ms, previousEnd);
    let end = Math.max(u.end_ms, start);
    if (options.durationMs !== undefined) {
      end = Math.min(end, options.durationMs);
      start = Math.min(start, end);
    }
    out.push({ text: u.text, start_ms: start, end_ms: end });
    previousEnd = end;
  }
  return out;
}

/** Applies `normalizeTimedUnits` to every segment and keeps segment bounds consistent. */
export function normalizeTranscript(t: Transcript, options: { durationMs?: number } = {}): Transcript {
  let previousEnd = 0;
  const segments = t.segments.map((s) => {
    if (!s.timed_text_units) return s;
    const units = normalizeTimedUnits(s.timed_text_units, options).map((u) => {
      const start = Math.max(u.start_ms, previousEnd);
      const unit = { text: u.text, start_ms: start, end_ms: Math.max(u.end_ms, start) };
      previousEnd = unit.end_ms;
      return unit;
    });
    return { ...s, timed_text_units: units };
  });
  return { ...t, segments };
}
