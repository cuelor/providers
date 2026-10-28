import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  canonicalJson,
  constantTimeEqual,
  createRequestGuard,
  errorBody,
  isValidHandshakeToken,
  listenModeFromEnv,
  listeningLine,
  normalizeMediaType,
  onStdinClosed,
  ProviderError,
  readHandshakeToken,
  sameJson,
  sanitizeMessage,
  sniffMediaType,
} from "../src/index.ts";

test("canonical JSON ignores key order and whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), '{"a":[1,{"c":3,"d":2}],"b":1}');
  assert.ok(sameJson(JSON.parse('{"x": 1.0, "y": "z"}'), { y: "z", x: 1 }));
  assert.ok(!sameJson({ a: 1 }, { a: "1" }));
  assert.ok(!sameJson([1, 2], [2, 1]));
});

test("sanitizeMessage removes secrets, signed URLs and control characters and truncates", () => {
  const fakeKey = ["s", "k-"].join("") + "abcdefghijklmnopqrstuvwx";
  const out = sanitizeMessage(`upstream said no for ${fakeKey} at https://api.example.com/v1/x?sig=abc&exp=1\u0000 token SECRET-VALUE`, ["SECRET-VALUE"]);
  assert.ok(!out.includes(fakeKey));
  assert.ok(!out.includes("SECRET-VALUE"));
  assert.ok(!out.includes("sig=abc"));
  assert.ok(out.includes("https://api.example.com/v1/x"));
  assert.ok(!out.includes("\u0000"));
  assert.ok(sanitizeMessage("Bearer " + "q".repeat(40)).includes("[redacted]"));
  assert.equal(sanitizeMessage("x".repeat(1000)).length, 300);
  assert.equal(sanitizeMessage("missing or invalid bearer token"), "missing or invalid bearer token");
});

test("errorBody has the standard shape", () => {
  assert.deepEqual(errorBody("invalid_request", "bad", { reason: "unknown_model", params: { model: "m" } }), {
    error: { code: "invalid_request", message: "bad", reason: "unknown_model", params: { model: "m" } },
  });
  assert.deepEqual(new ProviderError(404, "not_found", "nope").toBody(), { error: { code: "not_found", message: "nope" } });
});

test("constantTimeEqual", () => {
  assert.ok(constantTimeEqual("abc", "abc"));
  assert.ok(!constantTimeEqual("abc", "abd"));
  assert.ok(!constantTimeEqual("abc", "abcd"));
  assert.ok(!constantTimeEqual("", "a"));
});

test("request guard rejects Origin, wrong Host and bad bearer tokens", () => {
  const token = "t".repeat(40);
  const guard = createRequestGuard({ token, allowedHosts: ["127.0.0.1:1234"] });
  const ok = { host: "127.0.0.1:1234", authorization: `Bearer ${token}` };
  guard(ok);
  const status = (h: Record<string, string>) => {
    try {
      guard(h);
      return 0;
    } catch (err) {
      assert.ok(err instanceof ProviderError);
      assert.ok(!err.message.includes(token));
      return err.status;
    }
  };
  assert.equal(status({ ...ok, origin: "https://example.com" }), 403);
  assert.equal(status({ ...ok, host: "localhost:1234" }), 403);
  assert.equal(status({ ...ok, host: "127.0.0.1:9999" }), 403);
  assert.equal(status({ host: ok.host }), 401);
  assert.equal(status({ ...ok, authorization: `Bearer ${token}x` }), 401);
  assert.equal(status({ ...ok, authorization: `Basic ${token}` }), 401);
});

test("handshake token is read from the first stdin line", async () => {
  const stdin = new PassThrough();
  const token = "A1".repeat(20);
  const p = readHandshakeToken(stdin);
  stdin.write(token.slice(0, 10));
  stdin.write(token.slice(10) + "\nmore");
  assert.equal(await p, token);
  assert.ok(isValidHandshakeToken(token));
  assert.ok(!isValidHandshakeToken("short"));
  assert.ok(!isValidHandshakeToken("x".repeat(31) + "-"));
  assert.equal(listeningLine(5), "cuelor-provider-listening port=5\n");
});

test("handshake rejects a bad token, an early end and a timeout", async () => {
  const bad = new PassThrough();
  const p1 = readHandshakeToken(bad);
  bad.write("not a token\n");
  await assert.rejects(p1, /at least 32/);
  const early = new PassThrough();
  const p2 = readHandshakeToken(early);
  early.end();
  await assert.rejects(p2, /closed/);
  await assert.rejects(readHandshakeToken(new PassThrough(), { timeoutMs: 20 }), /timed out/);
});

test("listen mode from the environment", () => {
  assert.deepEqual(listenModeFromEnv({}), { kind: "command" });
  assert.deepEqual(listenModeFromEnv({ CUELOR_PROVIDER_LISTEN: "0.0.0.0:8787", CUELOR_PROVIDER_TOKEN_FILE: "/t", CUELOR_PROVIDER_ALLOWED_HOSTS: "a.example.com, b.example.com:8443" }), {
    kind: "standalone",
    host: "0.0.0.0",
    port: 8787,
    tokenFile: "/t",
    allowedHosts: ["a.example.com", "b.example.com:8443"],
  });
  assert.throws(() => listenModeFromEnv({ CUELOR_PROVIDER_LISTEN: "8787" }));
  assert.throws(() => listenModeFromEnv({ CUELOR_PROVIDER_LISTEN: "127.0.0.1:8787" }));
});

test("media types: aliases and sniffing", () => {
  assert.equal(normalizeMediaType("Audio/X-WAV; codecs=1"), "audio/wav");
  assert.equal(normalizeMediaType("image/jpg"), "image/jpeg");
  assert.equal(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMediaType(Buffer.from("RIFF\0\0\0\0WAVEfmt ")), "audio/wav");
  assert.equal(sniffMediaType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffMediaType(Buffer.from("\0\0\0\x18ftypisom")), "video/mp4");
  assert.equal(sniffMediaType(Buffer.from("hello")), undefined);
});

test("onStdinClosed fires when stdin already ended during the handshake", async () => {
  const stdin = new PassThrough();
  const token = readHandshakeToken(stdin);
  stdin.write("A".repeat(40) + "\n");
  assert.equal(await token, "A".repeat(40));
  stdin.end();
  await new Promise((r) => setTimeout(r, 50));
  const fired = await new Promise<boolean>((resolve) => {
    onStdinClosed(() => resolve(true), stdin);
    setTimeout(() => resolve(false), 500);
  });
  assert.equal(fired, true);
});
