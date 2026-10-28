// Account, binding, the setup page (OAuth PKCE and a pasted key) and the stdin login. The keychain is an
// in-memory stand-in, or a temporary keychain file on macOS: never the user's login keychain.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computeBinding, keychainGet, keychainService } from "@cuelor/provider-sdk";
import { Credentials, KEYCHAIN_ACCOUNT } from "../src/account.ts";
import { runLogin } from "../src/login.ts";
import { MockOpenRouter, MOCK_USER_ID } from "./mock-openrouter.ts";
import { fakeKeychain, startPlugin, tempDir, type Plugin } from "./helpers.ts";

const SERVICE = keychainService("cuelor.openrouter");

test("without a key: needs_setup, a binding from the empty credential, and no new work", async () => {
  const p = await startPlugin({ withKey: false });
  const d = (await p.call("GET", "/v1/provider")).json;
  assert.equal(d.account.status, "needs_setup");
  assert.equal(d.account.binding, await computeBinding("", { dataDir: p.dataDir }));
  assert.equal(d.capabilities.setup, true);
  assert.equal(d.capabilities.cancel, false, "OpenRouter has no cancel endpoint");
  const models = await p.call("GET", "/v1/models");
  assert.deepEqual([models.status, models.json.error.code], [403, "provider_not_ready"]);
});

test("a 401 from OpenRouter marks the key invalid_credentials", async () => {
  const mock = new MockOpenRouter();
  await mock.start();
  const p = await startPlugin({ mock, options: { env: { CUELOR_PROVIDER_TEST_KEY: "a-key-the-mock-does-not-know" } } });
  assert.equal((await p.call("GET", "/v1/provider")).json.account.status, "ready", "the key is not checked on every request");
  const res = await p.call("POST", "/v1/jobs", { body: { model: "google/veo-3.1", route: "text2video", input: { artifacts: [] }, parameters: { prompt: "x" } }, headers: { "idempotency-key": "k401" } });
  assert.deepEqual([res.status, res.json.error.code], [403, "provider_not_ready"]);
  p.runtime.invalidateAccount();
  assert.equal((await p.call("GET", "/v1/provider")).json.account.status, "invalid_credentials");
  await mock.close();
});

test("the setup page: no bearer token, Host and Origin checked, OAuth PKCE to the keychain, binding from the user id", async () => {
  const keychain = fakeKeychain();
  const p = await startPlugin({ withKey: false, options: { platform: "darwin", keychain: { run: keychain.run } } });
  const setup = await p.call("POST", "/v1/setup");
  assert.equal(setup.status, 200);
  const url = new URL(setup.json.url);
  assert.equal(url.host, `127.0.0.1:${p.port}`);
  assert.match(url.pathname, /^\/setup\/[0-9a-f]{48}$/);
  assert.ok(Date.parse(setup.json.expires_at) - Date.now() <= 10 * 60_000);

  const page = await p.call("GET", url.pathname, { auth: false });
  assert.equal(page.status, 200);
  assert.match(page.text, /Sign in with OpenRouter/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer", "the secret path does not leak to OpenRouter");
  assert.equal((await p.call("GET", url.pathname, { auth: false, headers: { origin: "https://evil.example.com" } })).status, 403);
  assert.equal((await p.call("GET", "/setup/" + "0".repeat(48), { auth: false })).status, 404);
  assert.equal((await p.call("GET", "/v1/provider", { auth: false, headers: { origin: `http://127.0.0.1:${p.port}` } })).status, 403, "/v1/ still rejects every Origin");

  // "Sign in": the plugin redirects to OpenRouter's authorization page with an S256 challenge.
  const start = await p.call("GET", `${url.pathname}/oauth`, { auth: false, redirect: "manual" });
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.get("location")!);
  assert.equal(auth.origin, p.mock.url);
  assert.equal(auth.pathname, "/auth");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("callback_url"), `http://127.0.0.1:${p.port}${url.pathname}/callback`);
  // The mock approves at once and sends the browser back to the callback.
  const back = await fetch(auth, { redirect: "manual" });
  const callback = new URL(back.headers.get("location")!);
  assert.equal(callback.host, `127.0.0.1:${p.port}`);
  const done = await p.call("GET", callback.pathname + callback.search, { auth: false });
  assert.equal(done.status, 200, done.text);
  assert.match(done.text, /connected/);

  const stored = keychain.items.get(`${SERVICE}\n${KEYCHAIN_ACCOUNT}`)!;
  assert.match(stored, /^mock-oauth-/);
  assert.ok(!done.text.includes(stored) && !p.logs.join("\n").includes(stored), "the key is not shown or logged");
  const d = (await p.call("GET", "/v1/provider")).json;
  assert.equal(d.account.status, "ready", "setup dropped the cached account");
  assert.equal(d.account.binding, await computeBinding("user\n" + MOCK_USER_ID, { dataDir: p.dataDir }));
  // One use.
  assert.equal((await p.call("GET", url.pathname, { auth: false })).status, 404);
  assert.equal((await p.call("GET", callback.pathname + callback.search, { auth: false })).status, 404);
});

test("the setup page: a pasted key is checked, saved, and bound by the key; the page expires after 10 minutes", async () => {
  const keychain = fakeKeychain();
  let now = Date.now();
  const p = await startPlugin({ withKey: false, options: { platform: "darwin", keychain: { run: keychain.run }, now: () => now } });
  const own = { origin: `http://127.0.0.1:${p.port}`, "content-type": "application/x-www-form-urlencoded" };
  const pathname = new URL((await p.call("POST", "/v1/setup")).json.url).pathname;
  const wrong = await p.call("POST", `${pathname}/key`, { auth: false, headers: own, raw: new TextEncoder().encode("key=not-a-valid-key") });
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /rejected/);
  assert.equal(keychain.items.size, 0);
  const ok = await p.call("POST", `${pathname}/key`, { auth: false, headers: own, raw: new TextEncoder().encode(`key=${encodeURIComponent(p.mock.testKey)}`) });
  assert.equal(ok.status, 200, ok.text);
  const d = (await p.call("GET", "/v1/provider")).json;
  assert.equal(d.account.binding, await computeBinding("key\n" + p.mock.testKey, { dataDir: p.dataDir }));
  assert.notEqual(d.account.binding, await computeBinding("user\n" + MOCK_USER_ID, { dataDir: p.dataDir }), "two ways in, two bindings (VALIDATION.md)");

  const late = new URL((await p.call("POST", "/v1/setup")).json.url).pathname;
  now += 10 * 60_000 + 1;
  assert.equal((await p.call("GET", late, { auth: false })).status, 404, "expired");
});

test("login: the key comes from stdin, never from arguments, and is checked first", async () => {
  const mock = new MockOpenRouter();
  await mock.start();
  const keychain = fakeKeychain();
  const credentials = new Credentials({ env: {}, platform: "darwin", keychain: { run: keychain.run } });
  const run = async (args: string[], input: string) => {
    let err = "";
    const stderr = new Writable({ write: (c, _e, cb) => ((err += c), cb()) });
    const code = await runLogin({ args, stdin: Readable.from([input]), stderr, credentials, baseUrl: mock.url });
    return { code, err };
  };
  assert.equal((await run([mock.testKey], "")).code, 2, "a key as an argument is refused");
  assert.equal(keychain.items.size, 0);
  const rejected = await run([], "wrong-key\n");
  assert.deepEqual([rejected.code, /rejected/.test(rejected.err)], [1, true]);
  const ok = await run([], `${mock.testKey}\n`);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(keychain.items.get(`${SERVICE}\n${KEYCHAIN_ACCOUNT}`), mock.testKey);
  assert.ok(!ok.err.includes(mock.testKey));
  await mock.close();
});

test("login refuses a key on the command line of the built plugin", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const r = spawnSync(process.execPath, [main, "login", "some-key-value"], { input: "", encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /read from stdin/);
});

test("keychain round trip with a temporary keychain file (macOS only)", { skip: process.platform !== "darwin" }, async () => {
  const dir = tempDir();
  const file = path.join(dir, "test.keychain-db");
  execFileSync("/usr/bin/security", ["create-keychain", "-p", "test-password", file]);
  try {
    execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "test-password", file]);
    const mock = new MockOpenRouter();
    await mock.start();
    const credentials = new Credentials({ env: {}, keychain: { keychain: file } });
    const stderr = new Writable({ write: (_c, _e, cb) => cb() });
    assert.equal(await runLogin({ args: [], stdin: Readable.from([mock.testKey + "\n"]), stderr, credentials, baseUrl: mock.url }), 0);
    assert.equal(await keychainGet(SERVICE, KEYCHAIN_ACCOUNT, { keychain: file }), mock.testKey);
    const fresh = new Credentials({ env: {}, keychain: { keychain: file } });
    assert.equal((await fresh.account(dir)).status, "ready");
    await mock.close();
  } finally {
    execFileSync("/usr/bin/security", ["delete-keychain", file]);
  }
});

const FORM = "application/x-www-form-urlencoded";
const body = (key: string) => new TextEncoder().encode(`key=${encodeURIComponent(key)}`);
const exchanges = (p: Plugin) => p.mock.requests.filter((r) => r.path === "/api/v1/auth/keys").length;

async function darwinPlugin(keys?: string[]) {
  const keychain = fakeKeychain();
  const mock = keys ? new MockOpenRouter({ keys, imageMs: 300 }) : undefined;
  const p = await startPlugin({ mock, withKey: false, options: { platform: "darwin", keychain: { run: keychain.run } } });
  const stored = () => keychain.items.get(`${SERVICE}\n${KEYCHAIN_ACCOUNT}`);
  const newPage = async () => new URL((await p.call("POST", "/v1/setup")).json.url).pathname;
  /** Starts "Sign in with OpenRouter" and returns the callback the mock sends the browser to. */
  const signIn = async (pathname: string) => {
    const start = await p.call("GET", `${pathname}/oauth`, { auth: false, redirect: "manual" });
    assert.equal(start.status, 302);
    const back = await fetch(start.headers.get("location")!, { redirect: "manual" });
    const cb = new URL(back.headers.get("location")!);
    return cb.pathname + cb.search;
  };
  return { p, keychain, stored, newPage, signIn, own: { origin: `http://127.0.0.1:${p.port}`, "content-type": FORM } };
}

/** A request with a chosen Host header, which fetch does not allow. */
function rawGet(port: number, pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("a completed setup closes every other setup page (rework item 5)", async () => {
  const { p, stored, newPage, signIn, own } = await darwinPlugin(["mock-key-one-0001", "mock-key-two-0002"]);
  const a = await newPage();
  const b = await newPage();
  const c = await newPage();
  const bCallback = await signIn(b); // Signed in on b, but the browser has not come back yet.
  assert.equal((await p.call("POST", `${a}/key`, { auth: false, headers: own, raw: body("mock-key-one-0001") })).status, 200);
  assert.equal(stored(), "mock-key-one-0001");
  // The other pages were opened before; none of them can replace the key now.
  assert.equal((await p.call("GET", b, { auth: false })).status, 404);
  assert.equal((await p.call("POST", `${c}/key`, { auth: false, headers: own, raw: body("mock-key-two-0002") })).status, 404);
  assert.equal((await p.call("GET", bCallback, { auth: false })).status, 404);
  assert.equal(stored(), "mock-key-one-0001", "not replaced");
  assert.equal(exchanges(p), 0, "b's code was never exchanged");
  // A page created after the setup works as usual.
  const d = await newPage();
  assert.equal((await p.call("GET", d, { auth: false })).status, 200);
});

test("setup: a wrong or missing OAuth state is refused and does not use up the sign-in (rework item 6)", async () => {
  const { p, stored, newPage, signIn } = await darwinPlugin();
  const pathname = await newPage();
  const callback = await signIn(pathname);
  const wrong = callback.replace(/state=[0-9a-f]+/, "state=" + "0".repeat(32));
  assert.notEqual(wrong, callback);
  assert.equal((await p.call("GET", wrong, { auth: false })).status, 400);
  assert.equal((await p.call("GET", callback.replace(/&?state=[0-9a-f]+/, ""), { auth: false })).status, 400);
  assert.equal((await p.call("GET", `${pathname}/callback?state=abc`, { auth: false })).status, 400, "no code");
  assert.equal(exchanges(p), 0);
  assert.equal(stored(), undefined);
  assert.equal((await p.call("GET", callback, { auth: false })).status, 200, "the real callback still works");
  assert.match(stored()!, /^mock-oauth-/);
});

test("setup: a callback before sign-in started is refused (rework item 6)", async () => {
  const { p, stored, newPage } = await darwinPlugin();
  const pathname = await newPage();
  assert.equal((await p.call("GET", `${pathname}/callback?code=abc&state=def`, { auth: false })).status, 400);
  assert.equal(exchanges(p), 0);
  assert.equal(stored(), undefined);
});

test("setup: a key posted from another origin is refused (rework item 6)", async () => {
  const { p, stored, newPage } = await darwinPlugin();
  const pathname = await newPage();
  const res = await p.call("POST", `${pathname}/key`, { auth: false, headers: { origin: "https://evil.example.com", "content-type": FORM }, raw: body(p.mock.testKey) });
  assert.equal(res.status, 403);
  assert.equal(stored(), undefined);
  assert.equal((await p.call("GET", pathname, { auth: false })).status, 200, "the page is still usable");
});

test("setup: pages under /setup/ check Host (rework item 6)", async () => {
  const { p, newPage } = await darwinPlugin();
  const pathname = await newPage();
  for (const host of ["evil.example.com", `localhost:${p.port}`, "127.0.0.1", `127.0.0.1:${p.port + 1}`]) {
    assert.equal(await rawGet(p.port, pathname, host), 403, host);
    assert.equal(await rawGet(p.port, `${pathname}/oauth`, host), 403, `${host} /oauth`);
  }
  assert.equal(await rawGet(p.port, pathname, `127.0.0.1:${p.port}`), 200);
});

test("setup: after a failed code exchange the callback cannot be replayed (rework item 6)", async () => {
  const { p, stored, newPage, signIn } = await darwinPlugin();
  const pathname = await newPage();
  const callback = await signIn(pathname);
  p.mock.failNext("/api/v1/auth/keys", { status: 500 });
  assert.equal((await p.call("GET", callback, { auth: false })).status, 502);
  assert.equal((await p.call("GET", callback, { auth: false })).status, 400, "the code is exchanged once");
  assert.equal(exchanges(p), 1);
  assert.equal(stored(), undefined);
  // Signing in again from the same page works.
  assert.equal((await p.call("GET", await signIn(pathname), { auth: false })).status, 200);
  assert.match(stored()!, /^mock-oauth-/);
});
