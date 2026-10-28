import { promises as fs } from "node:fs";
import type { Readable, Writable } from "node:stream";

/** The line a plugin prints once it listens (plugins.md section 2). */
export function listeningLine(port: number): string {
  return `cuelor-provider-listening port=${port}\n`;
}

/** Prints the listening line on stdout. */
export function announcePort(port: number, stdout: Writable = process.stdout): void {
  stdout.write(listeningLine(port));
}

/** At least 32 ASCII letters and digits. */
export function isValidHandshakeToken(token: string): boolean {
  return /^[A-Za-z0-9]{32,}$/.test(token);
}

/**
 * Reads the first line of stdin: the token the host hands over. Resolves with the token, rejects when
 * stdin ends first, the line is not a valid token, or the timeout passes. stdin is paused afterwards, so
 * its end is kept until `onStdinClosed` reads on.
 */
export function readHandshakeToken(stdin: Readable = process.stdin, options: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    let buffered = "";
    const cleanup = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        if (buffered.length > 4096) {
          cleanup();
          reject(new Error("handshake token line is too long"));
        }
        return;
      }
      cleanup();
      const token = buffered.slice(0, newline).replace(/\r$/, "");
      if (!isValidHandshakeToken(token)) {
        reject(new Error("handshake token must be at least 32 ASCII letters and digits"));
        return;
      }
      resolve(token);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("stdin closed before the handshake token arrived"));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the handshake token on stdin"));
    }, timeoutMs);
    timer.unref?.();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    stdin.resume();
  });
}

/**
 * Calls `onClose` when stdin ends (the host closed it, exited or crashed). A plugin MUST exit then.
 * Keeps reading stdin so that the end is noticed; when stdin has already ended, calls `onClose` at once
 * (on the next tick).
 */
export function onStdinClosed(onClose: () => void, stdin: Readable = process.stdin): void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onClose();
  };
  if (stdin.readableEnded || stdin.destroyed) {
    process.nextTick(fire);
    return;
  }
  stdin.on("end", fire);
  stdin.on("close", fire);
  stdin.on("error", fire);
  stdin.on("data", () => {});
  stdin.resume();
}

/** How the plugin listens: started by a host (command form) or as a self-hosted service. */
export type ListenMode =
  | { kind: "command" }
  | { kind: "standalone"; host: string; port: number; tokenFile: string; allowedHosts: string[] };

/**
 * Reads the listen mode from the environment. Without `CUELOR_PROVIDER_LISTEN` the plugin uses the
 * command form (stdin handshake). With it, the plugin is a self-hosted service:
 *
 * - `CUELOR_PROVIDER_LISTEN=host:port` (for example `127.0.0.1:8787` or `0.0.0.0:8787`)
 * - `CUELOR_PROVIDER_TOKEN_FILE=path`: a file whose first line is the bearer token
 * - `CUELOR_PROVIDER_ALLOWED_HOSTS=a.example.com,b.example.com:8443` (optional): accepted `Host` values;
 *   defaults to the listen address.
 */
export function listenModeFromEnv(env: NodeJS.ProcessEnv = process.env): ListenMode {
  const listen = env.CUELOR_PROVIDER_LISTEN;
  if (!listen) return { kind: "command" };
  const match = /^(.*):(\d{1,5})$/.exec(listen);
  if (!match) throw new Error("CUELOR_PROVIDER_LISTEN must be host:port");
  const host = match[1]!.replace(/^\[(.*)\]$/, "$1");
  const port = Number(match[2]);
  const tokenFile = env.CUELOR_PROVIDER_TOKEN_FILE;
  if (!tokenFile) throw new Error("CUELOR_PROVIDER_TOKEN_FILE is required with CUELOR_PROVIDER_LISTEN");
  const allowedHosts = (env.CUELOR_PROVIDER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return { kind: "standalone", host, port, tokenFile, allowedHosts };
}

/** Reads a token file for the standalone mode. */
export async function readTokenFile(file: string): Promise<string> {
  const token = (await fs.readFile(file, "utf8")).split(/\r?\n/)[0]?.trim() ?? "";
  if (token.length < 16) throw new Error("the token in CUELOR_PROVIDER_TOKEN_FILE must be at least 16 characters");
  return token;
}
