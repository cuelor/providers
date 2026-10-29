# Cuelor Providers

The open part of Cuelor's provider protocol: everything you need to connect an image, video or
speech-recognition service to the [Cuelor](https://cuelor.com) desktop app.

> **Status:** the specification is at v1.0.1 (`spec-v1.0.1`). The conformance suite is released:
> `go install github.com/cuelor/providers/conformance/cmd/cuelor-provider-test@latest`. The SDK and the
> plugins are not released yet.

A provider is a small HTTP service that speaks **Cuelor Provider API v1**: it describes itself and its
models, takes uploaded inputs, runs jobs idempotently and hands back the results. It runs either as a
**local plugin** that the app starts on the user's machine, with the user's own upstream key, or as a
**self-hosted service** at a URL.

| Path | Contents |
|---|---|
| [`spec/`](spec/) | Cuelor Provider API v1: the specification, `openapi.yaml`, JSON Schemas (the source of truth for the public contract), examples, changelog |
| [`conformance/`](conformance/) | The conformance suite (Go module `github.com/cuelor/providers/conformance`) and the `cuelor-provider-test` command |
| [`sdk/typescript/`](sdk/typescript/) | `@cuelor/provider-sdk`: handshake, auth, idempotency and artifact storage, reference parsing, transcript validation |
| [`examples/fake-provider/`](examples/fake-provider/) | A complete plugin against a fake upstream, for learning and CI |
| [`providers/`](providers/) | Reference plugins: [`openrouter`](providers/openrouter/) |
| [`skills/write-provider/`](skills/write-provider/) | An agent skill for writing a provider plugin |
| [`registry/index.json`](registry/index.json) | The index of known provider plugins |

## Quick start

```sh
npm ci && npm run build                      # the SDK and the example plugin
go run ./conformance/cmd/cuelor-provider-test --manifest examples/fake-provider/dist/cuelor-provider.json
go run ./conformance/cmd/cuelor-provider-test --manifest examples/fake-provider/dist/cuelor-provider.json \
  --live --max-cost 0                       # tiers B and C too; the fake upstream costs nothing
```

To write your own plugin, start from [`examples/fake-provider`](examples/fake-provider/) or give an agent
[`skills/write-provider/SKILL.md`](skills/write-provider/SKILL.md).

## Releases

Each part is versioned and tagged separately: `spec-vX.Y.Z`, `conformance/vX.Y.Z` (Go sub-module),
`sdk-vX.Y.Z`, and `<plugin>-vX.Y.Z` for plugins. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Feedback

Please open an issue. This repository receives one exported commit per release, so pull requests cannot
be merged here yet: describe the change in an issue and a maintainer will bring it in (see
[CONTRIBUTING.md](CONTRIBUTING.md)).

## License

[Apache-2.0](LICENSE), except the two speech recordings in `conformance/samples/`, which are public-domain
LibriVox excerpts (see the README there).
