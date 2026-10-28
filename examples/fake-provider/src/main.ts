// Entry point of the fake provider plugin: run by the host as `node provider.mjs`.
import { runProvider } from "@cuelor/provider-sdk";
import { buildProvider } from "./provider.ts";

runProvider(buildProvider()).catch((err: unknown) => {
  process.stderr.write(`fake provider failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
