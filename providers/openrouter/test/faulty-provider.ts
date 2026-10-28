// A deliberately broken build of the OpenRouter plugin, for proving that the conformance suite notices
// when the plugin's idempotency records are missing. Never ship this.
// Usage: node faulty-provider.mjs --fault=no-idempotency-records
//
// | fault                  | defect                                                          | checks  |
// |------------------------|-----------------------------------------------------------------|---------|
// | no-idempotency-records | the idempotency records are deleted after every submission, so  | B2, B6  |
// |                        | a replay with the same key creates a new job (and a new charge) |         |
//
// It serves the real plugin with its own handshake, so the SDK stays free of switches that weaken it.
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { announcePort, createProviderHandler, onStdinClosed, readHandshakeToken } from "@cuelor/provider-sdk";
import { buildProvider } from "../src/provider.ts";

export const FAULTS = ["no-idempotency-records"] as const;

async function main(): Promise<void> {
  const fault = process.argv.find((a) => a.startsWith("--fault="))?.slice("--fault=".length);
  if (!(FAULTS as readonly string[]).includes(fault ?? "")) {
    process.stderr.write(`usage: faulty-provider.mjs --fault=<${FAULTS.join("|")}>\n`);
    process.exit(2);
  }
  const dataDir = process.env.CUELOR_PROVIDER_DATA_DIR;
  if (!dataDir) throw new Error("CUELOR_PROVIDER_DATA_DIR is not set");
  const token = await readHandshakeToken(process.stdin);
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const { handler, runtime } = createProviderHandler(buildProvider(), { dataDir, token, allowedHosts: [`127.0.0.1:${port}`] });
  runtime.port = port;
  server.on("request", (req, res) => {
    if (req.method === "POST" && req.url === "/v1/jobs") {
      // The SDK has written the key record by the time it answers; remove all of them.
      res.on("finish", () => void fs.rm(path.join(dataDir, "idempotency"), { recursive: true, force: true }));
    }
    handler(req, res);
  });
  announcePort(port);
  onStdinClosed(() => process.exit(0));
}

main().catch((err: unknown) => {
  process.stderr.write(`faulty provider failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
