import { invalidRequest, ProviderError } from "./errors.ts";
import { isValidMediaType, normalizeMediaType, topLevelType } from "./media.ts";
import { checkPromptReferences, countInputsByKind } from "./references.ts";
import type { Artifact, Catalog, JobRequest, Model, Parameter, Route, Slot } from "./types.ts";
import { TRANSCRIPT_MEDIA_TYPE } from "./types.ts";

export interface CatalogProblem {
  /** Where, for example `models[0].routes[1].slots[0]`. */
  path: string;
  message: string;
}

const EPSILON = 1e-9;

/**
 * Whether `value` is `min + k * step` for a whole `k` (from 0 without `min`). Steps such as 0.1 have no
 * exact binary form, so `k` is compared with a tolerance that grows with its size.
 */
function isAligned(value: number, min: number | undefined, step: number): boolean {
  const k = (value - (min ?? 0)) / step;
  return Math.abs(k - Math.round(k)) <= Math.max(EPSILON, 1e-12 * Math.abs(k));
}

/** A `number` or `integer` parameter may list its allowed values (v1.md section 3.3). */
function checkNumericEnum(p: Parameter, where: string, problems: CatalogProblem[]): void {
  if ((p.kind !== "integer" && p.kind !== "number") || !p.enum_values) return;
  const article = p.kind === "integer" ? "an" : "a";
  for (const v of p.enum_values) {
    if (typeof v !== "number" || !Number.isFinite(v)) problems.push({ path: where, message: `enum_values of ${article} ${p.kind} parameter must be numbers, got ${JSON.stringify(v)}` });
    else if (p.kind === "integer" && !Number.isInteger(v)) problems.push({ path: where, message: `enum_values of an integer parameter must be whole numbers, got ${v}` });
  }
}

function outputMatchesModality(mediaType: string, modality: string): boolean | undefined {
  const top = topLevelType(mediaType);
  switch (modality) {
    case "image":
    case "video":
    case "audio":
      return top === modality;
    case "text":
    case "transcript":
      return normalizeMediaType(mediaType) === TRANSCRIPT_MEDIA_TYPE || top === "text";
    default:
      return undefined;
  }
}

function checkDefault(p: Parameter, where: string, problems: CatalogProblem[]): void {
  if (p.default === undefined || p.default === null) return;
  const v = p.default;
  if (p.enum_values && p.enum_values.length > 0 && !p.enum_values.includes(v as string | number | boolean)) {
    problems.push({ path: where, message: `default ${JSON.stringify(v)} is not in enum_values` });
  }
  if (typeof v === "number") {
    if (p.min !== undefined && v < p.min - EPSILON) problems.push({ path: where, message: `default ${v} is below min ${p.min}` });
    if (p.max !== undefined && v > p.max + EPSILON) problems.push({ path: where, message: `default ${v} is above max ${p.max}` });
    if (p.step !== undefined && p.step > 0 && !isAligned(v, p.min, p.step)) {
      problems.push({ path: where, message: `default ${v} is not min + k * step` });
    }
    if (p.kind === "integer" && !Number.isInteger(v)) problems.push({ path: where, message: `default ${v} is not an integer` });
  }
  const typeOk = parameterValueProblem(p, v) === undefined;
  if (!typeOk && !(p.enum_values && p.enum_values.length > 0)) {
    problems.push({ path: where, message: `default ${JSON.stringify(v)} does not match kind ${p.kind}` });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** The shapes of `widget` and `visible_when` (v1.md section 3.3). Unknown members are allowed. */
function checkDisplayShapes(p: Parameter, where: string, problems: CatalogProblem[]): void {
  const raw = p as unknown as Record<string, unknown>;
  if ("widget" in raw && typeof raw.widget !== "string") problems.push({ path: where, message: "widget must be a string" });
  if (!("visible_when" in raw)) return;
  const v = raw.visible_when;
  if (!isObject(v)) {
    problems.push({ path: where, message: "visible_when must be an object {name, equals}" });
    return;
  }
  if (typeof v.name !== "string") problems.push({ path: where, message: "visible_when.name must be a string" });
  if (!("equals" in v)) problems.push({ path: where, message: "visible_when needs equals" });
}

/** The shape of `parameter_rules` (v1.md section 3.3). Unknown members are allowed. */
function checkRuleShapes(model: Model, where: string, problems: CatalogProblem[]): void {
  const raw = model as unknown as Record<string, unknown>;
  if (!("parameter_rules" in raw)) return;
  const rules = raw.parameter_rules;
  if (!Array.isArray(rules)) {
    problems.push({ path: where, message: "parameter_rules must be an array" });
    return;
  }
  rules.forEach((rule: unknown, i) => {
    const rp = `parameter_rules[${i}]`;
    if (!isObject(rule)) {
      problems.push({ path: where, message: `${rp} must be an object` });
      return;
    }
    for (const key of ["when_name", "reject_name", "message"]) {
      if (typeof rule[key] !== "string") problems.push({ path: where, message: `${rp}.${key} must be a string` });
    }
    for (const key of ["when_values", "reject_values"]) {
      if (!isStringArray(rule[key])) problems.push({ path: where, message: `${rp}.${key} must be an array of strings` });
    }
  });
}

/**
 * Checks the catalog rules of conformance check A5: every route parameter is defined; defaults are
 * inside enums and ranges; `min <= max`; `step > 0` and defaults aligned to `min + k * step` (from 0
 * without `min`, with a tolerance for fractional steps); numeric `enum_values` are numbers; slot
 * `min_artifacts <= max_artifacts`; `max_total_artifacts` is at least the sum of the slot minimums; media
 * types are valid MIME types; route output types match the model's output modality; `widget`,
 * `visible_when` and `parameter_rules` have their shapes. Returns the problems found (empty when the
 * catalog is fine).
 */
export function validateCatalog(catalog: Catalog): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  const modelIds = new Set<string>();
  catalog.models.forEach((model, mi) => {
    const mp = `models[${mi}]`;
    if (modelIds.has(model.id)) problems.push({ path: mp, message: `duplicate model id ${model.id}` });
    modelIds.add(model.id);
    checkRuleShapes(model, mp, problems);
    const params = new Map<string, Parameter>();
    model.parameters.forEach((p, pi) => {
      const pp = `${mp}.parameters[${pi}]`;
      if (params.has(p.name)) problems.push({ path: pp, message: `duplicate parameter ${p.name}` });
      params.set(p.name, p);
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) problems.push({ path: pp, message: `min ${p.min} > max ${p.max}` });
      if (p.step !== undefined && !(p.step > 0)) problems.push({ path: pp, message: `step must be > 0` });
      if (p.enum_values !== undefined && p.enum_values.length === 0) {
        problems.push({ path: pp, message: `enum_values of parameter "${p.name}" is an empty list: omit enum_values instead of sending an empty list` });
      } else if (p.kind === "enum" && !p.enum_values) problems.push({ path: pp, message: "enum parameter without enum_values" });
      checkNumericEnum(p, pp, problems);
      checkDefault(p, pp, problems);
      checkDisplayShapes(p, pp, problems);
    });
    const routeIds = new Set<string>();
    model.routes.forEach((route, ri) => {
      const rp = `${mp}.routes[${ri}]`;
      if (routeIds.has(route.id)) problems.push({ path: rp, message: `duplicate route id ${route.id}` });
      routeIds.add(route.id);
      for (const name of route.parameter_names) {
        if (!params.has(name)) problems.push({ path: rp, message: `parameter_names lists ${name}, which the model does not define` });
      }
      let minSum = 0;
      const slotIds = new Set<string>();
      route.input.slots.forEach((slot, si) => {
        const sp = `${rp}.input.slots[${si}]`;
        if (slotIds.has(slot.id)) problems.push({ path: sp, message: `duplicate slot id ${slot.id}` });
        slotIds.add(slot.id);
        if (slot.min_artifacts > slot.max_artifacts) problems.push({ path: sp, message: `min_artifacts ${slot.min_artifacts} > max_artifacts ${slot.max_artifacts}` });
        minSum += slot.min_artifacts;
        for (const mt of slot.media_types) {
          if (!isValidMediaType(mt)) problems.push({ path: sp, message: `invalid media type ${mt}` });
        }
      });
      const total = route.input.max_total_artifacts;
      if (total !== undefined && total < minSum) problems.push({ path: rp, message: `max_total_artifacts ${total} is below the sum of slot minimums ${minSum}` });
      for (const mt of route.output?.media_types ?? []) {
        if (!isValidMediaType(mt)) {
          problems.push({ path: rp, message: `invalid output media type ${mt}` });
          continue;
        }
        if (outputMatchesModality(mt, model.output.modality) === false) {
          problems.push({ path: rp, message: `output media type ${mt} does not match the model's output modality ${model.output.modality}` });
        }
      }
    });
  });
  return problems;
}

/** Returns why `value` is not acceptable for `p`, or `undefined` when it is. */
export function parameterValueProblem(p: Parameter, value: unknown): string | undefined {
  switch (p.kind) {
    case "text":
    case "string":
      if (typeof value !== "string") return "must be a string";
      if (p.max_length !== undefined && [...value].length > p.max_length) return `must be at most ${p.max_length} characters`;
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (p.kind === "integer" && !Number.isInteger(value)) return "must be an integer";
      if (p.min !== undefined && value < p.min - EPSILON) return `must be at least ${p.min}`;
      if (p.max !== undefined && value > p.max + EPSILON) return `must be at most ${p.max}`;
      if (p.step !== undefined && p.step > 0 && !isAligned(value, p.min, p.step)) return `must be ${p.min ?? 0} + k * ${p.step}`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return "must be a boolean";
      break;
    case "enum":
      break;
    default:
      return undefined;
  }
  if (p.enum_values && p.enum_values.length > 0 && !p.enum_values.includes(value as string | number | boolean)) {
    return `must be one of ${p.enum_values.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return undefined;
}

export interface ValidatedRequest {
  model: Model;
  route: Route;
  /** Inputs in position order, with their artifacts and slots. */
  inputs: { ref: JobRequest["input"]["artifacts"][number]; artifact: Artifact; slot: Slot }[];
}

/**
 * Checks a job request against the catalog the way the client is expected to (v1.md section 3.3), so a
 * plugin rejects bad requests with 400 before anything is recorded or sent upstream. `lookupArtifact`
 * returns the artifact for an id, or `undefined`.
 *
 * Reasons: `unknown_model`, `model_unavailable`, `unknown_route`, `missing_parameter`,
 * `invalid_parameter`, `unknown_parameter`, `artifact_not_found`, `invalid_position`, `unknown_role`,
 * `too_few_inputs`, `too_many_inputs`, `unsupported_media_type`, `input_too_large`,
 * `prompt_reference_out_of_range`.
 */
export async function validateJobRequest(
  catalog: Catalog,
  request: JobRequest,
  lookupArtifact: (id: string) => Artifact | undefined | Promise<Artifact | undefined>,
): Promise<ValidatedRequest> {
  const model = catalog.models.find((m) => m.id === request.model);
  if (!model) throw invalidRequest("unknown_model", `unknown model ${request.model}`, { model: request.model });
  if (!model.available) {
    throw invalidRequest("model_unavailable", `model ${model.id} is not available`, { model: model.id });
  }
  const route = model.routes.find((r) => r.id === request.route);
  if (!route) throw invalidRequest("unknown_route", `model ${model.id} has no route ${request.route}`, { route: request.route });

  // Parameters.
  const defs = new Map(model.parameters.map((p) => [p.name, p]));
  const allowed = new Set(route.parameter_names);
  for (const [name, value] of Object.entries(request.parameters ?? {})) {
    const def = defs.get(name);
    if (!def || !allowed.has(name)) {
      throw invalidRequest("unknown_parameter", `route ${route.id} has no parameter ${name}`, { parameter: name });
    }
    if (value === null) continue;
    const problem = parameterValueProblem(def, value);
    if (problem) throw invalidRequest("invalid_parameter", `parameter ${name} ${problem}`, { parameter: name });
  }
  for (const name of route.parameter_names) {
    const def = defs.get(name);
    if (def?.required && (request.parameters?.[name] === undefined || request.parameters[name] === null)) {
      throw invalidRequest("missing_parameter", `parameter ${name} is required`, { parameter: name });
    }
  }

  // Inputs.
  const refs = [...(request.input?.artifacts ?? [])].sort((a, b) => a.position - b.position);
  refs.forEach((ref, i) => {
    if (ref.position !== i) {
      throw invalidRequest("invalid_position", "input positions must number the inputs from 0 without gaps or repeats", { position: ref.position });
    }
  });
  const inputs: ValidatedRequest["inputs"] = [];
  const perSlot = new Map<string, number>();
  for (const ref of refs) {
    const slot = route.input.slots.find((s) => s.role === ref.role);
    if (!slot) throw invalidRequest("unknown_role", `route ${route.id} has no input role ${ref.role}`, { role: ref.role });
    const artifact = await lookupArtifact(ref.artifact_id);
    if (!artifact) throw invalidRequest("artifact_not_found", `artifact ${ref.artifact_id} does not exist; upload it again`, { artifact_id: ref.artifact_id });
    const accepted = slot.media_types.map(normalizeMediaType);
    if (!accepted.includes(normalizeMediaType(artifact.media_type))) {
      throw invalidRequest("unsupported_media_type", `role ${slot.role} does not accept ${artifact.media_type}`, {
        role: slot.role,
        media_type: artifact.media_type,
      });
    }
    if (slot.max_bytes !== undefined && artifact.bytes > slot.max_bytes) {
      throw invalidRequest("input_too_large", `an input for role ${slot.role} is larger than ${slot.max_bytes} bytes`, {
        role: slot.role,
        max_bytes: slot.max_bytes,
      });
    }
    if (slot.max_duration_ms !== undefined && artifact.metadata?.duration_ms !== undefined && artifact.metadata.duration_ms > slot.max_duration_ms) {
      throw invalidRequest("input_too_long", `an input for role ${slot.role} is longer than ${slot.max_duration_ms} ms`, {
        role: slot.role,
        max_duration_ms: slot.max_duration_ms,
      });
    }
    perSlot.set(slot.id, (perSlot.get(slot.id) ?? 0) + 1);
    inputs.push({ ref, artifact, slot });
  }
  for (const slot of route.input.slots) {
    const n = perSlot.get(slot.id) ?? 0;
    if (n > slot.max_artifacts) {
      throw invalidRequest("too_many_inputs", `route ${route.id} accepts at most ${slot.max_artifacts} ${slot.role} input${slot.max_artifacts === 1 ? "" : "s"}`, {
        role: slot.role,
        max: slot.max_artifacts,
        received: n,
      });
    }
    if (n < slot.min_artifacts) {
      throw invalidRequest("too_few_inputs", `route ${route.id} needs at least ${slot.min_artifacts} ${slot.role} input${slot.min_artifacts === 1 ? "" : "s"}`, {
        role: slot.role,
        min: slot.min_artifacts,
        received: n,
      });
    }
  }
  const total = route.input.max_total_artifacts;
  if (total !== undefined && refs.length > total) {
    throw invalidRequest("too_many_inputs", `route ${route.id} accepts at most ${total} inputs in total`, { max: total, received: refs.length });
  }

  // Prompt references.
  const prompt = request.parameters?.prompt;
  if (typeof prompt === "string") {
    checkPromptReferences(
      prompt,
      countInputsByKind(inputs.map((i) => ({ ...i.ref, media_type: i.artifact.media_type })), (i) => i.media_type),
    );
  }
  return { model, route, inputs };
}

/** The largest `max_bytes` of any slot, or `undefined` when no slot declares one. */
/**
 * The largest `max_bytes` of any slot in the catalog: the upload limit. Returns `undefined` when some slot
 * has no `max_bytes` (that slot is not limited, so neither are uploads) or when there are no slots.
 */
export function largestMaxBytes(catalog: Catalog): number | undefined {
  let max: number | undefined;
  for (const m of catalog.models) for (const r of m.routes) for (const s of r.input.slots) {
    if (s.max_bytes === undefined) return undefined;
    max = Math.max(max ?? 0, s.max_bytes);
  }
  return max;
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}
