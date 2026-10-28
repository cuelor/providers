# Running the OpenRouter plugin against the real OpenRouter

Everything in this repository's checks runs against a mock of OpenRouter. This page is for the
maintainer who runs the plugin once against the real service, with a real key and real (small) costs,
and records the results in [`VALIDATION.md`](VALIDATION.md), section "Live results". Agents that work on
this repository do not run it and never handle the key.

Budget: the run below creates a few images, one 4-second 480p video, and transcribes two short
samples. The suite estimates it at about 0.50 USD before it submits anything and refuses to start above
`--max-cost`. Use `--max-cost 2`. On 2026-10-28 the run, with the manual checks 4a, 4b and 4d, cost
about 0.6 USD in all. The manual checks cost a few cents each, a video about 0.17 USD.

## 1. Account and key

1. Create an OpenRouter account and add a small balance (5 USD is plenty; OpenRouter charges a fee on
   top-ups).
2. Create a key at <https://openrouter.ai/settings/keys> with a **credit limit** of, say, 3 USD, and a
   name such as "cuelor live test". Revoke it when you are done.
3. Keep the key out of shell history and command lines. In the terminal you run the suite from:

   ```sh
   printf 'OpenRouter key: '; stty -echo; read -r CUELOR_PROVIDER_TEST_KEY; stty echo; echo
   export CUELOR_PROVIDER_TEST_KEY
   ```

   The plugin takes the key from `CUELOR_PROVIDER_TEST_KEY` before the keychain. The suite passes it on
   with `--env CUELOR_PROVIDER_TEST_KEY`, which names the variable; the value is never on a command line.

## 2. Build

From the repository root, with Go and Node 24 (ffprobe on `PATH` is optional; with it B5 also decodes
the outputs):

```sh
npm ci
npm run build -w sdk/typescript
npm run build -w providers/openrouter
go -C conformance build -o ../dist/bin/cuelor-provider-test ./cmd/cuelor-provider-test
```

Make sure `OPENROUTER_BASE_URL` is **not** set: without it the plugin talks to `https://openrouter.ai`.

## 3. Tiers A, B and C

```sh
dist/bin/cuelor-provider-test \
  --manifest providers/openrouter/dist/cuelor-provider.json \
  --env CUELOR_PROVIDER_TEST_KEY \
  --live --max-cost 2 --output json > openrouter-live.json
```

Synchronous image calls can take minutes; if B-checks time out, add `--job-timeout 15m`. Expected: every
check passes except B9 (skipped, the plugin declares no cancel). Things worth reading in the report:

- B6, B7: the crash checks, run with the image model. B7 kills the plugin while the synchronous image
  call runs, so the job ends `failed`, `submission_unknown`, reason `interrupted` (VALIDATION.md, M4);
  OpenRouter may still charge that image.
- B10: usage against the estimate. A warning means the price table in `src/models.ts` is off; note
  the model and the real price.
- C1: character error rate of the two samples.

Instead of a local run you can use the **Live conformance** workflow (`.github/workflows/live.yml`): put
the key in the `live` environment as `LIVE_OPENROUTER`, and start it with plugin `providers/openrouter`,
max cost `2` and key secret `LIVE_OPENROUTER`.

## 4. Manual checks

These answer questions the suite cannot. They call OpenRouter directly with `curl` and `jq`. The header
with the key goes through stdin (`-H @-`), so it is not on the command line:

```sh
auth() { printf 'Authorization: Bearer %s\n' "$CUELOR_PROVIDER_TEST_KEY"; }
```

Write down each answer in `VALIDATION.md`, "Live results".

### 4a. Do models understand "image 2"? (`@imageN`)

The plugin turns `@image2` into the words "image 2" and sends references in order. Make two clearly
different references, for example a red square `red.png` and a blue circle `blue.png`, then:

```sh
jq -n --arg a "data:image/png;base64,$(base64 < red.png | tr -d '\n')" \
      --arg b "data:image/png;base64,$(base64 < blue.png | tr -d '\n')" \
  '{model: "bytedance-seed/seedream-4.5", n: 1, resolution: "2K",
    prompt: "Draw only the object from image 2, large, on a white background. Ignore image 1.",
    input_references: [{type: "image_url", image_url: {url: $a}}, {type: "image_url", image_url: {url: $b}}]}' \
  > body.json
auth | curl -sS -H @- -H 'Content-Type: application/json' --data @body.json \
  https://openrouter.ai/api/v1/images > out.json
jq -r '.data[0].b64_json' out.json | base64 -d > result.png; jq '.usage, (.data | length)' out.json
```

Swap the order of the two references and repeat. Record whether the result follows "image 2" both
times, once, or never. Repeat once with `google/gemini-2.5-flash-image`. For video, the same question with
`bytedance/seedance-2.0-fast` and two image references is worth one run (about 0.40 USD; poll as in 4d).

### 4b. Several outputs

`out.json` from 4a: `.data | length` should be 1, since the plugin always sends `n: 1`. If any request
returned more than one, note the model: the plugin keeps the first and warns `outputs_dropped`.

### 4c. Moderation

Do not send content that breaks OpenRouter's or a model's terms. Note the shape of any moderation error
you see during normal use (status, `error.code`, `error.metadata`), particularly from `/api/v1/images`,
whose moderation errors are not documented. If the account's activity page lists a filtered request,
record what it shows.

### 4d. Video retention and the error inside HTTP 200

```sh
jq -n '{model: "bytedance/seedance-2.0-fast", prompt: "a slow pan over a quiet lake", duration: 4, resolution: "480p", generate_audio: false}' > v.json
auth | curl -sS -H @- -H 'Content-Type: application/json' --data @v.json https://openrouter.ai/api/v1/videos | tee v-job.json
id=$(jq -r .id v-job.json)
auth | curl -sS -H @- "https://openrouter.ai/api/v1/videos/$id" | jq '{status, expires_at, error, usage, n: (.unsigned_urls | length)}'
```

Repeat the last line until it is `completed`, and record `usage.cost` against the plugin's estimate. On
2026-10-28 the answer had no `urls` and no `expires_at`, so retention cannot be read from it. Keep the
`id`, and after a day and after a week check whether the content is still there (status 200 or 404):

```sh
auth | curl -sS -H @- -o /dev/null -w '%{http_code}\n' "https://openrouter.ai/api/v1/videos/$id/content?index=0"
```

If signed `urls` do appear, do not paste them anywhere: they work without a key.

### 4e. Sign in with OpenRouter (OAuth) and the binding

This checks that OpenRouter accepts a callback on `127.0.0.1` (VALIDATION.md, "callback host") and
whether a pasted key and an OAuth key of the same account can get the same binding. It creates one more
key in your account and stores it in your login keychain, as the app would.

In a **new** terminal, without `CUELOR_PROVIDER_TEST_KEY`:

```sh
cd providers/openrouter/dist
token=$(openssl rand -hex 24); data=$(mktemp -d); echo "token: $token  data: $data"
{ echo "$token"; cat; } | CUELOR_PROVIDER_DATA_DIR="$data" node provider.mjs
```

It prints `cuelor-provider-listening port=N`. In another terminal (the token is a throwaway for this run):

```sh
curl -sS -X POST -H "Authorization: Bearer <token>" http://127.0.0.1:<N>/v1/setup
```

Open the `url` from the answer, choose **Sign in with OpenRouter**, and approve. Record:

- whether OpenRouter came back to `http://127.0.0.1:<N>/…/callback` and the page says "connected", or
  refused the callback URL (then try once whether it accepts `localhost` instead, by editing the
  `callback_url` in the address bar of the authorization page to `localhost`; the plugin will answer 403
  to it, which is the finding);
- then, in the terminal with your test key: `auth | curl -sS -H @- https://openrouter.ai/api/v1/key | jq .data.creator_user_id`,
  and compare with the `user_id` in `<data>/account.json` (the `data` directory printed above). Equal
  means pasted keys could share the OAuth binding.

Stop the plugin with Ctrl-C. Afterwards, remove the key the plugin stored and revoke it in OpenRouter:

```sh
security delete-generic-password -s cuelor-provider:cuelor.openrouter -a api_key
```

### 4f. Models and prices

Check every model in `src/models.ts` against OpenRouter's lists (`/api/v1/images/models`,
`/api/v1/videos/models`, `/api/v1/models?output_modalities=transcription`) and its pricing pages: the
id, the price, the number of image references (does `/images/models` give it in `supported_parameters`,
and under which name?) and, for transcription, whether `verbose_json` with word timestamps works
(`openai/whisper-1`, `elevenlabs/scribe-v2`; `openai/gpt-4o-mini-transcribe` should refuse it).

## 5. Afterwards

- Revoke the test key (and the OAuth key from 4e) at <https://openrouter.ai/settings/keys>.
- `unset CUELOR_PROVIDER_TEST_KEY`, delete `body.json`, `out.json`, `v-job.json` and the images.
- Fill in "Live results" in `VALIDATION.md` and attach `openrouter-live.json` to the pull request. The
  report holds no key, but check it before you share it.
