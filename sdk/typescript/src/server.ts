import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { readJsonFile, writeJsonAtomic } from "./atomic-file.ts";
import { createRequestGuard, type RequestGuard } from "./auth.ts";
import { sha256Hex } from "./canonical-json.ts";
import { largestMaxBytes, validateJobRequest } from "./catalog.ts";
import { errorBody, invalidRequest, jobError, NotSubmittedError, ProviderError, sanitizeMessage } from "./errors.ts";
import { announcePort, listenModeFromEnv, onStdinClosed, readHandshakeToken, readTokenFile, type ListenMode } from "./handshake.ts";
import { IdempotencyStore, MIN_KEY_RETENTION_MS, requireIdempotencyKey } from "./idempotency.ts";
import { acquireInstanceLock } from "./instance-lock.ts";
import { normalizeMediaType, sniffMediaType } from "./media.ts";
import { parseUpload } from "./multipart.ts";
import { probeFileMetadata, probeMetadata } from "./probe.ts";
import { normalizeTranscript, validateTranscript } from "./transcript.ts";
import type {
  Account,
  Approval,
  Artifact,
  ArtifactMetadata,
  Capabilities,
  Catalog,
  ErrorObject,
  Estimate,
  Job,
  JobRequest,
  JobStatus,
  Model,
  ProviderDescription,
  Route,
  Transcript,
  Usage,
  Warning,
} from "./types.ts";
import { isTerminal, JOB_STATUSES, TRANSCRIPT_MEDIA_TYPE } from "./types.ts";

// ---------------------------------------------------------------------------------------------------
// Definition: what a plugin author provides.

/** Passed to every callback of a definition. */
export interface ProviderContext {
  /** The plugin's data directory (`CUELOR_PROVIDER_DATA_DIR`). */
  dataDir: string;
  /** Writes a line to the plugin log (stderr). Never pass secrets. */
  log: (message: string) => void;
  /** Drops the cached `account()` result, for example after a login changed the credentials. */
  invalidateAccount: () => void;
}

/** One resolved input of a job, in `position` order. */
export interface ResolvedInput {
  artifact: Artifact;
  role: string;
  position: number;
  /** `@image1`, `@video1`, … : the input's reference alias (v1.md section 3.6). */
  alias: string;
  /** The file holding the bytes. */
  path: string;
  read(): Promise<Buffer>;
}

export interface SubmitContext extends ProviderContext {
  jobId: string;
  request: JobRequest;
  model: Model;
  route: Route;
  inputs: ResolvedInput[];
  /**
   * A stable reference derived from the idempotency key and the account binding (not the key itself).
   * Attach it to the upstream job when the upstream allows custom metadata, so `lookup` can find the job
   * after a crash.
   */
  clientReference: string;
  /**
   * Aborted after `submitHardTimeoutMs` (default 10 minutes), when the server stops waiting for the call
   * at all. Passing `submitTimeoutMs` does not abort it: the client gets 502 and the call goes on.
   */
  signal: AbortSignal;
}

export interface EstimateContext extends ProviderContext {
  request: JobRequest;
  model: Model;
  route: Route;
  inputs: ResolvedInput[];
}

export interface UpstreamOutput {
  /** `output` (default) or `transcript` (default for transcript media). */
  role?: string;
  mediaType: string;
  /** The bytes, or a function that downloads them. */
  data: Uint8Array | (() => Promise<Uint8Array>);
  metadata?: ArtifactMetadata;
}

/** What the upstream says about a job. */
export interface UpstreamState {
  status: JobStatus;
  /** 0 to 100. */
  progress?: number;
  outputs?: UpstreamOutput[];
  error?: ErrorObject;
  usage?: Usage;
  warnings?: Warning[];
  approval?: Approval;
}

export interface PollContext extends ProviderContext {
  jobId: string;
  request: JobRequest;
}

/** Translates the protocol to one upstream. */
export interface UpstreamAdapter {
  /**
   * Submits the job and returns the upstream's job id as soon as the upstream accepted it. Do not wait
   * for the job to finish here: start synchronous upstream calls in the background and return an id.
   *
   * - Throw `ProviderError` with a 4xx status only when it is certain that nothing was created upstream.
   * - Throw `NotSubmittedError` when the upstream certainly did not accept the job but a retry may work.
   * - Any other error leaves the submission unknown: a replay goes through `lookup`, and without a match
   *   the job ends `failed` with `submission_unknown`. It is never submitted again.
   */
  submit(ctx: SubmitContext): Promise<{ upstreamId: string }>;
  /** The current state of an upstream job. Called when the client queries a job that has not ended. */
  poll(upstreamId: string, ctx: PollContext): Promise<UpstreamState>;
  /** Finds an upstream job by the `clientReference` given to `submit`; `null` when there is none. */
  lookup?(clientReference: string, ctx: ProviderContext): Promise<string | null | undefined>;
  /** Asks the upstream to cancel. Best effort. Required when `capabilities.cancel` is true. */
  cancel?(upstreamId: string, ctx: PollContext): Promise<void>;
  /** Prices a request. Required when `capabilities.estimate` is true. */
  estimate?(ctx: EstimateContext): Promise<Estimate>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  version: string;
  repository?: string;
  /** Default `1.0`. */
  protocolVersion?: string;
  capabilities: Capabilities;
  /** `credits` or an ISO 4217 code. */
  billingUnit: string;
  /**
   * The account: status, label, binding (see `computeBinding`), warnings. The result is cached for
   * `accountCacheMs`; a new submission always calls it again.
   */
  account(ctx: ProviderContext): Promise<Account> | Account;
  catalog(ctx: ProviderContext): Promise<Catalog> | Catalog;
  upstream: UpstreamAdapter;
  /** `POST /v1/setup`: a one-time local page. Required when `capabilities.setup` is true. */
  setup?(ctx: ProviderContext & { port: number }): Promise<{ url: string; expires_at?: string }>;
  /**
   * Requests outside `/v1/` (for example the plugin's own setup page under `/setup/<random>`). The SDK
   * checks `Host` and accepts no `Origin` but the plugin's own; there is **no bearer token** (plugins.md
   * section 2), so the path itself must be the secret. Return true when handled; the cached account is
   * dropped then. Requests under `/v1/` never reach this.
   */
  extraRoutes?(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ProviderContext): Promise<boolean> | boolean;
  /** Extra strings to remove from every error message (for example the upstream key). */
  secrets?(): string[];
  /** Largest accepted upload. Default: the largest slot `max_bytes` in the catalog; 512 MiB when a slot has none. */
  maxUploadBytes?: number;
  /** How long `submit` may take before the client gets 502 and the call continues in the background. Default 20 s. */
  submitTimeoutMs?: number;
  /**
   * How long a `submit` may run in the background at all. Then its `signal` is aborted and the
   * submission is treated as unknown: a replay looks the job up (`lookup`) and otherwise ends it
   * `submission_unknown`. Default 10 minutes; never less than `submitTimeoutMs`.
   */
  submitHardTimeoutMs?: number;
  /** How long a query waits for the upstream before answering with the stored state. Default 1.5 s. */
  pollTimeoutMs?: number;
  /** How long an `account()` result is reused. Default 5 s; 0 calls `account()` for every request. */
  accountCacheMs?: number;
  /**
   * Minimum ages before deletion. `jobMs`: a job that ended this long ago is deleted with its key
   * (default and minimum 30 days); jobs that have not ended are kept.
   */
  retention?: { outputMs?: number; inputMs?: number; keyMs?: number; jobMs?: number };
}

// ---------------------------------------------------------------------------------------------------
// Runtime.

interface JobRecord {
  job: Job;
  request: JobRequest;
  key_sha256: string;
  client_reference: string;
  upstream_id?: string;
  /** `submitting`: no upstream id yet; `submitted`: upstream id known; `unknown`: ended as submission_unknown. */
  submission: "submitting" | "submitted" | "unknown";
}

type SubmitOutcome =
  | { kind: "ok" }
  | { kind: "rejected"; error: ProviderError }
  | { kind: "not_submitted"; error: NotSubmittedError }
  | { kind: "unknown" };

const JOB_ID = /^job_[0-9a-f]{24}$/;
/** Jobs are kept at least this long after they ended (plugins.md section 4). */
export const MIN_JOB_RETENTION_MS = MIN_KEY_RETENTION_MS;
const MAX_JSON_BODY = 1024 * 1024;
const DEFAULT_MAX_UPLOAD = 512 * 1024 * 1024;

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "pending_approval", "succeeded", "failed", "rejected", "cancelled"],
  running: ["succeeded", "failed", "rejected", "cancelled", "pending_approval"],
  pending_approval: ["queued", "running", "succeeded", "rejected", "expired", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

const DEFAULT_ERRORS: Partial<Record<JobStatus, [string, string]>> = {
  failed: ["upstream_failed", "the upstream reported a failure"],
  rejected: ["content_moderated", "the upstream rejected the job"],
  expired: ["approval_expired", "the approval expired"],
  cancelled: ["cancelled", "the job was cancelled"],
};

export interface ProviderRuntimeOptions {
  dataDir: string;
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * The protocol implementation behind `runProvider`: routing, stores, idempotency, job state. Use
 * `createProviderHandler` to embed it in your own HTTP server or tests.
 */
export class ProviderRuntime {
  readonly definition: ProviderDefinition;
  readonly dataDir: string;
  readonly artifacts: ArtifactStore;
  readonly idempotency: IdempotencyStore;
  readonly ctx: ProviderContext;
  /** The port the server listens on, once known (used for setup URLs). */
  port = 0;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<SubmitOutcome>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly jobLocks = new Map<string, Promise<void>>();
  private readonly secretsList: string[] = [];
  private accountCache: { at: number; account: Promise<Account> } | undefined;

  constructor(definition: ProviderDefinition, options: ProviderRuntimeOptions) {
    this.definition = definition;
    this.dataDir = options.dataDir;
    this.now = options.now ?? Date.now;
    const log = options.log ?? ((m: string) => process.stderr.write(m + "\n"));
    this.ctx = { dataDir: this.dataDir, log: (m) => log(this.sanitize(m)), invalidateAccount: () => this.invalidateAccount() };
    this.artifacts = new ArtifactStore({
      dir: path.join(this.dataDir, "artifacts"),
      outputRetentionMs: definition.retention?.outputMs,
      inputRetentionMs: definition.retention?.inputMs,
      now: this.now,
    });
    this.idempotency = new IdempotencyStore({
      dir: path.join(this.dataDir, "idempotency"),
      retentionMs: definition.retention?.keyMs,
      now: this.now,
      jobExists: async (id) => (await this.loadJob(id)) !== undefined,
    });
  }

  /** Adds strings that must never appear in responses or logs (the bearer token). */
  addSecret(secret: string): void {
    this.secretsList.push(secret);
  }

  private secrets(): string[] {
    return [...this.secretsList, ...(this.definition.secrets?.() ?? [])];
  }

  sanitize(message: string): string {
    return sanitizeMessage(message, this.secrets());
  }

  /** Deletes expired artifacts, jobs that ended past the retention with their keys, and orphaned keys. */
  async purge(): Promise<void> {
    await this.artifacts.purgeExpired();
    await this.purgeJobs();
    await this.idempotency.purge();
  }

  // -- HTTP ------------------------------------------------------------------------------------------

  async handle(req: IncomingMessage, res: ServerResponse, guard: RequestGuard): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://provider.invalid");
      if (!url.pathname.startsWith("/v1/")) {
        // Pages: Host and Origin are checked before the plugin sees the request (DNS rebinding).
        guard.page(req.headers);
        if (this.definition.extraRoutes && (await this.definition.extraRoutes(req, res, url, this.ctx))) {
          // A page such as the setup page may have changed the credentials.
          this.invalidateAccount();
          return;
        }
      }
      guard(req.headers);
      await this.route(req, res, url);
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const method = req.method ?? "GET";
    const allow = (methods: string[]) => {
      if (!methods.includes(method)) {
        throw new ProviderError(405, "method_not_allowed", `use ${methods.join(" or ")} for ${url.pathname}`, {
          headers: { Allow: methods.join(", ") },
        });
      }
    };
    if (parts[0] !== "v1") throw new ProviderError(404, "not_found", "unknown path");
    const [, a, b, c, ...rest] = parts;
    if (rest.length === 0) {
      if (a === "provider" && b === undefined) {
        allow(["GET"]);
        return this.sendJson(res, 200, await this.describe());
      }
      if (a === "models" && b === undefined) {
        allow(["GET"]);
        await this.requireReady();
        return this.sendJson(res, 200, await this.definition.catalog(this.ctx));
      }
      if (a === "artifacts" && b === undefined) {
        allow(["POST"]);
        return this.upload(req, res);
      }
      if (a === "artifacts" && b !== undefined && c === undefined) {
        allow(["GET"]);
        return this.sendJson(res, 200, ArtifactStore.toArtifact(await this.artifacts.require(b)));
      }
      if (a === "artifacts" && b !== undefined && c === "content") {
        allow(["GET"]);
        return this.download(req, res, b);
      }
      if (a === "jobs" && b === undefined) {
        allow(["POST"]);
        return this.createJob(req, res);
      }
      if (a === "jobs" && b !== undefined && c === undefined) {
        allow(["GET"]);
        // A known job is answered from storage also when the account is not ready.
        return this.sendJson(res, 200, (await this.isReady()) ? await this.getJob(b) : await this.storedJob(b));
      }
      if (a === "jobs" && b !== undefined && c === "cancel" && this.definition.capabilities.cancel && this.definition.upstream.cancel) {
        allow(["POST"]);
        return this.sendJson(res, 200, await this.cancelJob(b));
      }
      if (a === "estimates" && b === undefined && this.definition.capabilities.estimate && this.definition.upstream.estimate) {
        allow(["POST"]);
        return this.sendJson(res, 200, { estimate: await this.estimate(req) });
      }
      if (a === "setup" && b === undefined && this.definition.capabilities.setup && this.definition.setup) {
        allow(["POST"]);
        this.invalidateAccount();
        return this.sendJson(res, 200, await this.definition.setup({ ...this.ctx, port: this.port }));
      }
    }
    throw new ProviderError(404, "not_found", "unknown path");
  }

  sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
      ...headers,
    });
    res.end(text);
  }

  sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof ProviderError) {
      this.sendJson(res, err.status, err.toBody(this.secrets()), err.headers ?? {});
      return;
    }
    if (err instanceof NotSubmittedError) {
      this.sendJson(res, err.status, errorBody(err.code, err.message, { secrets: this.secrets() }));
      return;
    }
    this.ctx.log(`internal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    this.sendJson(res, 500, errorBody("internal_error", "the provider hit an internal error"));
  }

  // -- Provider and account --------------------------------------------------------------------------

  /**
   * The account, reusing a result younger than `accountCacheMs`. `fresh` always calls the definition
   * (a new submission: the binding scopes its key and must be current).
   */
  private account(fresh = false): Promise<Account> {
    const ttl = Math.max(0, this.definition.accountCacheMs ?? 5000);
    const cached = this.accountCache;
    if (!fresh && cached && this.now() - cached.at < ttl) return cached.account;
    const account = Promise.resolve().then(() => this.definition.account(this.ctx));
    const entry = { at: this.now(), account };
    this.accountCache = entry;
    // A failure is not cached.
    account.catch(() => {
      if (this.accountCache === entry) this.accountCache = undefined;
    });
    return account;
  }

  /** Drops the cached account; the next request calls `account()` again. */
  invalidateAccount(): void {
    this.accountCache = undefined;
  }

  async describe(): Promise<ProviderDescription> {
    const d = this.definition;
    const account = await this.account();
    const provider: ProviderDescription["provider"] = { id: d.id, name: d.name, version: d.version };
    if (d.repository) provider.repository = d.repository;
    return {
      protocol: { version: d.protocolVersion ?? "1.0" },
      provider,
      capabilities: d.capabilities,
      account,
      billing: { unit: d.billingUnit },
    };
  }

  private async requireReady(): Promise<Account> {
    const account = await this.account();
    if (account.status !== "ready") throw notReady(account);
    return account;
  }

  /** Whether the account is ready; false when the definition cannot tell. */
  private async isReady(): Promise<boolean> {
    try {
      return (await this.account()).status === "ready";
    } catch (err) {
      this.ctx.log(`account check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // -- Artifacts -------------------------------------------------------------------------------------

  private async upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const catalog = await this.definition.catalog(this.ctx);
    const maxBytes = this.definition.maxUploadBytes ?? largestMaxBytes(catalog) ?? DEFAULT_MAX_UPLOAD;
    const tmp = await this.artifacts.tempFile();
    const file = await parseUpload(req, { contentType: req.headers["content-type"], tempPath: tmp, maxBytes });
    try {
      const declared = file.mediaType ? normalizeMediaType(file.mediaType) : undefined;
      let mediaType = declared;
      if (!mediaType || mediaType === "application/octet-stream") {
        const head = Buffer.alloc(64);
        const handle = await fs.open(file.path, "r");
        try {
          await handle.read(head, 0, 64, 0);
        } finally {
          await handle.close();
        }
        mediaType = sniffMediaType(head) ?? mediaType ?? "application/octet-stream";
      }
      const metadata = await probeFileMetadata(file.path, mediaType).catch(() => undefined);
      const { artifact, created } = await this.artifacts.putFile(file.path, file.sha256, file.bytes, mediaType, {
        kind: "input",
        metadata,
      });
      this.sendJson(res, created ? 201 : 200, ArtifactStore.toArtifact(artifact));
    } finally {
      await fs.rm(file.path, { force: true });
    }
  }

  private async download(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const record = await this.artifacts.require(id);
    let range: { start: number; end: number } | undefined;
    const header = req.headers.range;
    if (header) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : record.bytes - Number(m[2]);
        let end = m[1] && m[2] ? Number(m[2]) : record.bytes - 1;
        start = Math.max(0, start);
        end = Math.min(end, record.bytes - 1);
        if (start > end || start >= record.bytes) {
          throw new ProviderError(416, "range_not_satisfiable", "the requested range is outside the artifact", {
            headers: { "Content-Range": `bytes */${record.bytes}` },
          });
        }
        range = { start, end };
      }
    }
    const { stream } = await this.artifacts.open(id, range);
    const headers: Record<string, string | number> = {
      "Content-Type": record.media_type,
      "Content-Length": range ? range.end - range.start + 1 : record.bytes,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${record.bytes}`;
    res.writeHead(range ? 206 : 200, headers);
    stream.pipe(res);
    await new Promise<void>((resolve) => {
      stream.on("error", () => {
        res.destroy();
        resolve();
      });
      res.on("close", () => {
        stream.destroy();
        resolve();
      });
      res.on("finish", () => resolve());
    });
  }

  // -- Jobs ------------------------------------------------------------------------------------------

  private jobFile(id: string): string {
    return path.join(this.dataDir, "jobs", `${id}.json`);
  }

  private async loadJob(id: string): Promise<JobRecord | undefined> {
    if (!JOB_ID.test(id)) return undefined;
    return readJsonFile<JobRecord>(this.jobFile(id));
  }

  private async saveJob(record: JobRecord): Promise<void> {
    await writeJsonAtomic(this.jobFile(record.job.id), record);
  }

  /** Serialises changes to one job. */
  private async withJob<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.jobLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => current);
    this.jobLocks.set(id, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.jobLocks.get(id) === chained) this.jobLocks.delete(id);
    }
  }

  private async updateJob(id: string, change: (record: JobRecord) => boolean | Promise<boolean>): Promise<JobRecord | undefined> {
    return this.withJob(id, async () => {
      const record = await this.loadJob(id);
      if (!record) return undefined;
      if (await change(record)) await this.saveJob(record);
      return record;
    });
  }

  private touch(job: Job): void {
    const now = new Date(this.now()).toISOString();
    job.updated_at = now > job.updated_at ? now : job.updated_at;
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_JSON_BODY) throw new ProviderError(413, "payload_too_large", "the request body is too large", { params: { max_bytes: MAX_JSON_BODY } });
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw invalidRequest("invalid_json", "the request body is not valid JSON");
    }
  }

  private checkRequestShape(body: unknown): JobRequest {
    const b = body as Partial<JobRequest> | null;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw invalidRequest("invalid_body", "the request body must be a JSON object");
    if (typeof b.model !== "string" || b.model === "") throw invalidRequest("invalid_body", "model is required");
    if (typeof b.route !== "string" || b.route === "") throw invalidRequest("invalid_body", "route is required");
    if (!b.input || typeof b.input !== "object" || !Array.isArray(b.input.artifacts)) {
      throw invalidRequest("invalid_body", "input.artifacts must be an array");
    }
    for (const a of b.input.artifacts) {
      if (!a || typeof a.artifact_id !== "string" || typeof a.role !== "string" || !Number.isInteger(a.position) || a.position < 0) {
        throw invalidRequest("invalid_body", "each input needs artifact_id, role and a non-negative integer position");
      }
    }
    if (!b.parameters || typeof b.parameters !== "object" || Array.isArray(b.parameters)) {
      throw invalidRequest("invalid_body", "parameters must be an object");
    }
    return b as JobRequest;
  }

  private async resolve(request: JobRequest): Promise<{ model: Model; route: Route; inputs: ResolvedInput[] }> {
    const catalog = await this.definition.catalog(this.ctx);
    const validated = await validateJobRequest(catalog, request, async (id) => {
      try {
        return ArtifactStore.toArtifact(await this.artifacts.require(id));
      } catch {
        return undefined;
      }
    });
    const counters = new Map<string, number>();
    const inputs: ResolvedInput[] = [];
    for (const { ref, artifact } of validated.inputs) {
      const kind = artifact.media_type.split("/")[0] ?? "";
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      const file = await this.artifacts.filePath(artifact.id);
      inputs.push({
        artifact,
        role: ref.role,
        position: ref.position,
        alias: `@${kind}${n}`,
        path: file,
        read: () => fs.readFile(file),
      });
    }
    return { model: validated.model, route: validated.route, inputs };
  }

  private async createJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = requireIdempotencyKey(req.headers["idempotency-key"]);
    const request = this.checkRequestShape(await this.readJsonBody(req));
    // The scope of a key is (account, key): include the binding. Without a binding it is unknown whether
    // the key is a replay, so the answer must be temporary (503), never a rejection.
    let account: Account | undefined;
    try {
      account = await this.account(true);
    } catch (err) {
      this.ctx.log(`account check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!account || typeof account.binding !== "string" || !BINDING.test(account.binding)) {
      throw new ProviderError(503, "upstream_unavailable", "the account binding is not available; retry later", { reason: "binding_unavailable" });
    }
    const ready = account.status === "ready";
    const scopedKey = `${account.binding}\n${key}`;
    const { status, job } = await this.idempotency.withKey(scopedKey, async () => {
      const existing = await this.idempotency.get(scopedKey);
      if (existing) {
        if (existing.body_sha256 !== IdempotencyStore.bodyHash(request)) {
          throw new ProviderError(409, "idempotency_conflict", "this Idempotency-Key was used with a different request body");
        }
        const record = await this.loadJob(existing.job_id);
        if (!record) throw new ProviderError(500, "internal_error", "the job for this Idempotency-Key is missing");
        // A known key is answered from storage when the account is not ready; the upstream is not asked.
        return { status: 200, job: ready ? await this.currentJob(record) : record.job };
      }
      if (!ready) throw notReady(account);
      const resolved = await this.resolve(request);
      const jobId = "job_" + randomBytes(12).toString("hex");
      const now = new Date(this.now()).toISOString();
      const record: JobRecord = {
        job: {
          id: jobId,
          status: "queued",
          model: request.model,
          route: request.route,
          created_at: now,
          updated_at: now,
          approval: null,
          outputs: [],
          error: null,
          usage: null,
        },
        request,
        key_sha256: IdempotencyStore.keyHash(scopedKey),
        client_reference: sha256Hex("client-reference\n" + scopedKey).slice(0, 32),
        submission: "submitting",
      };
      // The job first, then the key: a key never points at a missing job.
      await this.saveJob(record);
      await this.idempotency.begin(scopedKey, request, jobId);
      const outcome = await this.submitUpstream(record, resolved, scopedKey);
      switch (outcome.kind) {
        case "ok": {
          const saved = await this.loadJob(jobId);
          return { status: 201, job: saved!.job };
        }
        case "rejected":
        case "not_submitted":
          await this.idempotency.remove(scopedKey);
          await fs.rm(this.jobFile(jobId), { force: true });
          throw outcome.error;
        case "unknown":
          throw new ProviderError(502, "upstream_unavailable", "the upstream did not confirm the submission; replay with the same Idempotency-Key");
      }
    });
    this.sendJson(res, status, job);
  }

  /**
   * Calls `upstream.submit` and records the result. Resolves within `submitTimeoutMs`; a slower call
   * keeps running and records its result when it finishes, until `submitHardTimeoutMs` aborts it.
   */
  private submitUpstream(record: JobRecord, resolved: { model: Model; route: Route; inputs: ResolvedInput[] }, scopedKey: string): Promise<SubmitOutcome> {
    const controller = new AbortController();
    const jobId = record.job.id;
    // Set when the client got 502: from then on a replay may have handed out the job id.
    let answered = false;
    const work = (async (): Promise<SubmitOutcome> => {
      let outcome: SubmitOutcome;
      try {
        const { upstreamId } = await this.definition.upstream.submit({
          ...this.ctx,
          jobId,
          request: record.request,
          model: resolved.model,
          route: resolved.route,
          inputs: resolved.inputs,
          clientReference: record.client_reference,
          signal: controller.signal,
        });
        if (typeof upstreamId !== "string" || upstreamId === "") throw new Error("upstream.submit returned no upstreamId");
        await this.updateJob(jobId, (r) => {
          // After the hard timeout a replay may have ended the job already; keep that.
          if (r.submission !== "submitting") return false;
          r.upstream_id = upstreamId;
          r.submission = "submitted";
          return true;
        });
        await this.idempotency.settle(scopedKey, upstreamId);
        return { kind: "ok" };
      } catch (err) {
        if (err instanceof ProviderError && err.status >= 400 && err.status < 500) outcome = { kind: "rejected", error: err };
        else if (err instanceof NotSubmittedError) outcome = { kind: "not_submitted", error: err };
        else {
          this.ctx.log(`submission of ${jobId} has an unknown result: ${err instanceof Error ? err.message : String(err)}`);
          outcome = { kind: "unknown" };
        }
      }
      // Recorded before the call stops counting as running, so a replay waiting for it sees the result.
      if (answered) {
        await this.recordLate(jobId, scopedKey, outcome).catch((err) =>
          this.ctx.log(`recording the late result of ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      return outcome;
    })();
    const tracked: Promise<SubmitOutcome> = work.finally(() => {
      if (this.inflight.get(jobId) === tracked) this.inflight.delete(jobId);
    });
    this.inflight.set(jobId, tracked);
    const timeoutMs = this.definition.submitTimeoutMs ?? 20_000;
    const hardTimeoutMs = Math.max(this.definition.submitHardTimeoutMs ?? 10 * 60_000, timeoutMs);
    const hardTimer = setTimeout(() => {
      // Give up on the call: abort it and stop treating it as running, so a replay recovers the job.
      controller.abort();
      if (this.inflight.get(jobId) === tracked) this.inflight.delete(jobId);
    }, hardTimeoutMs);
    hardTimer.unref?.();
    void tracked.then(() => clearTimeout(hardTimer));
    return new Promise<SubmitOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // Answer the client (502) but let the call go on: it may still return the upstream id.
        answered = true;
        resolve({ kind: "unknown" });
      }, timeoutMs);
      timer.unref?.();
      void tracked.then((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  /**
   * Records a submission that ended without an upstream job after the client got 502. A replay may
   * have returned the job id since, so the job and its key are kept (v1.md section 3.5.4): the job ends
   * with the meaning of the error (v1.md section 3.5.2), and the client submits again with a new key.
   */
  private async recordLate(jobId: string, scopedKey: string, outcome: SubmitOutcome): Promise<void> {
    if (outcome.kind !== "rejected" && outcome.kind !== "not_submitted") return;
    const late =
      outcome.kind === "rejected"
        ? lateRejection(outcome.error)
        : { status: "failed" as const, error: { code: "upstream_failed", reason: "not_submitted", message: outcome.error.message } };
    await this.finish(jobId, late.status, late.error);
    await this.idempotency.settle(scopedKey, undefined).catch(() => undefined);
  }

  /** Ends a job that has no upstream result, keeping terminal states unchanged. */
  private async finish(jobId: string, status: JobStatus, error: ErrorObject): Promise<void> {
    await this.updateJob(jobId, (r) => {
      if (isTerminal(r.job.status)) return false;
      r.job.status = status;
      r.job.error = jobError(error.code, error.message, { reason: error.reason, params: error.params, secrets: this.secrets() });
      r.job.outputs = [];
      r.job.approval = null;
      if (status === "failed" && error.code === "submission_unknown") r.submission = "unknown";
      this.touch(r.job);
      return true;
    });
  }

  /**
   * Resolves a record whose submission has no upstream id: waits for a submission still running in this
   * process; otherwise (after a crash) looks the job up upstream, and ends it `submission_unknown` when
   * it cannot be found. Never submits again.
   */
  private async recover(record: JobRecord): Promise<JobRecord> {
    const jobId = record.job.id;
    const running = this.inflight.get(jobId);
    if (running) {
      const timeoutMs = this.definition.submitTimeoutMs ?? 20_000;
      await Promise.race([running, sleep(timeoutMs)]);
      return (await this.loadJob(jobId)) ?? record;
    }
    let upstreamId: string | null | undefined;
    if (this.definition.upstream.lookup) {
      try {
        upstreamId = await this.definition.upstream.lookup(record.client_reference, this.ctx);
      } catch (err) {
        this.ctx.log(`lookup for ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw new ProviderError(502, "upstream_unavailable", "could not check whether the upstream accepted this job; retry later");
      }
    }
    if (upstreamId) {
      const id = upstreamId;
      await this.updateJob(jobId, (r) => {
        if (r.submission !== "submitting") return false;
        r.upstream_id = id;
        r.submission = "submitted";
        return true;
      });
      await this.settleByHash(record.key_sha256, id);
    } else {
      await this.finish(jobId, "failed", {
        code: "submission_unknown",
        message: "the upstream may have accepted this job; it was not submitted again",
      });
      await this.settleByHash(record.key_sha256, undefined);
    }
    return (await this.loadJob(jobId)) ?? record;
  }

  private async settleByHash(keyHash: string, upstreamId: string | undefined): Promise<void> {
    const file = path.join(this.idempotency.dir, `${keyHash}.json`);
    const existing = await readJsonFile<Record<string, unknown>>(file);
    if (!existing) return;
    const updated = { ...existing, state: "submitted", updated_at: new Date(this.now()).toISOString() } as Record<string, unknown>;
    if (upstreamId !== undefined) updated.upstream_id = upstreamId;
    await writeJsonAtomic(file, updated);
  }

  /** The job after recovering or refreshing it from the upstream. */
  private async currentJob(record: JobRecord): Promise<Job> {
    let r = record;
    if (r.submission === "submitting" && !isTerminal(r.job.status)) r = await this.recover(r);
    if (!isTerminal(r.job.status) && r.upstream_id) {
      await this.refresh(r.job.id);
      r = (await this.loadJob(r.job.id)) ?? r;
    }
    return r.job;
  }

  async getJob(id: string): Promise<Job> {
    const record = await this.loadJob(id);
    if (!record) throw new ProviderError(404, "not_found", "unknown job");
    return this.currentJob(record);
  }

  /** The job as stored, without asking the upstream. */
  private async storedJob(id: string): Promise<Job> {
    const record = await this.loadJob(id);
    if (!record) throw new ProviderError(404, "not_found", "unknown job");
    return record.job;
  }

  /** Polls the upstream once (single flight per job) and waits up to `pollTimeoutMs` for it. */
  private async refresh(id: string): Promise<void> {
    let running = this.refreshing.get(id);
    if (!running) {
      running = this.pollAndApply(id)
        .catch((err) => this.ctx.log(`polling ${id} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.refreshing.delete(id));
      this.refreshing.set(id, running);
    }
    await Promise.race([running, sleep(this.definition.pollTimeoutMs ?? 1500)]);
  }

  private async pollAndApply(id: string): Promise<void> {
    const record = await this.loadJob(id);
    if (!record || isTerminal(record.job.status) || !record.upstream_id) return;
    const state = await this.definition.upstream.poll(record.upstream_id, { ...this.ctx, jobId: id, request: record.request });
    let outputs: Job["outputs"];
    let failure: ErrorObject | undefined;
    if (state.status === "succeeded") {
      try {
        outputs = await this.storeOutputs(state.outputs ?? [], record);
      } catch (err) {
        if (err instanceof InvalidOutputError) failure = { code: "upstream_failed", message: err.message };
        else throw err; // A download problem: try again on the next query.
      }
    }
    await this.updateJob(id, (r) => applyState(r.job, state, outputs, failure, () => this.touch(r.job), this.secrets()));
  }

  private async storeOutputs(outputs: UpstreamOutput[], record: JobRecord): Promise<Job["outputs"]> {
    // v1: a generation route has exactly one `output`, a transcription exactly one `transcript`.
    const first = outputs[0];
    if (!first) throw new InvalidOutputError("the upstream reported success without an output");
    const data = typeof first.data === "function" ? await first.data() : first.data;
    const mediaType = normalizeMediaType(first.mediaType);
    const role = first.role ?? (mediaType === TRANSCRIPT_MEDIA_TYPE ? "transcript" : "output");
    let bytes: Uint8Array = data;
    let metadata = first.metadata;
    if (mediaType === TRANSCRIPT_MEDIA_TYPE) {
      let transcript: Transcript;
      try {
        transcript = JSON.parse(Buffer.from(data).toString("utf8")) as Transcript;
      } catch {
        throw new InvalidOutputError("the upstream returned a transcript that is not JSON");
      }
      const durationMs = await this.inputDuration(record);
      // Normalising a malformed transcript (no segments, a unit without text) throws. Any other error
      // means "try again on the next query", so the job would never end: it is an invalid output.
      try {
        transcript = normalizeTranscript(transcript, durationMs !== undefined ? { durationMs } : {});
      } catch (err) {
        throw new InvalidOutputError(`the upstream returned an invalid transcript: ${err instanceof Error ? err.message : String(err)}`);
      }
      const problems = validateTranscript(transcript, { durationMs });
      if (problems.length > 0) {
        throw new InvalidOutputError(`the upstream returned an invalid transcript: ${problems[0]!.path} ${problems[0]!.message}`);
      }
      bytes = Buffer.from(JSON.stringify(transcript));
    } else {
      if (bytes.byteLength === 0) throw new InvalidOutputError("the upstream returned an empty output");
      const sniffed = sniffMediaType(bytes);
      if (sniffed && sniffed !== mediaType) throw new InvalidOutputError(`the upstream output is ${sniffed}, not ${mediaType}`);
      metadata = { ...probeMetadata(bytes, mediaType), ...metadata };
    }
    const { artifact } = await this.artifacts.put(bytes, mediaType, { kind: "output", metadata });
    const out: NonNullable<Job["outputs"]>[number] = {
      artifact_id: artifact.id,
      role,
      media_type: artifact.media_type,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    };
    if (artifact.metadata && Object.keys(artifact.metadata).length > 0) out.metadata = artifact.metadata;
    return [out];
  }

  private async inputDuration(record: JobRecord): Promise<number | undefined> {
    for (const input of record.request.input.artifacts) {
      const a = await this.artifacts.find(input.artifact_id);
      if (a?.media_type.startsWith("audio/") && a.metadata?.duration_ms !== undefined) return a.metadata.duration_ms;
    }
    return undefined;
  }

  async cancelJob(id: string): Promise<Job> {
    let record = await this.loadJob(id);
    if (!record) throw new ProviderError(404, "not_found", "unknown job");
    if (isTerminal(record.job.status)) return record.job;
    // Cancelling a job that has not ended needs the upstream.
    if (!(await this.isReady())) throw new ProviderError(403, "provider_not_ready", "the provider needs setup");
    if (record.submission === "submitting") record = await this.recover(record);
    if (isTerminal(record.job.status) || !record.upstream_id) return record.job;
    try {
      await this.definition.upstream.cancel!(record.upstream_id, { ...this.ctx, jobId: id, request: record.request });
    } catch (err) {
      this.ctx.log(`cancelling ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refresh(id);
    return ((await this.loadJob(id)) ?? record).job;
  }

  /**
   * Deletes jobs that ended more than `retention.jobMs` (at least 30 days) ago, each together with its
   * key, under the key's lock: a replay waits and then finds neither, so it is a new submission. Jobs
   * that have not ended are kept.
   */
  private async purgeJobs(): Promise<number> {
    const retentionMs = Math.max(this.definition.retention?.jobMs ?? MIN_JOB_RETENTION_MS, MIN_JOB_RETENTION_MS);
    const due = (r: JobRecord) => isTerminal(r.job.status) && Date.parse(r.job.updated_at) + retentionMs < this.now();
    let removed = 0;
    for (const name of await fs.readdir(path.join(this.dataDir, "jobs")).catch(() => [] as string[])) {
      const id = /^(job_[0-9a-f]{24})\.json$/.exec(name)?.[1];
      if (!id) continue;
      const record = await this.loadJob(id).catch(() => undefined);
      if (!record || !due(record)) continue;
      await this.idempotency.withKeyHash(record.key_sha256, () =>
        this.withJob(id, async () => {
          const current = await this.loadJob(id);
          if (!current || !due(current)) return;
          // The key first: a key never points at a missing job.
          await this.idempotency.removeHash(current.key_sha256, id);
          await fs.rm(this.jobFile(id), { force: true });
          removed++;
        }),
      );
    }
    return removed;
  }

  private async estimate(req: IncomingMessage): Promise<Estimate> {
    const request = this.checkRequestShape(await this.readJsonBody(req));
    await this.requireReady();
    const resolved = await this.resolve(request);
    return this.definition.upstream.estimate!({ ...this.ctx, request, ...resolved });
  }
}

class InvalidOutputError extends Error {}

const BINDING = /^[0-9a-fA-F]{64}$/;

/**
 * The job state for a 4xx from `submit` that arrived after the client got 502 (v1.md section 3.5.2).
 * The original status, code and reason go into `params`.
 */
function lateRejection(err: ProviderError): { status: JobStatus; error: ErrorObject } {
  const params: Record<string, unknown> = { ...err.params, original_status: err.status, original_code: err.code };
  if (err.reason) params.original_reason = err.reason;
  const failed = (code: string, reason?: string) => ({ status: "failed" as const, error: { code, reason, message: err.message, params } });
  if (err.status === 422 && err.code === "content_moderated") {
    // Moderation at submission; v1.md section 3.10.
    return { status: "rejected", error: { code: "content_moderated", message: err.message, params: { stage: "input", source: "upstream", ...params } } };
  }
  if (err.status === 402) return failed("insufficient_credits");
  if (err.status === 403) return failed(err.code, err.reason);
  // Temporary (v1.md section 3.8): the upstream did not take the job, as with NotSubmittedError.
  if (err.status === 429) return failed("upstream_failed", "not_submitted");
  return failed("invalid_input");
}

function notReady(account: Account): ProviderError {
  return new ProviderError(403, "provider_not_ready", `the provider needs setup (account status ${account.status})`);
}

/**
 * Applies an upstream state to a job; returns whether anything changed. A transition the state machine
 * does not allow is ignored, except into a terminal state: the upstream job has ended, so the job ends
 * `failed` with `upstream_failed` rather than waiting for a state that will never come.
 */
function applyState(
  job: Job,
  state: UpstreamState,
  outputs: Job["outputs"],
  failure: ErrorObject | undefined,
  touch: () => void,
  secrets: readonly string[],
): boolean {
  if (isTerminal(job.status)) return false;
  let next: JobStatus = failure ? "failed" : state.status;
  if (!JOB_STATUSES.includes(next)) return false;
  if (next !== job.status && !TRANSITIONS[job.status].includes(next)) {
    if (!isTerminal(next)) {
      next = job.status;
    } else {
      const params: Record<string, unknown> = { upstream_status: next };
      if (state.error?.code) params.upstream_code = state.error.code;
      params.previous_status = job.status;
      failure = { code: "upstream_failed", message: `the upstream reported ${next} for a job that was ${job.status}`, params };
      next = "failed";
    }
  }
  const before = JSON.stringify(job);
  job.status = next;
  if (state.progress !== undefined && Number.isFinite(state.progress)) {
    job.progress = { percent: Math.min(100, Math.max(0, state.progress)) };
  }
  job.approval = next === "pending_approval" ? state.approval ?? job.approval ?? { policy: "upstream", deadline: new Date(Date.now() + 86_400_000).toISOString() } : null;
  if (next === "succeeded") {
    job.outputs = outputs ?? [];
    job.error = null;
    if (job.progress) job.progress = { percent: 100 };
  } else {
    job.outputs = [];
    if (isTerminal(next)) {
      const fallback = DEFAULT_ERRORS[next]!;
      // A rejection without a reason is assumed to be moderation; say that it was inferred (v1.md 3.10).
      const assumed: ErrorObject = { code: fallback[0], message: fallback[1] };
      if (next === "rejected") assumed.params = { inferred: true };
      const e = failure ?? state.error ?? assumed;
      job.error = jobError(e.code, e.message, { reason: e.reason, params: e.params, secrets });
    }
  }
  if (state.usage) job.usage = state.usage;
  if (state.warnings && state.warnings.length > 0) {
    const all = [...(job.warnings ?? [])];
    for (const w of state.warnings) {
      const warning = { code: w.code, message: sanitizeMessage(w.message, secrets) };
      if (!all.some((x) => x.code === warning.code && x.message === warning.message)) all.push(warning);
    }
    job.warnings = all;
  }
  const changed = JSON.stringify(job) !== before;
  if (changed) touch();
  return changed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

// ---------------------------------------------------------------------------------------------------
// Serving.

export interface HandlerOptions {
  dataDir: string;
  /** The bearer token clients must send. */
  token: string;
  /** Accepted Host values. */
  allowedHosts: string[];
  /** Accepted `Origin` values on pages outside `/v1/`. Default: `http://<host>` for each allowed host. */
  pageOrigins?: string[];
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * A request handler for the protocol, for embedding in your own server or for tests. `runProvider`
 * uses it.
 */
export function createProviderHandler(definition: ProviderDefinition, options: HandlerOptions): {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  runtime: ProviderRuntime;
} {
  const runtime = new ProviderRuntime(definition, { dataDir: options.dataDir, log: options.log, now: options.now });
  runtime.addSecret(options.token);
  const guard = createRequestGuard({ token: options.token, allowedHosts: options.allowedHosts, pageOrigins: options.pageOrigins });
  return {
    runtime,
    handler: (req, res) => {
      void runtime.handle(req, res, guard);
    },
  };
}

export interface RunOptions {
  /** Default: `CUELOR_PROVIDER_DATA_DIR`. */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Called instead of `process.exit` when stdin closes. */
  exit?: (code: number) => void;
}

export interface RunningProvider {
  server: http.Server;
  port: number;
  runtime: ProviderRuntime;
  close(): Promise<void>;
}

/**
 * Runs a provider. In the command form (the default) it reads the token from stdin, listens on
 * `127.0.0.1:0`, prints `cuelor-provider-listening port=N` and exits when stdin closes
 * (plugins.md section 2). With `CUELOR_PROVIDER_LISTEN` it runs as a self-hosted service instead (see
 * `listenModeFromEnv`).
 *
 * One data directory serves one instance: it takes the directory's `instance.lock` first and fails to
 * start while another running instance holds it (`acquireInstanceLock`).
 */
export async function runProvider(definition: ProviderDefinition, options: RunOptions = {}): Promise<RunningProvider> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const dataDir = options.dataDir ?? env.CUELOR_PROVIDER_DATA_DIR;
  if (!dataDir) throw new Error("CUELOR_PROVIDER_DATA_DIR is not set");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const mode = listenModeFromEnv(env);
  const lock = await acquireInstanceLock(dataDir);
  process.once("exit", () => lock.releaseSync());
  try {
    return await serve(definition, { log, exit, dataDir, mode, release: () => lock.release() });
  } catch (err) {
    await lock.release();
    throw err;
  }
}

async function serve(
  definition: ProviderDefinition,
  o: { log: (m: string) => void; exit: (code: number) => void; dataDir: string; mode: ListenMode; release: () => Promise<void> },
): Promise<RunningProvider> {
  const { log, exit, dataDir, mode } = o;
  let token: string;
  let host: string;
  let port: number;
  if (mode.kind === "command") {
    token = await readHandshakeToken(process.stdin);
    host = "127.0.0.1";
    port = 0;
  } else {
    token = await readTokenFile(mode.tokenFile);
    host = mode.host;
    port = mode.port;
  }

  const runtime = new ProviderRuntime(definition, { dataDir, log });
  runtime.addSecret(token);
  const starting = () => {
    throw new ProviderError(503, "internal_error", "starting");
  };
  let guard: RequestGuard = Object.assign(starting, { page: starting });
  const server = http.createServer((req, res) => {
    void runtime.handle(req, res, guard);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = (server.address() as AddressInfo).port;
  runtime.port = actualPort;
  const allowedHosts =
    mode.kind === "command"
      ? [`127.0.0.1:${actualPort}`]
      : mode.allowedHosts.length > 0
        ? mode.allowedHosts
        : [`${host.includes(":") ? `[${host}]` : host}:${actualPort}`];
  // A self-hosted service may sit behind a proxy that terminates TLS, so its own origin can be https.
  const pageOrigins = mode.kind === "command" ? undefined : allowedHosts.flatMap((h) => [`http://${h}`, `https://${h}`]);
  guard = createRequestGuard({ token, allowedHosts, pageOrigins });

  const purge = () => void runtime.purge().catch((err) => log(`purge failed: ${err instanceof Error ? err.message : String(err)}`));
  purge();
  const purgeTimer = setInterval(purge, 6 * 60 * 60 * 1000);
  purgeTimer.unref();

  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(purgeTimer);
      server.close(() => resolve());
      server.closeAllConnections?.();
    }).then(() => o.release());

  if (mode.kind === "command") {
    announcePort(actualPort);
    onStdinClosed(() => exit(0));
  } else {
    log(`listening on ${host}:${actualPort}`);
  }
  process.once("SIGTERM", () => exit(0));
  return { server, port: actualPort, runtime, close };
}
