# Local provider plugins

A local plugin is a provider ([`v1.md`](v1.md)) that the Cuelor app starts as a command on the user's
machine. This document is the part of the contract that only applies to plugins: how the host starts and
stops them, the manifest, what a plugin must do to survive crashes, and where it keeps upstream keys.

The [TypeScript SDK](../sdk/typescript/) implements all of it.

## 1. Forms

| | Local command | URL (self-hosted) |
|---|---|---|
| Who runs it | The host, using the manifest's command | The user (for example in Docker, on their own server) |
| Address | `127.0.0.1`, random port | The URL the user enters. MUST be HTTPS, except `127.0.0.1` |
| Client → service token | A random token the host generates each time it starts the plugin | The token the user enters; the host stores it and never shows it again |
| Third-party key | Kept by the plugin (section 5) | Kept by the service, usually in an environment variable |

## 2. Handshake

1. The host starts the plugin **in a new process group**. The working directory is the plugin's install
   directory. **The environment is built from scratch**; nothing is inherited from the host. It contains
   only `PATH=/usr/bin:/bin`, `HOME`, `TMPDIR`, `LANG`, `CUELOR_PROVIDER_DATA_DIR` (the plugin's own data
   directory) and `CUELOR_PROVIDER_PROTOCOL=1`, plus whatever the host's Node runtime needs for a `node`
   plugin.
2. The host writes **one line with a random token** (at least 32 ASCII letters and digits) to the
   plugin's stdin and keeps stdin open. The token never appears on the command line or in the environment,
   so `ps` cannot see it.
3. The plugin binds `127.0.0.1:0` only and prints one line to stdout:
   `cuelor-provider-listening port=N`. If the line does not arrive within 15 seconds the host ends the
   plugin and records the start as failed.
4. The host reads `GET /v1/provider`. The protocol major version, `provider.id` and `provider.version`
   MUST match the manifest; otherwise the host ends the plugin and records it as incompatible.
5. For every request the plugin MUST check that `Host` is exactly `127.0.0.1:<port>`. Under `/v1/` it
   MUST also check the bearer token (constant-time comparison) and reject requests that carry an `Origin`
   header. Rejections are 4xx responses with the standard error body (the SDK answers 403 `forbidden`
   with reason `host_not_allowed` or `origin_not_allowed`). This stops web pages from reaching the plugin
   through DNS rebinding.

   **The setup page is the exception** (section 5). The browser opens it, so it cannot send the bearer
   token, and the forms on it send an `Origin`. Under `/setup/<random>`, the page and everything it uses
   (for example an OAuth callback):
   - need no bearer token: the random part, valid once and for 10 minutes, is the secret;
   - MUST check `Host` as above;
   - MUST accept an `Origin` only when it is the plugin's own, `http://127.0.0.1:<port>`; a request
     without `Origin` is accepted.

   Under `/v1/` every `Origin` is still rejected, the plugin's own too.
6. **When stdin closes, the plugin MUST exit**, within 5 seconds, leaving no child processes. When the
   app exits or crashes (including `kill -9`) stdin closes by itself, so the plugin never becomes an
   orphan. To stop a plugin the host closes stdin, sends SIGTERM to the process group after 5 seconds and
   SIGKILL after another 5.
7. Anything else the plugin writes to stdout, and everything on stderr, goes to the plugin's log. The log
   never appears in any API response. The plugin MUST NOT write keys or tokens to it.

## 3. Manifest: `cuelor-provider.json`

Schema: [`manifest.json`](schemas/manifest.json).

```json
{
  "manifest_version": 1,
  "id": "example.images",
  "name": "Example Images",
  "version": "0.3.1",
  "description": "Images, video and transcription through one Example key.",
  "publisher": "example",
  "repository": "https://example.com/example-images",
  "license": "Apache-2.0",
  "protocol": "1.0",
  "capabilities": ["image", "video", "transcription"],
  "runtime": { "kind": "node", "entry": "provider.mjs" },
  "network": ["api.example.com"],
  "setup": { "login_command": ["login"], "docs": "https://example.com/example-images#setup" },
  "test": {
    "image": { "model": "example/image-1", "route": "text2image", "parameters": { "prompt": "a red square" } }
  }
}
```

| Field | Meaning |
|---|---|
| `manifest_version` | `1` |
| `id` | `<publisher>.<name>`: lowercase letters, digits and `-`. The `cuelor.` prefix is reserved for plugins Cuelor maintains; the official service's id is `cuelor` (no dot). One id has one instance in the app |
| `version` | The plugin's own semantic version |
| `repository`, `license` | Source and license, shown to the user when adding the plugin |
| `protocol` | The protocol version implemented |
| `capabilities` | `image`, `video`, `transcription`. Only for display and the index; `GET /v1/provider` is authoritative |
| `runtime` | `{"kind": "node", "entry": "…"}`: one JavaScript file run by the Node that ships with the app (recommended); `{"kind": "exec", "command": ["/absolute/path", "args…"]}`: any executable |
| `network` | The hosts the plugin connects to, shown to the user when adding it. **A declaration only; v1 does not enforce it** |
| `setup` | How the user sets the upstream key: `login_command` is the plugin's own login subcommand (for agents and terminals), `docs` a link |
| `test` | The cheapest model and parameters for conformance tiers B and C, keyed by capability (`image`, `video`, `transcription`) |

A self-hosted service has no manifest file: the user only enters a URL and a token, and the client reads
the same information from `GET /v1/provider`.

When the user confirms a plugin, the host pins the SHA-256 of the entry file (`node`) or the executable
(`exec`). A plugin whose file changed is not started until the user confirms it again.

**Recommended form.** TypeScript bundled into one dependency-free `.mjs` file (for example with esbuild),
run by the app's Node. Installing it is downloading one file and checking its SHA-256: no `npm install`,
no install scripts, no runtime for the user to install. Other languages use the `exec` form, such as a
single static binary.

## 4. Recovery

The client's side of recovery is unchanged by plugins: jobs with a remote id are queried again; jobs whose
submission result is unknown are replayed with the same body and key; a changed binding pauses the job.
The plugin's side:

1. **Persist idempotency records** in the data directory (`CUELOR_PROVIDER_DATA_DIR`), in storage that
   commits atomically (SQLite, or files written with fsync and rename): the key, a hash of the request
   body, the job id, the upstream job id, the state, and timestamps.
2. **Record before calling.** Write "submitting" before calling the upstream, and the upstream id as soon
   as it is known ([`v1.md`](v1.md) section 3.5.2).
3. **A record with "submitting" and no upstream id**: look the job up at the upstream when it supports
   searching by a client-supplied field; when it cannot be found, end the job `failed` with
   `submission_unknown` and never submit it again.
4. **No polling after a restart.** Wait until the client asks, then query the upstream and update the
   record.
5. **Store results.** When an upstream job ends, download the result into the data directory, named by
   SHA-256, and serve it as the job's output artifact. The upstream may keep results for a short time
   only, and the plugin does not run while the app is closed.
6. **Clean up**: output artifacts may be deleted 7 days after their job ended; idempotency records are
   kept for at least 30 days. A job that ended at least 30 days ago may be deleted together with its
   idempotency record, under the lock that replays of its key take, so that a replay finds both or
   neither. A job that has not ended is kept.
7. **One data directory, one instance.** The records are only safe when one process uses them. A plugin
   SHOULD refuse to start while another running instance uses its data directory. This matters most when
   the same program runs as a self-hosted service, where nothing else stops a second copy. The SDK takes
   a lock file, `instance.lock`, and refuses to start while another running instance holds it.

## 5. Upstream keys

- **Local plugins: the macOS keychain.** Only the macOS desktop app runs plugins in the command form
  today. A plugin on another platform keeps the key in that platform's secure storage; a self-hosted
  service uses environment variables (below). Use the service name `cuelor-provider:<id>`. A plugin
  provides its own way to log in and writes the key to the keychain:
  - For agents and terminals: `setup.login_command`, for example `provider-example login`. The key comes
    from stdin or an OAuth callback and MUST NOT appear in command-line arguments (`ps` can see them).
  - For the app's UI: the optional `POST /v1/setup` (`capabilities.setup`) returns `{url, expires_at}`
    (schema: [`setup.json`](schemas/setup.json)): a one-time local page,
    `http://127.0.0.1:<port>/setup/<random>`, valid for 10 minutes and for one use, and when it stops
    working. Section 2 says how the page is protected. The app opens it in the system browser. The page can offer an
    upstream login (OAuth PKCE with the callback on the plugin's own port) or a field to paste the key.
    **The key never passes through the app.**
  - The keychain protects against plain-text files, backups and accidental commits. It does **not**
    protect against other programs of the same user: an item written with the `security` command can be
    read back with it.
- **Self-hosted services: environment variables**, managed by whoever deploys them (for example Docker
  secrets).
- **Not recommended**: plain-text configuration in the plugin directory or under `~/.config`.

## 6. Trust

A local plugin runs as the user and can read what the user can read. Its trust level equals a
command-line tool the user installed. What the host controls: a plugin runs only after the user confirmed
it in the app; it is the file that was confirmed (pinned SHA-256); it never gets the app's token or
environment; and everything it returns is checked (lengths and SHA-256 of outputs, file types from
headers, messages truncated and shown as plain text). Usage reported by a plugin is shown as "reported by
the plugin" and never used for billing.

**The plugin index.** `registry/index.json` lists known plugins as `{index_version: 1, providers: [...]}`
(schema: [`registry-index.json`](schemas/registry-index.json)). Each entry has the manifest's identity
and where to download a release and check it (`manifest_url`, `asset_url`, `sha256`). Being listed means
the format and conformance tier A were checked; it is not a guarantee of the plugin's behaviour.

## 7. Testing a plugin

```sh
cuelor-provider-test --command "node dist/provider.mjs"                    # tier A, free
cuelor-provider-test --command "node dist/provider.mjs" --live --max-cost 0.50   # tiers B and C
```

See [`../conformance/README.md`](../conformance/README.md).
