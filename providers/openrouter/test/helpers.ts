import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { createProviderHandler, type ProviderRuntime, type SecurityRunner } from "@cuelor/provider-sdk";
import { buildProvider, type OpenRouterOptions } from "../src/provider.ts";
import { MockOpenRouter } from "./mock-openrouter.ts";

export const SAMPLES = new URL("../../../conformance/samples/", import.meta.url);

/** A temporary directory removed after the test file finishes. */
export function tempDir(prefix = "openrouter-test-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The offline guard: from here on, `fetch` to anything but 127.0.0.1 fails, and the test file fails
 * after its tests when anything tried. The plugin makes every upstream request with `fetch`.
 */
export const blockedRequests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1") {
    blockedRequests.push(url.origin);
    throw new TypeError(`offline guard: a test tried to reach ${url.origin}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
let expectBlocked = 0;
/** For the test that proves the guard works: it expects exactly `n` blocked requests. */
export function allowBlocked(n: number): void {
  expectBlocked += n;
}
after(() => assert.equal(blockedRequests.length, expectBlocked, `requests outside 127.0.0.1: ${blockedRequests.join(", ")}`));

/** An in-memory `security -i`: the keychain without touching the user's keychain. */
export function fakeKeychain(): { run: SecurityRunner; items: Map<string, string> } {
  const items = new Map<string, string>();
  const run: SecurityRunner = async (_args, stdin) => {
    const words = [...stdin.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!));
    const opt = (flag: string) => words[words.indexOf(flag) + 1];
    const id = `${opt("-s")}\n${opt("-a")}`;
    if (words[0] === "add-generic-password") {
      items.set(id, opt("-w")!);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (words[0] === "find-generic-password") {
      const v = items.get(id);
      return v === undefined ? { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." } : { code: 0, stdout: v + "\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unsupported" };
  };
  return { run, items };
}

export interface Plugin {
  mock: MockOpenRouter;
  runtime: ProviderRuntime;
  definition: ReturnType<typeof buildProvider>;
  port: number;
  dataDir: string;
  logs: string[];
  call: (method: string, p: string, init?: { body?: unknown; raw?: Uint8Array; headers?: Record<string, string>; auth?: boolean; redirect?: "follow" | "manual" }) => Promise<{ status: number; json: any; text: string; headers: Headers }>;
  close: () => Promise<void>;
}

/**
 * The plugin in this process, against a mock OpenRouter (started here unless given), on a loopback port
 * with a random bearer token. `options` go to `buildProvider`; by default the key comes from
 * CUELOR_PROVIDER_TEST_KEY, as in the conformance runs.
 */
export async function startPlugin(o: { mock?: MockOpenRouter; dataDir?: string; options?: Partial<OpenRouterOptions>; withKey?: boolean } = {}): Promise<Plugin> {
  const mock = o.mock ?? new MockOpenRouter({ imageMs: 300, video: { pendingMs: 150, totalMs: 600 } });
  if (!mock.url) {
    await mock.start();
    after(() => mock.close());
  }
  const dataDir = o.dataDir ?? tempDir();
  const env: NodeJS.ProcessEnv = o.withKey === false ? {} : { CUELOR_PROVIDER_TEST_KEY: mock.testKey };
  const definition = buildProvider({ baseUrl: mock.url, env, platform: "linux", retry: { maxDelayMs: 50 }, ...o.options });
  const token = randomBytes(24).toString("hex");
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const logs: string[] = [];
  const { handler, runtime } = createProviderHandler(definition, { dataDir, token, allowedHosts: [`127.0.0.1:${port}`], log: (m) => logs.push(m) });
  runtime.port = port;
  server.on("request", handler);
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  after(close);
  const call: Plugin["call"] = async (method, p, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.auth !== false) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers,
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      redirect: init.redirect ?? "follow",
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { mock, runtime, definition, port, dataDir, logs, call, close };
}

/** Uploads bytes as an artifact. */
export async function upload(p: Plugin, bytes: Uint8Array, mediaType: string, name = "file") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mediaType }), name);
  const req = new Request("http://upload.invalid/", { method: "POST", body: form });
  const res = await p.call("POST", "/v1/artifacts", { raw: new Uint8Array(await req.arrayBuffer()), headers: { "content-type": req.headers.get("content-type")! } });
  assert.ok(res.status === 200 || res.status === 201, `upload: ${res.status} ${res.text}`);
  return res.json as { id: string };
}

/** Polls a job until it ends. */
export async function waitForEnd(p: Plugin, id: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = (await p.call("GET", `/v1/jobs/${id}`)).json;
    if (["succeeded", "failed", "rejected", "expired", "cancelled"].includes(j.status)) return j;
    if (Date.now() > deadline) throw new Error(`job ${id} did not end: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let keyCounter = 0;
/** Submits a job with a fresh idempotency key. */
export async function submit(p: Plugin, body: unknown, key = `test-${process.pid}-${++keyCounter}`) {
  return p.call("POST", "/v1/jobs", { body, headers: { "idempotency-key": key } });
}
