import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "minimal-provider.ts");

function spawnFixture(env: Record<string, string>, stdin: "pipe" | "ignore" = "pipe"): ChildProcess {
  return spawn(process.execPath, [FIXTURE], {
    env: { PATH: process.env.PATH ?? "", CUELOR_PROVIDER_DATA_DIR: tempDir(), CUELOR_PROVIDER_PROTOCOL: "1", ...env },
    stdio: [stdin, "pipe", "pipe"],
  });
}

const exitCode = (child: ChildProcess) => new Promise<number | null>((r) => child.on("exit", (code) => r(code)));

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl >= 0) resolve(out.slice(0, nl));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code} before printing a line`)));
  });
}

test("command mode: token on stdin, port line, guard, exit when stdin closes", async () => {
  const token = randomBytes(30).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 36);
  const child = spawnFixture({});
  const exited = exitCode(child);
  child.stdin!.write(token + "\n");
  const line = await firstLine(child);
  const m = /^cuelor-provider-listening port=(\d+)$/.exec(line);
  assert.ok(m, line);
  const port = Number(m[1]);
  const ok = await fetch(`http://127.0.0.1:${port}/v1/provider`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { provider: { id: string } }).provider.id, "example.minimal");
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/provider`)).status, 401);
  assert.equal((await fetch(`http://localhost:${port}/v1/provider`, { headers: { authorization: `Bearer ${token}` } })).status, 403);
  // Not reachable on another interface: the server listens on 127.0.0.1 only.
  const addr = await new Promise<string>((r) => {
    const s = net.connect(port, "127.0.0.1", () => {
      r(s.remoteAddress ?? "");
      s.destroy();
    });
  });
  assert.equal(addr, "127.0.0.1");
  const t0 = Date.now();
  child.stdin!.end();
  assert.equal(await exited, 0);
  assert.ok(Date.now() - t0 < 5000);
});

test("command mode: a short token is refused", async () => {
  const child = spawnFixture({});
  const exited = exitCode(child);
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  child.stdin!.write("tooshort\n");
  assert.equal(await exited, 1);
  assert.match(err, /at least 32/);
});

test("standalone mode: token file and listen address", async () => {
  const dir = tempDir();
  const tokenFile = path.join(dir, "token");
  const token = randomBytes(24).toString("hex");
  writeFileSync(tokenFile, token + "\n");
  const port = await new Promise<number>((r) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
  const child = spawnFixture({ CUELOR_PROVIDER_LISTEN: `127.0.0.1:${port}`, CUELOR_PROVIDER_TOKEN_FILE: tokenFile }, "ignore");
  const exited = exitCode(child);
  try {
    let res: Response | undefined;
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/v1/provider`, { headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
      if (!res) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(res?.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/provider`, { headers: { authorization: "Bearer nope" } })).status, 401);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
});

test("command mode: exits when stdin closes right after the token", async () => {
  const token = "B".repeat(40);
  const child = spawnFixture({});
  const exited = exitCode(child);
  child.stdin!.end(token + "\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, "the plugin did not exit within 5 s after stdin closed");
});

test("one data directory, one instance: a second one is refused; after kill -9 the directory is free again", async () => {
  const dataDir = tempDir();
  const start = () => {
    const child = spawnFixture({ CUELOR_PROVIDER_DATA_DIR: dataDir });
    child.stdin!.write("C".repeat(40) + "\n");
    return child;
  };
  const first = start();
  const firstExit = exitCode(first);
  assert.match(await firstLine(first), /^cuelor-provider-listening port=\d+$/);
  assert.ok(existsSync(path.join(dataDir, "instance.lock")));

  const second = start();
  let err = "";
  second.stderr!.on("data", (d) => (err += d));
  const timer = setTimeout(() => second.kill("SIGKILL"), 10_000); // a second instance that started
  assert.equal(await exitCode(second), 1);
  clearTimeout(timer);
  assert.match(err, /another instance is using the data directory/);
  assert.match(err, /instance\.lock/);

  first.kill("SIGKILL");
  await firstExit;
  assert.ok(existsSync(path.join(dataDir, "instance.lock")), "kill -9 leaves the lock behind");
  const third = start();
  const thirdExit = exitCode(third);
  assert.match(await firstLine(third), /^cuelor-provider-listening port=\d+$/);
  third.stdin!.end();
  assert.equal(await thirdExit, 0);
  assert.ok(!existsSync(path.join(dataDir, "instance.lock")), "a clean exit removes the lock");
});
