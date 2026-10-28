// A deliberately broken variant of the fake provider, for proving that the conformance checks fail.
// Never ship this. Usage: node faulty-provider.mjs --fault=<name>
//
// It runs the real provider on an internal port and puts a small proxy in front of it that injects one
// defect. The proxy does the handshake itself, so the SDK stays free of switches that weaken it.
//
// | fault                  | defect                                                     | check |
// |------------------------|------------------------------------------------------------|-------|
// | no-auth                | accepts requests without or with a wrong bearer token      | A2    |
// | short-binding          | account.binding is not 64 hexadecimal digits               | A1    |
// | ignore-stdin           | keeps running after stdin closes                           | A3    |
// | unchecked-references   | accepts references to inputs that do not exist             | A6    |
// | wrong-sha256           | the upload response carries a wrong sha256                 | A7    |
// | unknown-job-500        | answers 500 instead of 404 for an unknown job              | A8    |
// | new-job-same-key       | a replay with the same key and body creates a new job      | B2    |
// | no-conflict            | the same key with another body returns the old job, no 409 | B3    |
// | garbled-transcript     | the recogniser returns the wrong text                      | C1    |
// | catalog-shapes         | widget, visible_when and parameter_rules have wrong shapes | A5    |

import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  announcePort,
  createProviderHandler,
  createRequestGuard,
  jsonHash,
  onStdinClosed,
  ProviderError,
  readHandshakeToken,
  replacePromptReferences,
  TRANSCRIPT_MEDIA_TYPE,
  type ProviderDefinition,
} from "@cuelor/provider-sdk";
import { buildProvider } from "../src/provider.ts";
import { FAULTS, type Fault } from "./fault-names.ts";

function parseFault(argv: string[]): Fault {
  const arg = argv.find((a) => a.startsWith("--fault="));
  const name = arg?.slice("--fault=".length);
  if (!name || !(FAULTS as readonly string[]).includes(name)) {
    process.stderr.write(`usage: faulty-provider.mjs --fault=<${FAULTS.join("|")}>\n`);
    process.exit(2);
  }
  return name as Fault;
}

/** Faults that live in the provider definition rather than in the proxy. */
function faultyDefinition(fault: Fault): ProviderDefinition {
  const definition = buildProvider();
  if (fault === "short-binding") {
    const account = definition.account;
    definition.account = async (ctx) => ({ ...(await account(ctx)), binding: "abcd1234" });
  }
  if (fault === "catalog-shapes") {
    const catalog = definition.catalog.bind(definition);
    definition.catalog = async (ctx) => {
      const c = structuredClone(await catalog(ctx)) as unknown as { models: Record<string, unknown>[] };
      const model = c.models[0]!;
      const params = model.parameters as Record<string, unknown>[];
      params[0]!.widget = { type: "textarea" }; // not a string
      params[1]!.visible_when = { name: "prompt" }; // no equals
      model.parameter_rules = [{ when_name: "ratio", when_values: ["1:1"], reject_name: "seed", reject_values: ["0"] }]; // no message
      return c as never;
    };
  }
  if (fault === "garbled-transcript") {
    const poll = definition.upstream.poll.bind(definition.upstream);
    definition.upstream.poll = async (id, ctx) => {
      const state = await poll(id, ctx);
      for (const output of state.outputs ?? []) {
        if (output.mediaType !== TRANSCRIPT_MEDIA_TYPE || typeof output.data === "function") continue;
        const t = JSON.parse(Buffer.from(output.data).toString("utf8"));
        const garble = (s: string) => s.replace(/[^\s]/gu, "x");
        t.text = garble(t.text);
        for (const seg of t.segments ?? []) {
          seg.text = garble(seg.text);
          for (const u of seg.timed_text_units ?? []) u.text = garble(u.text);
        }
        output.data = Buffer.from(JSON.stringify(t));
      }
      return state;
    };
  }
  return definition;
}

function sameBody(a: Buffer, b: Buffer): boolean {
  try {
    return jsonHash(JSON.parse(a.toString("utf8"))) === jsonHash(JSON.parse(b.toString("utf8")));
  } catch {
    return a.equals(b);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const fault = parseFault(process.argv.slice(2));
  const dataDir = process.env.CUELOR_PROVIDER_DATA_DIR;
  if (!dataDir) throw new Error("CUELOR_PROVIDER_DATA_DIR is not set");
  const token = await readHandshakeToken(process.stdin);

  // The real provider, on an internal port with its own token.
  const innerToken = randomBytes(24).toString("hex");
  let innerHost = "";
  const inner = http.createServer((req, res) => innerHandler(req, res));
  await new Promise<void>((r) => inner.listen(0, "127.0.0.1", () => r()));
  innerHost = `127.0.0.1:${(inner.address() as AddressInfo).port}`;
  const { handler: innerHandler } = createProviderHandler(faultyDefinition(fault), {
    dataDir,
    token: innerToken,
    allowedHosts: [innerHost],
  });

  const firstBody = new Map<string, Buffer>();
  const front = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const guard = createRequestGuard({ token, allowedHosts: [`127.0.0.1:${port}`] });
      try {
        guard(req.headers);
      } catch (err) {
        // no-auth: Host and Origin are still checked, the bearer token is not.
        if (!(fault === "no-auth" && err instanceof ProviderError && err.status === 401)) throw err;
      }
      const url = req.url ?? "/";
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: innerHost, authorization: `Bearer ${innerToken}` };
      let body: Buffer | undefined;
      const isJobSubmit = req.method === "POST" && (url === "/v1/jobs" || url === "/v1/estimates");
      if (isJobSubmit) {
        body = await readBody(req);
        const key = req.headers["idempotency-key"];
        if (fault === "unchecked-references") {
          try {
            const json = JSON.parse(body.toString("utf8"));
            if (typeof json?.parameters?.prompt === "string") {
              json.parameters.prompt = replacePromptReferences(json.parameters.prompt, () => "");
              body = Buffer.from(JSON.stringify(json));
            }
          } catch {
            // Leave invalid JSON to the provider.
          }
        }
        if ((fault === "new-job-same-key" || fault === "no-conflict") && typeof key === "string" && url === "/v1/jobs") {
          const first = firstBody.get(key);
          if (!first) firstBody.set(key, body);
          else if (sameBody(first, body)) {
            // new-job-same-key: a replay gets a fresh key, so the provider makes a new job.
            if (fault === "new-job-same-key") headers["idempotency-key"] = (key + "-" + randomBytes(4).toString("hex")).slice(-128);
          } else if (fault === "no-conflict") {
            // no-conflict: another body under the same key is swapped for the first one.
            body = first;
          }
        }
        headers["content-length"] = String(body.length);
      }
      const upstream = http.request({ host: "127.0.0.1", port: Number(innerHost.split(":")[1]), method: req.method, path: url, headers });
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        upstream.on("response", resolve);
        upstream.on("error", reject);
        if (body) upstream.end(body);
        else req.pipe(upstream);
      });
      const status = response.statusCode ?? 500;
      const rewriteUpload = fault === "wrong-sha256" && req.method === "POST" && url === "/v1/artifacts" && status < 300;
      if (fault === "unknown-job-500" && req.method === "GET" && url.startsWith("/v1/jobs/") && status === 404) {
        await readBody(response);
        return reply(500, { error: { code: "internal_error", message: "something went wrong" } });
      }
      if (rewriteUpload) {
        const json = JSON.parse((await readBody(response)).toString("utf8"));
        json.sha256 = (json.sha256[0] === "0" ? "1" : "0") + json.sha256.slice(1);
        return reply(status, json);
      }
      res.writeHead(status, response.headers);
      response.pipe(res);
    } catch (err) {
      if (err instanceof ProviderError) return reply(err.status, err.toBody([token]));
      reply(500, { error: { code: "internal_error", message: "proxy error" } });
    }
  });
  let port = 0;
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  port = (front.address() as AddressInfo).port;
  announcePort(port);
  if (fault !== "ignore-stdin") onStdinClosed(() => process.exit(0));
  else process.stdin.resume();
}

main().catch((err: unknown) => {
  process.stderr.write(`faulty provider failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
