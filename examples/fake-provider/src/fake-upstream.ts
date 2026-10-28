import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readJsonFile,
  sha256Hex,
  TRANSCRIPT_MEDIA_TYPE,
  writeFileAtomic,
  writeJsonAtomic,
  type UpstreamOutput,
  type UpstreamState,
} from "@cuelor/provider-sdk";
import { solidPng } from "./png.ts";
import { fakeTranscript } from "./transcribe.ts";
import { SAMPLE_MP4_BASE64, SAMPLE_MP4_METADATA } from "./video-sample.ts";

/**
 * A fake upstream service. It stands in for a remote API, so it keeps its jobs on disk (in the plugin's
 * data directory) and they survive a crash of the plugin. Jobs move from queued to running to succeeded
 * by elapsed time. Nothing here uses the network.
 *
 * Prompt markers for trying out other outcomes: `[fail]` (the upstream fails), `[moderate]` (rejected by
 * moderation), `[approval]` (waits for approval for one second first).
 */

export type FakeKind = "image" | "video" | "transcription";

export interface FakeJob {
  id: string;
  client_reference: string;
  kind: FakeKind;
  model: string;
  route: string;
  parameters: Record<string, unknown>;
  /** Files the fake upstream "received", in its own storage. */
  inputs: { file: string; media_type: string }[];
  created_ms: number;
  approval_ms: number;
  queued_ms: number;
  total_ms: number;
  cancelled_ms?: number;
}

/** How long fake jobs take, by kind (total, of which the first `queued` milliseconds are queued). */
export const TIMINGS: Record<FakeKind, { queued: number; total: number }> = {
  image: { queued: 300, total: 1500 },
  video: { queued: 300, total: 3000 },
  transcription: { queued: 200, total: 1000 },
};

export class FakeUpstream {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(options: { dir: string; now?: () => number }) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
  }

  private jobFile(id: string): string {
    if (!/^up_[0-9a-f]{20}$/.test(id)) throw new Error("unknown upstream job");
    return path.join(this.dir, "jobs", `${id}.json`);
  }

  /** Accepts a job. The job is on disk before the id is returned. */
  async submit(job: {
    clientReference: string;
    kind: FakeKind;
    model: string;
    route: string;
    parameters: Record<string, unknown>;
    inputs: { bytes: Uint8Array; media_type: string }[];
  }): Promise<string> {
    const id = "up_" + randomBytes(10).toString("hex");
    const inputs: FakeJob["inputs"] = [];
    for (const input of job.inputs) {
      const file = path.join(this.dir, "inputs", sha256Hex(input.bytes));
      await writeFileAtomic(file, input.bytes);
      inputs.push({ file, media_type: input.media_type });
    }
    const prompt = String(job.parameters.prompt ?? "");
    const timing = TIMINGS[job.kind];
    const record: FakeJob = {
      id,
      client_reference: job.clientReference,
      kind: job.kind,
      model: job.model,
      route: job.route,
      parameters: job.parameters,
      inputs,
      created_ms: this.now(),
      approval_ms: prompt.includes("[approval]") ? 1000 : 0,
      queued_ms: timing.queued,
      total_ms: timing.total,
    };
    await writeJsonAtomic(this.jobFile(id), record);
    return id;
  }

  async get(id: string): Promise<FakeJob | undefined> {
    return readJsonFile<FakeJob>(this.jobFile(id));
  }

  /** Finds a job by the client reference it was submitted with. */
  async findByClientReference(reference: string): Promise<string | null> {
    const dir = path.join(this.dir, "jobs");
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const job = await readJsonFile<FakeJob>(path.join(dir, name)).catch(() => undefined);
      if (job?.client_reference === reference) return job.id;
    }
    return null;
  }

  async cancel(id: string): Promise<void> {
    const job = await this.get(id);
    if (!job || job.cancelled_ms !== undefined) return;
    if (this.now() - job.created_ms >= job.approval_ms + job.total_ms) return; // already finished
    job.cancelled_ms = this.now();
    await writeJsonAtomic(this.jobFile(id), job);
  }

  /** The state of a job, computed from the time since it was submitted. */
  async status(id: string): Promise<UpstreamState> {
    const job = await this.get(id);
    if (!job) return { status: "failed", error: { code: "upstream_failed", message: "the upstream lost the job" } };
    const end = job.created_ms + job.approval_ms + job.total_ms;
    const now = this.now();
    const usage = { amount: 0, unit: "USD", basis: "estimate" as const };
    if (job.cancelled_ms !== undefined && job.cancelled_ms < end) {
      return { status: "cancelled", error: { code: "cancelled", message: "the job was cancelled" }, usage };
    }
    const elapsed = now - job.created_ms;
    if (elapsed < job.approval_ms) {
      return {
        status: "pending_approval",
        approval: { policy: "fake_review", deadline: new Date(job.created_ms + 86_400_000).toISOString() },
      };
    }
    const run = elapsed - job.approval_ms;
    if (run < job.queued_ms) return { status: "queued", progress: 0 };
    if (run < job.total_ms) return { status: "running", progress: Math.round((run / job.total_ms) * 100) };

    const prompt = String(job.parameters.prompt ?? "");
    if (prompt.includes("[fail]")) {
      return { status: "failed", error: { code: "upstream_failed", message: "the fake upstream failed as asked" }, usage };
    }
    if (prompt.includes("[moderate]")) {
      return {
        status: "rejected",
        error: { code: "content_moderated", message: "the fake upstream filtered the output", params: { stage: "output", source: "upstream" } },
        usage,
      };
    }
    return { status: "succeeded", progress: 100, outputs: [await this.output(job)], usage, warnings: this.warnings(job) };
  }

  private warnings(job: FakeJob): UpstreamState["warnings"] {
    const duration = job.parameters.duration;
    if (job.kind === "video" && duration !== undefined && duration !== 1) {
      return [{ code: "parameter_ignored", message: "the fake upstream always returns a one-second clip" }];
    }
    return undefined;
  }

  private async output(job: FakeJob): Promise<UpstreamOutput> {
    switch (job.kind) {
      case "image": {
        const h = Buffer.from(sha256Hex(String(job.parameters.prompt ?? "") + "|" + String(job.parameters.seed ?? "")), "hex");
        return { mediaType: "image/png", data: solidPng(64, 64, [h[0]!, h[1]!, h[2]!]), metadata: { width: 64, height: 64 } };
      }
      case "video":
        return { mediaType: "video/mp4", data: Buffer.from(SAMPLE_MP4_BASE64, "base64"), metadata: { ...SAMPLE_MP4_METADATA } };
      case "transcription": {
        const audio = job.inputs[0];
        const bytes = audio ? await fs.readFile(audio.file) : Buffer.alloc(0);
        const transcript = fakeTranscript(bytes, {
          language: typeof job.parameters.language === "string" ? job.parameters.language : undefined,
          timestamps: typeof job.parameters.timestamps === "string" ? job.parameters.timestamps : undefined,
        });
        return { role: "transcript", mediaType: TRANSCRIPT_MEDIA_TYPE, data: Buffer.from(JSON.stringify(transcript)) };
      }
    }
  }
}
