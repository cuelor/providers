// `provider.mjs login`: reads an OpenRouter key from stdin, checks it and writes it to the keychain. The
// key is never accepted as a command-line argument, where `ps` could see it (plugins.md section 5).

import type { Readable, Writable } from "node:stream";
import { keychainService } from "@cuelor/provider-sdk";
import type { Credentials } from "./account.ts";
import { PROVIDER_ID } from "./config.ts";
import { checkKey } from "./setup.ts";

export interface LoginOptions {
  args: string[];
  stdin: Readable & { isTTY?: boolean };
  stderr: Writable;
  credentials: Credentials;
  baseUrl: string;
  fetch?: typeof fetch;
}

/** Returns the exit status. */
export async function runLogin(o: LoginOptions): Promise<number> {
  if (o.args.length > 0) {
    o.stderr.write("login takes no arguments: the key is read from stdin, for example\n  pbpaste | node provider.mjs login\n");
    return 2;
  }
  if (o.stdin.isTTY) o.stderr.write("Paste the OpenRouter API key and press Return:\n");
  const key = await readFirstLine(o.stdin);
  const problem = await checkKey(key, { baseUrl: o.baseUrl, fetch: o.fetch });
  if (problem) {
    o.stderr.write(`${problem}\n`);
    return 1;
  }
  try {
    await o.credentials.save(key);
  } catch (err) {
    o.stderr.write(`could not save the key: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  o.stderr.write(`Saved the key in the keychain (service ${keychainService(PROVIDER_ID)}).\n`);
  return 0;
}

async function readFirstLine(stdin: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stdin) {
    text += chunk.toString();
    const nl = text.indexOf("\n");
    if (nl >= 0) {
      text = text.slice(0, nl);
      break;
    }
    if (text.length > 4096) break;
  }
  return text.replace(/\r$/, "").trim();
}
