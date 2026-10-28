# Fake provider (example)

A complete Cuelor provider plugin with a fake upstream. It needs no account, makes no network calls
and costs nothing. Use it to:

- learn how a plugin is put together with [`@cuelor/provider-sdk`](../../sdk/typescript);
- run the conformance suite without a real upstream (all checks pass, tier B and C included);
- develop a host against a provider that behaves like a real one.

## What it offers

| Model | Routes | Output |
|---|---|---|
| `example/fake-image` | `text2image`, `image2image` (1 to 4 references) | a 64x64 PNG with one colour derived from the prompt and the seed |
| `example/fake-video` | `text2video`, `image2video` (the image is the first frame), `multimodal2video` | the same one-second, 64x64 MP4 every time |
| `example/fake-asr` | `audio2text` | a transcript; see below |

Jobs move through `queued`, `running` and `succeeded` in about 1.5 s (image), 3 s (video) or 1 s
(transcription). The state comes from the time since submission, and the fake upstream keeps its jobs
on disk, so jobs survive a restart. Prices and usage are always 0 USD.

The prompt can ask for other outcomes:

| In the prompt | Outcome |
|---|---|
| `[fail]` | `failed`, `upstream_failed` |
| `[moderate]` | `rejected`, `content_moderated` |
| `[approval]` | one second of `pending_approval` before the job is queued |

A video `duration` other than 1 is accepted and gives a `parameter_ignored` warning.

**Transcription.** The fake recogniser cannot hear. It reads the text that the conformance samples
carry in their WAV `LIST/INFO/ICMT` chunk, as JSON `{"language", "text"}`. It spreads the words
(characters for Chinese and Japanese) evenly over the middle 90 % of the audio. Any other audio gives
an empty transcript.

## Build and run

From the repository root:

```sh
npm install
npm run build     # builds the SDK, then dist/ and dist-test/ here
npm test
```

`dist/` holds the plugin: `provider.mjs`, a single file with no dependencies, and
`cuelor-provider.json`.

Command mode is how a host runs it. The token goes on stdin, the port comes back on stdout, and the
plugin exits when stdin closes:

```sh
cd examples/fake-provider/dist
export CUELOR_PROVIDER_DATA_DIR=$(mktemp -d)
TOKEN=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)
{ echo "$TOKEN"; cat; } | node provider.mjs
# cuelor-provider-listening port=53117
```

In another terminal:

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:53117/v1/models
curl -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: try-1" -H "Content-Type: application/json" \
  -d '{"model":"example/fake-image","route":"text2image","input":{"artifacts":[]},"parameters":{"prompt":"a red square"}}' \
  http://127.0.0.1:53117/v1/jobs
```

Standalone mode serves on a fixed address with a token from a file:

```sh
CUELOR_PROVIDER_LISTEN=127.0.0.1:8787 CUELOR_PROVIDER_TOKEN_FILE=./token node provider.mjs
```

## Conformance

```sh
dist/bin/cuelor-provider-test --dir examples/fake-provider/dist --live --max-cost 0
```

## The faulty fixture

`test/faulty-provider.ts` is built to `dist-test/faulty-provider.mjs`. It runs this provider with one
deliberate defect, chosen with `--fault=<name>`, to prove that the conformance suite detects it. It is
for tests only and must never be shipped.

| Fault | Defect | Check that fails |
|---|---|---|
| `no-auth` | accepts requests without a bearer token or with a wrong one | A2 |
| `short-binding` | `account.binding` is not 64 hexadecimal digits | A1 |
| `ignore-stdin` | keeps running after stdin closes | A3 |
| `unchecked-references` | accepts `@image3` with fewer images | A6 |
| `wrong-sha256` | the upload response has a wrong `sha256` | A7 |
| `unknown-job-500` | answers 500 instead of 404 for an unknown job | A8 |
| `new-job-same-key` | a replay with the same key and body creates a new job | B2 (also B4, B6, B8, which replay too) |
| `no-conflict` | the same key with another body returns the old job instead of 409 | B3 |
| `garbled-transcript` | the recogniser returns the wrong text | C1 |

The defects are injected by a small proxy in front of the real provider, or by wrapping the provider
definition. The SDK has no switch that weakens it.

```sh
dist/bin/cuelor-provider-test --dir examples/fake-provider --only A2 \
  --command "node dist-test/faulty-provider.mjs --fault=no-auth"
```

## Files

```
src/main.ts           entry point: runProvider(buildProvider())
src/provider.ts       the provider definition and the adapter to the fake upstream
src/catalog.ts        models, routes, parameters and slots
src/fake-upstream.ts  the fake upstream: jobs on disk, states over time, outputs
src/transcribe.ts     the fake recogniser
src/png.ts            a minimal PNG encoder
src/video-sample.ts   the embedded MP4 (made for this project, Apache-2.0)
test/                 unit tests and the faulty fixture
build.mjs             esbuild bundling into dist/ and dist-test/
```

Licensed under Apache-2.0.
