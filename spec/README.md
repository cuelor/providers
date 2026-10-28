# Cuelor Provider API v1: specification

| File | Contents |
|---|---|
| [`v1.md`](v1.md) | The protocol: transport, provider description, catalog, artifacts, jobs, references, transcription, errors, estimates, moderation, extension rules |
| [`plugins.md`](plugins.md) | Local plugins: handshake, manifest, recovery, upstream keys |
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.1 description of the endpoints; it references the schemas below |
| [`schemas/`](schemas/) | JSON Schemas, draft 2020-12. **The source of truth for the public contract** |
| [`examples/`](examples/) | Example documents. Each validates against the schema named by its prefix; files in `examples/invalid/` must fail |
| [`CHANGELOG.md`](CHANGELOG.md) | Changes per version |

## Schemas

| Schema | Describes |
|---|---|
| `common.json` | Shared definitions: error object, warning, MIME type, SHA-256, binding, timestamp, `Idempotency-Key`, prompt reference, usage, media metadata |
| `provider-description.json` | `GET /v1/provider` |
| `catalog.json` | `GET /v1/models`: models, routes, slots, parameters, pricing |
| `artifact.json` | `POST /v1/artifacts` and `GET /v1/artifacts/{id}` |
| `job-request.json` | The body of `POST /v1/jobs` and `POST /v1/estimates` |
| `job.json` | The job object, with the closed set of states |
| `estimate.json` | `POST /v1/estimates` |
| `error.json` | The error body of every 4xx and 5xx response the service itself produces |
| `transcript.json` | `application/vnd.cuelor.transcript+json` |
| `setup.json` | `POST /v1/setup` |
| `manifest.json` | The plugin manifest `cuelor-provider.json` |
| `registry-index.json` | `registry/index.json` |

Each schema's `$id` is `https://cuelor.com/schemas/provider/v1/<file>`. References between schemas are
relative (`common.json#/$defs/error`), so they resolve the same way whether a tool loads the files from
disk or registers them by `$id`.

**Unknown fields are allowed.** Both sides of the protocol must ignore fields they do not know, so no
object sets `additionalProperties: false`. Closed sets that v1 will never extend are enums (job states,
`account.status`, transcript `unit`, `usage.basis`). Descriptive sets that may grow within v1 (routes,
roles, parameter kinds, error codes, moderation stages and categories) are plain strings with `examples`.

Rules that JSON Schema cannot express (transcript units ordered and not overlapping, `position` without
gaps, defaults inside ranges, and so on) are in the text and checked by the
[conformance suite](../conformance/) and the [SDK](../sdk/typescript/).

## Validating

```sh
make ck-verify          # includes the spec check
cd tools && go run ./speccheck -spec ../spec registry-index=../registry/index.json
```

## Versions

Tags `spec-vX.Y.Z`. Within v1 only additions are allowed (section 3.11 of `v1.md`); each minor version
has a changelog entry and its schemas. The protocol version a service reports is `<major>.<minor>`.
