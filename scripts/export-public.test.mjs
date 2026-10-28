// Tests for export-public.mjs: export drills against a local bare repository that stands in for the
// public one, and the cases the gate must refuse without leaving a commit or a tag. Everything happens in
// temporary directories with an isolated git configuration (which asks for signing and names another
// user, to prove neither leaks into an export). The forbidden term and the key-shaped string are made up
// and assembled at run time, so no committed file contains them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const IDENTITY = "Cuelor <oss@cuelor.com>";
const TERM = ["zq", "build", "host"].join("-");
const KEY = "sk-" + "ant-" + "api03-" + "a".repeat(40);

function run(cwd, env, cmd, args, input) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8" });
  if (r.error) throw r.error;
  return r;
}

/** A sandbox with an internal repository (holding the scripts under test), a bare public one and its clone. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "export-public-"));
  const gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = Someone Else\n\temail = someone@example.test\n[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  Object.assign(env, { HOME: dir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", CUELOR_FORBIDDEN_TERMS: TERM });
  const git = (cwd, ...args) => {
    const r = run(cwd, env, "git", ["-c", "commit.gpgsign=false", ...args]);
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const fx = { dir, env, git, internal: join(dir, "internal"), bare: join(dir, "public.git"), clone: join(dir, "public") };

  const files = {
    "README.md": "# Example\n",
    ".gitignore": "*.log\n",
    ".public-exclude": "# Paths that stay internal.\ninternal/\n",
    "spec/CHANGELOG.md": "# Changelog\n\n## [1.0.0] - 2026-10-27\n\nFirst version.\n\n- One endpoint.\n",
    "spec/v1.md": "# v1\n",
    "tools/run.sh": "#!/bin/sh\necho run\n",
    "samples/kept.log": "tracked although ignored\n",
    "internal/notes.md": "internal only\n",
  };
  for (const [path, text] of Object.entries(files)) write(fx, path, text);
  chmodSync(join(fx.internal, "tools/run.sh"), 0o755);
  mkdirSync(join(fx.internal, "scripts"), { recursive: true });
  for (const f of ["export-public.mjs", "scan-repo.mjs", "forbidden-terms.sha256"]) {
    copyFileSync(join(scripts, f), join(fx.internal, "scripts", f));
  }
  git(dir, "init", "-q", "-b", "main", fx.internal);
  git(fx.internal, "add", "-A");
  git(fx.internal, "add", "-f", "samples/kept.log");
  commitInternal(fx, "Merged from " + TERM);
  git(dir, "init", "-q", "--bare", "-b", "main", fx.bare);
  git(dir, "clone", "-q", fx.bare, fx.clone);
  return fx;
}

function write(fx, path, text) {
  mkdirSync(dirname(join(fx.internal, path)), { recursive: true });
  writeFileSync(join(fx.internal, path), text);
}

/** Commits in the internal repository with an internal-looking identity and message. */
function commitInternal(fx, message) {
  fx.git(fx.internal, "add", "-A");
  fx.git(fx.internal, "-c", "user.name=Internal Dev", "-c", "user.email=dev@example.test", "commit", "-q", "-m", message);
}

function exportPublic(fx, ...args) {
  const r = run(fx.internal, fx.env, process.execPath, [join(fx.internal, "scripts/export-public.mjs"), "--public", fx.clone, ...args]);
  return { status: r.status, out: r.stdout + r.stderr };
}

/** Every reference of the clone and the bare repository, HEAD and the clone's status. */
function snapshot(fx) {
  const refs = (cwd) => fx.git(cwd, "for-each-ref", "--format=%(refname) %(objectname)");
  return {
    clone: refs(fx.clone),
    bare: refs(fx.bare),
    head: run(fx.clone, fx.env, "git", ["symbolic-ref", "-q", "HEAD"]).stdout.trim(),
    status: fx.git(fx.clone, "status", "--porcelain", "--untracked-files=all"),
  };
}

/** The tree of the internal commit as `git ls-tree -r` lines, without the excluded paths. */
function expectedTree(fx, rev = "HEAD") {
  return fx.git(fx.internal, "ls-tree", "-r", rev).split("\n").filter((l) => !l.split("\t")[1].startsWith("internal/"));
}

function assertExportCommit(fx, rev) {
  const [author, committer] = fx.git(fx.clone, "log", "-1", "--format=%an <%ae>%n%cn <%ce>", rev).split("\n");
  assert.equal(author, IDENTITY);
  assert.equal(committer, IDENTITY);
  assert.ok(!fx.git(fx.clone, "cat-file", "commit", rev).includes("gpgsig"), "the commit is not signed");
  assert.deepEqual(fx.git(fx.clone, "ls-tree", "-r", rev).split("\n"), expectedTree(fx));
}

function assertTag(fx, tag, commit) {
  assert.equal(fx.git(fx.clone, "cat-file", "-t", tag), "tag", `${tag} is annotated`);
  assert.equal(fx.git(fx.clone, "for-each-ref", "--format=%(taggername) %(taggeremail)", `refs/tags/${tag}`), "Cuelor <oss@cuelor.com>");
  assert.equal(fx.git(fx.clone, "rev-parse", `${tag}^{commit}`), commit);
  assert.ok(!fx.git(fx.clone, "cat-file", "tag", tag).includes("BEGIN PGP"), "the tag is not signed");
}

/** Runs an export that must be refused, and checks that nothing changed. */
function assertRefused(fx, args, reason) {
  const before = snapshot(fx);
  const { status, out } = exportPublic(fx, ...args);
  assert.notEqual(status, 0, out);
  assert.match(out, reason);
  assert.match(out, /Nothing was committed or tagged/);
  assert.ok(!out.includes(TERM) && !out.includes(KEY), "findings are reported without the matched text");
  assert.deepEqual(snapshot(fx), before, "references, HEAD and the work tree are unchanged");
  return out;
}

test("the first export makes one root commit and an annotated tag; the second adds one commit", () => {
  const fx = fixture();
  const internalHead = fx.git(fx.internal, "rev-parse", "HEAD");
  const first = exportPublic(fx, "--tag", "spec-v1.0.0");
  assert.equal(first.status, 0, first.out);

  const c1 = fx.git(fx.clone, "rev-parse", "main");
  assert.equal(fx.git(fx.clone, "rev-list", "--count", "main"), "1");
  assert.equal(fx.git(fx.clone, "log", "-1", "--format=%P", "main"), "", "a root commit");
  assertExportCommit(fx, "main");
  assertTag(fx, "spec-v1.0.0", c1);
  const message = fx.git(fx.clone, "log", "-1", "--format=%B", "main");
  assert.match(message, /^Cuelor Provider API spec v1\.0\.0\n\nFirst version\.\n\n- One endpoint\.$/);
  assert.ok(!fx.git(fx.clone, "log", "--all", "--format=%B").includes(TERM), "no internal history");
  // The work tree is the exported tree, with the file mode kept, and nothing was pushed.
  assert.equal(snapshot(fx).status, "");
  assert.equal(fx.git(fx.clone, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.ok(!existsSync(join(fx.clone, "internal")));
  assert.ok(statSync(join(fx.clone, "tools/run.sh")).mode & 0o100);
  assert.equal(fx.git(fx.clone, "remote"), "origin");
  assert.equal(fx.git(fx.bare, "for-each-ref"), "", "nothing pushed");
  for (const want of [internalHead, c1, "git push origin main", "git push origin spec-v1.0.0"]) {
    assert.ok(first.out.includes(want), `the output names ${want}`);
  }

  // The maintainer pushes; the next release changes one file and deletes another.
  fx.git(fx.clone, "push", "-q", "origin", "main", "spec-v1.0.0");
  write(fx, "README.md", "# Example, updated\n");
  rmSync(join(fx.internal, "spec/v1.md"));
  write(fx, "spec/CHANGELOG.md", "# Changelog\n\n## [1.0.1] - 2026-11-02\n\nA fix.\n\n## [1.0.0] - 2026-10-27\n\nFirst version.\n");
  commitInternal(fx, "Second internal change");
  const second = exportPublic(fx, "--tag", "spec-v1.0.1");
  assert.equal(second.status, 0, second.out);

  const c2 = fx.git(fx.clone, "rev-parse", "main");
  assert.equal(fx.git(fx.clone, "rev-list", "--count", "main"), "2");
  assert.equal(fx.git(fx.clone, "log", "-1", "--format=%P", "main"), c1, "the parent is the previous export");
  assertExportCommit(fx, "main");
  assertTag(fx, "spec-v1.0.1", c2);
  assert.equal(fx.git(fx.clone, "log", "-1", "--format=%s", "main"), "Cuelor Provider API spec v1.0.1");
  assert.ok(!existsSync(join(fx.clone, "spec/v1.md")), "a file deleted internally is deleted publicly");
  assert.equal(readFileSync(join(fx.clone, "README.md"), "utf8"), "# Example, updated\n");
  assert.equal(snapshot(fx).status, "");
});

test("a message file sets the commit message and allows several tags", () => {
  const fx = fixture();
  const file = join(fx.dir, "message.txt");
  writeFileSync(file, "Spec v1.0.0 and SDK v1.0.0\n\nBoth parts.\n");
  const r = exportPublic(fx, "--tag", "spec-v1.0.0", "--tag", "sdk-v1.0.0", "--message-file", file);
  assert.equal(r.status, 0, r.out);
  assert.equal(fx.git(fx.clone, "log", "-1", "--format=%B", "main"), "Spec v1.0.0 and SDK v1.0.0\n\nBoth parts.");
  const c = fx.git(fx.clone, "rev-parse", "main");
  assertTag(fx, "spec-v1.0.0", c);
  assertTag(fx, "sdk-v1.0.0", c);
});

test("refuses a commit message with a forbidden term", () => {
  const fx = fixture();
  const file = join(fx.dir, "message.txt");
  writeFileSync(file, `Cuelor Provider API spec v1.0.0\n\nReviewed on ${TERM}\n`);
  assertRefused(fx, ["--tag", "spec-v1.0.0", "--message-file", file], /commit message:3: forbidden term/);
});

test("refuses a tree with a key-shaped string", () => {
  const fx = fixture();
  write(fx, "config/example.env", `API_KEY=${KEY}\n`);
  commitInternal(fx, "Add an example");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /config\/example\.env:1: Anthropic API key/);
});

test("refuses a tag name with a forbidden term", () => {
  const fx = fixture();
  const file = join(fx.dir, "message.txt");
  writeFileSync(file, "A plugin\n");
  assertRefused(fx, ["--tag", `${TERM}-v1.0.0`, "--message-file", file], /tags:1: forbidden term/);
});

test("refuses a public main with a commit of another identity", () => {
  const fx = fixture();
  writeFileSync(join(fx.clone, "README.md"), "by hand\n");
  fx.git(fx.clone, "add", "README.md");
  fx.git(fx.clone, "commit", "-q", "-m", "A commit by hand");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /not by Cuelor <oss@cuelor\.com>/);
});

test("refuses an internal work tree that is not clean", () => {
  const fx = fixture();
  writeFileSync(join(fx.internal, "README.md"), "changed\n");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /work tree of this repository is not clean/);
  fx.git(fx.internal, "checkout", "--", "README.md");
  writeFileSync(join(fx.internal, "untracked.md"), "new\n");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /work tree of this repository is not clean/);
});

test("refuses a public clone that is not clean", () => {
  const fx = fixture();
  writeFileSync(join(fx.clone, "stray.txt"), "stray\n");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /public clone is not clean/);
});

test("refuses a tag that exists", () => {
  const fx = fixture();
  assert.equal(exportPublic(fx, "--tag", "spec-v1.0.0").status, 0);
  write(fx, "README.md", "# Again\n");
  commitInternal(fx, "Again");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /tag spec-v1\.0\.0 exists/);
});

test("refuses a public main that differs from origin/main", () => {
  const fx = fixture();
  assert.equal(exportPublic(fx, "--tag", "spec-v1.0.0").status, 0);
  fx.git(fx.clone, "push", "-q", "origin", "main");
  // A second, unpushed export puts main ahead of origin/main.
  write(fx, "spec/CHANGELOG.md", "# Changelog\n\n## [1.0.1] - 2026-11-02\n\nA fix.\n");
  commitInternal(fx, "Fix");
  assert.equal(exportPublic(fx, "--tag", "spec-v1.0.1").status, 0);
  write(fx, "spec/CHANGELOG.md", "# Changelog\n\n## [1.0.2] - 2026-11-03\n\nAnother fix.\n");
  commitInternal(fx, "Another fix");
  assertRefused(fx, ["--tag", "spec-v1.0.2"], /differs from origin\/main/);
});

test("refuses an undated changelog section, an unknown version and a tag that is not a release tag", () => {
  const fx = fixture();
  write(fx, "spec/CHANGELOG.md", "# Changelog\n\n## [1.0.0] - unreleased\n\nFirst version.\n");
  commitInternal(fx, "Undated");
  assertRefused(fx, ["--tag", "spec-v1.0.0"], /has no release date/);
  assertRefused(fx, ["--tag", "spec-v2.0.0"], /no section for 2\.0\.0/);
  assertRefused(fx, ["--tag", "v1.0.0"], /not a release tag/);
});

test("needs a message file for several tags or a part without a changelog", () => {
  const fx = fixture();
  assertRefused(fx, ["--tag", "spec-v1.0.0", "--tag", "sdk-v1.0.0"], /--message-file/);
  assertRefused(fx, ["--tag", "sdk-v1.0.0"], /--message-file/);
});

test("refuses to export into this repository", () => {
  const fx = fixture();
  const r = run(fx.internal, fx.env, process.execPath, [join(fx.internal, "scripts/export-public.mjs"), "--public", fx.internal, "--tag", "spec-v1.0.0"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /this repository/);
  assert.equal(fx.git(fx.internal, "tag"), "");
});

test("release.yml runs only on the public repository", () => {
  const text = readFileSync(join(scripts, "..", ".github", "workflows", "release.yml"), "utf8");
  const jobs = text.slice(text.indexOf("\njobs:\n")).split(/\n {2}(?=[a-z][a-z0-9_-]*:\n)/).slice(1);
  assert.ok(jobs.length >= 6, `found ${jobs.length} jobs`);
  for (const job of jobs) {
    const name = job.slice(0, job.indexOf(":"));
    const cond = job.match(/^ {4}if: (.*)$/m)?.[1] ?? "";
    assert.ok(cond.startsWith("github.repository == 'cuelor/providers'"), `job ${name} has no repository guard`);
  }
});
