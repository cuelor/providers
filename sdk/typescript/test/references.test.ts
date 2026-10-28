import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkPromptReferences,
  countInputsByKind,
  numberInputs,
  parsePromptReferences,
  ProviderError,
  replacePromptReferences,
} from "../src/index.ts";

test("parses references and treats every other @ as text", () => {
  const refs = parsePromptReferences("@image1 meets @video12 at me@example.com, @image0, @images, @audio3x");
  assert.deepEqual(
    refs.map((r) => [r.text, r.kind, r.index]),
    [
      ["@image1", "image", 1],
      ["@video12", "video", 12],
      ["@audio3", "audio", 3],
    ],
  );
  // Greedy digits: a reference is never followed by another digit.
  assert.equal(parsePromptReferences("@image10")[0]!.index, 10);
  assert.equal(parsePromptReferences("@image01").length, 0);
});

test("numbers inputs per media type in position order", () => {
  const inputs = [
    { artifact_id: "c", role: "reference", position: 2, type: "image/png" },
    { artifact_id: "a", role: "reference", position: 0, type: "image/jpeg" },
    { artifact_id: "b", role: "video_track", position: 1, type: "video/mp4" },
  ];
  assert.deepEqual(
    numberInputs(inputs, (i) => i.type).map((n) => [n.input.artifact_id, n.alias]),
    [
      ["a", "@image1"],
      ["b", "@video1"],
      ["c", "@image2"],
    ],
  );
  assert.deepEqual(countInputsByKind(inputs, (i) => i.type), { image: 2, video: 1 });
});

test("out-of-range references are rejected with 400", () => {
  checkPromptReferences("@image1 and @image2", { image: 2 });
  assert.throws(
    () => checkPromptReferences("@image1 then @image3", { image: 2 }),
    (err: unknown) => err instanceof ProviderError && err.status === 400 && err.reason === "prompt_reference_out_of_range",
  );
  assert.throws(() => checkPromptReferences("@audio1", {}), ProviderError);
});

test("rewrites references for an upstream", () => {
  assert.equal(replacePromptReferences("put @image2 next to @image1.", (r) => `<${r.kind}-${r.index}>`), "put <image-2> next to <image-1>.");
});
