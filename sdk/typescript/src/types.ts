// Protocol types for Cuelor Provider API v1. The JSON Schemas in spec/schemas are the source of truth;
// these types mirror them. Index signatures are omitted on purpose: unknown fields are allowed on the
// wire, and the SDK passes through what it does not know.

export type JobStatus =
  | "queued"
  | "running"
  | "pending_approval"
  | "succeeded"
  | "failed"
  | "rejected"
  | "expired"
  | "cancelled";

export const JOB_STATUSES: readonly JobStatus[] = [
  "queued",
  "running",
  "pending_approval",
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "rejected", "expired", "cancelled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface ErrorObject {
  code: string;
  message: string;
  reason?: string;
  params?: Record<string, unknown>;
}

export interface Warning {
  code: string;
  message: string;
}

export interface Usage {
  amount: number;
  unit: string;
  basis: "billed" | "estimate";
}

export interface ArtifactMetadata {
  width?: number;
  height?: number;
  duration_ms?: number;
  audio?: boolean;
  sample_rate?: number;
}

export interface Artifact {
  id: string;
  media_type: string;
  bytes: number;
  sha256: string;
  created_at?: string;
  expires_at?: string;
  metadata?: ArtifactMetadata;
}

export interface JobOutput {
  artifact_id: string;
  role: string;
  media_type: string;
  bytes: number;
  sha256: string;
  metadata?: ArtifactMetadata;
}

export interface Approval {
  policy: string;
  deadline: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  model?: string;
  route?: string;
  created_at: string;
  updated_at: string;
  progress?: { percent?: number } | null;
  approval?: Approval | null;
  outputs?: JobOutput[];
  error?: ErrorObject | null;
  usage?: Usage | null;
  warnings?: Warning[];
}

export interface InputRef {
  artifact_id: string;
  role: string;
  position: number;
}

export interface JobRequest {
  model: string;
  route: string;
  input: { artifacts: InputRef[] };
  parameters: Record<string, unknown>;
  callback?: { url: string; secret: string };
}

export interface Estimate {
  amount: number;
  unit: string;
  basis: "exact" | "estimate";
  note?: string;
}

export interface Capabilities {
  generation?: string[];
  transcription?: boolean;
  cancel?: boolean;
  estimate?: boolean;
  webhook?: boolean;
  setup?: boolean;
}

export type AccountStatus = "ready" | "needs_setup" | "invalid_credentials";

export interface Account {
  status: AccountStatus;
  label?: string;
  binding: string;
  warnings?: Warning[];
}

export interface ProviderDescription {
  protocol: { version: string };
  provider: { id: string; name: string; version: string; repository?: string };
  capabilities: Capabilities;
  account: Account;
  billing: { unit: string };
}

export interface Parameter {
  name: string;
  kind: string;
  required?: boolean;
  default?: unknown;
  enum_values?: (string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  max_length?: number;
  /** A display hint, for example `slider`. v1 does not fix its values. */
  widget?: string;
  /** Show the parameter while the parameter `name` has the value `equals`. */
  visible_when?: VisibleWhen;
}

export interface VisibleWhen {
  name: string;
  equals: unknown;
}

/** While `when_name` has one of `when_values`, `reject_name` must not have one of `reject_values` (v1.md section 3.3). */
export interface ParameterRule {
  when_name: string;
  when_values: string[];
  reject_name: string;
  reject_values: string[];
  /** English, for people. */
  message: string;
}

export interface Slot {
  id: string;
  role: string;
  modality: string;
  min_artifacts: number;
  max_artifacts: number;
  media_types: string[];
  max_bytes?: number;
  max_duration_ms?: number;
}

export interface Pricing {
  basis: "exact" | "estimate";
  unit: string;
  amount: number;
  currency: string;
  note?: string;
}

export interface Route {
  id: string;
  label?: string;
  description?: string;
  input: { modality?: string; slots: Slot[]; max_total_artifacts?: number };
  parameter_names: string[];
  output?: { media_types?: string[]; audio?: "none" | "always" | "optional" };
  pricing?: Pricing;
}

export interface Model {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  available: boolean;
  availability_reason?: string | null;
  output: { modality: string };
  parameters: Parameter[];
  parameter_rules?: ParameterRule[];
  routes: Route[];
}

export interface Catalog {
  models: Model[];
}

export interface TimedTextUnit {
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface TranscriptSegment {
  text: string;
  start_ms?: number;
  end_ms?: number;
  speaker?: string;
  timed_text_units?: TimedTextUnit[];
}

export interface Transcript {
  schema_version: 1;
  language?: string;
  language_probability?: number;
  unit: "word" | "character" | "token";
  text: string;
  segments: TranscriptSegment[];
  provider?: { name?: string };
}

export const TRANSCRIPT_MEDIA_TYPE = "application/vnd.cuelor.transcript+json";
