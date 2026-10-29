import assert from "node:assert/strict";
import { test } from "node:test";
import { largestMaxBytes, ProviderError, validateCatalog, validateJobRequest, type Artifact, type Catalog } from "../src/index.ts";

const catalog: Catalog = {
  models: [
    {
      id: "m/video",
      label: "Video",
      available: true,
      output: { modality: "video" },
      parameters: [
        { name: "prompt", kind: "text", required: true, max_length: 20 },
        { name: "duration", kind: "integer", default: 5, min: 4, max: 15, step: 1, widget: "slider" },
        { name: "ratio", kind: "enum", default: "16:9", enum_values: ["16:9", "1:1"], visible_when: { name: "audio", equals: null } },
        { name: "audio", kind: "boolean", default: true },
      ],
      parameter_rules: [{ when_name: "ratio", when_values: ["1:1"], reject_name: "duration", reject_values: ["15"], message: "15 s is not available in 1:1" }],
      routes: [
        {
          id: "multimodal2video",
          input: {
            slots: [
              { id: "reference", role: "reference", modality: "image", min_artifacts: 0, max_artifacts: 2, media_types: ["image/png"], max_bytes: 100 },
              { id: "video_track", role: "video_track", modality: "video", min_artifacts: 0, max_artifacts: 1, media_types: ["video/mp4"] },
            ],
            max_total_artifacts: 2,
          },
          parameter_names: ["prompt", "duration", "ratio", "audio"],
          output: { media_types: ["video/mp4"] },
        },
      ],
    },
    { id: "m/off", label: "Off", available: false, output: { modality: "image" }, parameters: [], routes: [{ id: "text2image", input: { slots: [] }, parameter_names: [] }] },
  ],
};

const artifacts: Record<string, Artifact> = {
  img1: { id: "img1", media_type: "image/png", bytes: 10, sha256: "0".repeat(64) },
  img2: { id: "img2", media_type: "image/png", bytes: 10, sha256: "1".repeat(64) },
  img3: { id: "img3", media_type: "image/png", bytes: 10, sha256: "2".repeat(64) },
  big: { id: "big", media_type: "image/png", bytes: 1000, sha256: "3".repeat(64) },
  vid: { id: "vid", media_type: "video/mp4", bytes: 10, sha256: "4".repeat(64) },
  wav: { id: "wav", media_type: "audio/wav", bytes: 10, sha256: "5".repeat(64) },
};

const base = () => ({
  model: "m/video",
  route: "multimodal2video",
  input: { artifacts: [{ artifact_id: "img1", role: "reference", position: 0 }] },
  parameters: { prompt: "@image1 walks", duration: 5 } as Record<string, unknown>,
});

async function reason(change: (r: ReturnType<typeof base>) => void): Promise<string | undefined> {
  const r = base();
  change(r);
  try {
    await validateJobRequest(catalog, r, (id) => artifacts[id]);
    return undefined;
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, 400);
    return err.reason;
  }
}

test("a good catalog has no problems", () => {
  assert.deepEqual(validateCatalog(catalog), []);
});

test("catalog problems are found", () => {
  const bad: Catalog = structuredClone(catalog);
  const m = bad.models[0]!;
  m.parameters[1]!.default = 20; // above max
  m.parameters.push({ name: "steps", kind: "number", min: 1, max: 10, step: 2, default: 2 }); // not aligned
  m.parameters.push({ name: "bad", kind: "integer", min: 5, max: 1 });
  m.routes[0]!.parameter_names.push("missing");
  m.routes[0]!.input.slots[0]!.min_artifacts = 3; // > max 2
  m.routes[0]!.input.slots[0]!.media_types.push("not a type");
  m.routes[0]!.output!.media_types = ["image/png"];
  const messages = validateCatalog(bad).map((p) => p.message).join("\n");
  for (const fragment of ["above max", "not min + k * step", "min 5 > max 1", "missing", "min_artifacts 3 > max_artifacts 2", "invalid media type", "below the sum", "does not match the model's output modality"]) {
    assert.ok(messages.includes(fragment), `expected ${fragment} in\n${messages}`);
  }
});

test("a valid request resolves its inputs", async () => {
  const v = await validateJobRequest(catalog, base(), (id) => artifacts[id]);
  assert.equal(v.inputs.length, 1);
  assert.equal(v.route.id, "multimodal2video");
});

test("invalid requests are rejected with a reason", async () => {
  assert.equal(await reason((r) => (r.model = "nope")), "unknown_model");
  assert.equal(await reason((r) => ((r.model = "m/off"), (r.route = "text2image"))), "model_unavailable");
  assert.equal(await reason((r) => (r.route = "text2video")), "unknown_route");
  assert.equal(await reason((r) => delete r.parameters.prompt), "missing_parameter");
  assert.equal(await reason((r) => (r.parameters.duration = 16)), "invalid_parameter");
  assert.equal(await reason((r) => (r.parameters.duration = 4.5)), "invalid_parameter");
  assert.equal(await reason((r) => (r.parameters.ratio = "4:3")), "invalid_parameter");
  assert.equal(await reason((r) => (r.parameters.audio = "yes")), "invalid_parameter");
  assert.equal(await reason((r) => (r.parameters.prompt = "x".repeat(21))), "invalid_parameter");
  assert.equal(await reason((r) => (r.parameters.seed = 1)), "unknown_parameter");
  assert.equal(await reason((r) => (r.input.artifacts[0]!.artifact_id = "missing")), "artifact_not_found");
  assert.equal(await reason((r) => (r.input.artifacts[0]!.position = 1)), "invalid_position");
  assert.equal(await reason((r) => (r.input.artifacts[0]!.role = "first_frame")), "unknown_role");
  assert.equal(await reason((r) => (r.input.artifacts[0]!.artifact_id = "wav")), "unsupported_media_type");
  assert.equal(await reason((r) => (r.input.artifacts[0]!.artifact_id = "big")), "input_too_large");
  assert.equal(
    await reason((r) =>
      r.input.artifacts.push(
        { artifact_id: "img2", role: "reference", position: 1 },
        { artifact_id: "img3", role: "reference", position: 2 },
      ),
    ),
    "too_many_inputs",
  );
  assert.equal(
    await reason((r) =>
      r.input.artifacts.push({ artifact_id: "vid", role: "video_track", position: 1 }, { artifact_id: "img2", role: "reference", position: 2 }),
    ),
    "too_many_inputs",
  );
  assert.equal(await reason((r) => (r.parameters.prompt = "@image2")), "prompt_reference_out_of_range");
});

test("widget, visible_when and parameter_rules must have their shapes", () => {
  const loose = (v: unknown) => v as Record<string, unknown>;
  const shapes: [string, (m: Catalog["models"][number]) => void, string][] = [
    ["widget object", (m) => (loose(m.parameters[1]).widget = { type: "slider" }), "widget must be a string"],
    ["widget null", (m) => (loose(m.parameters[1]).widget = null), "widget must be a string"],
    ["visible_when without equals", (m) => (loose(m.parameters[2]).visible_when = { name: "audio" }), "visible_when needs equals"],
    ["visible_when name not a string", (m) => (loose(m.parameters[2]).visible_when = { name: 1, equals: true }), "visible_when.name must be a string"],
    ["visible_when list", (m) => (loose(m.parameters[2]).visible_when = [{ name: "audio", equals: true }]), "visible_when must be an object"],
    ["rules not a list", (m) => (loose(m).parameter_rules = { when_name: "ratio" }), "parameter_rules must be an array"],
    ["rule not an object", (m) => (loose(m).parameter_rules = ["ratio"]), "parameter_rules[0] must be an object"],
    ["rule without message", (m) => delete loose(m.parameter_rules![0]).message, "parameter_rules[0].message must be a string"],
    ["rule values not a list", (m) => (loose(m.parameter_rules![0]).when_values = "1:1"), "parameter_rules[0].when_values must be an array of strings"],
    ["rule value not a string", (m) => (loose(m.parameter_rules![0]).reject_values = [15]), "parameter_rules[0].reject_values must be an array of strings"],
    ["rule name not a string", (m) => (loose(m.parameter_rules![0]).reject_name = null), "parameter_rules[0].reject_name must be a string"],
  ];
  for (const [what, change, fragment] of shapes) {
    const bad: Catalog = structuredClone(catalog);
    change(bad.models[0]!);
    const messages = validateCatalog(bad).map((p) => `${p.path}: ${p.message}`).join("\n");
    assert.ok(messages.includes(fragment), `${what}: expected ${fragment} in\n${messages}`);
  }
  // Unknown members are ignored, and the names do not have to be defined parameters (A5 checks shapes only).
  const extended: Catalog = structuredClone(catalog);
  loose(extended.models[0]!.parameter_rules![0]).severity = "error";
  extended.models[0]!.parameter_rules![0]!.reject_name = "not_a_parameter";
  assert.deepEqual(validateCatalog(extended), []);
});

test("the upload limit is the largest max_bytes, or none when a slot is unlimited", () => {
  assert.equal(largestMaxBytes(catalog), undefined); // video_track has no max_bytes
  const limited: Catalog = structuredClone(catalog);
  limited.models[0]!.routes[0]!.input.slots[1]!.max_bytes = 50;
  assert.equal(largestMaxBytes(limited), 100);
});

test("numeric parameters may list their values, and a number's step may be fractional", async () => {
  const model = (parameters: Catalog["models"][number]["parameters"]): Catalog => ({
    models: [{ id: "m", label: "M", available: true, output: { modality: "video" }, parameters, routes: [{ id: "text2video", input: { slots: [] }, parameter_names: parameters.map((p) => p.name) }] }],
  });
  const good = model([
    { name: "duration", kind: "integer", default: 6, enum_values: [4, 6, 8] },
    { name: "motion", kind: "number", default: 0.3, min: 0, max: 1, step: 0.1 },
    { name: "offset", kind: "number", default: 0.75, step: 0.25 },
    { name: "seconds", kind: "number", default: 9876543.2, min: 0, step: 0.1 },
  ]);
  assert.deepEqual(validateCatalog(good), []);
  const messages = (c: Catalog) => validateCatalog(c).map((p) => p.message).join("\n");
  assert.match(messages(model([{ name: "duration", kind: "integer", default: 5, enum_values: [4, 6, 8] }])), /not in enum_values/);
  assert.match(messages(model([{ name: "duration", kind: "integer", default: 4, enum_values: [4, "6"] }])), /enum_values of an integer parameter must be numbers/);
  assert.match(messages(model([{ name: "duration", kind: "integer", default: 4, enum_values: [4, 6.5] }])), /enum_values of an integer parameter must be whole numbers/);
  assert.match(messages(model([{ name: "motion", kind: "number", default: 0.5, enum_values: [0.5, true] }])), /enum_values of a number parameter must be numbers/);
  // An empty enum_values is refused for every kind, with the fix in the message.
  for (const kind of ["enum", "integer", "number"] as const) {
    const msgs = validateCatalog(model([{ name: "duration", kind, enum_values: [] }])).map((p) => p.message);
    assert.deepEqual(msgs, [`enum_values of parameter "duration" is an empty list: omit enum_values instead of sending an empty list`], kind);
  }
  // Without min, values are aligned from 0.
  assert.match(messages(model([{ name: "offset", kind: "number", default: 0.6, step: 0.25 }])), /not min \+ k \* step/);

  const req = (parameters: Record<string, unknown>) => validateJobRequest(good, { model: "m", route: "text2video", input: { artifacts: [] }, parameters }, () => undefined);
  await req({ duration: 8, motion: 0.7, offset: 1.25 });
  for (const parameters of [{ duration: 5 }, { duration: "4" }, { motion: 0.35 }, { offset: 0.6 }]) {
    await assert.rejects(req(parameters), (err: unknown) => err instanceof ProviderError && err.reason === "invalid_parameter", JSON.stringify(parameters));
  }
});
