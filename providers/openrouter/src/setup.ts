// The setup page (plugins.md section 5): a one-time local page, `/setup/<random>`, valid for 10 minutes
// and one completed setup. A completed setup closes every open page, so a page opened earlier cannot
// replace the key afterwards. It offers "Sign in with OpenRouter" (OAuth PKCE, the callback on the plugin's
// own port) and a field to paste a key. The key goes from OpenRouter or the browser straight to the
// keychain; it never passes through the app.
//
// The SDK checks Host and Origin before these requests arrive; there is no bearer token, so the random
// part of the path is the secret. Pages send `Referrer-Policy: no-referrer` so it does not leak to
// OpenRouter when the browser follows a link.

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderContext } from "@cuelor/provider-sdk";
import type { Credentials } from "./account.ts";
import { OpenRouterClient, UpstreamHttpError } from "./client.ts";

const LIFETIME_MS = 10 * 60_000;
const TOKEN = /^[0-9a-f]{48}$/;
const MAX_FORM_BYTES = 4096;

interface Session {
  token: string;
  expires: number;
  done: boolean;
  /** PKCE verifier and OAuth state, once the user chose to sign in. */
  verifier?: string;
  state?: string;
}

export interface SetupOptions {
  credentials: Credentials;
  /** The client used for the code exchange. */
  client: OpenRouterClient;
  /** OpenRouter's origin; the authorization page is `<baseUrl>/auth`. */
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class SetupPages {
  private readonly o: SetupOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;

  constructor(o: SetupOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /** `POST /v1/setup`: a new page. */
  create(port: number): { url: string; expires_at: string } {
    for (const [t, s] of this.sessions) if (s.expires <= this.now() || s.done) this.sessions.delete(t);
    const token = randomBytes(24).toString("hex");
    const expires = this.now() + LIFETIME_MS;
    this.sessions.set(token, { token, expires, done: false });
    return { url: `http://127.0.0.1:${port}/setup/${token}`, expires_at: new Date(expires).toISOString() };
  }

  /** Handles everything under `/setup/`. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ProviderContext): Promise<boolean> {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "setup") return false;
    const session = this.live(parts[1]);
    if (!session) {
      page(res, 404, "This setup link is not valid", "<p>The link has expired or was already used. Open the setup again from the Cuelor app.</p>");
      return true;
    }
    const action = parts[2] ?? "";
    const own = `http://${req.headers.host}`;
    const base = `/setup/${session.token}`;
    try {
      if (action === "" && req.method === "GET") {
        page(
          res,
          200,
          "Connect OpenRouter",
          `<p>Cuelor uses your own OpenRouter account. Generations are billed to your OpenRouter balance.</p>
<p><a class="button" href="${base}/oauth">Sign in with OpenRouter</a></p>
<form method="post" action="${base}/key"><p><label>Or paste an OpenRouter API key<br><input name="key" type="password" autocomplete="off" required size="60"></label></p><p><button type="submit">Save key</button></p></form>
<p class="note">The key is stored in the macOS keychain and never passes through the Cuelor app.</p>`,
        );
        return true;
      }
      if (action === "oauth" && req.method === "GET") {
        session.verifier = base64url(randomBytes(32));
        session.state = randomBytes(16).toString("hex");
        const auth = new URL("/auth", this.o.baseUrl);
        auth.searchParams.set("callback_url", `${own}${base}/callback`);
        auth.searchParams.set("code_challenge", base64url(createHash("sha256").update(session.verifier).digest()));
        auth.searchParams.set("code_challenge_method", "S256");
        auth.searchParams.set("state", session.state);
        res.writeHead(302, { Location: auth.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
        res.end();
        return true;
      }
      if (action === "callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        if (!code || !session.verifier || url.searchParams.get("state") !== session.state) {
          page(res, 400, "Sign-in did not complete", `<p>OpenRouter did not return a valid answer. <a href="${base}">Try again</a>.</p>`);
          return true;
        }
        const verifier = session.verifier;
        session.verifier = undefined; // A code is exchanged once.
        let answer: { key?: unknown; user_id?: unknown };
        try {
          answer = (await this.o.client.json<{ key?: unknown; user_id?: unknown }>("POST", "/api/v1/auth/keys", { auth: false, json: { code, code_verifier: verifier, code_challenge_method: "S256" } })).body;
        } catch (err) {
          ctx.log(`OAuth code exchange failed: ${err instanceof Error ? err.message : String(err)}`);
          page(res, 502, "Sign-in did not complete", `<p>OpenRouter did not issue a key. <a href="${base}">Try again</a>.</p>`);
          return true;
        }
        if (typeof answer.key !== "string" || answer.key === "") {
          page(res, 502, "Sign-in did not complete", `<p>OpenRouter did not issue a key. <a href="${base}">Try again</a>.</p>`);
          return true;
        }
        if (!this.claim(session)) {
          page(res, 409, "Already connected", "<p>Another setup page saved a key in the meantime; this one was not saved.</p>");
          return true;
        }
        await this.o.credentials.save(answer.key, { dataDir: ctx.dataDir, userId: typeof answer.user_id === "string" ? answer.user_id : null });
        page(res, 200, "OpenRouter is connected", "<p>You can close this page and return to Cuelor.</p>");
        return true;
      }
      if (action === "key" && req.method === "POST") {
        const key = (await readForm(req)).get("key")?.trim() ?? "";
        const problem = await checkKey(key, this.o);
        if (problem) {
          page(res, 400, "The key was not saved", `<p>${escapeHtml(problem)} <a href="${base}">Try again</a>.</p>`);
          return true;
        }
        if (!this.claim(session)) {
          page(res, 409, "Already connected", "<p>Another setup page saved a key in the meantime; this one was not saved.</p>");
          return true;
        }
        await this.o.credentials.save(key, { dataDir: ctx.dataDir });
        page(res, 200, "OpenRouter is connected", "<p>The key is saved. You can close this page and return to Cuelor.</p>");
        return true;
      }
      page(res, 404, "Not found", "<p>Unknown page.</p>");
      return true;
    } catch (err) {
      ctx.log(`setup page failed: ${err instanceof Error ? err.message : String(err)}`);
      page(res, 500, "Setup failed", "<p>The key could not be saved. Check the plugin's log.</p>");
      return true;
    }
  }

  /**
   * Takes the right to save a key: only while the session is still live (another page may have finished
   * during the key check or the code exchange). Every page closes at once, before the save, so two
   * pages can never both save.
   */
  private claim(session: Session): boolean {
    if (this.live(session.token) !== session) return false;
    session.done = true;
    this.sessions.clear();
    return true;
  }

  private live(token: string | undefined): Session | undefined {
    if (!token || !TOKEN.test(token)) return undefined;
    const s = this.sessions.get(token);
    if (!s || s.done || s.expires <= this.now()) return undefined;
    return s;
  }
}

/** Checks a key with `GET /api/v1/key`. Returns a problem for the user, or undefined. */
export async function checkKey(key: string, o: { baseUrl: string; fetch?: typeof fetch }): Promise<string | undefined> {
  if (key === "" || /[\s\0]/.test(key) || key.length > 512) return "That does not look like an API key.";
  const client = new OpenRouterClient({ baseUrl: o.baseUrl, key: () => key, fetch: o.fetch });
  try {
    await client.json("GET", "/api/v1/key", { timeoutMs: 15_000 });
    return undefined;
  } catch (err) {
    if (err instanceof UpstreamHttpError && err.effectiveStatus === 401) return "OpenRouter rejected this key.";
    return "Could not reach OpenRouter to check the key.";
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new Error("form too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function base64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#222}a.button,button{display:inline-block;padding:.5rem 1rem;border-radius:6px;border:1px solid #333;background:#333;color:#fff;text-decoration:none;font:inherit;cursor:pointer}input{font:inherit;padding:.4rem;width:100%;box-sizing:border-box}.note{color:#666;font-size:.9rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(html);
}
