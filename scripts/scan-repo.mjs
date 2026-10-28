#!/usr/bin/env node
// Scans the repository for things that must never be published (AGENTS.md):
//
//   - secrets in common key formats (see KEY_PATTERNS);
//   - internal addresses: Tailscale addresses (the 100.64/10 CGNAT range) and *.ts.net names;
//   - forbidden terms: internal host, service and repository names (owner/repo). Only their SHA-256 is committed
//     (scripts/forbidden-terms.sha256). More terms, in plain text, can come from the
//     CUELOR_FORBIDDEN_TERMS environment variable (comma or newline separated; CI keeps it as a
//     secret) or from an untracked .forbidden-terms file.
//
// Findings are printed as file:line and a kind, never with the matched text, so CI logs stay clean.
// Usage: node scripts/scan-repo.mjs [--root DIR]
//        node scripts/scan-repo.mjs --stdin [--label NAME]   (scan text such as commit messages or a
//                                                            pull request description)

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KEY_PATTERNS = [
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenRouter API key", /\bsk-or-v1-[0-9a-f]{32,}/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["Slack token", /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/],
  ["Tailscale address", /\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b/],
  ["Tailscale host name", /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i],
];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Candidate terms in a line: host names and their parent domains, runs of words, and runs of path
 * segments (for repository names such as owner/repo; a trailing .git is dropped).
 */
export function candidates(line) {
  const out = new Set();
  const lower = line.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9._-]+(?:\/[a-z0-9._-]+)+/g)) {
    const segments = m[0].split("/").map((s) => s.replace(/\.git$/, ""));
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 2; j <= Math.min(segments.length, i + 6); j++) out.add(segments.slice(i, j).join("/"));
    }
  }
  for (const m of lower.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)) {
    const labels = m[0].split(".");
    for (let i = 0; i < labels.length - 1; i++) out.add(labels.slice(i).join("."));
  }
  for (const m of lower.matchAll(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g)) {
    const parts = m[0].split(/[-_]/);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j <= Math.min(parts.length, i + 6); j++) out.add(parts.slice(i, j).join("-"));
    }
  }
  return out;
}

/**
 * Scans text. `hashes` is a Set of SHA-256 hex digests of forbidden terms (normalised: lowercase,
 * `_` written as `-`). Returns [{line, kind}].
 */
export function scanText(text, hashes) {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [kind, re] of KEY_PATTERNS) {
      if (re.test(line)) findings.push({ line: i + 1, kind });
    }
    if (hashes.size > 0) {
      for (const c of candidates(line)) {
        const h = sha256(c);
        if (hashes.has(h)) findings.push({ line: i + 1, kind: `forbidden term (sha256 ${h.slice(0, 12)}…)` });
      }
    }
  });
  return findings;
}

/** Loads the forbidden-term hashes: the committed list, plus plain-text terms from env and file. */
export function loadHashes(root, env = process.env) {
  const hashes = new Set();
  const list = join(root, "scripts", "forbidden-terms.sha256");
  if (existsSync(list)) {
    for (const line of readFileSync(list, "utf8").split("\n")) {
      const t = line.trim();
      if (/^[0-9a-f]{64}$/.test(t)) hashes.add(t);
    }
  }
  const plain = [];
  if (env.CUELOR_FORBIDDEN_TERMS) plain.push(...env.CUELOR_FORBIDDEN_TERMS.split(/[,\n]/));
  const local = join(root, ".forbidden-terms");
  if (existsSync(local)) plain.push(...readFileSync(local, "utf8").split("\n").filter((l) => !l.startsWith("#")));
  for (const term of plain) {
    const t = term.trim().toLowerCase().replaceAll("_", "-");
    if (t) hashes.add(sha256(t));
  }
  return hashes;
}

/** Files to scan: tracked files plus untracked files that are not ignored. */
export function repoFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  return out.toString("utf8").split("\0").filter(Boolean);
}

function report(findings) {
  for (const f of findings) console.error(`${f.where}: ${f.kind}`);
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s); nothing above may be published (see AGENTS.md)`);
    process.exit(1);
  }
}

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const root = resolve(option(args, "--root") ?? join(fileURLToPath(import.meta.url), "..", ".."));
  const hashes = loadHashes(root);
  if (args.includes("--stdin")) {
    const label = option(args, "--label") ?? "stdin";
    const findings = scanText(readFileSync(0, "utf8"), hashes).map((f) => ({ where: `${label}:${f.line}`, kind: f.kind }));
    report(findings);
    console.log(`scanned ${label}, ${hashes.size} forbidden terms: no findings`);
    return;
  }
  const findings = [];
  let scanned = 0;
  for (const file of repoFiles(root)) {
    if (file === "scripts/forbidden-terms.sha256") continue;
    const path = join(root, file);
    if (!existsSync(path)) continue; // deleted in the working tree
    const buf = readFileSync(path);
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    scanned++;
    for (const f of scanText(buf.toString("utf8"), hashes)) findings.push({ where: `${file}:${f.line}`, kind: f.kind });
  }
  report(findings);
  console.log(`scanned ${scanned} files, ${hashes.size} forbidden terms: no findings`);
}

// realpath: started through a symbolic link (such as /var -> /private/var on macOS), the module URL is the
// resolved path.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();
