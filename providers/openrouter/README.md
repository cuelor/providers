# OpenRouter plugin

A Cuelor provider plugin (`cuelor.openrouter`) for [OpenRouter](https://openrouter.ai): image and video
generation and transcription, paid from your own OpenRouter balance. It is the reference plugin for
[Provider API v1](../../spec/v1.md), written with [`@cuelor/provider-sdk`](../../sdk/typescript/).
[`VALIDATION.md`](VALIDATION.md) lists how each part of the protocol maps to OpenRouter, and what the
protocol cannot express.

Status: 0.1.0, not released yet. Tested against a mock of OpenRouter, and run once against the real
service on 2026-10-28 (tiers A, B and C pass; [`VALIDATION.md`](VALIDATION.md), "Live results"). How to run
it again: [`LIVE.md`](LIVE.md).

## Setup

The plugin needs an OpenRouter key. Either:

- **Sign in with OpenRouter.** In Cuelor, set up the provider: a page on the plugin's own local port
  opens in your browser. "Sign in with OpenRouter" takes you to OpenRouter (OAuth with PKCE), and
  OpenRouter creates a key for this app in your account. Or paste an existing key into the same page.
- **From a terminal**, with a key on the clipboard (macOS):

  ```sh
  pbpaste | node provider.mjs login
  ```

  `login` reads the key from stdin only (never from arguments), checks it with OpenRouter, and stores it.

The key is stored in the macOS login keychain, service `cuelor-provider:cuelor.openrouter`, account
`api_key`. It is never written to the plugin's log or shown in any response. To remove it:
`security delete-generic-password -s cuelor-provider:cuelor.openrouter -a api_key`, and revoke the key at
<https://openrouter.ai/settings/keys>.

Costs are charged by OpenRouter to your balance at the models' prices. Cuelor shows the plugin's
estimates and OpenRouter's reported cost, in USD.

## What it offers

The plugin offers a model only when it is in its own table ([`src/models.ts`](src/models.ts)) **and**
in OpenRouter's current model list, so models OpenRouter removes disappear from the catalog.

| Kind | Models | Routes |
|---|---|---|
| Image | Seedream 4.5 (`bytedance-seed/seedream-4.5`), Gemini 2.5 Flash Image (`google/gemini-2.5-flash-image`) | `text2image`, `image2image` |
| Video | Seedance 2.0 Fast, Seedance 2.0 (`bytedance/…`), Veo 3.1 (`google/veo-3.1`) | `text2video`, `image2video` (first frame), `frames2video` (first and last frame), `multimodal2video` (references) |
| Transcription | Whisper (`openai/whisper-1`), GPT-4o mini Transcribe, ElevenLabs Scribe v2 | `audio2text` |

- Parameters come from OpenRouter's lists: aspect ratio, resolution, duration, sound, seed. Defaults are
  the cheapest choice: shortest video, lowest resolution, no sound. Values a model refuses although its
  list offers them (Seedream 4.5 and `1K`) are left out.
- Prices: video from OpenRouter's `pricing_skus` (per second, or per video token), images and
  transcription from the plugin's table. They are estimates; the job's `usage` is what OpenRouter billed.
- Every request produces exactly one result. If OpenRouter returns several, the first is kept and the job
  carries a warning `outputs_dropped`.
- References are sent in order. In prompts, `@image2` is sent as the words "image 2": OpenRouter has no
  syntax for referring to an input.
- Audio and video references are offered only for Seedance 2.0; other models would ignore them. An input
  a model does not take is rejected, never dropped silently.
- Word timestamps are offered for Whisper and Scribe. Languages are reported as BCP 47 (`en`, `zh`).
- No cancel: OpenRouter has no cancel endpoint. No webhooks: the plugin polls when Cuelor asks.

**Limits** (conservative until checked against the real service): image inputs 10 MiB; video references
MP4, 20 MiB and 15 s; audio references 15 MiB and 15 s; transcription input 25 MiB.

**How jobs run.** Images and transcription are single long requests at OpenRouter; the plugin runs them
in the background and answers at once. If the plugin is stopped during such a request, or OpenRouter
answers with an error inside HTTP 200 or a gateway error, the job ends `failed` with `submission_unknown`:
OpenRouter may still have charged for it, so its usage is the estimate. Video is an OpenRouter job that
survives restarts; the finished video (at most 512 MiB) is downloaded into the plugin's data directory.

## Network

The plugin connects only to `https://openrouter.ai` (manifest `network`). It never follows URLs from
OpenRouter's answers: downloads use URLs it builds from the job id, with redirects refused.

For tests, `OPENROUTER_BASE_URL` points it at a mock; only `http://127.0.0.1:<port>` or an `https://`
origin is accepted. Cuelor starts plugins with an empty environment, so this cannot be set in the app.
`CUELOR_PROVIDER_TEST_KEY` gives a key for test runs (the conformance suite's `--env`); it is used before
the keychain.

## Development

```sh
npm run build -w sdk/typescript          # once
npm run typecheck -w providers/openrouter
npm run build -w providers/openrouter     # dist/provider.mjs, dist-test/ (mock and faulty build)
npm test -w providers/openrouter          # offline tests against the mock OpenRouter
sh providers/openrouter/scripts/check-mock.sh live     # tiers A, B and C against the mock
sh providers/openrouter/scripts/check-mock.sh faults   # B2 and B6 must catch a build without idempotency records
```

The plugin's tests import the SDK's build, so build the SDK first (the first line above) when you run
`npm test -w providers/openrouter` on its own; `make ck-verify` runs all of these in order. The tests never reach the network: a guard in
[`test/helpers.ts`](test/helpers.ts) fails any test file that tried to connect anywhere but 127.0.0.1,
and the keychain is replaced by an in-memory stand-in (or a temporary keychain file on macOS).

The mock ([`test/mock-openrouter.ts`](test/mock-openrouter.ts)) follows OpenRouter's documented API;
markers in a prompt, such as `[moderate]` or `[budget]`, make it answer with a given error. Without a test
key, `scripts/check-plugins.sh` (tier A) runs against it too.

The test audio in `conformance/samples/` and the MP4 copied into [`test/mock-media.ts`](test/mock-media.ts)
are the conformance suite's own samples (Apache-2.0).
