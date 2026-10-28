import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import {
  createProviderHandler,
  NotSubmittedError,
  ProviderError,
  TRANSCRIPT_MEDIA_TYPE,
  type Account,
  type Catalog,
  type ProviderDefinition,
  type UpstreamState,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const TOKEN = "T".repeat(40);
const BINDING = "a".repeat(64);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308020000000000000000", "hex");

const catalog: Catalog = {
  models: [
    {
      id: "m/image",
      label: "Image",
      available: true,
      output: { modality: "image" },
      parameters: [{ name: "prompt", kind: "text", required: true }],
      routes: [
        { id: "text2image", input: { slots: [] }, parameter_names: ["prompt"] },
        {
          id: "image2image",
          input: { slots: [{ id: "reference", role: "reference", modality: "image", min_artifacts: 1, max_artifacts: 2, media_types: ["image/png"], max_bytes: 1000 }] },
          parameter_names: ["prompt"],
        },
      ],
    },
    {
      id: "m/asr",
      label: "ASR",
      available: true,
      output: { modality: "text" },
      parameters: [],
      routes: [{ id: "audio2text", input: { slots: [{ id: "audio", role: "audio", modality: "audio", min_artifacts: 1, max_artifacts: 1, media_types: ["audio/wav"], max_bytes: 100000 }] }, parameter_names: [] }],
    },
  ],
};

/** A scriptable upstream. */
class Upstream {
  jobs = new Map<string, { states: UpstreamState[]; reference: string }>();
  submits = 0;
  next: "ok" | "reject" | "not_submitted" | "unknown" | "hang" | "slow" | "slow_reject" | "manual" = "ok";
  /** Submissions in `manual` mode, settled by the test. */
  pending: { resolve: (upstreamId: string) => void; reject: (err: unknown) => void }[] = [];
  polls = 0;
  signals: AbortSignal[] = [];
  rejectMessage = "upstream says no";
  script: UpstreamState[] = [{ status: "running" }, { status: "succeeded", outputs: [{ mediaType: "image/png", data: PNG }], usage: { amount: 0.1, unit: "USD", basis: "billed" } }];
  lookupResult: "none" | "found" = "none";
  cancelled: string[] = [];
}

async function setup(
  options: { account?: Partial<Account> | (() => Partial<Account>); definition?: Partial<ProviderDefinition>; dataDir?: string; upstream?: Upstream; now?: () => number } = {},
) {
  const up = options.upstream ?? new Upstream();
  const dataDir = options.dataDir ?? tempDir();
  const definition: ProviderDefinition = {
    id: "example.test",
    name: "Test",
    version: "1.2.3",
    capabilities: { generation: ["image"], transcription: true, cancel: true, estimate: true },
    billingUnit: "USD",
    account: () => ({ status: "ready", binding: BINDING, ...(typeof options.account === "function" ? options.account() : options.account) }) as Account,
    catalog: () => catalog,
    submitTimeoutMs: 300,
    upstream: {
      async submit(ctx) {
        up.submits++;
        up.signals.push(ctx.signal);
        const id = `up_${up.submits}`;
        const mode = up.next;
        if (mode === "reject") throw new ProviderError(400, "invalid_request", "upstream says no", { reason: "invalid_input" });
        if (mode === "not_submitted") throw new NotSubmittedError("connection refused");
        if (mode === "unknown") {
          up.jobs.set(id, { states: [...up.script], reference: ctx.clientReference });
          throw new Error("socket hang up");
        }
        if (mode === "hang") return new Promise(() => {});
        if (mode === "manual") {
          return new Promise<string>((resolve, reject) => up.pending.push({ resolve, reject })).then((upstreamId) => {
            up.jobs.set(upstreamId, { states: [...up.script], reference: ctx.clientReference });
            return { upstreamId };
          });
        }
        if (mode === "slow") await new Promise((r) => setTimeout(r, 600));
        if (mode === "slow_reject") {
          await new Promise((r) => setTimeout(r, 600));
          throw new ProviderError(400, "invalid_request", up.rejectMessage);
        }
        up.jobs.set(id, { states: [...up.script], reference: ctx.clientReference });
        return { upstreamId: id };
      },
      async poll(id) {
        up.polls++;
        const job = up.jobs.get(id)!;
        return job.states.length > 1 ? job.states.shift()! : job.states[0]!;
      },
      async lookup(reference) {
        if (up.lookupResult === "none") return null;
        for (const [id, j] of up.jobs) if (j.reference === reference) return id;
        return null;
      },
      async cancel(id) {
        up.cancelled.push(id);
        const job = up.jobs.get(id)!;
        job.states = [{ status: "cancelled" }];
      },
      async estimate() {
        return { amount: 0.1, unit: "USD", basis: "exact" };
      },
    },
    ...options.definition,
  };
  let port = 0;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  const { handler, runtime } = createProviderHandler(definition, { dataDir, token: TOKEN, allowedHosts: [`127.0.0.1:${port}`], log: () => {}, now: options.now });
  after(() => new Promise<void>((r) => server.close(() => r())));
  server.closeIdleConnections?.();
  const call = async (method: string, path: string, opts: { body?: unknown; raw?: Buffer; headers?: Record<string, string>; auth?: boolean } = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {}
    return { status: res.status, json, buf, headers: res.headers };
  };
  const upload = async (data: Buffer, type: string) => {
    const form = new FormData();
    form.append("file", new Blob([data], { type }), "f");
    const req = new Request("http://x", { method: "POST", body: form });
    return call("POST", "/v1/artifacts", { raw: Buffer.from(await req.arrayBuffer()), headers: { "content-type": req.headers.get("content-type")! } });
  };
  const submit = (key: string | undefined, body: unknown) => call("POST", "/v1/jobs", { body, headers: key === undefined ? {} : { "idempotency-key": key } });
  return { up, call, upload, submit, runtime, dataDir, port };
}

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const T2I = { model: "m/image", route: "text2image", input: { artifacts: [] }, parameters: { prompt: "a red square" } };

async function poll(call: Awaited<ReturnType<typeof setup>>["call"], id: string) {
  for (let i = 0; i < 20; i++) {
    const r = await call("GET", `/v1/jobs/${id}`);
    if (!["queued", "running", "pending_approval"].includes(r.json.status)) return r.json;
  }
  throw new Error("job did not end");
}

test("describe, catalog, auth before routing, unknown paths and methods", async () => {
  const { call } = await setup();
  const d = await call("GET", "/v1/provider");
  assert.equal(d.status, 200);
  assert.deepEqual(d.json.protocol, { version: "1.0" });
  assert.equal(d.json.provider.id, "example.test");
  assert.equal(d.json.account.binding, BINDING);
  assert.equal((await call("GET", "/v1/models")).json.models.length, 2);
  for (const [m, p] of [["GET", "/v1/provider"], ["GET", "/v1/nope"], ["POST", "/v1/jobs"], ["GET", "/v1/jobs/job_x"], ["POST", "/v1/artifacts"]] as const) {
    const r = await call(m, p, { auth: false });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.json.error.code, "unauthorized");
  }
  assert.equal((await call("GET", "/v1/nope")).status, 404);
  assert.equal((await call("DELETE", "/v1/provider")).status, 405);
  assert.equal((await call("GET", "/v1/jobs/job_000000000000000000000000")).json.error.code, "not_found");
  assert.equal((await call("GET", "/v1/artifacts/art_x")).status, 404);
  assert.equal((await call("GET", "/v1/artifacts/art_x/content")).status, 404);
});

test("not ready: catalog and jobs answer 403 provider_not_ready", async () => {
  const { call, submit } = await setup({ account: { status: "needs_setup" } });
  assert.equal((await call("GET", "/v1/provider")).status, 200);
  const m = await call("GET", "/v1/models");
  assert.equal(m.status, 403);
  assert.equal(m.json.error.code, "provider_not_ready");
  assert.equal((await submit("k", T2I)).json.error.code, "provider_not_ready");
});

test("a job: submit, replay, conflict, poll, output, terminal replay", async () => {
  const { call, submit, up } = await setup();
  const first = await submit("key-1", T2I);
  assert.equal(first.status, 201);
  assert.equal(first.json.status, "queued");
  const replay = await submit("key-1", { parameters: { prompt: "a red square" }, input: { artifacts: [] }, route: "text2image", model: "m/image" });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  const conflict = await submit("key-1", { ...T2I, parameters: { prompt: "other" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "idempotency_conflict");
  const done = await poll(call, first.json.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.outputs.length, 1);
  assert.equal(done.outputs[0].role, "output");
  assert.equal(done.outputs[0].sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.deepEqual(done.outputs[0].metadata, { width: 2, height: 3 });
  assert.deepEqual(done.usage, { amount: 0.1, unit: "USD", basis: "billed" });
  assert.ok(done.updated_at >= first.json.updated_at);
  const bytes = await call("GET", `/v1/artifacts/${done.outputs[0].artifact_id}/content`);
  assert.deepEqual(bytes.buf, PNG);
  assert.equal(bytes.headers.get("content-type"), "image/png");
  assert.equal(bytes.headers.get("content-length"), String(PNG.length));
  // Terminal states never change, whatever the upstream says later.
  up.jobs.get("up_1")!.states = [{ status: "running" }];
  assert.equal((await call("GET", `/v1/jobs/${first.json.id}`)).json.status, "succeeded");
  assert.equal((await submit("key-1", T2I)).json.status, "succeeded");
  assert.equal(up.submits, 1);
});

test("the same key under another binding is another job", async () => {
  const dataDir = tempDir();
  const up = new Upstream();
  const a = await setup({ dataDir, upstream: up });
  const first = await a.submit("shared", T2I);
  const b = await setup({ dataDir, upstream: up, account: { binding: "b".repeat(64) } });
  const second = await b.submit("shared", { ...T2I, parameters: { prompt: "different" } });
  assert.equal(second.status, 201);
  assert.notEqual(second.json.id, first.json.id);
});

test("validation errors and missing keys create nothing", async () => {
  const { submit, up } = await setup();
  const missing = await submit(undefined, T2I);
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.reason, "missing_idempotency_key");
  assert.equal((await submit("k1", { ...T2I, model: "nope" })).json.error.reason, "unknown_model");
  assert.equal((await submit("k1", { ...T2I, parameters: { prompt: "@image1" } })).json.error.reason, "prompt_reference_out_of_range");
  assert.equal(up.submits, 0);
  // The key is still free.
  assert.equal((await submit("k1", T2I)).status, 201);
});

test("an input the service does not have: 400 artifact_not_found on submit and estimate", async () => {
  const { submit, call, up } = await setup();
  const body = { model: "m/asr", route: "audio2text", input: { artifacts: [{ artifact_id: "art_gone", role: "audio", position: 0 }] }, parameters: {} };
  for (const r of [await submit("k-missing", body), await call("POST", "/v1/estimates", { body })]) {
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "invalid_request");
    assert.equal(r.json.error.reason, "artifact_not_found");
    assert.deepEqual(r.json.error.params, { artifact_id: "art_gone" });
  }
  assert.equal(up.submits, 0);
});

test("an upstream 4xx is passed on and the key is freed", async () => {
  const { submit, up } = await setup();
  up.next = "reject";
  const r = await submit("k", T2I);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.message, "upstream says no");
  up.next = "ok";
  assert.equal((await submit("k", { ...T2I, parameters: { prompt: "other" } })).status, 201);
});

test("NotSubmittedError answers 503 and the replay submits again", async () => {
  const { submit, up } = await setup();
  up.next = "not_submitted";
  const r = await submit("k", T2I);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "upstream_unavailable");
  up.next = "ok";
  assert.equal((await submit("k", T2I)).status, 201);
  assert.equal(up.submits, 2);
});

test("an unknown submission result is never submitted again", async () => {
  const { submit, call, up } = await setup();
  up.next = "unknown";
  const r = await submit("k", T2I);
  assert.equal(r.status, 502);
  up.next = "ok";
  const replay = await submit("k", T2I);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.status, "failed");
  assert.equal(replay.json.error.code, "submission_unknown");
  assert.equal((await submit("k", T2I)).json.id, replay.json.id);
  assert.equal((await call("GET", `/v1/jobs/${replay.json.id}`)).json.status, "failed");
  assert.equal(up.submits, 1);
});

test("an unknown submission result is found again by lookup", async () => {
  const { submit, call, up } = await setup();
  up.next = "unknown";
  up.lookupResult = "found";
  assert.equal((await submit("k", T2I)).status, 502);
  const replay = await submit("k", T2I);
  assert.equal(replay.status, 200);
  assert.notEqual(replay.json.status, "failed");
  assert.equal((await poll(call, replay.json.id)).status, "succeeded");
  assert.equal(up.submits, 1);
});

test("a crash between recording and the upstream id recovers through lookup (new runtime, same data)", async () => {
  const dataDir = tempDir();
  const up = new Upstream();
  const a = await setup({ dataDir, upstream: up });
  up.next = "hang";
  assert.equal((await a.submit("k", T2I)).status, 502); // submitTimeoutMs = 300
  // "Restart": a new runtime on the same data directory knows nothing of the hanging call.
  const b = await setup({ dataDir, upstream: up });
  const replay = await b.submit("k", T2I);
  assert.equal(replay.json.status, "failed");
  assert.equal(replay.json.error.code, "submission_unknown");
  assert.equal(up.submits, 1);
});

test("a slow submission finishes in the background and the replay gets the job", async () => {
  const { submit, call, up } = await setup();
  up.next = "slow";
  assert.equal((await submit("k", T2I)).status, 502);
  const replay = await submit("k", T2I); // waits for the running submission
  assert.equal(replay.status, 200);
  assert.equal((await poll(call, replay.json.id)).status, "succeeded");
  assert.equal(up.submits, 1);
});

test("invalid outputs end the job failed", async () => {
  const { submit, call, up } = await setup();
  up.script = [{ status: "succeeded" }];
  const none = await submit("a", T2I);
  const r1 = await poll(call, none.json.id);
  assert.equal(r1.status, "failed");
  assert.equal(r1.error.code, "upstream_failed");
  up.script = [{ status: "succeeded", outputs: [{ mediaType: "video/mp4", data: PNG }] }];
  const wrong = await submit("b", T2I);
  assert.match((await poll(call, wrong.json.id)).error.message, /image\/png, not video\/mp4/);
});

test("transcripts are normalised and validated", async () => {
  const { submit, call, up, upload } = await setup();
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + 32000, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(32000, 40);
  const art = await upload(wav, "audio/wav");
  assert.deepEqual(art.json.metadata, { duration_ms: 1000, sample_rate: 16000 });
  const body = { model: "m/asr", route: "audio2text", input: { artifacts: [{ artifact_id: art.json.id, role: "audio", position: 0 }] }, parameters: {} };
  const transcript = {
    schema_version: 1,
    language: "en",
    unit: "word",
    text: "hello world",
    segments: [{ text: "hello world", timed_text_units: [{ text: "hello", start_ms: 0, end_ms: 500 }, { text: ",", start_ms: 500, end_ms: 500 }, { text: "world", start_ms: 400, end_ms: 1100 }] }],
  };
  up.script = [{ status: "succeeded", outputs: [{ mediaType: TRANSCRIPT_MEDIA_TYPE, data: Buffer.from(JSON.stringify(transcript)) }] }];
  const ok = await poll(call, (await submit("t1", body)).json.id);
  assert.equal(ok.status, "succeeded");
  assert.equal(ok.outputs[0].role, "transcript");
  const t = (await call("GET", `/v1/artifacts/${ok.outputs[0].artifact_id}/content`)).json;
  assert.deepEqual(t.segments[0].timed_text_units, [
    { text: "hello", start_ms: 0, end_ms: 500 },
    { text: "world", start_ms: 500, end_ms: 1000 },
  ]);
  up.script = [{ status: "succeeded", outputs: [{ mediaType: TRANSCRIPT_MEDIA_TYPE, data: Buffer.from(JSON.stringify({ ...transcript, unit: undefined })) }] }];
  const bad = await poll(call, (await submit("t2", body)).json.id);
  assert.equal(bad.status, "failed");
  assert.match(bad.error.message, /invalid transcript/);
});

test("disallowed transitions are ignored and updated_at never decreases", async () => {
  const { submit, call, up } = await setup();
  up.script = [{ status: "running" }, { status: "queued" }, { status: "running", progress: 50 }];
  const j = await submit("k", T2I);
  const seen: string[] = [];
  let last = "";
  for (let i = 0; i < 3; i++) {
    const r = (await call("GET", `/v1/jobs/${j.json.id}`)).json;
    seen.push(r.status);
    assert.ok(r.updated_at >= last);
    last = r.updated_at;
  }
  assert.deepEqual(seen, ["running", "running", "running"]);
});

test("cancel and estimate", async () => {
  const { submit, call, up } = await setup();
  up.script = [{ status: "running" }];
  const j = await submit("k", T2I);
  const c1 = await call("POST", `/v1/jobs/${j.json.id}/cancel`);
  assert.equal(c1.status, 200);
  assert.equal(c1.json.status, "cancelled");
  assert.equal(c1.json.error.code, "cancelled");
  const c2 = await call("POST", `/v1/jobs/${j.json.id}/cancel`);
  assert.equal(c2.status, 200);
  assert.equal(c2.json.status, "cancelled");
  assert.deepEqual(up.cancelled, ["up_1"]);
  const e = await call("POST", "/v1/estimates", { body: T2I });
  assert.deepEqual(e.json, { estimate: { amount: 0.1, unit: "USD", basis: "exact" } });
  assert.equal((await call("POST", "/v1/estimates", { body: { ...T2I, model: "x" } })).status, 400);
  assert.equal(up.submits, 1);
});

test("optional endpoints answer 404 when the capability is off", async () => {
  const { call, submit } = await setup({ definition: { capabilities: { generation: ["image"] } } });
  const j = await submit("k", T2I);
  assert.equal((await call("POST", `/v1/jobs/${j.json.id}/cancel`)).status, 404);
  assert.equal((await call("POST", "/v1/estimates", { body: T2I })).status, 404);
  assert.equal((await call("POST", "/v1/setup")).status, 404);
});

test("uploads: dedupe, 413 over the largest max_bytes, range downloads", async () => {
  const { upload, call } = await setup();
  const a = await upload(PNG, "image/png");
  assert.equal(a.status, 201);
  const b = await upload(PNG, "image/png");
  assert.equal(b.status, 200);
  assert.equal(b.json.id, a.json.id);
  const big = await upload(Buffer.alloc(100001, 1), "image/png");
  assert.equal(big.status, 413);
  assert.deepEqual(big.json.error.params, { max_bytes: 100000 });
  const r = await call("GET", `/v1/artifacts/${a.json.id}/content`, { headers: { range: "bytes=1-3" } });
  assert.equal(r.status, 206);
  assert.equal(r.buf.toString(), "PNG");
  assert.equal(r.headers.get("content-range"), `bytes 1-3/${PNG.length}`);
  assert.equal((await call("GET", `/v1/artifacts/${a.json.id}/content`, { headers: { range: "bytes=999-" } })).status, 416);
});

// ---------------------------------------------------------------------------------------------------
// Regressions.

test("a key stays valid past 30 days while its job exists, also after a purge", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { submit, call, up, runtime } = await setup({ now: () => now });
  const first = await submit("old-key", T2I);
  assert.equal(first.status, 201);
  assert.equal((await call("GET", `/v1/jobs/${first.json.id}`)).json.status, "running");
  now += 5 * DAY; // the job ends 5 days after the key was made
  assert.equal((await poll(call, first.json.id)).status, "succeeded");
  now += 26 * DAY; // the key is 31 days old, the job ended 26 days ago
  await runtime.purge();
  const replay = await submit("old-key", T2I);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, first.json.id);
  assert.equal(up.submits, 1);
});

const WAV_1S = (() => {
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + 32000, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(32000, 40);
  return wav;
})();

test("a malformed upstream transcript ends the job failed instead of polling forever", async () => {
  const { submit, call, up, upload } = await setup();
  const art = await upload(WAV_1S, "audio/wav");
  const body = { model: "m/asr", route: "audio2text", input: { artifacts: [{ artifact_id: art.json.id, role: "audio", position: 0 }] }, parameters: {} };
  const cases: unknown[] = [
    null,
    { schema_version: 1, unit: "word", text: "no segments" },
    { schema_version: 1, unit: "word", text: 5, segments: [{ text: "a", timed_text_units: [{ text: 5, start_ms: 0, end_ms: 10 }] }] },
    { schema_version: 1, unit: "word", text: "x", segments: [null] },
  ];
  for (const [i, transcript] of cases.entries()) {
    up.script = [{ status: "succeeded", outputs: [{ mediaType: TRANSCRIPT_MEDIA_TYPE, data: Buffer.from(JSON.stringify(transcript)) }] }];
    const done = await poll(call, (await submit(`bad-${i}`, body)).json.id);
    assert.equal(done.status, "failed", JSON.stringify(transcript));
    assert.equal(done.error.code, "upstream_failed");
    assert.match(done.error.message, /invalid transcript/);
  }
});

test("a terminal state the job cannot reach ends it failed with upstream_failed", async () => {
  const { submit, call, up } = await setup();
  up.script = [{ status: "running" }, { status: "expired", error: { code: "approval_expired", message: "too late" } }];
  const done = await poll(call, (await submit("k", T2I)).json.id);
  assert.equal(done.status, "failed");
  assert.equal(done.error.code, "upstream_failed");
  assert.deepEqual(done.error.params, { upstream_status: "expired", upstream_code: "approval_expired", previous_status: "running" });
});

test("secrets of the definition are removed from job errors and warnings", async () => {
  const secret = "opaque-credential-0123456789";
  const { submit, call, up } = await setup({ definition: { secrets: () => [secret] } });
  up.script = [{ status: "running", warnings: [{ code: "slow", message: `retrying with ${secret}` }] }, { status: "failed", error: { code: "upstream_failed", message: `key ${secret} was refused` } }];
  const done = await poll(call, (await submit("k", T2I)).json.id);
  assert.equal(done.status, "failed");
  assert.ok(!JSON.stringify(done).includes(secret), JSON.stringify(done));
  assert.match(done.error.message, /\[redacted\]/);
  // A late rejection, recorded after the submit timeout.
  up.next = "slow_reject";
  up.rejectMessage = `bad key ${secret}`;
  assert.equal((await submit("late", T2I)).status, 502);
  await new Promise((r) => setTimeout(r, 500));
  const late = await submit("late", T2I);
  assert.equal(late.json.status, "failed");
  assert.ok(!JSON.stringify(late.json).includes(secret), JSON.stringify(late.json));
});

test("not ready: known keys and jobs are answered from storage; a missing binding answers 503", async () => {
  let account: Partial<Account> = { status: "ready" };
  const { submit, call, up } = await setup({ account: () => account });
  const done = await submit("known", T2I);
  assert.equal((await poll(call, done.json.id)).status, "succeeded");
  up.script = [{ status: "running" }];
  const open = await submit("open", T2I);
  assert.equal((await call("GET", `/v1/jobs/${open.json.id}`)).json.status, "running");
  account = { status: "needs_setup" };
  const polls = up.polls;
  const replay = await submit("known", T2I);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, done.json.id);
  assert.equal(replay.json.status, "succeeded");
  assert.equal((await submit("known", { ...T2I, parameters: { prompt: "other" } })).status, 409);
  const get = await call("GET", `/v1/jobs/${done.json.id}`);
  assert.equal(get.status, 200);
  assert.equal(get.json.status, "succeeded");
  const running = await call("GET", `/v1/jobs/${open.json.id}`);
  assert.equal(running.status, 200);
  assert.equal(running.json.status, "running");
  assert.equal(up.polls, polls, "no upstream calls while the account is not ready");
  const fresh = await submit("fresh", T2I);
  assert.equal(fresh.status, 403);
  assert.equal(fresh.json.error.code, "provider_not_ready");
  account = { status: "needs_setup", binding: undefined };
  const unbound = await submit("known", T2I);
  assert.equal(unbound.status, 503);
  assert.equal(unbound.json.error.code, "upstream_unavailable");
  assert.equal(up.submits, 2);
});

test("the submit timeout answers 502 without aborting the upstream call; the hard limit aborts it", async () => {
  const { submit, call, up } = await setup();
  up.next = "slow";
  assert.equal((await submit("k", T2I)).status, 502);
  const replay = await submit("k", T2I);
  assert.equal(replay.status, 200);
  assert.equal(up.signals[0]!.aborted, false);
  assert.equal((await poll(call, replay.json.id)).status, "succeeded");
  const hard = await setup({ definition: { submitHardTimeoutMs: 400 } as Partial<ProviderDefinition> });
  hard.up.next = "hang";
  assert.equal((await hard.submit("h", T2I)).status, 502);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hard.up.signals[0]!.aborted, true);
  // Nothing is running any more: the replay recovers and, without a match upstream, ends the job.
  const after = await hard.submit("h", T2I);
  assert.equal(after.json.status, "failed");
  assert.equal(after.json.error.code, "submission_unknown");
  assert.equal(hard.up.submits, 1);
});

test("a rejection without a reason is content_moderated with params.inferred", async () => {
  const { submit, call, up } = await setup();
  up.script = [{ status: "rejected" }];
  const done = await poll(call, (await submit("k", T2I)).json.id);
  assert.equal(done.status, "rejected");
  assert.equal(done.error.code, "content_moderated");
  assert.deepEqual(done.error.params, { inferred: true });
  up.script = [{ status: "rejected", error: { code: "content_moderated", message: "flagged" } }];
  const explicit = await poll(call, (await submit("k2", T2I)).json.id);
  assert.equal(explicit.error.params, undefined);
});

test("a late NotSubmittedError after the 502 ends the job failed and keeps the key", async () => {
  const { submit, call, up } = await setup();
  up.next = "manual";
  assert.equal((await submit("k", T2I)).status, 502); // submitTimeoutMs = 300
  const replay = await submit("k", T2I);
  assert.equal(replay.status, 200);
  const id = replay.json.id;
  up.pending[0]!.reject(new NotSubmittedError("connection refused"));
  await sleep(100);
  const got = await call("GET", `/v1/jobs/${id}`);
  assert.equal(got.status, 200, JSON.stringify(got.json));
  assert.equal(got.json.status, "failed");
  assert.equal(got.json.error.code, "upstream_failed");
  assert.equal(got.json.error.reason, "not_submitted");
  const again = await submit("k", T2I);
  assert.equal(again.status, 200);
  assert.equal(again.json.id, id);
  assert.equal(again.json.status, "failed");
  assert.equal(up.submits, 1);
});

test("a late 4xx after the 502 keeps its meaning (v1.md section 3.8)", async () => {
  const { submit, call, up } = await setup();
  up.next = "manual";
  const cases = [
    {
      err: new ProviderError(422, "content_moderated", "the prompt was blocked", { params: { category: "violence" } }),
      status: "rejected",
      code: "content_moderated",
      reason: undefined,
      params: { category: "violence", stage: "input", source: "upstream", original_status: 422, original_code: "content_moderated" },
    },
    {
      err: new ProviderError(402, "insufficient_credits", "the balance is too low"),
      status: "failed",
      code: "insufficient_credits",
      reason: undefined,
      params: { original_status: 402, original_code: "insufficient_credits" },
    },
    {
      err: new ProviderError(403, "forbidden", "not in this region", { reason: "region_restricted" }),
      status: "failed",
      code: "forbidden",
      reason: "region_restricted",
      params: { original_status: 403, original_code: "forbidden", original_reason: "region_restricted" },
    },
    {
      err: new ProviderError(400, "invalid_request", "the size is not supported", { reason: "unsupported_size" }),
      status: "failed",
      code: "invalid_input",
      reason: undefined,
      params: { original_status: 400, original_code: "invalid_request", original_reason: "unsupported_size" },
    },
  ];
  for (const [i, c] of cases.entries()) {
    assert.equal((await submit(`late-${i}`, T2I)).status, 502);
    up.pending[i]!.reject(c.err);
    await sleep(50);
    const replay = await submit(`late-${i}`, T2I);
    assert.equal(replay.status, 200, c.code);
    const job = (await call("GET", `/v1/jobs/${replay.json.id}`)).json;
    assert.equal(job.status, c.status, c.code);
    assert.equal(job.error.code, c.code);
    assert.equal(job.error.reason, c.reason);
    assert.equal(job.error.message, c.err.message);
    assert.deepEqual(job.error.params, c.params);
    assert.equal((await submit(`late-${i}`, T2I)).json.id, replay.json.id);
  }
  assert.equal(up.submits, cases.length);
});

/** A request with any Host header (fetch cannot set one). */
function rawRequest(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("pages outside /v1/: Host checked, no bearer token, only the plugin's own Origin", async () => {
  let hits = 0;
  const { port } = await setup({
    definition: {
      extraRoutes(_req, res, url) {
        if (!url.pathname.startsWith("/setup/")) return false;
        hits++;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("setup page");
        return true;
      },
    },
  });
  const self = `127.0.0.1:${port}`;
  const page = await rawRequest(port, "GET", "/setup/abc", { host: self });
  assert.equal(page.status, 200);
  assert.equal(page.text, "setup page");
  for (const host of [`localhost:${port}`, "example.com", `127.0.0.1:${port + 1}`]) {
    const r = await rawRequest(port, "GET", "/setup/abc", { host });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.error.code, "forbidden");
    assert.equal(r.json.error.reason, "host_not_allowed");
    assert.equal(typeof r.json.error.message, "string");
  }
  assert.equal((await rawRequest(port, "POST", "/setup/abc", { host: self, origin: `http://${self}` })).status, 200);
  for (const origin of ["https://example.com", "null", `http://localhost:${port}`, `https://${self}`]) {
    const r = await rawRequest(port, "POST", "/setup/abc", { host: self, origin });
    assert.equal(r.status, 403, origin);
    assert.equal(r.json.error.reason, "origin_not_allowed");
  }
  assert.equal(hits, 2);
  // /v1/ rejects every Origin, also the plugin's own.
  const api = await rawRequest(port, "GET", "/v1/provider", { host: self, origin: `http://${self}`, authorization: `Bearer ${TOKEN}` });
  assert.equal(api.status, 403);
  assert.equal(api.json.error.reason, "origin_not_allowed");
});

test("jobs that ended more than 30 days ago are deleted with their key; open jobs are kept", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const { submit, call, up, runtime } = await setup({ now: () => now });
  const ended = await submit("ended", T2I);
  assert.equal((await poll(call, ended.json.id)).status, "succeeded");
  up.script = [{ status: "running" }];
  const open = await submit("open", T2I);
  assert.equal((await call("GET", `/v1/jobs/${open.json.id}`)).json.status, "running");
  now += 30 * DAY - 1000;
  await runtime.purge();
  assert.equal((await call("GET", `/v1/jobs/${ended.json.id}`)).status, 200);
  assert.equal((await submit("ended", T2I)).json.id, ended.json.id);
  now += 2000;
  await runtime.purge();
  assert.equal((await call("GET", `/v1/jobs/${ended.json.id}`)).status, 404);
  // The key went with the job: it is free again.
  const fresh = await submit("ended", { ...T2I, parameters: { prompt: "another" } });
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.json.id, ended.json.id);
  now += 365 * DAY;
  await runtime.purge();
  assert.equal((await call("GET", `/v1/jobs/${open.json.id}`)).json.status, "running");
  assert.equal((await submit("open", T2I)).json.id, open.json.id);
});

test("the job retention is configurable but never under 30 days", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const short = await setup({ now: () => now, definition: { retention: { jobMs: DAY } } });
  const long = await setup({ now: () => now, definition: { retention: { jobMs: 40 * DAY } } });
  const a = await short.submit("k", T2I);
  const b = await long.submit("k", T2I);
  assert.equal((await poll(short.call, a.json.id)).status, "succeeded");
  assert.equal((await poll(long.call, b.json.id)).status, "succeeded");
  now += 29 * DAY;
  await short.runtime.purge();
  assert.equal((await short.call("GET", `/v1/jobs/${a.json.id}`)).status, 200);
  now += 6 * DAY;
  await long.runtime.purge();
  assert.equal((await long.call("GET", `/v1/jobs/${b.json.id}`)).status, 200);
  now += 6 * DAY;
  await long.runtime.purge();
  assert.equal((await long.call("GET", `/v1/jobs/${b.json.id}`)).status, 404);
});

test("account() is cached briefly; a submission always reads it fresh", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let calls = 0;
  let binding = BINDING;
  const { call, submit, runtime, port } = await setup({
    now: () => now,
    account: () => {
      calls++;
      return { binding };
    },
    definition: {
      extraRoutes(_req, res, url) {
        if (url.pathname !== "/setup/done") return false;
        res.writeHead(204);
        res.end();
        return true;
      },
    },
  });
  for (let i = 0; i < 3; i++) assert.equal((await call("GET", "/v1/provider")).status, 200);
  assert.equal((await call("GET", "/v1/models")).status, 200);
  assert.equal(calls, 1);
  const first = await submit("k", T2I);
  assert.equal(first.status, 201);
  assert.equal(calls, 2);
  for (let i = 0; i < 3; i++) await call("GET", `/v1/jobs/${first.json.id}`);
  assert.equal(calls, 2);
  // The binding changes while the cache still holds the old one: the submission uses the new one, so the
  // same key with another body is a new job under the new account, not a conflict under the old one.
  binding = "b".repeat(64);
  const second = await submit("k", { ...T2I, parameters: { prompt: "other" } });
  assert.equal(second.status, 201);
  assert.notEqual(second.json.id, first.json.id);
  assert.equal((await call("GET", "/v1/provider")).json.account.binding, binding);
  // Expiry.
  binding = "c".repeat(64);
  now += 5001;
  assert.equal((await call("GET", "/v1/provider")).json.account.binding, binding);
  // Invalidation: by the runtime, and after a page outside /v1/ (a setup page) was served.
  binding = "d".repeat(64);
  runtime.invalidateAccount();
  assert.equal((await call("GET", "/v1/provider")).json.account.binding, binding);
  binding = "e".repeat(64);
  assert.equal((await rawRequest(port, "POST", "/setup/done", { host: `127.0.0.1:${port}` })).status, 204);
  assert.equal((await call("GET", "/v1/provider")).json.account.binding, binding);
});
