import { invalidRequest } from "./errors.ts";
import { topLevelType } from "./media.ts";
import type { InputRef } from "./types.ts";

export type ReferenceKind = "image" | "video" | "audio";

export interface PromptReference {
  /** The reference as written, for example `@image2`. */
  text: string;
  kind: ReferenceKind;
  /** 1-based number within the media type. */
  index: number;
  /** Offset of `@` in the prompt (UTF-16 code units). */
  start: number;
  end: number;
}

// The digits are greedy, so a match is never followed by another digit (v1.md section 3.6 rule 3).
const REFERENCE = /@(image|video|audio)([1-9][0-9]*)/g;

/** Finds every input reference in a prompt. Every other `@` is plain text. */
export function parsePromptReferences(prompt: string): PromptReference[] {
  const out: PromptReference[] = [];
  for (const m of prompt.matchAll(REFERENCE)) {
    out.push({
      text: m[0],
      kind: m[1] as ReferenceKind,
      index: Number(m[2]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

export interface NumberedInput<T extends InputRef = InputRef> {
  input: T;
  kind: string;
  /** 1-based number within `kind`. */
  index: number;
  /** `@image1` and so on. */
  alias: string;
}

/**
 * Numbers inputs per media type in `position` order: inputs image, video, image become `@image1`,
 * `@video1`, `@image2`. `mediaTypeOf` gives an input's MIME type (from the artifact).
 */
export function numberInputs<T extends InputRef>(inputs: readonly T[], mediaTypeOf: (input: T) => string): NumberedInput<T>[] {
  const counters = new Map<string, number>();
  return [...inputs]
    .sort((a, b) => a.position - b.position)
    .map((input) => {
      const kind = topLevelType(mediaTypeOf(input));
      const index = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, index);
      return { input, kind, index, alias: `@${kind}${index}` };
    });
}

/** Counts inputs per media type. */
export function countInputsByKind<T extends InputRef>(inputs: readonly T[], mediaTypeOf: (input: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const input of inputs) {
    const kind = topLevelType(mediaTypeOf(input));
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Throws 400 `invalid_request` with reason `prompt_reference_out_of_range` when the prompt references an
 * input that does not exist, for example `@image3` with two images.
 */
export function checkPromptReferences(prompt: string, counts: Readonly<Record<string, number>>): void {
  for (const ref of parsePromptReferences(prompt)) {
    const available = counts[ref.kind] ?? 0;
    if (ref.index > available) {
      throw invalidRequest(
        "prompt_reference_out_of_range",
        `the prompt references ${ref.text} but the request has ${available} ${ref.kind} input${available === 1 ? "" : "s"}`,
        { reference: ref.text, available },
      );
    }
  }
}

/**
 * Rewrites references for an upstream, for example to the upstream's own syntax or to words such as
 * "image 2". Text between references is kept as it is.
 */
export function replacePromptReferences(prompt: string, replace: (ref: PromptReference) => string): string {
  let out = "";
  let last = 0;
  for (const ref of parsePromptReferences(prompt)) {
    out += prompt.slice(last, ref.start) + replace(ref);
    last = ref.end;
  }
  return out + prompt.slice(last);
}
