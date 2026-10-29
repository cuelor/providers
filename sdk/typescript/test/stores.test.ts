import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  acquireInstanceLock,
  ArtifactStore,
  computeBinding,
  IdempotencyStore,
  InstanceLockedError,
  isValidIdempotencyKey,
  keychainDelete,
  keychainGet,
  keychainService,
  keychainSet,
  parseUpload,
  parseWav,
  pngMetadata,
  ProviderError,
  quoteSecurityArg,
  requireIdempotencyKey,
  writeFileAtomic,
  type SecurityRunner,
} from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const DAY = 86_400_000;

test("atomic writes leave no temporary files", async () => {
  const dir = tempDir();
  const file = path.join(dir, "a", "b.json");
  await writeFileAtomic(file, "one");
  await writeFileAtomic(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.deepEqual(execFileSync("ls", ["-a", path.dirname(file)]).toString().split("\n").filter((n) => n.endsWith(".tmp")), []);
});

test("artifacts: same bytes and type give the same id, also in a new store", async () => {
  const dir = tempDir();
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new ArtifactStore({ dir, now: () => now });
  const a = await store.put(Buffer.from("hello"), "audio/x-wav");
  const b = await store.put(Buffer.from("hello"), "audio/wav");
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.artifact.id, b.artifact.id);
  assert.equal(a.artifact.media_type, "audio/wav");
  assert.equal(a.artifact.sha256, createHash("sha256").update("hello").digest("hex"));
  assert.equal(a.artifact.bytes, 5);
  const other = await store.put(Buffer.from("hello"), "text/plain");
  assert.notEqual(other.artifact.id, a.artifact.id);
  const again = new ArtifactStore({ dir, now: () => now });
  assert.equal((await again.put(Buffer.from("hello"), "audio/wav")).artifact.id, a.artifact.id);
  assert.equal((await again.readBytes(a.artifact.id)).toString(), "hello");
  assert.equal(ArtifactStore.toArtifact(a.artifact).id, a.artifact.id);
  assert.ok(!("kind" in ArtifactStore.toArtifact(a.artifact)));
});

test("artifacts: outputs are kept 7 days, then answer 410; unknown ids answer 404", async () => {
  const dir = tempDir();
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new ArtifactStore({ dir, now: () => now, outputRetentionMs: DAY }); // raised to the minimum
  const { artifact } = await store.put(Buffer.from("out"), "image/png", { kind: "output", metadata: { width: 1, height: 1 } });
  assert.equal(artifact.expires_at, new Date(now + 7 * DAY).toISOString());
  now += 7 * DAY - 1;
  await store.require(artifact.id);
  now += 2;
  await assert.rejects(store.require(artifact.id), (e: unknown) => e instanceof ProviderError && e.status === 410 && e.code === "artifact_expired");
  await assert.rejects(store.require("art_" + "0".repeat(32)), (e: unknown) => e instanceof ProviderError && e.status === 404);
  await assert.rejects(store.require("../etc/passwd"), (e: unknown) => e instanceof ProviderError && e.status === 404);
  now += 2 * DAY;
  assert.equal(await store.purgeExpired(), 1);
  assert.equal(await store.find(artifact.id), undefined);
});

test("idempotency: new, existing, conflict, settle, retention", async () => {
  const dir = tempDir();
  let now = Date.parse("2026-01-01T00:00:00Z");
  const store = new IdempotencyStore({ dir, now: () => now });
  const body = { model: "m", parameters: { a: 1, b: 2 } };
  const first = await store.begin("key-1", body, "job_1");
  assert.equal(first.kind, "new");
  assert.equal(first.record.state, "submitting");
  assert.ok(!readFileSync(path.join(dir, `${IdempotencyStore.keyHash("key-1")}.json`), "utf8").includes("key-1"));
  assert.equal((await store.begin("key-1", { parameters: { b: 2, a: 1 }, model: "m" }, "job_2")).kind, "existing");
  const conflict = await store.begin("key-1", { model: "m", parameters: { a: 1, b: 3 } }, "job_3");
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.record.job_id, "job_1");
  const settled = await store.settle("key-1", "up_1");
  assert.equal(settled.state, "submitted");
  assert.equal((await store.get("key-1"))?.upstream_id, "up_1");
  now += 30 * DAY - 1;
  assert.ok(await store.get("key-1"));
  now += 2;
  assert.equal(await store.get("key-1"), undefined);
  assert.equal(await store.purge(), 1);
  await store.begin("key-2", body, "job_4");
  await store.remove("key-2");
  assert.equal(await store.get("key-2"), undefined);
});

test("idempotency: a key whose job still exists outlives the retention", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const jobs = new Set(["job_live", "job_gone"]);
  const store = new IdempotencyStore({ dir: tempDir(), now: () => now, jobExists: async (id) => jobs.has(id) });
  await store.begin("live", { a: 1 }, "job_live");
  await store.begin("gone", { a: 1 }, "job_gone");
  now += 31 * DAY;
  jobs.delete("job_gone");
  assert.equal((await store.get("live"))?.job_id, "job_live");
  assert.equal(await store.get("gone"), undefined);
  assert.equal(await store.purge(), 1);
  assert.equal((await store.begin("live", { a: 1 }, "job_new")).kind, "existing");
});

test("idempotency: withKey serialises work on one key", async () => {
  const store = new IdempotencyStore({ dir: tempDir() });
  const order: string[] = [];
  await Promise.all([
    store.withKey("k", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    }),
    store.withKey("k", async () => {
      order.push("b");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
});

test("idempotency key header", () => {
  assert.ok(isValidIdempotencyKey("gen_01JB-abc"));
  assert.ok(isValidIdempotencyKey("x".repeat(128)));
  assert.ok(!isValidIdempotencyKey("x".repeat(129)));
  assert.ok(!isValidIdempotencyKey("has space"));
  assert.ok(!isValidIdempotencyKey("ü"));
  assert.throws(() => requireIdempotencyKey(undefined), (e: unknown) => e instanceof ProviderError && e.status === 400 && e.reason === "missing_idempotency_key");
  assert.throws(() => requireIdempotencyKey("bad key"), (e: unknown) => e instanceof ProviderError && e.reason === "invalid_idempotency_key");
});

function multipart(boundary: string, parts: { name: string; filename?: string; type?: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("preamble\r\n")];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename.replace(/["\\]/g, "\\$&")}"`;
    head += "\r\n";
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    chunks.push(Buffer.from(head + "\r\n"), p.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function byteStream(data: Buffer, chunk: number): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunk) parts.push(data.subarray(i, i + chunk));
  return Readable.from(parts);
}

test("multipart: the file part is streamed to disk and hashed, in any chunking", async () => {
  const dir = tempDir();
  const data = Buffer.concat([Buffer.from("\r\n--notboundary\r\n"), Buffer.alloc(5000, 7)]);
  const body = multipart("XyZ", [
    { name: "other", data: Buffer.from("ignored") },
    { name: "file", filename: 'a "b".wav', type: "audio/wav", data },
  ]);
  for (const size of [1, 7, 64, 100000]) {
    const tempPath = path.join(dir, `f${size}`);
    const f = await parseUpload(byteStream(body, size), { contentType: "multipart/form-data; boundary=XyZ", tempPath, maxBytes: 10000 });
    assert.equal(f.bytes, data.length);
    assert.equal(f.sha256, createHash("sha256").update(data).digest("hex"));
    assert.equal(f.mediaType, "audio/wav");
    assert.equal(f.filename, 'a "b".wav');
    assert.deepEqual(readFileSync(tempPath), data);
  }
});

test("multipart: too large, missing part, bad content type", async () => {
  const dir = tempDir();
  const tempPath = path.join(dir, "big");
  const body = multipart("b", [{ name: "file", filename: "x", type: "image/png", data: Buffer.alloc(2000) }]);
  await assert.rejects(
    parseUpload(byteStream(body, 100), { contentType: "multipart/form-data; boundary=b", tempPath, maxBytes: 1000 }),
    (e: unknown) => e instanceof ProviderError && e.status === 413 && (e.params as { max_bytes: number }).max_bytes === 1000,
  );
  assert.ok(!existsSync(tempPath));
  const none = multipart("b", [{ name: "other", data: Buffer.from("x") }]);
  await assert.rejects(parseUpload(byteStream(none, 10), { contentType: "multipart/form-data; boundary=b", tempPath, maxBytes: 1000 }), /no "file" part/);
  await assert.rejects(parseUpload(byteStream(none, 10), { contentType: "application/json", tempPath, maxBytes: 1000 }), /multipart/);
  const empty = multipart("b", [{ name: "file", filename: "e", data: Buffer.alloc(0) }]);
  const f = await parseUpload(byteStream(empty, 3), { contentType: 'multipart/form-data; boundary="b"', tempPath, maxBytes: 1000 });
  assert.equal(f.bytes, 0);
});

test("binding: 64 hex digits, stable, changes with the secret and the salt", async () => {
  const dir = tempDir();
  const a = await computeBinding("secret-one", { dataDir: dir });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(await computeBinding("secret-one", { dataDir: dir }), a);
  assert.notEqual(await computeBinding("secret-two", { dataDir: dir }), a);
  assert.notEqual(await computeBinding("secret-one", { dataDir: tempDir() }), a);
  assert.ok(!a.includes(Buffer.from("secret-one").toString("hex")));
});

test("keychain: commands go to security -i on stdin, never in argv", async () => {
  const calls: { args: string[]; stdin: string }[] = [];
  const run: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (stdin.startsWith("find-generic-password")) return { code: 0, stdout: 'va"l\\ue\n', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const service = keychainService("example.x");
  assert.equal(service, "cuelor-provider:example.x");
  await keychainSet(service, "default", 'va"l\\ue', { run });
  assert.deepEqual(calls[0]!.args, ["-i"]);
  assert.equal(calls[0]!.stdin, 'add-generic-password -U -s "cuelor-provider:example.x" -a "default" -w "va\\"l\\\\ue"\n');
  assert.equal(await keychainGet(service, "default", { run }), 'va"l\\ue');
  assert.ok(await keychainDelete(service, "default", { run }));
  assert.throws(() => quoteSecurityArg("a\nb"));
  const missing: SecurityRunner = async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." });
  assert.equal(await keychainGet(service, "default", { run: missing }), undefined);
});

test("keychain: round trip on a temporary keychain file (macOS only)", { skip: process.platform !== "darwin" }, async () => {
  const dir = tempDir();
  const keychain = path.join(dir, "test.keychain-db");
  execFileSync("/usr/bin/security", ["create-keychain", "-p", "test-password", keychain]);
  try {
    execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "test-password", keychain]);
    const secret = 'not "a" real\\ key with spaces';
    await keychainSet("cuelor-provider:example.test", "default", secret, { keychain });
    assert.equal(await keychainGet("cuelor-provider:example.test", "default", { keychain }), secret);
    await keychainSet("cuelor-provider:example.test", "default", "replaced", { keychain });
    assert.equal(await keychainGet("cuelor-provider:example.test", "default", { keychain }), "replaced");
    assert.ok(await keychainDelete("cuelor-provider:example.test", "default", { keychain }));
    assert.equal(await keychainGet("cuelor-provider:example.test", "default", { keychain }), undefined);
  } finally {
    execFileSync("/usr/bin/security", ["delete-keychain", keychain]);
  }
});

test("probe: PNG size and WAV header", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(pngMetadata(png), { width: 640, height: 480 });
  const wav = readFileSync(new URL("../../../conformance/samples/en.wav", import.meta.url));
  const info = parseWav(wav)!;
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.ok(Math.abs(info.durationMs - 5860) <= 1);
  assert.equal(JSON.parse(info.info.ICMT!).language, "en");
});

test("instance lock: refused while held, released, stale locks taken over", async () => {
  const dir = tempDir();
  const file = path.join(dir, "instance.lock");
  const lock = await acquireInstanceLock(dir);
  await assert.rejects(acquireInstanceLock(dir), InstanceLockedError);
  await lock.release();
  assert.ok(!existsSync(file));
  // A dead process on this host: taken over at once.
  const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).toString();
  writeFileSync(file, JSON.stringify({ pid: Number(dead), host: os.hostname(), nonce: "x", started_at: "2026-01-01T00:00:00Z" }));
  await (await acquireInstanceLock(dir)).release();
  // A live process on this host (the parent of this test): refused.
  writeFileSync(file, JSON.stringify({ pid: process.ppid, host: os.hostname(), nonce: "x", started_at: "2026-01-01T00:00:00Z" }));
  await assert.rejects(acquireInstanceLock(dir), /pid \d+ on /);
  // Another host, or an unreadable file: refused while it is touched, taken over once it is not.
  for (const content of [JSON.stringify({ pid: 1, host: "other.example", nonce: "x", started_at: "2026-01-01T00:00:00Z" }), "not json"]) {
    writeFileSync(file, content);
    await assert.rejects(acquireInstanceLock(dir), InstanceLockedError);
    const old = new Date(Date.now() - 61_000);
    utimesSync(file, old, old);
    await (await acquireInstanceLock(dir)).release();
  }
});
