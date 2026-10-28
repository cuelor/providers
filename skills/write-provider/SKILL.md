---
name: write-provider
description: Write a Cuelor provider plugin (Cuelor Provider API v1) that connects an image, video or speech-recognition service to the Cuelor app, using @cuelor/provider-sdk, and make it pass the conformance suite (tier A without cost, then tiers B and C within a budget). Use when asked to add, port or fix a Cuelor provider, plugin or `cuelor-provider.json`.
---

# Write a Cuelor provider plugin

A plugin is one JavaScript file that the Cuelor app starts on the user's machine. It speaks the HTTP
protocol in `spec/v1.md` on `127.0.0.1` and translates it to one upstream service (an image, video or
speech-recognition API) using the user's own upstream key. `@cuelor/provider-sdk` implements the whole
protocol: handshake, auth, uploads, request validation, idempotency, the job state machine, recovery and
error bodies. **You write the catalog, the account and an adapter with `submit` and `poll`.** Do not
reimplement protocol endpoints by hand.

Done means: `cuelor-provider-test --manifest dist/cuelor-provider.json` prints `PASS` for A1–A9 and ends
with `PASSED`; and, when the user allows spending, `--live --max-cost <budget>` passes B and C too.

## Ground rules

- **Never call the paid upstream without permission.** Tier A and unit tests must not create upstream
  jobs. Run `--live` only when the user gave a budget, and always with `--max-cost`.
- **Never write a key into a file, an argument, a log or an error message.** Keys live in the macOS
  keychain (service `cuelor-provider:<id>`). Return the key from `secrets()` so the SDK strips it from
  every error message. Tests use fake keys built at run time, never strings that look like real keys.
- **Work from the specification, not from guesses.** When the upstream cannot do something, leave the
  route or parameter out of the catalog rather than faking it.
- The SDK is the source of protocol behaviour. If a check fails inside SDK code, report it; do not patch
  around it in the plugin.

## Read first

1. `examples/fake-provider/`: a complete plugin. Its `src/provider.ts` (definition and adapter) and
   `src/catalog.ts` (catalog) are the templates for your files.
2. `spec/v1.md` sections 3.3 (catalog), 3.5 (jobs and states), 3.6 (ordered inputs and `@image1`
   references) and 3.8 (errors); 3.7 too for speech recognition. `spec/plugins.md` sections 3–5.
3. The SDK types: `sdk/typescript/src/types.ts` (protocol objects: `Catalog`, `Model`, `Parameter`,
   `Route`, `Slot`, `Pricing`, `Capabilities`, `Account`, `ErrorObject`) and the definition types at the
   top of `sdk/typescript/src/server.ts` (`ProviderDefinition`, `UpstreamAdapter`, `UpstreamState`).
4. The upstream's API documentation: submit, poll, cancel, whether a job can carry a client-supplied
   reference (needed for `lookup`), how long results are kept, prices, error responses.

## Steps

### 1. Scaffold

Inside this repository, copy `examples/fake-provider` to `providers/<name>/` (`<name>`: lowercase
letters, digits and `-`) and add the directory to the root `package.json` workspaces; keep the
dependency `"@cuelor/provider-sdk": "1.0.0"` (the workspace resolves it). **Change `name` in the copied
`package.json`** (for example `@cuelor/provider-<name>`): npm refuses two workspaces with the same
name. Then run `npm install` at the root so `package-lock.json` gains the new workspace. In a separate repository, depend on the published `@cuelor/provider-sdk` (or, before it is
published, `"file:<path to this repository>/sdk/typescript"` after `npm run build` there) and add
`esbuild`, `typescript` and `@types/node` as dev dependencies.

Keep `build.mjs` (esbuild bundles `src/main.ts` into one dependency-free `dist/provider.mjs` and copies
the manifest next to it) **but delete its second `build(...)` block**, which builds the example's faulty
test variant. Keep `src/main.ts` and `tsconfig.json`. Delete `src/fake-upstream.ts`, `src/png.ts`,
`src/transcribe.ts`, `src/video-sample.ts` and everything in `test/`.

### 2. Manifest: `cuelor-provider.json`

```json
{
  "manifest_version": 1,
  "id": "<publisher>.<name>",
  "name": "…", "version": "0.1.0", "description": "…",
  "publisher": "<publisher>", "repository": "https://…", "license": "Apache-2.0",
  "protocol": "1.0",
  "capabilities": ["image"],
  "runtime": { "kind": "node", "entry": "provider.mjs" },
  "network": ["api.upstream.example"],
  "setup": { "login_command": ["login"], "docs": "https://…" },
  "test": { "image": { "model": "<cheapest model>", "route": "text2image", "parameters": { "prompt": "a red square" } } }
}
```

- `id` (lowercase letters, digits and `-`, as `<publisher>.<name>`) and `version` **must equal** `id` and
  `version` in the provider definition (A1). Export them as constants and compare them in a unit test.
- **One version everywhere.** The `version` of the plugin's `package.json`, the manifest `version` and
  `PROVIDER_VERSION` must be the same, and a release is tagged `<name>-v<version>` with that version
  (`release.yml` refuses a tag that differs from `package.json` or the built manifest).
- `capabilities` here is a display list (`image`, `video`, `transcription`). The authoritative object is
  the definition's `capabilities` (step 4).
- `test` names the **cheapest** model and parameters per capability; tiers B and C use them.
- Schema: `spec/schemas/manifest.json`.

### 3. Catalog

`catalog(ctx)` returns `{ models: [...] }`. Schema: `spec/schemas/catalog.json`; TypeScript: `Catalog`.

```ts
const PRICE: Pricing = { basis: "exact", unit: "job", amount: 0.002, currency: "USD" };
// basis: exact | estimate; unit: job | image | second | minute | character

{
  id: "upstream-model-1",          // any string unique in the service; may contain "/"
  label: "Model 1", provider: "Upstream", available: true,
  output: { modality: "image" },   // image | video | audio | text (speech recognition)
  parameters: [                    // kind: text (prompt-like) | string | number | integer | boolean | enum
    { name: "prompt", kind: "text", required: true, max_length: 1000 },
    { name: "aspect", kind: "enum", default: "1:1", enum_values: ["1:1", "4:3", "16:9"] },
    { name: "seed", kind: "integer", min: 0, max: 999999, step: 1,
      widget: "number",                                   // optional display hint: a string
      visible_when: { name: "aspect", equals: "1:1" } },  // optional: show while aspect is "1:1"
  ],
  // optional: while `aspect` is one of when_values, `seed` must not be one of reject_values
  parameter_rules: [
    { when_name: "aspect", when_values: ["16:9"], reject_name: "seed", reject_values: ["0"],
      message: "seed 0 is not available in 16:9" },
  ],
  routes: [
    { id: "text2image", input: { slots: [], max_total_artifacts: 0 },
      parameter_names: ["prompt", "aspect", "seed"], output: { media_types: ["image/png"] }, pricing: PRICE },
    { id: "image2image",
      input: { slots: [{ id: "reference", role: "reference", modality: "image", min_artifacts: 1, max_artifacts: 3,
                         media_types: ["image/png", "image/jpeg"], max_bytes: 8 * 1024 * 1024 }],
               max_total_artifacts: 3 },
      parameter_names: ["prompt", "aspect", "seed"], output: { media_types: ["image/png"] }, pricing: PRICE },
  ],
}
```

Route ids: `text2image`, `image2image`, `text2video`, `image2video`, `audio2text`, and the others in
`spec/v1.md` section 3.3. `image2video` takes one image as the first frame (slot `role: "first_frame"`);
a video guided by reference images is `multimodal2video` with `reference` slots. A numeric parameter
with a few allowed values (`duration` of 4, 6 or 8 s) lists them in `enum_values` and keeps its kind.
Speech recognition: `output.modality: "text"`, route `audio2text`, a slot with `role: "audio"`, output
`application/vnd.cuelor.transcript+json`.

A5 fails on any of these, so check them while writing:

- every name in a route's `parameter_names` is defined in the model's `parameters`;
- a `default` is one of `enum_values`, inside `min`..`max`, and equal to `min + k * step`;
- `min <= max`; each slot's `min_artifacts <= max_artifacts`;
- `max_total_artifacts` is at least the sum of the slots' `min_artifacts`;
- `media_types` are real MIME types (`image/png`, not `png` or `image`);
- route outputs match the model's modality;
- `widget` is a string; `visible_when` is `{ name, equals }` with both present; each `parameter_rules`
  item has `when_name`, `reject_name` and `message` (strings) and `when_values`, `reject_values` (arrays
  of strings). Leave out what you do not need.

`validateCatalog(catalog)` from the SDK returns the same problems; assert it returns `[]` in a unit test.

Give every slot the `max_bytes` the upstream really accepts. A7 uploads one byte more than the largest
and expects 413; if any slot has no `max_bytes`, uploads have no declared limit and A7 skips that part.

Only list what the upstream supports. Prefer fewer, correct parameters over many guessed ones.

### 4. Definition and account

Start from `buildProvider()` in the example's `src/provider.ts`:

```ts
export const PROVIDER_ID = "<publisher>.<name>";
export const PROVIDER_VERSION = "0.1.0";
const SERVICE = keychainService(PROVIDER_ID);   // "cuelor-provider:<id>"

let cachedKey: string | undefined;
async function upstreamKey(): Promise<string | undefined> {
  // CUELOR_PROVIDER_TEST_KEY is for development and the conformance suite only (`--env`); the app starts
  // the plugin with an empty environment, so users' keys always come from the keychain.
  cachedKey ??= process.env.CUELOR_PROVIDER_TEST_KEY || (await keychainGet(SERVICE, "default"));
  return cachedKey;
}

export function buildProvider(): ProviderDefinition {
  return {
    id: PROVIDER_ID, name: "…", version: PROVIDER_VERSION, repository: "https://…",
    capabilities: { generation: ["image"], transcription: false, cancel: true, estimate: false, webhook: false, setup: false },
    billingUnit: "USD",                                   // or "credits"
    async account(ctx) {
      const key = await upstreamKey();
      if (!key) return { status: "needs_setup", label: "No key", binding: await computeBinding("", { dataDir: ctx.dataDir }) };
      return { status: "ready", label: "…", binding: await computeBinding(key, { dataDir: ctx.dataDir }) };
    },
    secrets: () => (cachedKey ? [cachedKey] : []),
    catalog: () => CATALOG,
    upstream: { /* step 5 */ },
  };
}
```

- `capabilities.cancel: true` requires `upstream.cancel`; `estimate: true` requires `upstream.estimate`;
  `transcription: true` requires an `audio2text` route; `setup: true` requires `setup()`.
- `binding` always comes from `computeBinding` (64 hexadecimal digits, A1). It must change with the
  account, and with the key unless the jobs and idempotency records are still found under the new key
  (v1.md section 3.2): the client keeps querying and replaying with the same `Idempotency-Key` while
  the binding stays the same. The SDK keeps both in the data directory by binding, so when the upstream
  has an account id and a new key of that account can still query its jobs, pass the account id
  instead of the key, and rotating a key does not pause the client's jobs. Otherwise pass the key.
- Report `invalid_credentials` when the upstream rejected the key (for example remember a 401 from the
  last upstream call). Do not call the upstream on every `account()` call. The SDK reuses its result for
  `accountCacheMs` (5 s), but every new submission calls it again (A9). Load the key once, as above, so
  `secrets()` knows it before any error is built. A setup page that stores a new key resets the key and
  calls `ctx.invalidateAccount()`.
- **Setup page.** With `setup: true`, serve the page from `extraRoutes` under `/setup/<random>`. It has
  no bearer token; the SDK checks `Host` and allows only the plugin's own `Origin` (plugins.md
  section 2). The random part is the secret: long, used once, valid for 10 minutes.
- **Login.** The manifest's `setup.login_command` (`["login"]`) is run as `node provider.mjs login`. The
  SDK has no helper for it; dispatch in `src/main.ts` before `runProvider`:

```ts
async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

if (process.argv[2] === "login") {
  const key = (await readStdin()).trim();               // never from argv: `ps` shows arguments
  if (!key) { process.stderr.write("usage: provider.mjs login < key.txt\n"); process.exit(2); }
  await keychainSet(keychainService(PROVIDER_ID), "default", key);
  process.exit(0);
}
runProvider(buildProvider()).catch(/* as in the example */);
```

### 5. Adapter

```ts
upstream: {
  async submit(ctx)   { /* create the upstream job; return { upstreamId } as soon as it is accepted */ },
  async poll(id, ctx) { /* map the upstream state to an UpstreamState */ },
  async lookup(clientReference, ctx) { /* find the upstream job that submit tagged with clientReference; its id, or null */ },
  async cancel(id)    { /* best effort */ },
  async estimate(ctx) { /* { amount, unit, basis } */ },
}
```

**submit(ctx).** `ctx.request.parameters` has been validated against the catalog but **not filled in**:
an omitted parameter means its catalog `default`, so apply defaults yourself. `ctx.inputs` are in
`position` order; each has `artifact.media_type`, `alias` (`@image1`) and `await input.read()` for the
bytes. When the upstream does not understand `@image1` in prompts, rewrite them:
`replacePromptReferences(prompt, (ref) => \`image ${ref.index}\`)` (`ref.kind` is `image`, `video` or
`audio`; `ref.index` counts from 1 within the kind). Send `ctx.clientReference` to the upstream when it
accepts a client-supplied reference, and implement `lookup` with it. Do not wait for the job to finish.
Pass `ctx.signal` to `fetch`. After `submitTimeoutMs` (default 20 s) the client gets 502 but the call
goes on and its result is still recorded; only after `submitHardTimeoutMs` (default 10 minutes) is
`ctx.signal` aborted and the submission treated as unknown.

What `submit` throws decides recovery:

| Situation | Throw | Effect |
|---|---|---|
| The upstream answered and certainly created nothing (400 validation, 402 no credit, 403) | `new ProviderError(status, code, message)` with a code from the table below | The client gets that error; the key may be reused |
| Certainly not accepted, a retry may work (connection refused, DNS failure, 429, 503 before the job was created) | `new NotSubmittedError(message)` (503 `upstream_unavailable` by default) | The client replays later; the SDK submits again |
| Anything else: a timeout or a dropped connection after sending, an unexpected answer | any other `Error` | Unknown: the SDK never submits this key again; it calls `lookup(clientReference)`, and without a match ends the job `failed` with `submission_unknown` |

Error codes (`spec/v1.md` section 3.8): 400 `invalid_request` (with a `reason`), 402
`insufficient_credits`, 403 `forbidden`, 422 `content_moderated`, 429 `rate_limited`, 502/503/504
`upstream_unavailable`. Messages are short English for people, without keys or signed URLs.

**poll(upstreamId, ctx)** returns `{ status, progress?, outputs?, error?, usage?, warnings? }`:

| Upstream state | `status` | Also return |
|---|---|---|
| waiting, pending | `queued` | |
| processing | `running` | `progress` 0–100 if known |
| waiting for the user's approval | `pending_approval` | `approval: { policy, deadline }` |
| done | `succeeded` | exactly one output; `usage` when the upstream reports cost |
| refused by moderation | `rejected` | `error: { code: "content_moderated", message }` |
| failed | `failed` | `error: { code, message }`, for example `upstream_failed` |
| cancelled | `cancelled` | |

An output is `{ mediaType, data, metadata? }`. `data` is the bytes or an async function that downloads
them (add the upstream's auth header there if its result URLs need it). The SDK calls it once, stores the
file in the data directory, checks its type and serves it, so later polls never download again. Usage is
`{ amount, unit, basis: "billed" | "estimate" }`.

Speech recognition returns the transcript of `spec/v1.md` section 3.7.2 as the output (`mediaType:
"application/vnd.cuelor.transcript+json"`); `normalizeTranscript` and `validateTranscript` help. `unit`
(`word`, `character` or `token`) is required and must be the real granularity. Units must be ordered,
not overlapping, and inside the audio.

An input the service does not have (never uploaded, or no longer kept) is rejected by the SDK with 400
`invalid_request`, reason `artifact_not_found`; keep uploaded inputs for 30 days (the SDK does).

### 6. Build and test tier A

```sh
npm run build        # dist/provider.mjs and dist/cuelor-provider.json
```

Get the suite (Go 1.23+): from a clone of this repository run
`go run ./conformance/cmd/cuelor-provider-test …` at its root, or build it once with
`go build -o dist/bin/cuelor-provider-test ./conformance/cmd/cuelor-provider-test` (also what
`make ck-verify` leaves in `dist/bin/`). Once published:
`go install github.com/cuelor/providers/conformance/cmd/cuelor-provider-test@latest`.

```sh
export CUELOR_PROVIDER_TEST_KEY=…        # your development key; never write it into a file of the repository
cuelor-provider-test --manifest dist/cuelor-provider.json --env CUELOR_PROVIDER_TEST_KEY
cuelor-provider-test --manifest dist/cuelor-provider.json --env CUELOR_PROVIDER_TEST_KEY --only A5 --verbose
```

Tier A needs a **ready account**: until a key is set, the catalog and new submissions answer 403
`provider_not_ready` (`spec/v1.md` section 3.2) and A4–A9 fail with that reason. `--env NAME` copies the
variable from your environment into the plugin's, so the key is not on the command line; the suite
otherwise starts the plugin with an empty environment, as the app does. Tier A creates no upstream job,
so any value works when `account()` does not call the upstream; A6's last step submits one job, and only
with `--live`.

**Keys in CI.** `make ck-verify` (`scripts/check-plugins.sh`) runs tier A for every plugin in
`providers/`. It reads the key of `providers/<name>` from `CUELOR_TEST_KEY_<NAME>` (`<name>` in upper
case, `-` as `_`) and hands it to the plugin as `CUELOR_PROVIDER_TEST_KEY`. In CI that variable is the
GitHub secret of the same name, which a maintainer sets; add the line
`CUELOR_TEST_KEY_<NAME>: ${{ secrets.CUELOR_TEST_KEY_<NAME> }}` to the `env` of the ck-verify steps of
`.github/workflows/ci.yml` and `release.yml`. Never invent, commit or print a key value.

| Failing check | Usual cause |
|---|---|
| A1 | `id` or `version` differs from the manifest; binding not from `computeBinding` |
| A2 | A route served outside the SDK (`extraRoutes` handles only paths outside `/v1/`) |
| A3 | The process does not exit when stdin closes (an open handle such as an interval timer or a child process) |
| A4, A5 | Catalog shape or semantics; run `validateCatalog` in a unit test |
| A6 | `message` contains the key or the token: return it from `secrets()` |
| A7 | A `maxUploadBytes` larger than the catalog's `max_bytes` |
| A9 | `account()` or `catalog()` calls the upstream on every request: cache it |

### 7. Tiers B and C (only with the user's budget)

```sh
cuelor-provider-test --manifest dist/cuelor-provider.json --live --max-cost 0.50 --env CUELOR_PROVIDER_TEST_KEY
```

The suite estimates the cost first; above `--max-cost`, or when it cannot estimate, it submits nothing
and the run fails with every B and C check `not run`. B6 and B7 kill the plugin
during a job and restart it: everything must be in the data directory, which the SDK handles as long as
`submit` returns quickly and `poll` works after a restart.

**One data directory, one instance.** Never run two copies of the plugin on the same
`CUELOR_PROVIDER_DATA_DIR`, also not as a self-hosted service (`CUELOR_PROVIDER_LISTEN`) with several
replicas on one volume. `runProvider` refuses to start then ("another instance is using the data
directory"); give each copy its own directory.

## Before you finish

- [ ] Tier A passes; unit tests (`npm test`) pass and do not call the upstream.
- [ ] No key, token or internal host name in any file, test or commit message.
- [ ] `manifest.test` names the cheapest model; `network` lists every host the plugin connects to.
- [ ] A README for the plugin: what it supports, how to log in, what it costs, what it cannot do.
- [ ] Report what was not verified (for example tiers B and C when no budget was given).
