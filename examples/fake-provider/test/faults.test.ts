// Each fault of the faulty fixture breaks what it says, and the healthy provider passes the same probe.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "@cuelor/provider-sdk";
import { FAULTS } from "./fault-names.ts";
import { SAMPLES, tempDir } from "./helpers.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const FAULTY = fileURLToPath(new URL("./faulty-provider.ts", import.meta.url));

interface Running {
  child: ChildProcess;
  call: (method: string, path: string, init?: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string>; auth?: boolean }) => Promise<{ status: number; json: any }>;
}

async function start(fault?: string): Promise<Running> {
  const token = randomBytes(30).toString("hex").slice(0, 40);
  const child = spawn(process.execPath, fault ? [FAULTY, `--fault=${fault}`] : [MAIN], {
    env: { PATH: process.env.PATH ?? "", CUELOR_PROVIDER_DATA_DIR: tempDir(), CUELOR_PROVIDER_PROTOCOL: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin!.write(token + "\n");
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d) => {
      out += d;
      const m = /cuelor-provider-listening port=(\d+)\n/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}`)));
  });
  const call: Running["call"] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.auth !== false) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  };
  return { child, call };
}

async function uploadSample(r: Running, name: string) {
  const bytes = readFileSync(new URL(name, SAMPLES));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), name);
  const req = new Request("http://x", { method: "POST", body: form });
  const res = await r.call("POST", "/v1/artifacts", { raw: new Uint8Array(await req.arrayBuffer()), headers: { "content-type": req.headers.get("content-type")! } });
  return { res, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const T2I = (prompt: string) => ({ model: "example/fake-image", route: "text2image", input: { artifacts: [] }, parameters: { prompt } });

/** For each fault: a probe that returns true when the provider behaves correctly. */
const PROBES: Record<(typeof FAULTS)[number], (r: Running) => Promise<boolean>> = {
  "no-auth": async (r) => (await r.call("GET", "/v1/provider", { auth: false })).status === 401,
  "short-binding": async (r) => /^[0-9a-f]{64}$/.test((await r.call("GET", "/v1/provider")).json.account.binding),
  "ignore-stdin": async (r) => {
    const exited = new Promise<boolean>((resolve) => {
      r.child.on("exit", () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    r.child.stdin!.end();
    return exited;
  },
  "unchecked-references": async (r) => (await r.call("POST", "/v1/jobs", { body: T2I("next to @image1"), headers: { "idempotency-key": "p" } })).status === 400,
  "wrong-sha256": async (r) => {
    const { res, sha256 } = await uploadSample(r, "en.wav");
    return res.json.sha256 === sha256;
  },
  "unknown-job-500": async (r) => (await r.call("GET", "/v1/jobs/job_000000000000000000000000")).status === 404,
  "new-job-same-key": async (r) => {
    const a = await r.call("POST", "/v1/jobs", { body: T2I("same"), headers: { "idempotency-key": "k" } });
    const b = await r.call("POST", "/v1/jobs", { body: T2I("same"), headers: { "idempotency-key": "k" } });
    return a.json.id === b.json.id;
  },
  "no-conflict": async (r) => {
    await r.call("POST", "/v1/jobs", { body: T2I("first"), headers: { "idempotency-key": "k" } });
    return (await r.call("POST", "/v1/jobs", { body: T2I("second"), headers: { "idempotency-key": "k" } })).status === 409;
  },
  "catalog-shapes": async (r) => validateCatalog((await r.call("GET", "/v1/models")).json).length === 0,
  "garbled-transcript": async (r) => {
    const { res } = await uploadSample(r, "en.wav");
    const body = { model: "example/fake-asr", route: "audio2text", input: { artifacts: [{ artifact_id: res.json.id, role: "audio", position: 0 }] }, parameters: {} };
    const job = await r.call("POST", "/v1/jobs", { body, headers: { "idempotency-key": "asr" } });
    let j = job.json;
    for (let i = 0; i < 40 && !["succeeded", "failed"].includes(j.status); i++) {
      await new Promise((s) => setTimeout(s, 150));
      j = (await r.call("GET", `/v1/jobs/${job.json.id}`)).json;
    }
    if (j.status !== "succeeded") return false;
    const t = (await r.call("GET", `/v1/artifacts/${j.outputs[0].artifact_id}/content`)).json;
    return t.text === "The quick brown fox jumps over the lazy dog.";
  },
};

for (const fault of FAULTS) {
  test(`fault ${fault}: the healthy provider passes the probe, the faulty one fails it`, async () => {
    assert.equal(await PROBES[fault](await start()), true, "healthy provider");
    assert.equal(await PROBES[fault](await start(fault)), false, `--fault=${fault}`);
  });
}

test("the faulty fixture is otherwise a working provider", async () => {
  const r = await start("wrong-sha256");
  assert.equal((await r.call("GET", "/v1/models")).json.models.length, 3);
  assert.equal((await r.call("GET", "/v1/provider", { headers: { origin: "https://example.com" } })).status, 403);
});
