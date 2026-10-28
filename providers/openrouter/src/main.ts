// Entry point: run by the host as `node provider.mjs`; `node provider.mjs login` sets the key.
import { runProvider } from "@cuelor/provider-sdk";
import { Credentials } from "./account.ts";
import { baseUrlFromEnv } from "./config.ts";
import { runLogin } from "./login.ts";
import { buildProvider } from "./provider.ts";

const [command, ...args] = process.argv.slice(2);

if (command === "login") {
  runLogin({ args, stdin: process.stdin, stderr: process.stderr, credentials: new Credentials(), baseUrl: baseUrlFromEnv() })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`login failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
} else if (command !== undefined) {
  process.stderr.write("usage: node provider.mjs          run the plugin (the host does this)\n       node provider.mjs login    read an OpenRouter key from stdin into the keychain\n");
  process.exit(2);
} else {
  runProvider(buildProvider()).catch((err: unknown) => {
    process.stderr.write(`OpenRouter provider failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
