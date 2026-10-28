import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { readJsonFile, syncDir, writeJsonAtomic } from "./atomic-file.ts";
import { sha256Hex } from "./canonical-json.ts";
import { ProviderError } from "./errors.ts";
import { normalizeMediaType } from "./media.ts";
import type { Artifact, ArtifactMetadata } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Output artifacts are kept at least this long after their job succeeded (v1.md section 3.4). */
export const MIN_OUTPUT_RETENTION_MS = 7 * DAY_MS;

export interface ArtifactRecord extends Artifact {
  kind: "input" | "output";
  created_at: string;
  expires_at: string;
}

export interface ArtifactStoreOptions {
  /** Where to keep the files; usually `<data dir>/artifacts`. */
  dir: string;
  /** How long outputs are kept after they are stored. At least 7 days; default 7 days. */
  outputRetentionMs?: number;
  /** How long inputs are kept after their last upload. Default 30 days. */
  inputRetentionMs?: number;
  now?: () => number;
}

/**
 * A content-addressed artifact store. Bytes are stored once per SHA-256; the id is derived from the
 * SHA-256 and the canonical media type, so the same bytes with the same type always get the same id
 * (v1.md section 3.4), also across restarts. Expired artifacts answer 410 `artifact_expired`.
 */
export class ArtifactStore {
  readonly dir: string;
  private readonly outputRetentionMs: number;
  private readonly inputRetentionMs: number;
  private readonly now: () => number;

  constructor(options: ArtifactStoreOptions) {
    this.dir = options.dir;
    this.outputRetentionMs = Math.max(options.outputRetentionMs ?? MIN_OUTPUT_RETENTION_MS, MIN_OUTPUT_RETENTION_MS);
    this.inputRetentionMs = options.inputRetentionMs ?? 30 * DAY_MS;
    this.now = options.now ?? Date.now;
  }

  /** The artifact id for some bytes and a media type. */
  static idFor(sha256: string, mediaType: string): string {
    return "art_" + sha256Hex(normalizeMediaType(mediaType) + "\n" + sha256.toLowerCase()).slice(0, 32);
  }

  private blobPath(sha256: string): string {
    return path.join(this.dir, "blobs", sha256);
  }

  private metaPath(id: string): string {
    if (!/^art_[0-9a-f]{32}$/.test(id)) throw new Error("invalid artifact id");
    return path.join(this.dir, "meta", `${id}.json`);
  }

  /** Stores bytes. Returns the record and whether it already existed. */
  async put(
    data: Uint8Array,
    mediaType: string,
    options: { kind?: "input" | "output"; metadata?: ArtifactMetadata } = {},
  ): Promise<{ artifact: ArtifactRecord; created: boolean }> {
    const sha256 = sha256Hex(data);
    const blob = this.blobPath(sha256);
    if (!(await exists(blob))) {
      const tmp = await this.tempFile();
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await this.commitBlob(tmp, sha256);
    }
    return this.record(sha256, data.byteLength, mediaType, options);
  }

  /** A path for streaming an upload into the store, then `putFile`. */
  async tempFile(): Promise<string> {
    const dir = path.join(this.dir, "tmp");
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, `${randomBytes(8).toString("hex")}.part`);
  }

  /** Moves a fully written temporary file (from `tempFile`) into the store. */
  async putFile(
    tmp: string,
    sha256: string,
    bytes: number,
    mediaType: string,
    options: { kind?: "input" | "output"; metadata?: ArtifactMetadata } = {},
  ): Promise<{ artifact: ArtifactRecord; created: boolean }> {
    if (await exists(this.blobPath(sha256))) await fs.rm(tmp, { force: true });
    else await this.commitBlob(tmp, sha256);
    return this.record(sha256, bytes, mediaType, options);
  }

  private async commitBlob(tmp: string, sha256: string): Promise<void> {
    const handle = await fs.open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const dir = path.dirname(this.blobPath(sha256));
    await fs.mkdir(dir, { recursive: true });
    await fs.rename(tmp, this.blobPath(sha256));
    await syncDir(dir);
  }

  private async record(
    sha256: string,
    bytes: number,
    mediaType: string,
    options: { kind?: "input" | "output"; metadata?: ArtifactMetadata },
  ): Promise<{ artifact: ArtifactRecord; created: boolean }> {
    const media_type = normalizeMediaType(mediaType);
    const id = ArtifactStore.idFor(sha256, media_type);
    const kind = options.kind ?? "input";
    const now = this.now();
    const retention = kind === "output" ? this.outputRetentionMs : this.inputRetentionMs;
    const existing = await readJsonFile<ArtifactRecord>(this.metaPath(id));
    const expires = new Date(now + retention).toISOString();
    if (existing) {
      // Extend the retention: an existing artifact is kept at least as long as a new one would be.
      const updated: ArtifactRecord = {
        ...existing,
        kind: existing.kind === "output" || kind === "output" ? "output" : "input",
        expires_at: existing.expires_at > expires ? existing.expires_at : expires,
        metadata: existing.metadata ?? options.metadata,
      };
      if (updated.metadata === undefined) delete updated.metadata;
      await writeJsonAtomic(this.metaPath(id), updated);
      return { artifact: updated, created: false };
    }
    const artifact: ArtifactRecord = {
      id,
      media_type,
      bytes,
      sha256,
      kind,
      created_at: new Date(now).toISOString(),
      expires_at: expires,
    };
    if (options.metadata && Object.keys(options.metadata).length > 0) artifact.metadata = options.metadata;
    await writeJsonAtomic(this.metaPath(id), artifact);
    return { artifact, created: true };
  }

  /** The record, or `undefined` when unknown. Does not check expiry. */
  async find(id: string): Promise<ArtifactRecord | undefined> {
    if (!/^art_[0-9a-f]{32}$/.test(id)) return undefined;
    return readJsonFile<ArtifactRecord>(this.metaPath(id));
  }

  /** The record of a usable artifact; throws 404 `not_found` or 410 `artifact_expired`. */
  async require(id: string): Promise<ArtifactRecord> {
    const record = await this.find(id);
    if (!record || !(await exists(this.blobPath(record.sha256)))) {
      throw new ProviderError(404, "not_found", `unknown artifact ${truncateId(id)}`);
    }
    if (Date.parse(record.expires_at) <= this.now()) {
      throw new ProviderError(410, "artifact_expired", `artifact ${record.id} has expired`);
    }
    return record;
  }

  /** The public artifact object (without the store's own fields). */
  static toArtifact(record: ArtifactRecord): Artifact {
    const { kind: _kind, ...artifact } = record;
    return artifact;
  }

  /** Opens the bytes, optionally a byte range (inclusive end). */
  async open(id: string, range?: { start: number; end: number }): Promise<{ record: ArtifactRecord; stream: Readable }> {
    const record = await this.require(id);
    const stream = createReadStream(this.blobPath(record.sha256), range ? { start: range.start, end: range.end } : {});
    return { record, stream };
  }

  async readBytes(id: string): Promise<Buffer> {
    const record = await this.require(id);
    return fs.readFile(this.blobPath(record.sha256));
  }

  /** The file holding an artifact's bytes, for adapters that upload inputs from disk. */
  async filePath(id: string): Promise<string> {
    const record = await this.require(id);
    return this.blobPath(record.sha256);
  }

  /** Deletes records that expired more than `graceMs` ago and blobs no record uses. */
  async purgeExpired(graceMs = DAY_MS): Promise<number> {
    const metaDir = path.join(this.dir, "meta");
    let names: string[];
    try {
      names = await fs.readdir(metaDir);
    } catch {
      return 0;
    }
    const keep = new Set<string>();
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = await readJsonFile<ArtifactRecord>(path.join(metaDir, name)).catch(() => undefined);
      if (!record) continue;
      if (Date.parse(record.expires_at) + graceMs < this.now()) {
        await fs.rm(path.join(metaDir, name), { force: true });
        removed++;
      } else {
        keep.add(record.sha256);
      }
    }
    for (const blob of await fs.readdir(path.join(this.dir, "blobs")).catch(() => [] as string[])) {
      if (!keep.has(blob)) await fs.rm(path.join(this.dir, "blobs", blob), { force: true });
    }
    return removed;
  }
}

/** Streams data to a file while hashing it. */
export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function truncateId(id: string): string {
  return id.length > 80 ? id.slice(0, 80) + "…" : id;
}
