import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTimedUnits, normalizeTranscript, validateTranscript, type Transcript } from "../src/index.ts";

const good: Transcript = {
  schema_version: 1,
  language: "zh",
  unit: "character",
  text: "今天",
  segments: [{ text: "今天", timed_text_units: [{ text: "今", start_ms: 0, end_ms: 280 }, { text: "天", start_ms: 280, end_ms: 560 }] }],
};

test("a good transcript has no problems", () => {
  assert.deepEqual(validateTranscript(good, { durationMs: 600 }), []);
  assert.deepEqual(validateTranscript(good, { durationMs: 500 }), []); // 560 <= 500 + 60
});

test("transcript problems are found", () => {
  const paths = (t: unknown, d?: number) => validateTranscript(t, d === undefined ? {} : { durationMs: d }).map((p) => `${p.path}: ${p.message}`).join("\n");
  assert.match(paths({ ...good, schema_version: 2 }), /schema_version/);
  assert.match(paths({ ...good, unit: undefined }), /unit: is required/);
  assert.match(paths({ ...good, unit: "sentence" }), /unit/);
  assert.match(paths(good, 400), /more than 60 ms/);
  const overlap = structuredClone(good);
  overlap.segments[0]!.timed_text_units![1]!.start_ms = 200;
  assert.match(paths(overlap), /overlaps/);
  const backwards = structuredClone(good);
  backwards.segments[0]!.timed_text_units![0]!.end_ms = -1;
  assert.match(paths(backwards), /non-negative/);
  assert.match(paths("nope"), /object/);
  // unit is required (v1.md section 3.7.2); there is no option to leave it out.
  assert.match(validateTranscript({ ...good, unit: undefined }, { requireUnit: false } as never).map((p) => p.path).join(), /unit/);
});

test("normalisation fixes overlaps, drops punctuation and clamps to the duration", () => {
  const units = normalizeTimedUnits(
    [
      { text: "b", start_ms: 250.4, end_ms: 500 },
      { text: "a", start_ms: 0, end_ms: 300 },
      { text: "，", start_ms: 500, end_ms: 510 },
      { text: " ", start_ms: 510, end_ms: 520 },
      { text: "c", start_ms: 900, end_ms: 1200 },
    ],
    { durationMs: 1000 },
  );
  assert.deepEqual(units, [
    { text: "a", start_ms: 0, end_ms: 300 },
    { text: "b", start_ms: 300, end_ms: 500 },
    { text: "c", start_ms: 900, end_ms: 1000 },
  ]);
  const t = normalizeTranscript({ ...good, segments: [{ text: "x", timed_text_units: [{ text: "x", start_ms: 0, end_ms: 100 }] }, { text: "y", timed_text_units: [{ text: "y", start_ms: 50, end_ms: 120 }] }] });
  assert.deepEqual(validateTranscript(t), []);
});
