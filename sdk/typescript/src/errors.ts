import type { ErrorObject } from "./types.ts";

/** Maximum length of an error message on the wire (v1.md section 3.8). */
export const MAX_MESSAGE_LENGTH = 300;

export interface ProviderErrorOptions {
  reason?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * An error with an HTTP status and the standard error body. Throw it from upstream adapters and
 * handlers; the server turns it into `{"error": {code, message, reason?, params?}}`.
 */
export class ProviderError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | undefined;
  readonly params: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.reason = options.reason;
    this.params = options.params;
    this.headers = options.headers;
  }

  toBody(secrets: readonly string[] = []): { error: ErrorObject } {
    return errorBody(this.code, this.message, { reason: this.reason, params: this.params, secrets });
  }
}

/**
 * Thrown by an upstream adapter's `submit` when the upstream certainly did not accept the job but a
 * retry may succeed (for example a connection refused before the request was sent, or an explicit
 * "not accepted, try later"). The server forgets the submission and answers 503, so the client's replay
 * submits again. Any other error leaves the submission "unknown" and is never resubmitted.
 */
export class NotSubmittedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "NotSubmittedError";
    this.status = options.status ?? 503;
    this.code = options.code ?? "upstream_unavailable";
  }
}

// Strings that look like credentials or that carry signed URLs. Patterns are assembled from parts so
// this file never contains a key-shaped literal.
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  new RegExp("\\b(?:s" + "k|r" + "k|p" + "k)[-_][A-Za-z0-9_-]{8,}", "g"),
  new RegExp("\\bA" + "KIA[0-9A-Z]{16}\\b", "g"),
  new RegExp("\\bgh[pousr]_[A-Za-z0-9]{20,}", "g"),
  new RegExp("\\bgithub_" + "pat_[A-Za-z0-9_]{20,}", "g"),
  new RegExp("\\bnpm_[A-Za-z0-9]{20,}", "g"),
  new RegExp("\\bxox[baprs]-[A-Za-z0-9-]{10,}", "g"),
  new RegExp("\\bAI" + "za[0-9A-Za-z_-]{30,}", "g"),
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/**
 * Makes a message safe to send: removes the given secrets and anything that looks like a credential,
 * drops query strings and fragments of URLs (they often carry signatures), removes control characters,
 * and truncates to 300 characters.
 */
export function sanitizeMessage(message: string, secrets: readonly string[] = []): string {
  let out = String(message);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(/\b(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1");
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (out.length > MAX_MESSAGE_LENGTH) out = out.slice(0, MAX_MESSAGE_LENGTH - 1) + "…";
  return out;
}

/** Builds the standard error body with a sanitized message. */
export function errorBody(
  code: string,
  message: string,
  options: { reason?: string | undefined; params?: Record<string, unknown> | undefined; secrets?: readonly string[] } = {},
): { error: ErrorObject } {
  const error: ErrorObject = { code, message: sanitizeMessage(message, options.secrets) };
  if (options.reason) error.reason = options.reason;
  if (options.params) error.params = options.params;
  return { error };
}

/** An `ErrorObject` for a job, with a sanitized message. */
export function jobError(
  code: string,
  message: string,
  options: { reason?: string | undefined; params?: Record<string, unknown> | undefined; secrets?: readonly string[] } = {},
): ErrorObject {
  return errorBody(code, message, options).error;
}

export function invalidRequest(reason: string, message: string, params?: Record<string, unknown>): ProviderError {
  return new ProviderError(400, "invalid_request", message, { reason, params });
}
