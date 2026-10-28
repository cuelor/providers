// Where the plugin connects to, and where its key comes from.

export const PROVIDER_ID = "cuelor.openrouter";
export const PROVIDER_NAME = "OpenRouter";
export const PROVIDER_VERSION = "0.1.0";

/** The only upstream the plugin talks to unless a test overrides it. */
export const DEFAULT_BASE_URL = "https://openrouter.ai";

/**
 * The upstream origin. `OPENROUTER_BASE_URL` overrides it for tests against a mock: only
 * `http://127.0.0.1:<port>` or an `https://` origin is accepted, so a stray value cannot send the key to
 * a plain-HTTP host. The host never sets it (the app starts plugins with an empty environment).
 */
export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.OPENROUTER_BASE_URL;
  if (value === undefined || value === "") return DEFAULT_BASE_URL;
  return checkBaseUrl(value);
}

export function checkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPENROUTER_BASE_URL is not a URL");
  }
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";
  if (!loopback && url.protocol !== "https:") throw new Error("OPENROUTER_BASE_URL must be http://127.0.0.1:<port> or https://…");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("OPENROUTER_BASE_URL must be an origin, without a path, query or credentials");
  }
  return url.origin;
}

/**
 * The development and test key (CONTRIBUTING.md): the conformance suite passes it by name with
 * `--env CUELOR_PROVIDER_TEST_KEY`. Users' keys come from the keychain.
 */
export function testKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.CUELOR_PROVIDER_TEST_KEY?.trim();
  return key ? key : undefined;
}
