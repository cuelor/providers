// Jobs for OpenRouter's synchronous endpoints (images, transcription). The protocol wants a job at once
// (v1.md section 3.1), so the plugin records a local job, answers with its id, and makes the call in the
// background. The record and the result are on disk before the SDK asks for them, so a finished result
// survives a crash. A call that was running when the plugin died cannot be resumed: OpenRouter has no
// way to look it up, and it may have been charged.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeFileAtomic, writeJsonAtomic, type ArtifactMetadata, type ErrorObject, type UpstreamState, type Usage, type Warning } from "@cuelor/provider-sdk";

export type LocalKind = "image" | "transcription";

export type Outcome =
  | { status: "succeeded"; output: { bytes: Uint8Array; mediaType: string; metadata?: ArtifactMetadata }; usage?: Usage; warnings?: Warning[] }
  | { status: "failed" | "rejected"; error: ErrorObject; usage?: Usage; warnings?: Warning[] };

interface LocalRecord {
  id: string;
  kind: LocalKind;
  client_reference: string;
  state: "running" | "succeeded" | "failed" | "rejected";
  created_at: string;
  finished_at?: string;
  media_type?: string;
  metadata?: ArtifactMetadata;
  error?: ErrorObject;
  usage?: Usage;
  warnings?: Warning[];
  /** The estimated price, reported as usage when the call was cut short and may have been charged. */
  estimate?: Usage;
}

const ID = /^local-(image|transcription)-[0-9a-f]{24}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class LocalJobs {
  readonly dir: string;
  private readonly running = new Map<string, Promise<void>>();
  /** Jobs whose result could not be written, with the state they ended in (until the plugin stops). */
  private readonly unstored = new Map<string, Outcome>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private purged = false;

  constructor(o: { dir: string; now?: () => number; log?: (message: string) => void }) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => undefined);
  }

  static isLocalId(id: string): boolean {
    return ID.test(id);
  }

  private file(id: string, ext = "json"): string {
    if (!ID.test(id)) throw new Error("not a local job id");
    return path.join(this.dir, `${id}.${ext}`);
  }

  /**
   * Records a job and starts `call` in the background. The record is on disk before the call starts, so
   * `lookup` finds it after a crash.
   */
  async start(kind: LocalKind, clientReference: string, call: () => Promise<Outcome>, estimate?: Usage): Promise<string> {
    if (!this.purged) {
      this.purged = true;
      void this.purge().catch(() => undefined);
    }
    const id = `local-${kind}-${randomBytes(12).toString("hex")}`;
    const record: LocalRecord = { id, kind, client_reference: clientReference, state: "running", created_at: new Date(this.now()).toISOString(), ...(estimate ? { estimate } : {}) };
    await writeJsonAtomic(this.file(id), record);
    const run = (async () => {
      let outcome: Outcome;
      try {
        outcome = await call();
      } catch (err) {
        outcome = { status: "failed", error: { code: "upstream_failed", message: err instanceof Error ? err.message : String(err) } };
      }
      try {
        await this.finish(record, outcome);
      } catch (err) {
        // A full or read-only disk must not crash the plugin. The job ends failed (OpenRouter's usage is
        // kept: it may have charged), in memory, and on disk if the small record can still be written.
        this.log(`could not store the result of ${id}: ${err instanceof Error ? err.message : String(err)}`);
        const failed: Outcome = {
          status: "failed",
          error: { code: "upstream_failed", reason: "result_not_stored", message: "the plugin could not store the result on disk" },
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        };
        this.unstored.set(id, failed);
        await this.finish(record, failed).catch(() => undefined);
      }
    })().finally(() => this.running.delete(id));
    this.running.set(id, run);
    return id;
  }

  private async finish(record: LocalRecord, outcome: Outcome): Promise<void> {
    const done: LocalRecord = { ...record, state: outcome.status, finished_at: new Date(this.now()).toISOString() };
    if (outcome.usage) done.usage = outcome.usage;
    if (outcome.warnings?.length) done.warnings = outcome.warnings;
    if (outcome.status === "succeeded") {
      // The bytes first: a record that says succeeded always has its output.
      await writeFileAtomic(this.file(record.id, "out"), outcome.output.bytes);
      done.media_type = outcome.output.mediaType;
      if (outcome.output.metadata) done.metadata = outcome.output.metadata;
    } else {
      done.error = outcome.error;
    }
    await writeJsonAtomic(this.file(record.id), done);
  }

  /** Waits for the background calls (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  async find(clientReference: string): Promise<string | null> {
    for (const name of await fs.readdir(this.dir).catch(() => [] as string[])) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!ID.test(id)) continue;
      const r = await readJsonFile<LocalRecord>(this.file(id)).catch(() => undefined);
      if (r?.client_reference === clientReference) return id;
    }
    return null;
  }

  /** Reads a job's record (a separate method so tests can interleave with it). */
  protected async readRecord(id: string): Promise<LocalRecord | undefined> {
    return readJsonFile<LocalRecord>(this.file(id)).catch(() => undefined);
  }

  async state(id: string): Promise<UpstreamState> {
    // Running is checked before the record is read: a job leaves `running` only after its record was
    // written, so a record read afterwards is final. (Read first, a job that ended in between would look
    // interrupted.)
    if (this.running.has(id)) return { status: "running" };
    const lost = this.unstored.get(id);
    if (lost && lost.status !== "succeeded") return { status: lost.status, error: lost.error, ...(lost.usage ? { usage: lost.usage } : {}) };
    const r = await this.readRecord(id);
    if (!r) return { status: "failed", error: { code: "upstream_failed", message: "the plugin lost the record of this job" } };
    const common = { ...(r.usage ? { usage: r.usage } : {}), ...(r.warnings ? { warnings: r.warnings } : {}) };
    switch (r.state) {
      case "running":
        // Not running in this process: the plugin stopped during the call. Whether OpenRouter ran and charged it is unknown.
        return {
          status: "failed",
          error: { code: "submission_unknown", reason: "interrupted", message: "the plugin stopped while OpenRouter was working on this job; it may have been charged" },
          // It may have been charged in full: report the estimate rather than nothing.
          ...(r.estimate ? { usage: r.estimate } : {}),
        };
      case "succeeded": {
        const file = this.file(id, "out");
        return { status: "succeeded", outputs: [{ mediaType: r.media_type!, data: () => fs.readFile(file), ...(r.metadata ? { metadata: r.metadata } : {}) }], ...common };
      }
      default:
        return { status: r.state, error: r.error!, ...common };
    }
  }

  /** Deletes finished jobs older than 30 days, the SDK's own job retention. */
  async purge(): Promise<void> {
    for (const name of await fs.readdir(this.dir).catch(() => [] as string[])) {
      const id = name.replace(/\.(json|out)$/, "");
      if (!ID.test(id) || !name.endsWith(".json")) continue;
      const r = await readJsonFile<LocalRecord>(this.file(id)).catch(() => undefined);
      if (!r || r.state === "running" || !r.finished_at) continue;
      if (Date.parse(r.finished_at) + RETENTION_MS < this.now()) {
        await fs.rm(this.file(id, "out"), { force: true });
        await fs.rm(this.file(id), { force: true });
      }
    }
  }
}
