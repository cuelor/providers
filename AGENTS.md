# cuelor-providers: rules for agents

This repository is published on GitHub as `cuelor/providers` and licensed Apache-2.0: each release is
exported there as one commit (CONTRIBUTING.md, "Publishing"). Everything committed here is published.

## Never commit

- **Source code of the Cuelor product** (the product repository), including its tests and its fake
  services. Write against the specification instead. The product depends on this repository, never the
  other way round.
- **Internal service names and addresses**: internal hostnames, Tailscale addresses, names of internal
  services. Use `example.com` and invented names in examples.
- **Secrets of any kind**: API keys, tokens, passwords, private keys, even revoked or fake-looking ones
  that match real key formats.
- Generated or downloaded artifacts: build output, `node_modules`, large media. Test audio must be
  small, made by us, and its license stated.

## Layout and versioning

See README.md. Tags: `spec-vX.Y.Z`, `conformance/vX.Y.Z`, `sdk-vX.Y.Z`, `<plugin>-vX.Y.Z`. They are made only
in the public repository, by the export; never create them here.
`spec/schemas/` is the source of truth for the public contract; the product copies it.

## Verification

`make ck-verify` must pass before delivery. When `CK_TEST_REPORT` is set it writes a JSON report there
(`{status, summary, checks:[{name, status, duration_ms}]}`). Keep it working when you add checks.

## Process

- `main` is the only long-lived branch; changes land through pull requests on the project's code host.
- Specification changes follow the protocol's compatibility rules: within v1, only additions.
- Write in English: specification, code, comments, commit messages.
- Agents never touch the public repository or a clone of it, never run the export, and never handle
  GitHub credentials. Exporting and pushing are a maintainer's job.
