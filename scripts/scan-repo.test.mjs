// Tests for scan-repo.mjs. Key-shaped samples are assembled at run time so that no committed file
// contains one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText, loadHashes, candidates } from "./scan-repo.mjs";

const none = new Set();
const repeat = (c, n) => c.repeat(n);

test("finds common key formats", () => {
  const samples = {
    "Anthropic API key": "sk-" + "ant-" + "api03-" + repeat("a", 40),
    "OpenAI API key": "sk-" + "proj-" + repeat("B", 40),
    "OpenRouter API key": "sk-" + "or-v1-" + repeat("0", 64),
    "AWS access key id": "AKIA" + repeat("Z", 16),
    "GitHub token": "gh" + "p_" + repeat("x", 36),
    "npm token": "npm" + "_" + repeat("y", 36),
    "private key": "-----BEGIN " + "RSA PRIVATE" + " KEY-----",
    "Google API key": "AI" + "za" + repeat("c", 35),
    "Tailscale address": "100." + "100.1.2",
  };
  for (const [kind, sample] of Object.entries(samples)) {
    const found = scanText(`const x = "${sample}";`, none).map((f) => f.kind);
    assert.ok(found.includes(kind), `${kind} not found in ${found}`);
  }
});

test("does not flag ordinary text", () => {
  const text = [
    "the sk-learn library", "npm_config_cache", "100.0.0.1 is not tailscale", "AKIA",
    "sha256 3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7",
    "Authorization: Bearer <token>", "https://example.com/v1/jobs",
  ].join("\n");
  assert.deepEqual(scanText(text, none), []);
});

test("forbidden terms match by hash, including subdomains and underscores", () => {
  const term = "internal-" + "example.dev";
  const name = "secret" + "-svc";
  const hashes = new Set([term, name].map((t) => createHash("sha256").update(t).digest("hex")));
  const text = `url = "https://api.${term}/v1"\nenv SECRET_SVC_URL\nnothing here`;
  const lines = scanText(text, hashes).map((f) => f.line);
  assert.deepEqual(lines, [1, 2]);
  assert.ok(scanText(text, hashes).every((f) => !f.kind.includes(term)), "the term itself is never printed");
});

test("candidates cover parent domains and word runs", () => {
  const c = candidates("see a.b.example.com and my_service-name");
  for (const want of ["a.b.example.com", "b.example.com", "example.com", "my-service", "service-name", "my-service-name"]) {
    assert.ok(c.has(want), want);
  }
});

test("loadHashes reads the list, the environment and the local file", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  mkdirSync(join(root, "scripts"));
  const listed = createHash("sha256").update("listed").digest("hex");
  writeFileSync(join(root, "scripts", "forbidden-terms.sha256"), `# comment\n${listed}\n`);
  writeFileSync(join(root, ".forbidden-terms"), "# local\nLocal_Term\n");
  const hashes = loadHashes(root, { CUELOR_FORBIDDEN_TERMS: "from-env, other" });
  for (const t of ["listed", "local-term", "from-env", "other"]) {
    assert.ok(hashes.has(createHash("sha256").update(t).digest("hex")), t);
  }
});

test("forbidden terms with a slash match as path segments", () => {
  // Repository-style names (owner/repo). Built at run time; the names are not real ones.
  const owner = "z", repo = "widget" + "-tools";
  const term = [owner, "widget"].join("/");
  const longer = [owner, repo].join("/");
  const hashes = new Set([term, longer].map((t) => createHash("sha256").update(t).digest("hex")));
  const text = [
    `see ${term}#236 for the decision`,
    `git clone https://git.example.test/${longer}.git`,
    `the ${owner} team and the widget library`,
    `in ${repo}/src/${owner}/widget-x`,
  ].join("\n");
  assert.deepEqual(scanText(text, hashes).map((f) => f.line), [1, 2]);
  const c = candidates(`a/${owner}/widget/b and ${owner}/${repo}.git`);
  for (const want of [term, longer, "a/" + term]) assert.ok(c.has(want), want);
});

test("the command scans when started through a symbolic link", () => {
  // macOS temporary directories are behind /var -> /private/var; the scan must not silently do nothing.
  const dir = mkdtempSync(join(tmpdir(), "scan-link-"));
  symlinkSync(fileURLToPath(new URL(".", import.meta.url)), join(dir, "scripts"));
  const r = spawnSync(process.execPath, [join(dir, "scripts", "scan-repo.mjs"), "--stdin"], {
    input: "-----BEGIN " + "RSA PRIVATE" + " KEY-----\n",
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /stdin:1: private key/);
});
