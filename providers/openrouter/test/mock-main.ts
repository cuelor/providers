// Runs the mock OpenRouter as a process, for conformance runs against it (scripts/check-plugins.sh and
// scripts/check-mock.sh). Usage: node mock-upstream.mjs --write-env FILE
//
// It writes the environment a plugin needs to use it to FILE, one NAME=VALUE per line, once it listens:
// OPENROUTER_BASE_URL and a random CUELOR_PROVIDER_TEST_KEY that only this mock accepts. It runs until
// it gets SIGTERM or SIGINT.
import { writeFileSync, renameSync } from "node:fs";
import { MockOpenRouter } from "./mock-openrouter.ts";

const i = process.argv.indexOf("--write-env");
const file = i > 0 ? process.argv[i + 1] : undefined;
if (!file) {
  process.stderr.write("usage: mock-upstream.mjs --write-env FILE\n");
  process.exit(2);
}
const mock = new MockOpenRouter();
const url = await mock.start();
writeFileSync(file + ".tmp", `OPENROUTER_BASE_URL=${url}\nCUELOR_PROVIDER_TEST_KEY=${mock.testKey}\n`, { mode: 0o600 });
renameSync(file + ".tmp", file);
process.stderr.write(`mock OpenRouter listening on ${url}\n`);
const stop = () => void mock.close().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
