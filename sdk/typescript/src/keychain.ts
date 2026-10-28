import { spawn } from "node:child_process";

/**
 * Stores upstream keys in the macOS keychain with the `security` tool (plugins.md section 5). Commands
 * go to `security -i` on stdin, so the secret never appears in a process's arguments.
 *
 * The keychain keeps keys out of plain-text files, backups and commits. It does not protect against
 * other programs of the same user: an item written with `security` can be read back with it.
 */

export interface KeychainOptions {
  /** A keychain file instead of the default (login) keychain. Used by tests. */
  keychain?: string;
  /** Runs `security` with the given stdin and returns its result. Injectable for tests. */
  run?: SecurityRunner;
}

export type SecurityRunner = (args: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The service name of a plugin's keychain items: `cuelor-provider:<id>`. */
export function keychainService(providerId: string): string {
  return `cuelor-provider:${providerId}`;
}

/** Quotes an argument for the `security -i` command line. */
export function quoteSecurityArg(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("keychain values cannot contain line breaks or NUL");
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const defaultRunner: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });

function command(parts: string[], options: KeychainOptions): string {
  const line = parts.join(" ") + (options.keychain ? " " + quoteSecurityArg(options.keychain) : "");
  return line + "\n";
}

/** Adds or replaces a generic password. */
export async function keychainSet(service: string, account: string, secret: string, options: KeychainOptions = {}): Promise<void> {
  const run = options.run ?? defaultRunner;
  const line = command(
    ["add-generic-password", "-U", "-s", quoteSecurityArg(service), "-a", quoteSecurityArg(account), "-w", quoteSecurityArg(secret)],
    options,
  );
  const result = await run(["-i"], line);
  if (result.code !== 0 || /error|failed/i.test(result.stderr)) {
    throw new Error(`could not write the keychain item (security exited with ${result.code})`);
  }
}

/** Reads a generic password; `undefined` when there is none. */
export async function keychainGet(service: string, account: string, options: KeychainOptions = {}): Promise<string | undefined> {
  const run = options.run ?? defaultRunner;
  const line = command(["find-generic-password", "-s", quoteSecurityArg(service), "-a", quoteSecurityArg(account), "-w"], options);
  const result = await run(["-i"], line);
  if (result.code !== 0 || /could not be found|error/i.test(result.stderr)) return undefined;
  const value = result.stdout.replace(/\r?\n$/, "");
  return value.length > 0 ? value : undefined;
}

/** Deletes a generic password. Returns whether one existed. */
export async function keychainDelete(service: string, account: string, options: KeychainOptions = {}): Promise<boolean> {
  const run = options.run ?? defaultRunner;
  const line = command(["delete-generic-password", "-s", quoteSecurityArg(service), "-a", quoteSecurityArg(account)], options);
  const result = await run(["-i"], line);
  return result.code === 0 && !/could not be found|error/i.test(result.stderr);
}
