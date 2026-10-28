// The local job store (src/local-jobs.ts): failures while storing a result, and a query that races the
// end of a job.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LocalJobs, type Outcome } from "../src/local-jobs.ts";
import { tempDir } from "./helpers.ts";

const SUCCESS: Outcome = { status: "succeeded", output: { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }, usage: { amount: 0.04, unit: "USD", basis: "billed" } };

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

test("a result that cannot be written ends the job failed, logged, without crashing the plugin (rework item 2)", { skip: process.getuid?.() === 0 }, async () => {
  const dir = path.join(tempDir(), "jobs");
  const logs: string[] = [];
  const jobs = new LocalJobs({ dir, log: (m) => logs.push(m) });
  const g = gate();
  const id = await jobs.start("image", "ref-1", async () => (await g.wait, SUCCESS));
  chmodSync(dir, 0o500); // The record exists; nothing more can be written.
  try {
    g.open();
    await jobs.idle(); // Before the fix: the background write rejected, unhandled.
    const state = await jobs.state(id);
    assert.equal(state.status, "failed");
    assert.deepEqual([state.error?.code, state.error?.reason], ["upstream_failed", "result_not_stored"]);
    assert.deepEqual(state.usage, SUCCESS.usage, "OpenRouter charged it; the usage is still reported");
    assert.ok(logs.some((l) => l.includes(id) && /could not store/.test(l)), logs.join("\n"));
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a query that races the end of a job never reports a finished job as interrupted (rework item 3)", async () => {
  const dir = path.join(tempDir(), "jobs");
  // The job ends between reading its record and checking whether it still runs.
  class Racing extends LocalJobs {
    protected override async readRecord(id: string) {
      const r = await super.readRecord(id);
      await this.idle();
      return r;
    }
  }
  const jobs = new Racing({ dir });
  const g = gate();
  const id = await jobs.start("image", "ref-2", async () => (await g.wait, SUCCESS));
  const query = jobs.state(id);
  g.open();
  const state = await query;
  assert.ok(state.status === "running" || state.status === "succeeded", `got ${state.status} ${JSON.stringify(state.error)}`);
  await jobs.idle();
  assert.equal((await jobs.state(id)).status, "succeeded");
});
