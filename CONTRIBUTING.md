# Contributing

Thank you for helping. The GitHub repository is exported from the maintainers' development repository:
each release adds one commit by `Cuelor <oss@cuelor.com>` and its release tags ("Publishing" below).
Pull requests cannot be merged there yet, so please open an issue that describes the change and a
maintainer will bring it in.

## Before you start

- **Everything here is public, under Apache-2.0.** By contributing you agree to license your contribution
  under the same terms.
- **Never commit secrets.** Not even revoked or fake ones in a real key format: scanners cannot tell
  them apart, and neither can people. Tests that need a key-shaped string build it at run time (see
  `scripts/scan-repo.test.mjs`).
- **No internal names or addresses.** Use `example.com`, `example.test` and invented names in examples
  and tests.
- **No generated or downloaded files.** No `node_modules`, build output or large media. Test media must be
  small, made by the contributor, and its licence stated next to it (see `conformance/samples/README.md`).
- **English** for the specification, code, comments and commit messages.

## Layout

| Path | Contents | Toolchain |
|---|---|---|
| `spec/` | Protocol text, `openapi.yaml`, JSON Schemas (the source of truth), examples | — |
| `conformance/` | Go module `github.com/cuelor/providers/conformance` and `cuelor-provider-test` | Go 1.23+ |
| `sdk/typescript/` | `@cuelor/provider-sdk` | Node 24 |
| `examples/fake-provider/` | An example plugin against a fake upstream | Node 24 |
| `providers/<name>/` | Reference plugins, released as `<name>-vX.Y.Z` | Node 24 |
| `skills/write-provider/` | An agent skill for writing a plugin | — |
| `registry/index.json` | The index of known plugins | — |
| `tools/` | Repository tooling (the spec checker) | Go 1.26 |
| `scripts/` | `ck-verify.sh`, the leak scanner, helpers | sh, Node |

## Checks

```sh
make ck-verify
```

runs everything CI runs: the leak scan, the spec check, the Go and TypeScript tests, the conformance
suite against the example plugin and its deliberately broken builds, and tier A against every plugin in
`providers/` (against the plugin's mock upstream when no test key is set, below). It needs Go 1.26, Node 24 with npm,
and perl; `ffprobe` is optional. With `CK_TEST_REPORT=path` it also writes a JSON report.

The leak scanner (`node scripts/scan-repo.mjs`) checks key formats, Tailscale addresses and a list of
forbidden terms that is committed only as SHA-256 hashes. To add a term without publishing it, add its
hash to `scripts/forbidden-terms.sha256`:

```sh
printf '%s' 'the-term' | shasum -a 256
```

or keep terms in plain text in an untracked `.forbidden-terms` file or the `CUELOR_FORBIDDEN_TERMS`
environment variable.

## Plugins and their test keys

A plugin lives in `providers/<name>/` (`<name>`: lowercase letters, digits and `-`). Start from
`examples/fake-provider` or [`skills/write-provider/SKILL.md`](skills/write-provider/SKILL.md):

- Give the copied `package.json` its own `name`, add the directory to the root `workspaces`, and run
  `npm install` so the lockfile includes it.
- The `version` of its `package.json`, of its manifest and of the provider description are the same,
  and its releases are tagged `<name>-v<version>`.

Tier A needs a ready account, so a plugin that needs an upstream key needs one in CI too. **The
convention:**

| Where | Name | Set by |
|---|---|---|
| The plugin reads its development and test key from | `CUELOR_PROVIDER_TEST_KEY` | the suite, with `--env CUELOR_PROVIDER_TEST_KEY` (copied by name, never on a command line) |
| `make ck-verify` (`scripts/check-plugins.sh`) and `release.yml` read the key of `providers/<name>` from | `CUELOR_TEST_KEY_<NAME>`, `<NAME>` = `<name>` in upper case with `-` as `_` | you, locally; in CI the repository secret of the same name |
| `live.yml` (tiers B and C, by hand) reads | an environment secret of the `live` environment named `LIVE_<…>` | a maintainer |

**Without a key**, `scripts/check-plugins.sh` runs tier A against the plugin's mock upstream when the
plugin builds one as `dist-test/mock-upstream.mjs`: it starts it with `--write-env FILE`, and the mock
writes the variables the plugin needs (a base URL, a key only the mock accepts) to `FILE` as
`NAME=VALUE` lines, which reach the plugin with `--env NAME`. `providers/openrouter` is the example.
With a key the real upstream is used.

When you add a plugin that needs a key, add `CUELOR_TEST_KEY_<NAME>: ${{ secrets.CUELOR_TEST_KEY_<NAME> }}`
to the `env` of the `make ck-verify` steps in `.github/workflows/ci.yml` and `release.yml`, and ask a
maintainer to create the secret. Key values are only ever set on GitHub by a maintainer: never commit,
invent, log or paste one, not in examples either. The app never sets `CUELOR_PROVIDER_TEST_KEY` (it
starts plugins with an empty environment); users' keys come from the keychain.

## Secrets in the workflows

- `CUELOR_FORBIDDEN_TERMS` (repository secret): extra forbidden terms for the leak scan.
- `CUELOR_TEST_KEY_<NAME>` (repository secrets): tier A keys, as above. `release.yml` reads only names
  with this prefix.
- `LIVE_*` (secrets of the `live` environment): keys for tiers B and C. `live.yml` refuses any other
  name.
- `NPM_TOKEN`: **only** as a secret of the `npm` environment, which only the `sdk` job of `release.yml`
  uses. Do not create it as a repository secret.

Third-party actions are pinned to a full commit SHA with the version in a comment
(`uses: actions/checkout@<sha> # v5.1.0`); update the SHA and the comment together.

## Changing the specification

- Within v1 **only additions** are allowed (`spec/v1.md` section 3.11): new optional fields, new
  endpoints behind a capability, new values of open sets. Never remove or rename, never make something
  required, never change a meaning.
- Change the schema in `spec/schemas/`, then run `go generate ./...` in `conformance/` to copy it into
  the suite. Add or update an example in `spec/examples/` (and a counter-example in
  `spec/examples/invalid/` when the change adds a rule).
- Add an entry to `spec/CHANGELOG.md`.
- Where the text is unclear, do not guess in code: raise it in an issue on the project's code host. The
  decision goes into `spec/v1.md`, the schemas and the changelog.

## Changing the conformance suite

Every check keeps the id and pass condition from the specification. A new rule needs a fault in
`conformance/internal/testprovider` that breaks it, and a case in `TestFaultsAreDetected` that proves
the check fails.

## Releases

Tags, each released by `.github/workflows/release.yml` after `make ck-verify`:

| Tag | Releases |
|---|---|
| `spec-vX.Y.Z` | A tarball of `spec/` with `SHA256SUMS` and an attestation |
| `sdk-vX.Y.Z` | `@cuelor/provider-sdk` on npm, with provenance |
| `conformance/vX.Y.Z` | The Go module and `cuelor-provider-test` binaries with `SHA256SUMS` and attestations |
| `<plugin>-vX.Y.Z` | `provider.mjs`, `cuelor-provider.json`, `SHA256SUMS` and attestations for `providers/<plugin>` |

The version in the files (`spec/CHANGELOG.md`, `package.json`, `conformance.Version`, the manifest) must
match the tag, and the `spec/CHANGELOG.md` section must have its release date (`## [1.0.0] - 2026-10-27`).
Tiers B and C against real upstreams cost money and run only by hand (`.github/workflows/live.yml`).

Tags are made only in the public repository, by the export below; the development repository does not
use these names. Every job of `release.yml` runs only when the repository is `cuelor/providers`, so a
tag of the same name anywhere else publishes nothing. `ci.yml` runs everywhere.

## Publishing (maintainers)

The public repository has no history in common with the development repository. Publishing a release
means exporting one commit: its files, minus the paths listed in `.public-exclude`, become one new commit
on the public `main`, with `Cuelor <oss@cuelor.com>` as author and committer, and an annotated tag by the
same identity. Merge commits, branch names, review trailers and personal identities stay in the
development history. Agents never run the export, never touch the public repository and never handle
GitHub credentials.

1. In the development repository, merge the release (for the specification, a dated section
   `## [X.Y.Z] - YYYY-MM-DD` in `spec/CHANGELOG.md`) and check out the commit with a clean work tree.
2. Keep a clone of the public repository beside it: clean, on `main`, up to date (`git pull`). For the
   first release it is a clone of the empty repository.
3. Export:

   ```sh
   node scripts/export-public.mjs --public ../providers-public --tag spec-v1.0.0
   ```

   `--commit REV` exports a commit other than `HEAD`. The commit message comes from the tag's changelog
   section: a title such as `Cuelor Provider API spec v1.0.0`, then the section's text. To export several
   tags at once, or a part without a changelog, give the message with `--message-file FILE`.
4. Check the result in the public clone (`git show --stat main`, `git log`). Then push it yourself with
   the commands the script prints: `git push origin main`, then `git push origin <tag>`. The script never
   pushes, adds no remote and reads no credentials. It prints the development and public commit ids, but
   does not record which is which.

When a check fails the script stops and leaves no commit or tag. It checks that:

- the development work tree is clean;
- the public clone is clean and on `main`, every commit of its `main` has `Cuelor <oss@cuelor.com>` as
  author and committer, its `main` equals `origin/main`, and the tags are new release tags;
- the tag's changelog section exists and has a release date (`spec/CHANGELOG.md` must exist; the other
  parts are checked when they have a changelog);
- the exported files equal the commit's tree minus the excluded paths, file modes included;
- the leak scan (`scripts/scan-repo.mjs`: key formats, Tailscale addresses and forbidden terms, including
  those of an untracked `.forbidden-terms` and of `CUELOR_FORBIDDEN_TERMS`) finds nothing in the exported
  files, the commit message, the tag names or the tag message. Like the repository scan, it skips binary
  files;
- the new commit and tags, read back, carry exactly that identity and no signature.

Only then do `main` and the tags move, in one step. Your own git configuration does not reach the export:
the script sets the identity, the dates (in UTC), signing (off), line endings and hooks itself.

**The first release.** Create the GitHub repository as private and empty (no README, licence or
`.gitignore`). Export, push `main` and check it on GitHub. Then make the repository public and push the
tag. The tag comes last because it starts `release.yml`, and build attestations and npm provenance
generally need a public repository; check GitHub's and npm's current requirements before relying on this.
