// A minimal provider run by run-provider.test.ts as a child process.
import { runProvider } from "../../src/index.ts";

runProvider({
  id: "example.minimal",
  name: "Minimal",
  version: "0.0.1",
  capabilities: { generation: ["image"] },
  billingUnit: "USD",
  account: () => ({ status: "ready", binding: "c".repeat(64) }),
  catalog: () => ({ models: [] }),
  upstream: {
    submit: async () => ({ upstreamId: "never" }),
    poll: async () => ({ status: "failed" }),
  },
}).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
