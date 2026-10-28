# @cuelor/provider-sdk

Build plugins and services that speak the Cuelor Provider API v1 ([`spec/v1.md`](../../spec/v1.md),
[`spec/plugins.md`](../../spec/plugins.md)) in TypeScript or JavaScript.

You describe the provider (catalog, account) and write a small adapter to one upstream service
(`submit`, `poll`, and optionally `lookup`, `cancel` and `estimate`). The SDK does the rest:

- the stdin handshake, the port line, and exiting when stdin closes (command mode), or a token file
  and a listen address (standalone mode);
- bearer authentication with constant-time comparison, `Host` checks, and rejection of any `Origin`;
- every v1 endpoint, standard error bodies with sanitized messages, 404 and 405 answers;
- request validation against the catalog, including prompt references (`@image1`);
- idempotency: one job per (account binding, key) on disk, kept at least 30 days and as long as the job
  exists, 409 on a different body, and recovery after a crash between "recorded" and "the upstream
  answered", which never submits twice;
- content-addressed artifacts with streaming multipart uploads, 413 above the limit, Range
  downloads, retention, and 410 after expiry;
- the job state machine: terminal states never change and `updated_at` never decreases; an upstream
  that jumps to a terminal state the job cannot reach ends it `failed` with `upstream_failed`;
- output checks: the media type is sniffed, and transcripts are normalized and validated against the
  input audio's duration.

Node.js 20 or later. No runtime dependencies.

```sh
npm install @cuelor/provider-sdk
```

## A minimal provider

```ts
import { computeBinding, ProviderError, runProvider } from "@cuelor/provider-sdk";

await runProvider({
  id: "example.images",
  name: "Example Images",
  version: "0.1.0",
  capabilities: { generation: ["image"] },
  billingUnit: "USD",
  async account(ctx) {
    const key = await loadKey(); // for example with keychainGet
    // Without a key there is no account to fingerprint: report the binding of the empty secret.
    if (!key) return { status: "needs_setup", binding: await computeBinding("", ctx) };
    return { status: "ready", label: "Example key", binding: await computeBinding(key, ctx) };
  },
  catalog: () => CATALOG,
  upstream: {
    async submit(ctx) {
      const res = await fetch("https://api.example.com/v1/images", {
        method: "POST",
        body: JSON.stringify({ prompt: ctx.request.parameters.prompt, client_reference: ctx.clientReference }),
        signal: ctx.signal,
      });
      if (res.status === 400) throw new ProviderError(400, "invalid_request", await res.text());
      if (!res.ok) throw new Error(`upstream answered ${res.status}`); // the submission is now "unknown"
      return { upstreamId: (await res.json()).id };
    },
    async poll(upstreamId) {
      const job = await (await fetch(`https://api.example.com/v1/images/${upstreamId}`)).json();
      if (job.state === "done") {
        return { status: "succeeded", outputs: [{ mediaType: "image/png", data: () => download(job.url) }] };
      }
      return { status: job.state === "queued" ? "queued" : "running" };
    },
    // Lets the SDK find the job again after a crash during submit.
    async lookup(clientReference) {
      return findUpstreamJob(clientReference);
    },
  },
});
```

Bundle it into one file (for example with esbuild) next to a `cuelor-provider.json` manifest. See
[`examples/fake-provider`](../../examples/fake-provider) for a complete plugin.

### Rules for adapters

- `submit` returns as soon as the upstream has accepted the job. Long work belongs in `poll`.
- Throw `ProviderError` with a 4xx status only when nothing was created upstream. The client gets the
  error and may use the key again.
- Throw `NotSubmittedError` when the upstream certainly did not accept the job but a retry may work,
  for example a refused connection. The client gets 503 and its replay submits again.
- Any other error leaves the submission **unknown**. The client gets 502. Its replay calls
  `lookup(clientReference)`. Without a match the job ends `failed` with `submission_unknown`, and it is
  never submitted again.
- A `submit` slower than `submitTimeoutMs` (default 20 s) is **not** aborted: the client gets 502 and the
  call goes on in the background. When it returns an upstream id, a replay gets that job. Only after
  `submitHardTimeoutMs` (default 10 minutes) is `ctx.signal` aborted and the submission treated as
  unknown. Pass `ctx.signal` to `fetch` so that the hard limit really stops the call.
- When such a slow `submit` throws `NotSubmittedError` or a 4xx `ProviderError` after the 502, a replay
  may already have the job's id, so the job and its key are kept and the job ends (v1.md section 3.5.2):
  `NotSubmittedError` and 429 give `failed` with `upstream_failed` and reason `not_submitted`; 422
  `content_moderated` gives `rejected` (`params.stage = input`, `params.source = upstream` unless you set
  them); 402 gives `insufficient_credits`; 403 keeps its code and reason; any other 4xx gives
  `invalid_input`. The original status, code and reason are in `params`.
- Attach `ctx.clientReference` to the upstream job when the upstream supports it. It is derived from
  the key and the binding, and it is not the key itself.
- Return outputs only with `succeeded`. The SDK stores the first output. It fails the job with
  `upstream_failed` when the output does not match the route's media types or is not a valid transcript
  (also when it is not a transcript object at all).
- `rejected` without an `error` becomes `content_moderated` with `params.inferred = true`
  (v1.md section 3.10). Give the upstream's reason in `error` when it has one.
- Job errors and warnings are sanitized like every other message: credential-shaped strings and the
  strings returned by `secrets()` are replaced by `[redacted]`. Return the upstream key from `secrets()`.

### Account, pages and setup

- `account()` is cached for `accountCacheMs` (default 5 s), so polling does not read the keychain on
  every request. A new submission always calls it again: the binding scopes the key. The cache is
  dropped after `POST /v1/setup`, after every request that `extraRoutes` handled, and when you call
  `ctx.invalidateAccount()` (for example at the end of a login).
- `extraRoutes` serves paths outside `/v1/`, such as the setup page. There is no bearer token there
  (the browser cannot send one); the SDK checks `Host` and accepts no `Origin` but the plugin's own
  (plugins.md section 2). Put the page under `/setup/<random>`, make the random part long, and accept it
  once and for 10 minutes.

### When the account is not ready

`GET /v1/models`, `POST /v1/estimates` and new submissions answer 403 `provider_not_ready`. Jobs the
service already knows are still answered from storage, without calling the upstream: a replay of a known
`Idempotency-Key` (under the current binding) returns its job, and `GET /v1/jobs/{id}` returns the stored
state. Cancelling a job that has not ended answers 403. When `account()` throws or gives no valid binding,
`POST /v1/jobs` answers 503 `upstream_unavailable` (reason `binding_unavailable`): without the binding it
is unknown whether the key is a replay, so the answer must be temporary.

## Public API

Everything is exported from the package root.

### Running a provider

| Export | |
|---|---|
| `runProvider(definition, options?)` | Starts the provider in command or standalone mode (from the environment) and returns `{server, port, runtime}`. |
| `createProviderHandler(definition, options)` | An `http` request handler with authentication, for your own server. Returns `{handler, runtime}`. |
| `ProviderRuntime` | The protocol logic behind the handler: jobs, idempotency, artifacts, recovery. |
| `ProviderDefinition` (type) | What you provide: identity, capabilities, `account`, `catalog`, `upstream`, optional `setup`, `extraRoutes`, `secrets`, limits and timeouts. |
| `UpstreamAdapter` (type) | `submit`, `poll`, and optional `lookup`, `cancel` and `estimate`. |
| `UpstreamState`, `UpstreamOutput` (types) | What `poll` returns. |
| `ProviderContext`, `SubmitContext`, `PollContext`, `EstimateContext`, `ResolvedInput` (types) | Arguments given to the definition and the adapter. |
| `HandlerOptions`, `RunOptions`, `RunningProvider`, `ProviderRuntimeOptions` (types) | Options and results of the functions above. |

### Errors

| Export | |
|---|---|
| `ProviderError(status, code, message, {reason, params, headers})` | An error with an HTTP status. `.toBody(secrets)` gives the wire body. |
| `NotSubmittedError(message, {status, code})` | "Certainly not accepted, retry is safe" from `submit`. |
| `sanitizeMessage(message, secrets?)` | Removes secrets, key-like strings, URL query strings and control characters, and truncates to 300 characters. |
| `errorBody(code, message, options?)` | `{error: {code, message, reason?, params?}}` with a sanitized message. |
| `jobError(code, message, options?)` | A job's `error` object with a sanitized message. |
| `invalidRequest(reason, message, params?)` | A 400 `invalid_request` error. |
| `MAX_MESSAGE_LENGTH` | 300. |

### Handshake and security

| Export | |
|---|---|
| `readHandshakeToken(stdin, {timeoutMs})` | Reads and checks the token line (at least 32 letters and digits). |
| `isValidHandshakeToken(token)` | The token rule. |
| `listeningLine(port)` / `announcePort(port)` | `cuelor-provider-listening port=N`, written to stdout. |
| `onStdinClosed(callback, stdin?)` | Calls back when stdin ends. |
| `listenModeFromEnv(env)` | `{kind: "command"}` or `{kind: "standalone", host, port, tokenFile, allowedHosts}`. |
| `readTokenFile(path)` | Reads a standalone token (16 characters at least). |
| `createRequestGuard({token, allowedHosts, pageOrigins})` | For `/v1/`: rejects `Origin` (403), a wrong `Host` (403), and a bad bearer token (401). `.page(headers)` for pages outside `/v1/`: a wrong `Host`, and any `Origin` but `pageOrigins` (default `http://<host>`). |
| `constantTimeEqual(a, b)` | Constant-time string comparison. |
| `computeBinding(secret, {dataDir})` | `account.binding`: HMAC-SHA256 of the secret with a salt kept in the data directory. Pass the key, or the upstream's account id when a new key of that account can still reach the upstream jobs: the SDK's jobs and idempotency records belong to the binding, not to the key, so they are still found under a new key (v1.md section 3.2). |
| `keychainService(id)`, `keychainSet`, `keychainGet`, `keychainDelete` | macOS Keychain through `/usr/bin/security -i`. The secret goes on stdin, never in argv. |
| `quoteSecurityArg(value)` | Quoting for `security -i` commands. |

### Validation

| Export | |
|---|---|
| `validateCatalog(catalog)` | Catalog problems of check A5 (defaults, ranges, steps, slots, routes, output modality) and the shapes of `widget`, `visible_when` and `parameter_rules`. |
| `validateJobRequest(catalog, request, lookupArtifact)` | Throws the 400 error the protocol requires, or returns `{model, route, inputs}`. |
| `parameterValueProblem(parameter, value)` | Why a value does not fit a parameter, or `undefined`. |
| `largestMaxBytes(catalog)` | The upload limit implied by the catalog. |
| `parsePromptReferences(prompt)` | `@image1`, `@video2`, `@audio3`. Any other `@` is plain text. |
| `numberInputs(inputs, mediaTypeOf)` / `countInputsByKind(inputs, mediaTypeOf)` | Per-media-type numbering in position order. |
| `checkPromptReferences(prompt, counts)` | Throws 400 `prompt_reference_out_of_range`. |
| `replacePromptReferences(prompt, replace)` | Rewrites references for an upstream with its own syntax. |
| `validateTranscript(value, {durationMs})` | Transcript problems: schema (`unit` required), units, order, overlaps, the 60 ms end tolerance. |
| `normalizeTimedUnits(units, {durationMs})` / `normalizeTranscript(transcript, options)` | Sorts units, removes overlaps and punctuation-only units, rounds, and clamps. |
| `TRANSCRIPT_END_TOLERANCE_MS`, `TRANSCRIPT_MEDIA_TYPE` | 60, `application/vnd.cuelor.transcript+json`. |

### Storage

| Export | |
|---|---|
| `ArtifactStore({dir, outputRetentionMs, inputRetentionMs})` | Content-addressed artifacts: `put`, `putFile`, `find`, `require` (404, 410), `open` (ranges), `readBytes`, `purgeExpired`. |
| `MIN_OUTPUT_RETENTION_MS`, `hashFile(path)` | 7 days; the SHA-256 of a file. |
| `IdempotencyStore({dir, retentionMs, jobExists})` | Keys on disk: `begin` (new, existing or conflict), `settle`, `remove`, `withKey`, `withKeyHash`, `removeHash`, `purge`. With `jobExists`, a key whose job exists never expires. |
| `MIN_JOB_RETENTION_MS` | 30 days: the runtime deletes a job (and its key) only this long after it ended (`retention.jobMs`). |
| `acquireInstanceLock(dataDir, options?)`, `InstanceLockedError`, `INSTANCE_LOCK_FILE` | The data directory's `instance.lock`; `runProvider` takes it. |
| `MIN_KEY_RETENTION_MS`, `isValidIdempotencyKey`, `requireIdempotencyKey` | 30 days; key syntax; the header check (400). |
| `parseUpload(stream, options)` | Streaming `multipart/form-data` parser that writes the `file` part to disk and hashes it (413 above `maxBytes`). |
| `writeFileAtomic`, `writeJsonAtomic`, `readJsonFile` | Crash-safe files: temporary file, fsync, rename. |
| `canonicalJson`, `sameJson`, `jsonHash`, `sha256Hex` | Canonical JSON, used for idempotency bodies. |

### Media

| Export | |
|---|---|
| `normalizeMediaType(type)`, `MIME_ALIASES` | `audio/x-wav` becomes `audio/wav`, `image/jpg` becomes `image/jpeg`, and so on. |
| `isValidMediaType`, `topLevelType` | Syntax check; `image` of `image/png`. |
| `sniffMediaType(bytes)` | PNG, JPEG, WebP, GIF, WAV, MP4, WebM, MP3, Ogg, FLAC. |
| `pngMetadata`, `parseWav`, `probeMetadata`, `probeFileMetadata` | Width and height; WAV format, duration and `LIST/INFO` entries. |

### Protocol types

`Job`, `JobStatus`, `JOB_STATUSES`, `TERMINAL_STATUSES`, `isTerminal`, `JobRequest`, `InputRef`,
`JobOutput`, `Artifact`, `ArtifactMetadata`, `Approval`, `Usage`, `Warning`, `Estimate`,
`ErrorObject`, `Capabilities`, `Account`, `AccountStatus`, `ProviderDescription`, `Catalog`,
`Model`, `Route`, `Slot`, `Parameter`, `Pricing`, `Transcript`, `TranscriptSegment`, `TimedTextUnit`,
and the option and result types of the functions above.

## Data directory

The SDK keeps its state under `CUELOR_PROVIDER_DATA_DIR`, or under the `dataDir` option:

```
artifacts/blobs/<sha256>        artifact bytes
artifacts/meta/<id>.json        artifact metadata and expiry
artifacts/tmp/                  uploads in progress
idempotency/<sha256>.json       one record per key (the key itself is only stored hashed)
jobs/<job id>.json              job, request and submission state
binding-salt                    the salt of computeBinding
```

Every write is atomic. A plugin can be killed at any point and restarted with the same directory.

```
instance.lock                   the running instance: pid, host name, start time
```

**One data directory serves one instance.** The stores are files guarded by locks inside one process, so
two processes on the same directory could hand out two jobs for one key. `runProvider` takes
`instance.lock` before it listens and fails to start while another running instance holds it; the error
names the directory and the holder. Mind this when you run the plugin as a self-hosted service
(`CUELOR_PROVIDER_LISTEN=0.0.0.0:…`): give every container or process its own data directory, and do not
share one volume between replicas. A lock left by a process that no longer runs on this host (for
example after `kill -9`) is taken over at once. A lock written on another host that shares the
directory is taken over only when its holder has not refreshed it for 60 seconds.

Jobs that ended more than 30 days ago (`retention.jobMs`, never less) are deleted together with their
keys; a replay of such a key is a new submission. Jobs that have not ended are kept.

## Development

From the repository root:

```sh
npm install
npm run build      # tsc into sdk/typescript/dist
npm test           # node --test, TypeScript run directly by Node
npm run typecheck
```

Licensed under Apache-2.0.
