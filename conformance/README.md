# Conformance suite

Tests a service against [Cuelor Provider API v1](../spec/v1.md). It is a Go module,
`github.com/cuelor/providers/conformance`, with a command, `cuelor-provider-test`, and a library API
that other programs (the Cuelor CLI among them) embed.

## Install and run

```sh
go install github.com/cuelor/providers/conformance/cmd/cuelor-provider-test@latest
# or, from a clone of this repository:
go run ./conformance/cmd/cuelor-provider-test --help        # from the repository root
cd conformance && go build -o cuelor-provider-test ./cmd/cuelor-provider-test
```

The module needs Go 1.23 or newer. The repository's `go.work` (which also covers `tools/`) needs Go 1.26;
with an older Go, build inside `conformance/` with `GOWORK=off`. The command form (A3, B6, B7) needs macOS or Linux. `ffprobe` on `PATH` is optional; with
it B5 also decodes video and audio outputs.

```sh
# A plugin, started by the suite the way the Cuelor app starts it.
cuelor-provider-test --command "node dist/provider.mjs"                        # tier A: free
cuelor-provider-test --manifest dist/cuelor-provider.json                      # the runtime from the manifest
cuelor-provider-test --command "node dist/provider.mjs" --live --max-cost 0.50 # tiers A, B and C
cuelor-provider-test --command "node dist/provider.mjs" --only A3,B2 --output json

# A running service: self-hosted, remote, or a plugin the app has already started.
cuelor-provider-test --url https://provider.example.com --token-file token.txt
CUELOR_PROVIDER_TEST_TOKEN=... cuelor-provider-test --url http://127.0.0.1:8787 --live --max-cost 0
# The same, choosing the model of each capability instead of the catalog's first one.
cuelor-provider-test --url http://127.0.0.1:8787 --token-file token.txt --live --max-cost 1 \
  --model image=vendor/image-small --model video=vendor/clip-lite:text2video
```

| Flag | Meaning |
|---|---|
| `--command "…"` | Start the plugin with this command line. Quotes and backslashes are honoured; there is no shell |
| `--manifest PATH` | `cuelor-provider.json`. Its `id` and `version` are compared with the description (A1), its `test` entries choose the models for tiers B and C (unless `--model` does), and without `--command` its `runtime` is started |
| `--dir PATH` | Working directory of the plugin (default: the manifest's directory, else the current one) |
| `--node PATH` | `node` for a manifest with `runtime.kind: node` (default: `node` on `PATH`) |
| `--data-dir PATH` | `CUELOR_PROVIDER_DATA_DIR` for the plugin (default: a new temporary directory, removed afterwards) |
| `--env KEY=VALUE`, `--env NAME` | Add to the plugin's environment, which otherwise is built from scratch. A bare `NAME` copies the variable from the suite's own environment, so a test key stays off the command line (`CUELOR_PROVIDER_TEST_KEY=… cuelor-provider-test --env CUELOR_PROVIDER_TEST_KEY …`) |
| `--url URL` | Test a running service instead of starting a command |
| `--token-file PATH` | Bearer token for `--url` (or `CUELOR_PROVIDER_TEST_TOKEN`) |
| `--live` | Also run tiers B and C. They create real jobs and may cost money |
| `--max-cost N` | Required with `--live`: the most the run may cost, in the service's `billing.unit` |
| `--model CAP=MODEL[:ROUTE]` | Test capability `CAP` (a declared generation capability such as `image`, or `transcription`) with this model, in tiers B and C and A6. Repeatable, once per capability. Comes before the manifest's `test` entry, whose `parameters` are then not sent; required parameters are filled in as for a catalog model. See [Choosing the models](#choosing-the-models) |
| `--only IDS` | Run only these checks, for example `A3,B2`. Results of the others are not reported |
| `--output text\|json` | Report format (default `text`) |
| `--timeout D`, `--job-timeout D` | One request (default 30s); one job until it ends (default 10m) |
| `--ffprobe PATH\|off` | ffprobe for decoding outputs (default: on `PATH`) |
| `--verbose` | Progress and the plugin's own output on stderr |
| `--list`, `--version` | List the checks; print the version |

**Exit status:** 0 when every check that ran passed (warnings and skips included), 1 when a check
failed, 2 for invalid usage (for example `--live` without `--max-cost`, or a `--model` without `=` or given twice
for one capability; nothing is sent to the service then).

**JSON report** (`--output json`, and `Report.JSON()`):

```json
{
  "status": "failed",
  "summary": "20 / 22 checks passed (1 failed, 1 skipped)",
  "checks": [
    {"id": "A1", "name": "Provider description", "status": "passed", "duration_ms": 3, "detail": ""},
    {"id": "A2", "name": "Authentication", "status": "failed", "duration_ms": 12,
     "detail": "GET /v1/models without Authorization: expected HTTP 401, got 200"}
  ]
}
```

Check statuses: `passed`, `failed`, `skipped` (the check does not apply: a capability not declared, the
URL form, no `--live`) and `warning` (passed, but a SHOULD was missed). The report status is `failed`
when any check failed, else `passed`.

A failed check that **did not run** has `"not_run": true` and a `detail` that starts with `not run: `:
the live run was over `--max-cost` or its cost could not be estimated (no job was submitted), the
capability the check tests has no test case (C1 and C2, below), or the run was cancelled first. It still counts as failed. The field is absent on every other result, so the
shape is otherwise unchanged; in Go it is `Result.NotRun`.

```json
{"id": "B1", "name": "Submit", "status": "failed", "duration_ms": 0, "not_run": true,
 "detail": "not run: estimated cost of the live run: 1.2 USD (from the estimate endpoint) exceeds --max-cost 0.5 USD; no job was submitted"}
```

## What runs when

- **Tier A** never calls a paid upstream; it always runs. One exception: A6's last step submits a valid
  job, so it runs only with `--live` and within the budget; over the budget A6 leaves it out with a
  warning ([`v1.md` section 5](../spec/v1.md#5-conformance)).
- **Tiers B and C** need `--live`. Before submitting anything the suite adds up the cost of every job it
  may create (from `POST /v1/estimates` when the service has it, else from the catalog's prices; B7's
  retries count in full). When that total is more than `--max-cost`, or cannot be worked out, **nothing
  is submitted and the run fails**: every B and C check is failed and `not_run`, with the estimate, the
  limit and the unit, or the reason there is no estimate ([`v1.md` section 5](../spec/v1.md#5-conformance)). The estimate counts
  only the capabilities that have a test case. Which model each capability uses: [Choosing the
  models](#choosing-the-models).
- **Capabilities decide what is required.** A declared capability must pass its checks; checks for
  capabilities not declared are skipped: B9 needs `capabilities.cancel`, B11 `capabilities.estimate`,
  C1 and C2 `capabilities.transcription`.
- **A declared capability without a test case fails only its own checks.** The others still run, but the
  run fails: a capability the service declares and the suite could not test never passes.
- **A3, B6 and B7** need the command form: they close stdin or kill the process group.
- Moderation is not tested: sending content that breaks an upstream's terms on purpose would break those
  terms.

## Choosing the models

Tiers B and C test every declared capability with one model and route, its **test case**. For each
capability, in this order:

1. `--model <capability>=<model>[:<route>]` (`Options.Models`). The whole value after `=` is first
   looked up as a model id, since ids may contain `:`; only when no model has that id is it split at the
   last `:` into model and route. `vendor/image:free` is the model `vendor/image:free` when the catalog
   has it, else the route `free` of `vendor/image`; `vendor/image:free:text2image` is the route
   `text2image` of `vendor/image:free`. Without a route the model's first route for the capability whose
   required inputs the suite can provide is used. The request carries only required parameters.
2. The manifest's `test.<capability>` entry, with its parameters.
3. The first available model in the catalog with a route for the capability (`audio2text` for
   transcription, any other route of a model with that output modality for generation) whose required
   inputs the suite can provide.

The **primary** case, which B1–B11 use, is that of the first capability that has one: the generation
capabilities in the order the description lists them, then transcription. Each other generation
capability runs one job, checked by B4, B5 and B10; transcription runs C1 and C2. B1's notes, and C1's
and C2's, say which case each capability got and where it came from (`--model`, the manifest or the
catalog).

When a capability has **no test case** (its `--model` or manifest entry names a model that is not in the
catalog, is not available, or lacks the route, the route is not for that capability, or no catalog model
fits), no job is submitted for it and only its checks fail, saying why:

- a generation capability other than the primary one: one failure each in B4, B5 and B10;
- transcription: C1 and C2 fail as not run;
- the primary capability: the next capability with a case becomes primary, and the missing one fails
  B4, B5 and B10.

When no declared capability has a test case, every B and C check fails as not run, with the reason for
each capability. A `--model` for a capability the service does not declare, most likely misspelt, fails
A1.

## Checks

The ids and pass conditions are those of the specification; every check names the file and function
that implements it. `go doc` on the function gives the same condition.

### Tier A: protocol (free)

| Id | Check | Passes when | Implemented in |
|---|---|---|---|
| A1 | Provider description | `GET /v1/provider` matches the schema; major version 1; `provider.id` and `version` match the manifest; `binding` is 64 hexadecimal digits; every `--model` capability is declared | `checks_a.go` `checkA1` |
| A2 | Authentication | Without a Bearer token, or with a wrong one (same length, one character longer, another scheme): 401 with a standard error body, on every endpoint | `checkA2` |
| A3 | Local security (command form) | Listens on 127.0.0.1 only; rejects a `Host` other than `127.0.0.1:<port>`; rejects requests to `/v1/` with an `Origin` header (the setup page under `/setup/` may accept its own origin, plugins.md section 2); exits within 5 s of stdin closing and leaves no process in its group | `checkA3` |
| A4 | Catalog format | `GET /v1/models` matches the schema | `checkA4` |
| A5 | Catalog semantics | Every `parameter_names` entry is defined; defaults inside enums and ranges; `min <= max`; `step` aligned with `min` (with a tolerance, so a fractional `step` works); `enum_values`, when present, is not empty (any kind), and that of a `number` or `integer` parameter holds numbers of its kind; slot `min_artifacts <= max_artifacts`; `max_total_artifacts` at least the sum of the slots' minimums; `media_types` are valid MIME types; route outputs match the model's modality; `widget` is a string, `visible_when` is `{name, equals}` and each `parameter_rules` item has its five fields (shapes only) | `checkA5`, `catalogProblems` |
| A6 | Error format | Invalid submissions (unknown model, unknown route, a parameter out of range, too many inputs, a prompt reference past the inputs, no `Idempotency-Key`): each 400 with a standard error body whose `message` contains no part of the token; a valid request with a new key then works (`--live`) | `checkA6` |
| A7 | Artifact upload | The same bytes uploaded twice get the same `id`; `sha256` and `bytes` are right; metadata and download match the upload, after following the download's redirects (below); above the declared `max_bytes`: 413 | `checkA7` |
| A8 | Unknown resources | Unknown job, artifact, artifact content and cancel: 404 with a standard error body | `checkA8` |
| A9 | Response time | Describe, catalog and job queries answer within 30 s (more than 10 s is a warning) | `checkA9` |

### Tier B: jobs (`--live`)

| Id | Check | Passes when | Implemented in |
|---|---|---|---|
| B1 | Submit | Returns a job object within 30 s, in a valid initial state | `checks_b.go` `runPrimary` |
| B2 | Same key, same body | Replays immediately, while polling and after the end all return the same `id` | `runPrimary` |
| B3 | Same key, different body | 409 `idempotency_conflict`; the original job is unaffected | `runPrimary`, `conflictingRequest` |
| B4 | State machine | Every polled state is in the set and every transition in the diagram of section 3.5.3; the ended job is the same on 3 more queries; `updated_at` never decreases | `runPrimary`, `runExtra`, `stateIssues` |
| B5 | Outputs | A `succeeded` job has exactly one output (`output` for generation, `transcript` for transcription); the download's length and SHA-256 match the job; the file header matches `media_type`; with ffprobe, video and audio decode and their duration is within 5 % of `metadata` | `jobs.go` `verifyOutputs` |
| B6 | Interrupted submission (command form) | `kill -9` right after sending a submission, restart, replay the same key: one job, the same `id` on 2 more replays; or `failed` with `submission_unknown` | `checkB6` |
| B7 | Restart while running (command form) | `kill -9` while a job runs, restart, query the same `id`: it reaches a terminal state. A job that ends before it is seen `running` is replaced, up to 3 jobs; when none is seen running the check is a warning, never a pass | `checkB7` |
| B8 | Lost response | The client sends the whole body and disconnects; a replay with the same key returns the same job | `checkB8` |
| B9 | Cancel (`capabilities.cancel`) | Cancelling a running job ends it `cancelled` or leaves the state unchanged; cancelling again is not an error | `checkB9` |
| B10 | Usage | An ended job has `usage` with a valid `unit` and `basis`; an estimate more than 50 % away from the usage is a warning | `jobs.go` `usageIssues` |
| B11 | Estimate (`capabilities.estimate`) | Creates no job (the same body with a new key afterwards creates a new job); the format is valid | `checkB11` |

**Redirects.** Only downloads (`GET /v1/artifacts/{id}/content`, in A7 and B5) follow redirects, as
v1.md section 3.4 allows: at most 5, never from `https` to `http`, and without `Authorization` when the
scheme, host or port differs from the service's. Redirects to loopback addresses are followed, since the
services under test often run on `127.0.0.1`. `Content-Type`, `Content-Length`, length and SHA-256 are
checked on the final response. A redirect from any other endpoint is not followed, so the check that
made the request fails.

B1–B5 and B10 look at one job, observed through its whole life, plus one job for each other generation
capability. B6 can only show that a plugin gives the same answer for the same key. Whether it submitted
twice upstream is not visible to a test; the SDK's idempotency store and code review cover that.

### Tier C: transcription (`--live`, `capabilities.transcription`)

| Id | Check | Passes when | Implemented in |
|---|---|---|---|
| C1 | Transcription | With the suite's Chinese and English samples: `schema_version` 1; `language` matches the sample; `unit` set; units ordered, not overlapping, ending no more than 60 ms after the audio; character error rate against the known text below 30 % (this only catches gross mismatches; it does not rate quality) | `checks_c.go` `checkC1`, `transcriptIssues`, `unitIssues` |
| C2 | Language detection | `language=auto` on the English sample reports `en` | `checkC2` |

The samples are in [`samples/`](samples/) with their texts, durations and licence.

## Library API

```go
import "github.com/cuelor/providers/conformance"

max := 0.50
report, err := conformance.Run(ctx, conformance.Options{
	Command: []string{"node", "dist/provider.mjs"}, // or URL + Token
	Dir:     pluginDir,
	Live:    true,
	MaxCost: &max,
	Only:    []string{"A1", "B2"},
})
if err != nil {
	// errors.Is(err, conformance.ErrInvalidOptions): bad options; nothing was tested
}
os.Stdout.Write(report.JSON())
if !report.OK() { /* a check failed */ }
```

| Name | |
|---|---|
| `Run(ctx, Options) (*Report, error)` | Runs the selected checks. An error means the options were invalid or the run could not be set up; a plugin that does not start is a failed report, not an error. Cancelling `ctx` stops the run and the plugin |
| `Options` | `Command`, `Dir`, `Manifest`, `NodePath`, `Env`, `DataDir` (command form); `URL`, `Token` (URL form); `Live`, `MaxCost`, `Only`, `Models` (`--model`: capability to `"<model>[:<route>]"`); `RequestTimeout`, `JobTimeout`, `StartTimeout`; `FFprobe`; `Log` (progress) and `PluginOutput` (the plugin's stdout and stderr) |
| `Report`, `Result` | `{Status, Summary, Checks}`, `{ID, Name, Status, DurationMS, Detail}`; `Report.OK()`, `Report.JSON()` |
| `Checks() []CheckInfo` | Every check: `ID`, `Name`, `Tier`, `Condition` (when it applies) |
| `Status`, `Tier` | `StatusPassed`, `StatusFailed`, `StatusSkipped`, `StatusWarning`; `TierA`, `TierB`, `TierC` |
| `SplitCommand(string)` | Splits a command line the way `--command` does |
| `Version`, `ProtocolVersion` | The suite's version and the protocol version it tests |

`Run` is safe to call from several goroutines with different options. Its only dependencies are
`github.com/santhosh-tekuri/jsonschema/v6` and `golang.org/x/text`.

## Development

```sh
go generate ./...        # copy ../spec/schemas into schemas/ (make ck-verify checks they match)
go test ./...
```

The tests run every check against `internal/testprovider`, a small provider written against the
specification, in both forms, and switch on one fault at a time to prove that the check meant to catch it
fails. `make ck-verify` at the repository root also runs the suite against
[`examples/fake-provider`](../examples/fake-provider/) and its deliberately broken builds.

## Versions

Tags `conformance/vX.Y.Z` (the Go sub-module convention). A new minor version of the protocol adds
checks; it does not make existing checks stricter for v1.0 services.
