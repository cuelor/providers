#!/usr/bin/env node
// Exports one commit of this repository to a local clone of the public repository, as one new commit and
// its release tags (CONTRIBUTING.md, "Publishing"). The public repository shares no history with this one:
// an export is the commit's file tree minus the paths in .public-exclude, committed on top of the public
// main with the fixed identity below, with annotated tags by the same identity. A maintainer runs it and
// pushes the result. It never pushes, never adds a remote and never reads credentials.
//
// Usage: node scripts/export-public.mjs --public DIR --tag TAG [--tag TAG…] [--commit REV] [--message-file FILE]
//
// It stops, leaving no commit or tag, unless all of these hold:
//   - this work tree is clean;
//   - the public clone is clean and on main, every commit of its main has the fixed identity, its main
//     equals origin/main (when that exists), and the tags are new release tags;
//   - the tag's changelog section, when the part has a changelog, exists and has a release date;
//   - the exported files equal the commit's tree minus the excluded paths, file modes included;
//   - scan-repo.mjs finds nothing in the files, the commit message, the tag names or the tag message;
//   - the new commit and tags, read back, carry exactly the fixed identity.
// Only then do main and the tags move, in one atomic reference transaction.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = "Cuelor";
export const EMAIL = "oss@cuelor.com";
const IDENTITY = `${NAME} <${EMAIL}>`;
const EXCLUDE_FILE = ".public-exclude";
const scriptDir = dirname(fileURLToPath(import.meta.url));

// Settings of a maintainer's own git configuration that would change what an export writes: signing
// (with a personal key), line-ending conversion, file modes, the commit encoding, hooks.
const NEUTRAL = [
  "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
  "-c", "core.fileMode=true", "-c", "core.symlinks=true", "-c", "i18n.commitEncoding=UTF-8", "-c", "core.hooksPath=/dev/null",
];

// Variables of a surrounding git process that would point the commands below at another repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|AUTHOR_\w+|COMMITTER_\w+)$/.test(k)),
);

class Refusal extends Error {}
let moved = false; // main and the tags have moved
const refuse = (message) => {
  throw new Refusal(message);
};

function git(args, { cwd, extraEnv = {}, input, raw = false, allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, env: { ...env, ...extraEnv }, input, maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    if (allowFail) return null;
    const shown = args.filter((a, i) => a !== "-c" && args[i - 1] !== "-c").join(" ");
    throw new Error(`git ${shown} failed: ${r.stderr.toString().trim()}`);
  }
  return raw ? r.stdout : r.stdout.toString().trimEnd();
}

// Release tags, as in release.yml. Each part has its changelog and a commit title.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`;
const TAG_RE = new RegExp(String.raw`^(?:conformance/v(${VERSION})|([a-z0-9][a-z0-9-]*)-v(${VERSION}))$`);

export function parseTag(tag) {
  const m = TAG_RE.exec(tag);
  if (!m) return null;
  if (m[1]) return { tag, version: m[1], changelog: "conformance/CHANGELOG.md", title: `Cuelor provider conformance suite v${m[1]}` };
  const [, , part, version] = m;
  if (part === "spec") return { tag, version, changelog: "spec/CHANGELOG.md", title: `Cuelor Provider API spec v${version}`, required: true };
  if (part === "sdk") return { tag, version, changelog: "sdk/typescript/CHANGELOG.md", title: `@cuelor/provider-sdk v${version}` };
  return { tag, version, changelog: `providers/${part}/CHANGELOG.md`, title: `Cuelor provider plugin ${part} v${version}` };
}

/** The section `## [version] - label` of a changelog: its label and its text up to the next section. */
export function changelogSection(text, version) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const label = lines[start].slice(`## [${version}]`.length).replace(/^\s*-\s*/, "").trim();
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return { label, dated: /^\d{4}-\d{2}-\d{2}$/.test(label), body: lines.slice(start + 1, end).join("\n").trim() };
}

/** The excluded paths: one path per line, relative to the root, a directory with or without a final `/`. */
export function parseExcludes(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const p = t.replace(/\/+$/, "");
    if (p.startsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
      refuse(`${EXCLUDE_FILE}: "${t}" is not a path relative to the root`);
    }
    out.push(p);
  }
  return out;
}

/** A commit or tag object: its header lines and its message. */
function parseObject(text) {
  const cut = text.indexOf("\n\n");
  const headers = {};
  for (const line of text.slice(0, cut).split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of a multi-line header such as gpgsig
    const sp = line.indexOf(" ");
    (headers[line.slice(0, sp)] ??= []).push(line.slice(sp + 1));
  }
  return { headers, message: text.slice(cut + 2) };
}

function parseArgs(argv) {
  const opts = { tags: [], commit: "HEAD" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) refuse(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--public") opts.public = value();
    else if (a === "--tag") opts.tags.push(value());
    else if (a === "--commit") opts.commit = value();
    else if (a === "--message-file") opts.messageFile = value();
    else if (a === "--help" || a === "-h") opts.help = true;
    else refuse(`unknown argument ${a}`);
  }
  return opts;
}

const USAGE = `Usage: node scripts/export-public.mjs --public DIR --tag TAG [--tag TAG…] [--commit REV] [--message-file FILE]

  --public DIR         a clone of the public repository; it is not pushed
  --tag TAG            a release tag to create there: spec-vX.Y.Z, sdk-vX.Y.Z, conformance/vX.Y.Z, <plugin>-vX.Y.Z
  --commit REV         the commit of this repository to export (default HEAD)
  --message-file FILE  the commit message; needed for several tags or a part without a changelog
`;

/** Checks the public clone: (f) of the export rules. */
function inspectPublic(dir, internal, tags) {
  if (!existsSync(dir)) refuse(`${dir} does not exist`);
  const top = git(["rev-parse", "--show-toplevel"], { cwd: dir, allowFail: true });
  if (!top || realpathSync(top) !== realpathSync(dir)) refuse(`${dir} is not the top of a git clone with a work tree`);
  if (realpathSync(top) === realpathSync(internal)) refuse("--public names this repository; give a clone of the public repository");
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd: top });
  const head = git(["symbolic-ref", "-q", "HEAD"], { cwd: top, allowFail: true });
  const main = git(["rev-parse", "-q", "--verify", "refs/heads/main^{commit}"], { cwd: top, allowFail: true });
  const headCommit = git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: top, allowFail: true });
  // An empty clone may have an unborn HEAD of another name; the export points it at main.
  if (head !== "refs/heads/main" && (headCommit || main)) {
    refuse(`the public clone is not on main (HEAD is ${head ?? "detached"}); run git switch main there`);
  }
  if (git(["status", "--porcelain", "--untracked-files=normal"], { cwd: top })) refuse("the public clone is not clean");
  if (main) {
    const foreign = git(["log", "--format=%h%x09%an <%ae>%x09%cn <%ce>", "refs/heads/main"], { cwd: top })
      .split("\n")
      .filter((l) => {
        const [, author, committer] = l.split("\t");
        return author !== IDENTITY || committer !== IDENTITY;
      });
    if (foreign.length > 0) {
      refuse(`main of the public clone has ${foreign.length} commit(s) not by ${IDENTITY} (first: ${foreign[0].split("\t")[0]}); it may only contain exports`);
    }
  }
  const upstream = git(["rev-parse", "-q", "--verify", "refs/remotes/origin/main^{commit}"], { cwd: top, allowFail: true });
  if (upstream && upstream !== main) refuse("main of the public clone differs from origin/main; bring them together first (git pull, or push the last export)");
  for (const t of tags) {
    if (git(["rev-parse", "-q", "--verify", `refs/tags/${t}`], { cwd: top, allowFail: true })) refuse(`tag ${t} exists in the public clone`);
  }
  return { top, gitDir, head, main };
}

/** The commit message and the tag message: from --message-file, or from the one tag's changelog section. */
function messages(opts, releases, internal, commit) {
  let section = null;
  for (const r of releases) {
    const text = git(["show", `${commit}:${r.changelog}`], { cwd: internal, allowFail: true });
    if (text === null) {
      if (r.required) refuse(`${r.changelog} is missing in ${commit.slice(0, 12)}`);
      continue;
    }
    const s = changelogSection(text, r.version);
    if (!s) refuse(`${r.changelog} has no section for ${r.version}`);
    if (!s.dated) refuse(`${r.changelog}: the section for ${r.version} has no release date (it says "${s.label}"); date it and commit first`);
    section = { ...s, title: r.title };
  }
  let message;
  if (opts.messageFile) {
    message = readFileSync(opts.messageFile, "utf8").replaceAll("\r\n", "\n").replace(/\s+$/, "");
    if (!message.split("\n")[0].trim()) refuse(`${opts.messageFile} has no subject line`);
  } else if (releases.length === 1 && section) {
    message = section.body ? `${section.title}\n\n${section.body}` : section.title;
  } else {
    refuse("cannot derive a commit message for several tags or for a part without a changelog; pass --message-file");
  }
  message += "\n";
  return { message, tagMessage: message.split("\n")[0] + "\n" };
}

/** Plain-text forbidden terms for the scans: the environment's plus this repository's .forbidden-terms. */
function forbiddenTerms(internal) {
  const parts = [];
  if (process.env.CUELOR_FORBIDDEN_TERMS) parts.push(process.env.CUELOR_FORBIDDEN_TERMS);
  const local = join(internal, ".forbidden-terms");
  if (existsSync(local)) parts.push(readFileSync(local, "utf8").split("\n").filter((l) => !l.startsWith("#")).join("\n"));
  return parts.join("\n");
}

function exportCommit(opts) {
  const internal = git(["rev-parse", "--show-toplevel"], { cwd: join(scriptDir, "..") });
  if (git(["status", "--porcelain", "--untracked-files=normal"], { cwd: internal })) {
    refuse("the work tree of this repository is not clean; commit or remove the changes first");
  }
  const commit = git(["rev-parse", "-q", "--verify", "--end-of-options", `${opts.commit}^{commit}`], { cwd: internal, allowFail: true });
  if (!commit) refuse(`${opts.commit} is not a commit of this repository`);
  if (opts.tags.length === 0) refuse("give at least one --tag");
  if (new Set(opts.tags).size !== opts.tags.length) refuse("a tag is given twice");
  const releases = opts.tags.map((t) => parseTag(t) ?? refuse(`${t} is not a release tag (spec-vX.Y.Z, sdk-vX.Y.Z, conformance/vX.Y.Z, <plugin>-vX.Y.Z)`));
  const pub = inspectPublic(resolve(opts.public), internal, opts.tags);
  const { message, tagMessage } = messages(opts, releases, internal, commit);

  const tmp = mkdtempSync(join(tmpdir(), "export-public-"));
  try {
    // The files: git archive of the commit, minus the excluded paths.
    const tree = join(tmp, "tree");
    mkdirSync(tree);
    const tar = spawnSync("tar", ["-xf", "-", "-C", tree], { input: git(["archive", "--format=tar", commit], { cwd: internal, raw: true }) });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    const excludeText = git(["show", `${commit}:${EXCLUDE_FILE}`], { cwd: internal, allowFail: true }) ?? "";
    const excludes = parseExcludes(excludeText);
    for (const p of excludes) rmSync(join(tree, p), { recursive: true, force: true });

    // The tree they must give: the commit's tree minus the same paths, computed from git's own index.
    const expectedEnv = { GIT_INDEX_FILE: join(tmp, "expected.index") };
    git(["read-tree", commit], { cwd: internal, extraEnv: expectedEnv });
    if (excludes.length > 0) {
      git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...excludes.map((p) => `:(literal)${p}`)], { cwd: internal, extraEnv: expectedEnv });
    }
    const expected = git(["write-tree"], { cwd: internal, extraEnv: expectedEnv });

    // A scratch repository indexes the files, so that the scan and the check run before anything is
    // written to the public clone. -f: tracked files that a .gitignore matches are exported too.
    const stage = { GIT_DIR: join(tmp, "stage", ".git"), GIT_WORK_TREE: tree, GIT_INDEX_FILE: join(tmp, "stage.index") };
    git(["init", "-q", join(tmp, "stage")]);
    git([...NEUTRAL, "add", "-A", "-f"], { cwd: tree, extraEnv: stage });
    if (git(["write-tree"], { cwd: tree, extraEnv: stage }) !== expected) {
      refuse("the exported files differ from the commit's tree minus the excluded paths (check .gitattributes for export-ignore or export-subst)");
    }

    // The scan gate: files, commit message, tag names and tag message.
    const scanEnv = { ...env, ...stage, CUELOR_FORBIDDEN_TERMS: forbiddenTerms(internal) };
    const scan = (args, input) =>
      spawnSync(process.execPath, [join(scriptDir, "scan-repo.mjs"), "--root", tree, ...args], {
        cwd: tree, env: scanEnv, input, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"],
      }).status === 0;
    const clean = [
      scan([]),
      scan(["--stdin", "--label", "commit message"], message),
      scan(["--stdin", "--label", "tags"], `${opts.tags.join("\n")}\n\n${tagMessage}`),
    ];
    if (clean.includes(false)) refuse("the leak scan found something (listed above)");

    // The commit and the tags, as objects only. Dates are in UTC so that no local time zone is published.
    const pubEnv = { GIT_DIR: pub.gitDir };
    git([...NEUTRAL, "add", "-A", "-f"], { cwd: tree, extraEnv: { ...pubEnv, GIT_WORK_TREE: tree, GIT_INDEX_FILE: join(tmp, "public.index") } });
    const pubTree = git(["write-tree"], { cwd: tree, extraEnv: { ...pubEnv, GIT_INDEX_FILE: join(tmp, "public.index") } });
    if (pubTree !== expected) refuse("the tree written to the public clone differs from the expected tree");
    const when = `${Math.floor(Date.now() / 1000)} +0000`;
    const identityEnv = {
      GIT_AUTHOR_NAME: NAME, GIT_AUTHOR_EMAIL: EMAIL, GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: NAME, GIT_COMMITTER_EMAIL: EMAIL, GIT_COMMITTER_DATE: when,
    };
    const parents = pub.main ? ["-p", pub.main] : [];
    const publicCommit = git([...NEUTRAL, "commit-tree", "--no-gpg-sign", ...parents, "-F", "-", pubTree], {
      cwd: pub.top, extraEnv: { ...pubEnv, ...identityEnv }, input: message,
    });
    const c = parseObject(git(["cat-file", "commit", publicCommit], { cwd: pub.top }) + "\n");
    const ok = c.headers.tree?.[0] === pubTree && (c.headers.parent ?? []).join() === (pub.main ?? "") &&
      c.headers.author?.join() === `${IDENTITY} ${when}` && c.headers.committer?.join() === `${IDENTITY} ${when}` &&
      !c.headers.gpgsig && !c.headers.encoding && c.message === message;
    if (!ok) refuse("the new commit, read back, is not exactly the expected commit with the fixed identity");

    const tagObjects = opts.tags.map((t) => {
      const text = `object ${publicCommit}\ntype commit\ntag ${t}\ntagger ${IDENTITY} ${when}\n\n${tagMessage}`;
      const id = git(["mktag"], { cwd: pub.top, extraEnv: pubEnv, input: text });
      const o = parseObject(git(["cat-file", "tag", id], { cwd: pub.top }) + "\n");
      if (o.headers.object?.join() !== publicCommit || o.headers.tag?.join() !== t || o.headers.tagger?.join() !== `${IDENTITY} ${when}`) {
        refuse(`tag ${t}, read back, is not exactly the expected tag with the fixed identity`);
      }
      return id;
    });

    // All references at once: main (only from the value checked above) and the new tags.
    const zero = "0".repeat(publicCommit.length);
    const updates = [`update refs/heads/main ${publicCommit} ${pub.main ?? zero}`, ...opts.tags.map((t, i) => `create refs/tags/${t} ${tagObjects[i]}`)];
    git([...NEUTRAL, "update-ref", "-m", "export-public", "--stdin"], { cwd: pub.top, input: updates.join("\n") + "\n" });
    moved = true;

    // The work tree follows: files deleted internally disappear here too.
    if (pub.head !== "refs/heads/main") git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: pub.top });
    git([...NEUTRAL, "reset", "-q", "--hard"], { cwd: pub.top });

    console.log(`Exported ${commit} of this repository to ${pub.top}.`);
    console.log(`  internal commit  ${commit}`);
    console.log(`  public commit    ${publicCommit} (main; parent ${pub.main ?? "none, the first export"})`);
    console.log(`  tags             ${opts.tags.join(", ")} (annotated, by ${IDENTITY})`);
    console.log("Nothing was pushed. Check the export, then push it yourself:");
    console.log(`  cd ${pub.top}`);
    console.log("  git show --stat main");
    console.log("  git push origin main");
    for (const t of opts.tags) console.log(`  git push origin ${t}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(USAGE);
      return;
    }
    if (!opts.public) refuse("give the public clone with --public DIR");
    exportCommit(opts);
  } catch (err) {
    console.error(`export-public: ${err instanceof Error ? err.message : String(err)}`);
    console.error(moved ? "main and the tags were created; run git reset --hard in the public clone to update its files." : "Nothing was committed or tagged.");
    process.exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();
