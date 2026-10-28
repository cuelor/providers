# Validating Provider API v1 against OpenRouter

This plugin is the first real upstream behind [Provider API v1](../../spec/v1.md). This report lists,
point by point, how v1 and OpenRouter fit together, so the specification can be settled before
`spec-v1.0.0` is tagged: after that, v1 only takes additions (v1.md section 3.11).

**Status: offline, then one live run.** Everything below was built and tested against a mock of
OpenRouter ([`test/mock-openrouter.ts`](test/mock-openrouter.ts)) written from OpenRouter's public
documentation, read on 2026-10-28. On the same day the maintainer provided a test key and the plugin was
run once against the real service ([`LIVE.md`](LIVE.md)); "Live results" at the end has what that run
found, and the rows below are updated with it. Rows still marked **pending live** need a person at a
browser (OAuth) or more time (retention).

Each row is one of:

- **Expressed**: v1 says it directly.
- **Filled in**: OpenRouter does not do it, and the plugin makes up for it (how is said).
- **Not expressible**: v1 cannot say it. Then either **addition** (can come later as a v1 addition) or
  **before 1.0.0** (it changes the meaning of existing text, so it must be decided before the tag).

Sources: OpenRouter's documentation pages for [video generation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation.md),
[video submission](https://openrouter.ai/docs/api/api-reference/video-generation/submit-a-video-generation-request.md),
[video status](https://openrouter.ai/docs/api/api-reference/video-generation/poll-video-generation-status.md),
[reference-to-video](https://openrouter.ai/docs/cookbook/video-generation/reference-to-video.md),
[image generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation.md),
[transcription](https://openrouter.ai/docs/api/api-reference/stt/create-transcription.md),
[OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth.md),
[code exchange](https://openrouter.ai/docs/api/api-reference/oauth/exchange-authorization-code-for-api-key.md),
[current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key.md) and
[errors](https://openrouter.ai/docs/api_reference/errors-and-debugging.md).

## Summary

**Before 1.0.0** (each changes the meaning of existing normative text). All five are now **written into
v1.md** for 1.0.0, decided with the maintainers of the Cuelor app; the last column says how.

| # | Where | Problem | Written into v1.md |
|---|---|---|---|
| M1 | v1.md 3.2 `account.binding` | "MUST change when the key or the account changes" contradicts binding by account id (the SDK's own advice in `computeBinding`, and this plugin's OAuth path), which keeps the binding when only the key of the same account changes. | **Written into v1.md.** The binding MUST change with the account, and with the key **unless** the service still finds its jobs and idempotency records under the new key. The text gives the reason: with the same binding, the client keeps querying its jobs and replays unknown submissions with the same `Idempotency-Key`, so a service that lost them would answer 404 or charge twice. The SDK keeps both on disk by binding, so this plugin's OAuth binding (account id) is allowed, and its pasted-key binding (the key) changes with every key. Live: the OAuth `user_id` (`or_user_…`) and `creator_user_id` (`user_…`) are different identifiers, so the two paths keep separate bindings for the same account. Not checked live: whether OpenRouter answers a video poll made with another key of the same account. |
| M2 | v1.md 3.3 route `image2video` | "one `reference` image" does not say whether the image is the **first frame** or a **guide**. OpenRouter has both (`frame_images` with `first_frame`, and `input_references`), and they give different videos. | **Written into v1.md.** `image2video` takes one image as the first frame, slot role `first_frame` (was `reference`), as `frames2video` does. Reference-guided video is `multimodal2video` with only `reference` images. The plugin's slot is now `first_frame` (`units.test.ts`, `jobs.test.ts`). |
| M3 | v1.md 3.7.1 `timestamps` | "`word` (default)" conflicts with a catalog `default` for a model that has no word timestamps (here `openai/gpt-4o-mini-transcribe`, whose only value is `none`). | **Written into v1.md.** The catalog parameter's `default` decides; `word` is the default only when the catalog gives none. The plugin already gives `none` as that model's default. |
| M4 | v1.md 3.5.2, 3.5.3 `submission_unknown` | Defined as "unknown whether the upstream accepted the job". The plugin also needs it when a **synchronous** call may have run (and been charged) but its result was lost in a crash. | **Written into v1.md.** `submission_unknown` now means "unknown whether the upstream ran the job and charged for it; its result is not available", with the agreed reason `interrupted` for a synchronous call cut off while it ran. The plugin already uses that reason. |
| M5 | v1.md 3.10 filtered outputs | "The service MUST detect [a black replacement image]" cannot be met in general: the plugin can decode PNG, not JPEG or WebP, and OpenRouter does not say whether `/images` ever does this. **Live: Seedream 4.5 returns JPEG**, so the plugin's PNG check never sees its outputs. | **Written into v1.md.** MUST when the service knows its upstream does this; otherwise SHOULD, in the formats it can decode. OpenRouter does not document it, so the plugin's PNG check meets the SHOULD. |

**Additions**: an agreed warning `outputs_dropped` (A1), an opt-in for several outputs (A2), a per-request
total size for inputs (A4) and a structured hint for how references are passed (A5) stay for later
versions of v1. Two were settled before 1.0.0 and are **written into v1.md**:

- **A3**: a `number` or `integer` parameter MAY list its allowed values in `enum_values` (Veo 3.1's
  `duration` is `[4, 6, 8]`), clients MUST support it, and `step` MAY be fractional (v1.md 3.3).
  Conformance check A5 and the SDK's `validateCatalog` check numeric `enum_values` and align fractional
  steps with a tolerance. The plugin already offers such durations this way.
- **A6**: clients MUST accept moderation `stage` values they do not know, so a value such as `unknown`
  can be added later (v1.md 3.10, 3.11). The plugin still reports `input` for a failed video.

Details in the rows below; where a row still says "M…" or "A3"/"A6", the decision above applies.

**Still pending live:** the OAuth callback's host, the binding of a pasted key versus OAuth, the size
limits for inline references, the moderation error of `/images`, and OpenRouter's output retention.

## Rows

### Account and setup (`account`, `setup`)

| | |
|---|---|
| OpenRouter | OAuth PKCE: the browser opens `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256`; `POST /api/v1/auth/keys` with `{code, code_verifier, code_challenge_method}` returns `{key, user_id}`. Or the user pastes a key. `GET /api/v1/key` describes the current key (`label`, limits, `creator_user_id`, no `user_id`). |
| Plugin | `capabilities.setup = true`. `POST /v1/setup` gives `/setup/<48 hex>` for 10 minutes. The page offers "Sign in with OpenRouter" (PKCE, `state`, callback on the plugin's own port) and a field for a key, which is checked with `GET /api/v1/key` first. `login` reads a key from stdin, refuses arguments, checks it and writes it to the keychain (`cuelor-provider:cuelor.openrouter`, account `api_key`). The account needs no network: the key is checked when it is set, and any 401 marks it `invalid_credentials`. |
| Verdict | **Filled in.** Tests: `account.test.ts`. |
| Gap: binding | Binding is the HMAC of `user_id` after OAuth (recorded in `account.json` with a fingerprint of the key it belongs to), else of the key. **The same account gets two bindings depending on how the user signed in**, so switching from a pasted key to OAuth pauses the app's running jobs. `creator_user_id` from `GET /api/v1/key` could give pasted keys the same binding, if it equals the OAuth `user_id`: **pending live**. This is also where v1's text conflicts with practice: **M1**. |
| Gap: callback host | plugins.md section 2 makes the plugin reject any `Host` but `127.0.0.1:<port>`, also on the setup page. OpenRouter documents `localhost` callbacks "on any port"; the plugin sends `http://127.0.0.1:<port>/…/callback`. If OpenRouter refuses `127.0.0.1` or rewrites it to `localhost`, the callback is rejected by the Host check. **Pending live.** If it fails: allow `localhost:<port>` for pages outside `/v1/` (**addition** to plugins.md: it widens what a plugin accepts, nothing the app relies on). |
| Gap: "valid once" | plugins.md section 2 says the random part is "valid once". Signing in takes three requests (page, redirect, callback), so the plugin reads it as "one completed setup": once a key is saved from any page, **every** open setup page closes, so a page opened earlier cannot replace the key (tested in `account.test.ts`). Worth one sentence in plugins.md (**addition**, a clarification). |
| Note | A revoked key shows `ready` until the first upstream call fails with 401. That is allowed (the account is "what the service knows") and keeps describe free of network calls. |

### Catalog

| | |
|---|---|
| OpenRouter | `GET /api/v1/images/models` (`supported_parameters`: `enum`, `range`, `boolean` descriptors); `GET /api/v1/videos/models` (`supported_durations`, `supported_resolutions`, `supported_aspect_ratios`, `generate_audio`, `pricing_skus`); `GET /api/v1/models?output_modalities=transcription`. All public. |
| Plugin | A model is offered only when it is both in the plugin's table ([`src/models.ts`](src/models.ts)) and in OpenRouter's list. The table supplies what the lists lack: reference inputs of video models, word timestamps of recognisers, prices of images and transcription. Defaults are the cheapest choice (shortest duration, lowest resolution, no sound). `n` is never offered (one output). Lists are cached for 10 minutes; after a failed refresh the last one is used for up to an hour. |
| Verdict | **Filled in.** Tests: `units.test.ts` (catalog). |
| Gap: durations | A list such as `[5, 10, 12]` is not a range. **A3, written into v1.md:** a `number` or `integer` parameter may list its values in `enum_values`, and clients must support it. The plugin offers evenly spaced durations (Veo 3.1's `[4, 6, 8]`) as a range with `step`, and others as `kind: "integer"` with `enum_values` (before 1.0.0 it used `kind: "enum"`). Tests: `units.test.ts` (durations). |
| Gap: prices | One `pricing.amount` per route; OpenRouter's video price depends on sound, resolution and SKU. **Live:** `pricing_skus` come in shapes the documentation does not list: Veo per second by sound (`duration_seconds_with_audio` 0.40, `…_without_audio` 0.20, `…_4k`), Seedance per **video token** (`video_tokens`, `video_tokens_1080p`, `…_with_video_input`); none has `per-video-second`. The plugin prices a second at W×H×24/1024 tokens (Seedance 2.0 Fast, 480p, 4 s: estimated 0.161 USD, billed 0.1705) and gives the route's hint at the defaults; `POST /v1/estimates` prices the request's own resolution, ratio and sound. The token formula is the plugin's inference, not documented. Image prices are not in the lists at all (Seedream 4.5: billed 0.04, not the 0.05 of the product notes). |
| Gap: image references | **Live:** the key is `supported_parameters.input_references`, a `range` (Seedream 4.5: 0 to 14; Gemini 2.5 Flash Image: 0 to 3). The plugin reads it, as written. |
| Gap: values the list offers but the model refuses | **Live:** Seedream 4.5 lists `resolution` `1K`, `2K`, `4K`, but refuses `1K` with 400 ("requires at least 3,686,400 output pixels"). The plugin's first live run failed B5 on it. The table now has a minimum resolution per model. Not a protocol gap; it means the upstream lists cannot be trusted alone, and the plugin's table stays necessary. |
| Gap: account-level availability | Some models are restricted by region (OpenRouter's terms, 5.7); the lists do not say for whom. The plugin cannot set `available: false` ahead of time; the submission fails with 403 `forbidden` (`region_restricted` when the message says so). Expressible, but only after the fact. |
| Note | Upstream models come and go: Sora 2 Pro was removed on 2026-09-24, and **live** ElevenLabs Scribe v1 was gone too (replaced in the table by `elevenlabs/scribe-v2`). The table keeps Sora to show that a model missing upstream is not offered. |

### Artifact upload

| | |
|---|---|
| OpenRouter | No upload endpoint. Image references are HTTP(S) or base64 data URLs; transcription takes multipart (`file`, 25 MB) or base64 JSON. |
| Plugin | The SDK keeps uploads in the data directory; at submission the plugin inlines them as data URLs (images, video and audio references) or multipart (transcription). |
| Verdict | **Expressed** (artifacts are the service's own in v1) and **filled in** (inlining). |
| Gap: limits | OpenRouter documents only the 25 MB of transcription. Slots use conservative limits: images 10 MiB, reference video 20 MiB and 15 s, reference audio 15 MiB and 15 s. **Pending live.** |
| Gap: total size | Nine 10 MiB references become about 120 MB of JSON in one request; v1 has a count limit (`max_total_artifacts`) but no total size. **A4 (addition):** `input.max_total_bytes`. |

### Submission and idempotency

| | |
|---|---|
| OpenRouter | Images `POST /api/v1/images` and transcription `POST /api/v1/audio/transcriptions` are synchronous (the documentation's image example took 94 s). Video `POST /api/v1/videos` returns 202 `{id, polling_url, status}`. **No endpoint takes an idempotency key**, and none can be searched by a client field: `user`, `session_id` and `trace` are for OpenRouter's logging and "never sent to the provider"; there is no list of video jobs. |
| Plugin | Every submission goes through the SDK's "record, then call" (v1.md 3.5.2). Video: the id is recorded as soon as the 202 arrives. Images and transcription: a local job is written to disk, its id returned at once (`queued`/`running`, v1.md 3.1), and the call made in the background; the result is written to disk before anyone asks for it. `lookup` searches the plugin's own local jobs. |
| Verdict | **Expressed** (v1.md 3.5.2 describes exactly this) and **filled in**. Tests: `jobs.test.ts` (crash window), conformance B2, B6, B7, B8 against the mock; the build without idempotency records fails B2 and B6 (`scripts/check-mock.sh faults`). |
| Crash window, video | A crash between OpenRouter's 202 and the record leaves an upstream job the plugin cannot find again; the replay ends `failed` with `submission_unknown` and is never submitted twice. The window is one HTTP response long. This is an upstream limit, not a protocol gap. |
| Crash window, images and transcription | A crash **during** the synchronous call loses its result, though OpenRouter may have run and charged it. The plugin ends the job `failed`, `submission_unknown`, reason `interrupted`. That fits the client's handling (warn about a possible second charge), but not the code's definition: **M4**. |
| Gap: SDK | A crash before the local job was written means the call certainly was not made, so a new submission would be safe; the SDK's `lookup` cannot say "certainly not submitted", so the job still ends `submission_unknown`. Conservative and correct; an SDK improvement, not a protocol issue. |
| Gap: refused in the background | A background call that OpenRouter refuses for a while (429, the in-flight budget, as an HTTP status, never inside HTTP 200) is retried after `Retry-After`, three times, then ends `failed`, `upstream_failed`, reason `not_submitted`. v1.md defines that reason only for "after the service had answered 5xx"; the meaning ("the upstream did not take it, nothing was charged") is the same. Worth widening the sentence (**addition**, a clarification). |
| Gap: credentials in the background | A 401 during a background call ends the job (`upstream_failed`, `not_submitted`, `params.upstream_status: 401`). v1 says running jobs "pause" on `provider_not_ready`, but that is an HTTP answer, and the job's states are closed. Keeping such jobs `queued` until the key works again would be plugin work, no spec change. |

### Query and states

| | |
|---|---|
| OpenRouter | `GET /api/v1/videos/{id}`: `pending`, `in_progress`, `completed`, `failed`, `cancelled`, `expired`; `error` is a plain string; no progress. |
| Plugin | `pending` → `queued`, `in_progress` → `running`, `completed` → `succeeded` (after the download), `failed` → `failed` (`upstream_failed`) or `rejected` (moderation, below), `cancelled` → `cancelled`, `expired` → `failed` with `timed_out`, reason `upstream_expired`. An unknown status keeps the job running. A 404 ends it `failed` (`upstream_job_not_found`). |
| Verdict | **Expressed**, with one naming clash: v1's `expired` means "the approval expired" and is only reachable from `pending_approval`, so OpenRouter's `expired` cannot use it. The mapping above is clear; worth a sentence in v1.md 3.5.3 (**addition**). Tests: `jobs.test.ts` (status mapping), conformance B4. |

### Cancel

| | |
|---|---|
| OpenRouter | No cancel endpoint for video; synchronous calls cannot be cancelled. |
| Plugin | `capabilities.cancel = false`; B9 is skipped. |
| Verdict | **Expressed.** |

### Download

| | |
|---|---|
| OpenRouter | A finished job has `unsigned_urls` (`/api/v1/videos/{id}/content?index=N`, with the key) and, while a stored copy exists, signed `urls` that work without a key until `expires_at` ("treat them as secrets"). How long outputs are kept is not documented. |
| Plugin | On the first query that sees `completed` the plugin downloads `content?index=0` with the key into the data directory (v1.md 3.4). It builds that URL from the job id and never follows a URL from a response, so the key goes nowhere but OpenRouter's origin. Signed URLs are never used, and any seen are redacted from messages. Content that is gone (404, 410) ends the job `failed`, `output_unavailable`. |
| Verdict | **Filled in.** Tests: `jobs.test.ts` (video). |
| Risk | The plugin downloads when the client asks (plugins.md 4: no polling after a restart). If the app is closed longer than OpenRouter keeps outputs, the result is lost. **Live:** a completed job had `unsigned_urls` only, **no `urls` and no `expires_at`**, so retention cannot be read from the job: **pending** (fetch the content of an old job again after a day or a week). |

### Ordered inputs and prompt references

| | |
|---|---|
| OpenRouter | `input_references` (images; video and audio only honoured by Seedance 2.0 and later, others "use image references and ignore the rest"); `frame_images` with `first_frame`/`last_frame`. The documentation gives no meaning for the order and no syntax for "the second image" in a prompt. |
| Plugin | Inputs are sent in `position` order. `@image2` becomes the words "image 2" (v1.md 3.6 rule 6), and each route's `description` says so. Video models without audio and video references have no slots for them, so such a request is a 400 before anything is sent, never silently dropped. `image2video` sends the image as `first_frame`, `frames2video` as first and last frame, `multimodal2video` as `input_references`. |
| Verdict | **Filled in**; **live**, Seedream 4.5 followed "image 2" in both orders (Live results); other models not tried. |
| Gap | v1 leaves the translation to `description` (free text, a SHOULD). **A5 (addition):** a structured route hint such as `reference_mode: "native" | "words" | "order_only"` so the app can warn that "@image2" may be ignored. Not needed for 1.0.0. The `image2video` meaning is **M2**. |

### Transcription

| | |
|---|---|
| OpenRouter | `response_format: verbose_json` with `timestamp_granularities: ["word"]` returns `words[{word, start, end, type?}]`; support depends on the model (a model without it answers 400) and there is no flag for it. `verbose_json` "is only supported by OpenAI-compatible providers". `language` comes back as an English name (Whisper: `english`) or ISO 639-3 (Scribe: `eng`). |
| Plugin | The table lists the `timestamps` values per model; `word` is offered only where words exist. Language names and 639-3 codes become BCP 47 (`english`, `eng` → `en`; `cmn` → `zh`), a requested language is sent as its primary subtag (OpenRouter takes ISO 639-1). Words are cleaned (sound events dropped, overlaps moved to the previous end, integer milliseconds, nothing past the audio) and put into their segments. `unit` is `character` for Chinese and Japanese when every unit is one character. A model that was asked for words and returns none ends `failed` (`no_word_timestamps`). |
| Verdict | **Filled in.** Tests: `units.test.ts` (language, transcript), `jobs.test.ts` (transcription), conformance C1, C2. The default of `timestamps` is **M3**. |
| Gap | OpenRouter's two pages disagree on which models give words. **Live** (zh sample, `verbose_json` + `word`): Whisper gives words but in multi-character tokens; Scribe v2 gives one character per unit and language `zho`; GPT-4o mini Transcribe answers 400 ("does not support response_format \"verbose_json\""), as the table says. |
| Note | **Live:** Whisper transcribed the Mandarin sample in **traditional** characters (天氣, 我們), the reason for C1's 23 % character error rate (C1 passes). The plugin reports `zh`; it does not detect the script, so `zh-Hant` is not reported. Not a protocol gap: BCP 47 can say `zh-Hant`, the plugin would have to detect it. |

### Usage and estimates

| | |
|---|---|
| OpenRouter | `usage.cost` in USD on image and transcription answers, and on video jobs once they finished. |
| Plugin | `billing.unit = USD`. `usage` is `billed` from `usage.cost`, else the plugin's own estimate (`estimate`). A job that failed with an error from OpenRouter reports 0 (OpenRouter does not charge failed generations); one whose result is unknown (`submission_unknown`, also `interrupted`) reports the estimated full price, since it may have been charged. `POST /v1/estimates`: images by the table's price, video from `pricing_skus` (Catalog, "prices"), transcription by the table's price per minute times the audio's length. |
| Verdict | **Expressed.** A video's `usage` is `null` until it finished (allowed: `usage` is MAY while running). **Live:** the first run failed B10 because a failed job had no `usage`; fixed as above. |

### Moderation

| | |
|---|---|
| OpenRouter | A flagged input is a 403 whose `metadata` has `reasons`, `flagged_input`, `provider_name`; typed errors `content_policy_violation` and `refusal` (403). A failed video only has text (the documentation's example: "Content policy violation"). Whether `/images` reports moderation the same way is not documented. |
| Plugin | Typed signals become `content_moderated` (422 at submission for video; `rejected` for the background calls) with `stage: input`, `source: upstream` and `category` from `reasons`. A failure whose text only reads like moderation is classified by keywords with `inferred: true` (v1.md 3.10), but only on 403 and 422 and for failed video jobs: a plain 400 that mentions, say, an "unsafe" parameter stays an invalid request. An all-black PNG is `rejected`, `stage: output`, `inferred: true`, and is not returned. |
| Verdict | **Expressed** (3.10 covers typed and inferred signals). Tests: `units.test.ts`, `jobs.test.ts`. |
| Gap | For a failed video the stage is unknown; the plugin says `input`. **A6:** `stage: "unknown"`. This is an addition only if `stage` counts as a descriptive enumeration (v1.md 3.11 lists moderation categories, not stages); a client that switches on `input`/`output` would break. Say before 1.0.0 that clients MUST tolerate other `stage` values, then the value can come later. The black-image rule is **M5**. The real moderation errors of `/images`: **pending live**, without sending content that breaks the terms (LIVE.md, step 4c). |

### Errors

| | |
|---|---|
| OpenRouter | `{"error": {"code", "message", "metadata"}}`. Errors after generation started can come with **HTTP 200** and an `error` object in the body. 402 with `Retry-After` and `metadata.limit_source = openrouter_in_flight_budget` is a temporary limit; 402 without it is an empty balance. |
| Plugin | Every JSON answer is checked for an error object, whatever the status. **An error inside HTTP 200 is an unknown result, whatever its body's code** (402, 429 and 400 included): OpenRouter took the request, so generation may have started and been charged. At submission it is a 5xx (the client keeps the key and never resubmits); in the background it ends the job `submission_unknown`, reason `error_in_body`, usage the estimate, and is never retried. There is no exception, not even a typed moderation code: a rejected job would invite the user to submit again. Errors with an HTTP status are classified by it. At submission: in-flight budget → 429 `rate_limited` with `Retry-After`; balance → 402 `insufficient_credits`; 401 → 403 `provider_not_ready`; 403 → `forbidden` (`region_restricted` or `account_suspended` when the message says so); 400, 404, 413, 422 → 400; **5xx, timeouts and a 200 with an error → unknown** (502, then `submission_unknown`), because OpenRouter does not say that nothing was created. In the background the same errors become job states (`insufficient_credits`, `invalid_input`, `upstream_failed` with usage 0). **Gateway errors in the background** (408, 504, 524: reason `gateway_timeout`; 502: `gateway_error`) end the job `submission_unknown` with the estimate as usage: OpenRouter may still be generating, and charging. This is deliberately stricter than OpenRouter's image guide, which says a 502 from `/images` means the generation did not complete and nothing is charged; a gateway cannot prove that. |
| Verdict | **Filled in.** Tests: `units.test.ts` (errors), `jobs.test.ts`. |
| Gap | The 403 reasons are read from free text; v1 has `inferred` only for moderation. Small; an addition if wanted. OpenRouter's 503 ("no available provider") probably means "not accepted", but the documentation does not promise it, so it is treated as unknown: **pending live** (if OpenRouter confirms it, it can become `NotSubmittedError`, fewer `submission_unknown`). |

### Single output

| | |
|---|---|
| OpenRouter | `/images` takes `n` (1 to 10) and returns `data[]`; providers "may return fewer". A video job has one `unsigned_urls` entry per output. |
| Plugin | Never offers `n`, and sends `n: 1`. If several results come back anyway, it keeps the first (v1.md 3.5.3) and adds a warning `outputs_dropped`, so the user knows something was dropped. |
| Verdict | **Expressed** for 1.0.0. |
| Answer | **v1 should not require clients to tolerate several outputs now.** Requiring it later is not a problem, because several outputs can come as an **opt-in** addition (**A2**): an optional request field, for example `output_count`, absent meaning 1, plus a capability. A v1.0 client never sends it, so it never sees more than one output. Requiring tolerance today would add an obligation to every client for a feature no upstream needs yet. **A1 (addition):** make `outputs_dropped` an agreed warning code. **Live:** `n: 1` returned one image every time. |

### Not in v1 on purpose

- Webhooks: OpenRouter's `callback_url` must be public HTTPS; a local plugin cannot receive it and polls.
  `capabilities.webhook = false`.
- Voice-over: OpenRouter has `/api/v1/audio/speech`; v1 has no voice-over and the plugin does not use it.

## Live results

2026-10-28, plugin 0.1.0 (this branch), the suite from this repository, a test key of the maintainer's
with a 10 USD limit. Everything done with the key, including the two suite runs and the manual checks,
cost about 0.6 USD.

| Item | Result |
|---|---|
| Tiers A, B, C, first run | 19 of 22 passed, B9 skipped. **B5 failed**: Seedream 4.5 refuses the `1K` its list offers. **B10 failed**: the failed job had no `usage`, and the video estimate was 0.40 USD for a 0.17 USD video. All three fixed in the plugin. |
| Tiers A, B, C, after the fixes | **21 of 22 passed**, B9 skipped (no cancel). B7: image job killed while running ended `submission_unknown`, `interrupted`. C1: en 0 %, zh 23 % (Whisper's traditional characters). |
| OAuth callback host (127.0.0.1 accepted?) | Pending: needs a person at a browser (LIVE.md 4e). |
| `creator_user_id` equals the OAuth `user_id`? | `GET /api/v1/key` does return `creator_user_id`; the comparison needs the OAuth run. Pending. |
| "image 2" understood (step 4a) | Yes for Seedream 4.5: with a red and a blue reference, "the colour of image 2" gave a blue mug, and with the order swapped a red one. It still put a red object in the background of the first, so "do not use image 1" was not fully followed. Other models not tried. |
| `n: 1` ever returns several? `outputs_dropped` seen? | No: every image request returned one image. |
| Moderation error of `/images` | Not seen (nothing was sent that should be refused). Pending. |
| Video `expires_at` after completion (retention) | Not given: a completed job has no `urls` and no `expires_at`. Pending (see Download). |
| Model ids and prices of the table that are wrong | `elevenlabs/scribe-v1` gone (now `scribe-v2`, 0.0037 USD per minute); Seedream 4.5 0.04 USD per image, not 0.05; video prices as in Catalog, "prices". All corrected in `src/models.ts`. |
| Reference size limits found | Not tested (a large upload costs money for little). Pending. |
| Image output format | Seedream 4.5 returns JPEG (see M5). |
