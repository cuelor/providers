# Changelog: Cuelor Provider API

All notable changes to the specification and its schemas. Versions follow the protocol: within v1 only
backward-compatible additions are allowed (`v1.md` section 3.11).

## [1.0.1] - 2026-10-29

Clarification of section 3.3; the meaning of the existing text does not change.

- `enum_values`, when a parameter lists it, MUST NOT be empty, for any kind; with no values to list, the
  field is omitted. The text did not say what an empty list means. By the existing rules such a catalog
  was already not valid: "a value is then one of them" and "`default` MUST be inside `enum_values`" cannot
  hold for an empty list. `schemas/catalog.json` now has `minItems: 1`, and conformance check A5 reports
  an empty list with the parameter's name. An empty list is not the same as an omitted field.
- `protocol.version` stays `1.0`.

## [1.0.0] - 2026-10-28

First public version. The open questions of the draft were decided with the maintainers of the Cuelor
app and are written into `v1.md` and the schemas (listed below). From this version on, `v1.md` is
the normative text of the protocol and `schemas/` the source of truth for its shapes.

- Endpoints: `GET /v1/provider`, `GET /v1/models`, `POST /v1/artifacts`, `GET /v1/artifacts/{id}`,
  `GET /v1/artifacts/{id}/content`, `POST /v1/jobs`, `GET /v1/jobs/{id}`, `POST /v1/jobs/{id}/cancel`
  (optional), `POST /v1/estimates` (optional), `POST /v1/setup` (optional).
- Provider description with capabilities, account status and binding, billing unit. `provider.id` has
  no syntax of its own; a plugin's must equal its manifest `id`.
- Catalog of models, routes, slots and parameters, with optional `max_bytes`, `max_duration_ms`,
  `max_length`, route output and pricing hints.
- Content-addressed artifacts with SHA-256, metadata and at least 7 days' retention for outputs.
- Jobs with `Idempotency-Key` (same key and body: same job; same key, different body: 409), a closed set
  of eight states, one output per job (`outputs` may be `null` or empty until it succeeds), usage,
  warnings, approval and cancellation.
- Prompt references `@image<N>`, `@video<N>`, `@audio<N>` over ordered inputs.
- Transcription route `audio2text` and the transcript format `application/vnd.cuelor.transcript+json`
  (`schema_version` 1) with `language`, `language_probability` and a required `unit`.
- Error body `{error: {code, message, reason?, params?}}` and the table of codes.
- Estimates, usage and moderation rules.
- Local plugins: handshake, manifest `cuelor-provider.json` (`manifest_version` 1), recovery rules.
- JSON Schemas (draft 2020-12) for all of the above and for `registry/index.json` (`index_version` 1).

### Decided with the maintainers of the Cuelor app

Written into the text as they were applied in the draft:

- Job states: `running -> pending_approval` and `pending_approval -> cancelled` are allowed; a client
  may see any transition along a path of the diagram (3.5.3).
- A plugin rejects a wrong `Host` or an `Origin` header with a 4xx and the standard error body
  (plugins.md section 2).
- Uploads are limited by the largest `max_bytes` of the catalog when every slot declares one; otherwise
  they have no declared limit (3.4).
- `account.binding` is present in every account status; without a credential it is derived from an
  empty one (3.2).
- `output.modality` of a transcription model is `text` (3.3).
- `step` alignment: values and the default are `min + k * step` (from 0 without `min`); `max` need not be
  aligned (3.3).
- `POST /v1/setup` returns `{url, expires_at}` (3.2, plugins.md section 5).
- `approval` is `{policy, deadline}` while `pending_approval`, otherwise `null` or absent (3.5.3).
- The plugin index `registry/index.json` is `{index_version: 1, providers: [...]}` (plugins.md
  section 6).
- Conformance: A6's valid submission runs only with `--live` and within the cost limit; over the cost
  limit, or without an estimate, nothing is submitted, the run fails and B and C are reported as failed
  with `not_run: true`; checks may have the status `warning`, which does not fail a run; A6's
  out-of-range reference is `@image<n + 1>` (section 5).
- One output per job: when the upstream returns several, the service keeps the first (3.5.3).
- A job rejected without a reason is `content_moderated` with `params.inferred = true`; an unavailable
  model is 400 `invalid_request` with reason `model_unavailable` (3.5.1, 3.5.3).
- An omitted parameter means its `default`, which the service applies (3.3).
- A missing boolean capability means `false`; a missing `generation` means none (3.2).

Changed from the draft:

- `expired` means only that the approval expired; the draft's error code for an expired output is
  removed. An output that expired answers 410 `artifact_expired`; the client records that on its own
  side, and the job's state does not change (3.4, 3.5.3, 3.8).
- An unknown model in a submission or an estimate is 400 `invalid_request` with reason
  `unknown_model`; 404 is only for the resource in the path, a job or an artifact (3.8).
- `widget` is a string; `visible_when` is `{name, equals}`; each `parameter_rules` item is
  `{when_name, when_values, reject_name, reject_values, message}`. All are optional and, when present,
  must have these shapes; conformance check A5 checks them (3.3).
- `transcript.unit` is required (3.7.2).
- Services SHOULD keep uploaded inputs for 30 days. A submission or an estimate that refers to an
  artifact the service does not have is 400 `invalid_request` with reason `artifact_not_found` and
  `params.artifact_id`; the client uploads again and submits again (3.4, 3.5.1, 3.8).
- Every 4xx and 5xx that the service itself produces MUST have the standard error body; for errors from
  a proxy or gateway without it, the client acts on the class of the HTTP status (3.8).

Added by this repository as a clarification (not part of those decisions):

- While the account is not `ready`, the 403 `provider_not_ready` applies to new work. A replay of a
  known key and a query of a known job are answered from storage. The rule of 3.5.2 (4xx only when
  certain that no job was created) takes precedence over the 403: when the service cannot derive the
  `binding`, a submission gets 503 `upstream_unavailable` with reason `binding_unavailable` (3.2).
- A submission whose upstream call ends without an upstream job after the service answered 5xx keeps
  its job and key, because a replay may already have returned the job: the job ends `failed` with
  `upstream_failed` and reason `not_submitted`, or with the meaning of the upstream's 4xx (422
  `content_moderated` becomes `rejected`; 402 `insufficient_credits`; 403 keeps its code and reason;
  other 4xx `invalid_input`), with the original status, code and reason in `params` (3.5.2, 3.5.3).
- The setup page under `/setup/<random>` needs no bearer token, checks `Host`, and accepts only the
  plugin's own `Origin` or none; under `/v1/` every `Origin` is still rejected (plugins.md section 2).
- A job that ended at least 30 days ago may be deleted together with its key; a job that has not ended
  is kept. One data directory serves one running instance (plugins.md section 4).
- Only the macOS desktop app runs plugins in the command form; other platforms use their own secure
  storage, self-hosted services environment variables (plugins.md section 5).
- Requirements that the conformance suite cannot check are marked; the section numbers follow the
  design (there are no sections 2 and 4); `webhook` stays optional and unused by the Cuelor app (3.2).

### Decided after the reference plugin ran against OpenRouter

Validating v1 with the OpenRouter plugin (`providers/openrouter/VALIDATION.md`) found text that did not
fit a real upstream. Decided with the maintainers of the Cuelor app before 1.0.0:

- `account.binding` MUST change when the account changes, and when the key changes **unless** the
  service still finds the jobs and idempotency records it created under the old key: while the binding
  stays the same, the client keeps querying its jobs and replays unknown submissions with the same
  `Idempotency-Key`. A binding derived from the account id is allowed on that condition (3.2).
- `image2video` takes one image as the **first frame**, slot role `first_frame` (it was `reference`).
  A video guided by reference images is `multimodal2video` with only `reference` images (3.3).
- `timestamps` defaults to the catalog parameter's `default`, and to `word` only when the catalog gives
  none (3.7.1).
- `submission_unknown` means that it is unknown whether the upstream ran the job and charged for it,
  and that its result is not available. Agreed reason `interrupted`: a synchronous upstream call was cut
  off while it ran (3.5.2, 3.5.3).
- Black replacement images: a service MUST detect them when it knows its upstream does this, and
  otherwise SHOULD detect them in the formats it can decode (3.10).
- Clients MUST accept moderation `stage` values they do not know; later versions may add values such
  as `unknown` (3.10, 3.11).
- `number` and `integer` parameters MAY list their allowed values in `enum_values` (for example
  `duration` with `[4, 6, 8]`), and clients MUST support this; `step` MAY be fractional, and alignment
  is compared with a tolerance. Conformance check A5 checks numeric `enum_values` and fractional steps
  (3.3).

Also added before 1.0.0:

- Downloads (`GET /v1/artifacts/{id}/content`) MAY redirect with 302 or 307 to an address that needs no
  bearer token and SHOULD expire soon. Clients follow at most 5 redirects, never send `Authorization` to
  another origin, never follow `https` to `http`, and MAY refuse loopback or private addresses unless
  the service is on one. The download rules apply to the final response. No other endpoint redirects.
  The conformance suite follows redirects on downloads only, under these rules (3.4, 3.8).
