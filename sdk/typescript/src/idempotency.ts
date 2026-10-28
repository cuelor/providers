import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-file.ts";
import { jsonHash, sha256Hex } from "./canonical-json.ts";
import { invalidRequest } from "./errors.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Idempotency keys are kept at least this long (v1.md section 3.5.2). */
export const MIN_KEY_RETENTION_MS = 30 * DAY_MS;

/** `Idempotency-Key`: 1 to 128 visible ASCII characters. */
export function isValidIdempotencyKey(key: string): boolean {
  return /^[!-~]{1,128}$/.test(key);
}

/** Throws 400 when the header is missing or malformed. */
export function requireIdempotencyKey(value: string | string[] | undefined): string {
  if (value === undefined || value === "") {
    throw invalidRequest("missing_idempotency_key", "the Idempotency-Key header is required");
  }
  const key = Array.isArray(value) ? value[0] ?? "" : value;
  if (Array.isArray(value) && value.length > 1) {
    throw invalidRequest("invalid_idempotency_key", "send exactly one Idempotency-Key header");
  }
  if (!isValidIdempotencyKey(key)) {
    throw invalidRequest("invalid_idempotency_key", "Idempotency-Key must be 1 to 128 visible ASCII characters");
  }
  return key;
}

/**
 * The state of a key (plugins.md section 4):
 *
 * - `submitting`: recorded before calling the upstream; no upstream id yet.
 * - `submitted`: the upstream id is known, or the job was ended without one (`submission_unknown`).
 */
export type IdempotencyState = "submitting" | "submitted";

export interface IdempotencyRecord {
  /** SHA-256 of the key; the key itself is not stored. */
  key_sha256: string;
  /** SHA-256 of the canonical JSON body. */
  body_sha256: string;
  job_id: string;
  upstream_id?: string;
  state: IdempotencyState;
  created_at: string;
  updated_at: string;
}

export type BeginResult =
  | { kind: "new"; record: IdempotencyRecord }
  | { kind: "existing"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord };

/**
 * Persistent idempotency records, one file per key, written atomically (temporary file, fsync, rename).
 * Files rather than SQLite keep the SDK free of native or experimental modules.
 *
 * Callers serialise work on one key with `withKey`, so a replay that arrives while the first request is
 * still running waits for it.
 */
export class IdempotencyStore {
  readonly dir: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly jobExists: ((jobId: string) => Promise<boolean>) | undefined;
  private readonly locks = new Map<string, Promise<void>>();

  /**
   * `jobExists` tells whether a key's job still exists. Keys are kept for the retention **or until the
   * job is deleted, whichever is longer** (v1.md section 3.5.2): a key whose job exists never expires.
   * Without it, keys expire after the retention.
   */
  constructor(options: { dir: string; retentionMs?: number; now?: () => number; jobExists?: (jobId: string) => Promise<boolean> }) {
    this.dir = options.dir;
    this.retentionMs = Math.max(options.retentionMs ?? MIN_KEY_RETENTION_MS, MIN_KEY_RETENTION_MS);
    this.now = options.now ?? Date.now;
    this.jobExists = options.jobExists;
  }

  private async expired(record: IdempotencyRecord): Promise<boolean> {
    if (Date.parse(record.created_at) + this.retentionMs >= this.now()) return false;
    return !(this.jobExists && (await this.jobExists(record.job_id)));
  }

  static keyHash(key: string): string {
    return sha256Hex("idempotency-key\n" + key);
  }

  static bodyHash(body: unknown): string {
    return jsonHash(body);
  }

  private file(key: string): string {
    return path.join(this.dir, `${IdempotencyStore.keyHash(key)}.json`);
  }

  /** Runs `fn` with an in-process lock on `key`. */
  withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.withKeyHash(IdempotencyStore.keyHash(key), fn);
  }

  /** `withKey` for a key known only by its hash (`keyHash`), as job records store it. */
  async withKeyHash<T>(h: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(h) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => current);
    this.locks.set(h, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(h) === chained) this.locks.delete(h);
    }
  }

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    const record = await readJsonFile<IdempotencyRecord>(this.file(key));
    if (record && (await this.expired(record))) return undefined;
    return record;
  }

  /**
   * Looks the key up. A new key gets a `submitting` record for `jobId` (persisted before returning); a
   * known key with the same body returns the existing record; a different body is a conflict.
   */
  async begin(key: string, body: unknown, jobId: string): Promise<BeginResult> {
    const bodySha = IdempotencyStore.bodyHash(body);
    const existing = await this.get(key);
    if (existing) return { kind: existing.body_sha256 === bodySha ? "existing" : "conflict", record: existing };
    const now = new Date(this.now()).toISOString();
    const record: IdempotencyRecord = {
      key_sha256: IdempotencyStore.keyHash(key),
      body_sha256: bodySha,
      job_id: jobId,
      state: "submitting",
      created_at: now,
      updated_at: now,
    };
    await writeJsonAtomic(this.file(key), record);
    return { kind: "new", record };
  }

  /** Records the outcome of the submission. */
  async settle(key: string, upstreamId: string | undefined): Promise<IdempotencyRecord> {
    const record = await readJsonFile<IdempotencyRecord>(this.file(key));
    if (!record) throw new Error("no idempotency record for this key");
    const updated: IdempotencyRecord = { ...record, state: "submitted", updated_at: new Date(this.now()).toISOString() };
    if (upstreamId !== undefined) updated.upstream_id = upstreamId;
    await writeJsonAtomic(this.file(key), updated);
    return updated;
  }

  /** Forgets a key: only when it is certain no upstream job was created. */
  async remove(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }

  /** Forgets a key known only by its hash when it still points at `jobId`; call it inside `withKeyHash`. */
  async removeHash(h: string, jobId: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(h)) return;
    const file = path.join(this.dir, `${h}.json`);
    const record = await readJsonFile<IdempotencyRecord>(file).catch(() => undefined);
    if (record?.job_id === jobId) await fs.rm(file, { force: true });
  }

  /** Deletes records older than the retention whose job no longer exists. */
  async purge(): Promise<number> {
    let removed = 0;
    for (const name of await fs.readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      const record = await readJsonFile<IdempotencyRecord>(file).catch(() => undefined);
      if (record && (await this.expired(record))) {
        await fs.rm(file, { force: true });
        removed++;
      }
    }
    return removed;
  }
}
