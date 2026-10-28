import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { ProviderError } from "./errors.ts";

/**
 * Compares two strings in constant time. Both sides are hashed first, so the comparison takes the same
 * time whatever their lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export interface RequestGuardOptions {
  /** The bearer token clients must send. */
  token: string;
  /** Accepted `Host` header values, compared case-insensitively. For a local plugin: `127.0.0.1:<port>`. */
  allowedHosts: string[];
  /**
   * `Origin` values accepted on pages outside `/v1/`, compared case-insensitively. Default:
   * `http://<host>` for each allowed host, the plugin's own origin.
   */
  pageOrigins?: string[];
}

/** Checks one request's headers; throws a `ProviderError` when the request must be rejected. */
export interface RequestGuard {
  /** For `/v1/`: `Host`, no `Origin` at all, and the bearer token. */
  (headers: IncomingHttpHeaders): void;
  /**
   * For pages outside `/v1/`, such as the setup page (plugins.md section 2): `Host`, and an `Origin`
   * only when it is the service's own (`pageOrigins`). No bearer token: a browser opening the page
   * cannot send it.
   */
  page(headers: IncomingHttpHeaders): void;
}

/**
 * Returns the checks for incoming requests. Rejections:
 *
 * - a `Host` that is not allowed: 403 `forbidden`, reason `host_not_allowed` (blocks DNS rebinding);
 * - an `Origin` header (under `/v1/` any, on pages any but the service's own): 403 `forbidden`, reason
 *   `origin_not_allowed` (blocks web pages);
 * - under `/v1/`, a missing or wrong bearer token: 401 `unauthorized`.
 *
 * The token never appears in an error message.
 */
export function createRequestGuard(options: RequestGuardOptions): RequestGuard {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const origins = new Set((options.pageOrigins ?? options.allowedHosts.map((h) => `http://${h}`)).map((o) => o.toLowerCase()));
  const expected = options.token;
  const checkHost = (headers: IncomingHttpHeaders) => {
    const host = (headers.host ?? "").toLowerCase();
    if (!allowed.has(host)) {
      throw new ProviderError(403, "forbidden", "the Host header is not accepted", { reason: "host_not_allowed" });
    }
  };
  const rejectOrigin = (message: string) => {
    throw new ProviderError(403, "forbidden", message, { reason: "origin_not_allowed" });
  };
  const guard = (headers: IncomingHttpHeaders) => {
    if (headers.origin !== undefined) rejectOrigin("requests with an Origin header are not accepted");
    checkHost(headers);
    const authorization = headers.authorization ?? "";
    const match = /^Bearer[ ]+(\S+)\s*$/i.exec(authorization);
    if (!match || !constantTimeEqual(match[1]!, expected)) {
      throw new ProviderError(401, "unauthorized", "missing or invalid Authorization header", {
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }
  };
  guard.page = (headers: IncomingHttpHeaders) => {
    checkHost(headers);
    if (headers.origin !== undefined && !origins.has(headers.origin.toLowerCase())) rejectOrigin("only the service's own Origin is accepted");
  };
  return guard;
}
