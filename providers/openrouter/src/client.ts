// The HTTP client for OpenRouter. Every request goes to one origin, the configured base URL: a URL from
// a response (for example a polling or download URL) is never followed to another host, so the key
// cannot leak there and tests against a mock never reach the network.

/** An error answer of OpenRouter: `{"error": {"code", "message", "metadata"}}`, also inside HTTP 200. */
export class UpstreamHttpError extends Error {
  readonly status: number;
  /** `error.code` of the body: usually the HTTP status, sometimes a string. */
  readonly code: number | string | undefined;
  readonly metadata: Record<string, unknown> | undefined;
  /** Seconds from `Retry-After`. */
  readonly retryAfter: number | undefined;
  /** The HTTP status was 2xx but the body carried an error. */
  readonly inBody: boolean;

  constructor(o: { status: number; code?: number | string; message: string; metadata?: Record<string, unknown>; retryAfter?: number; inBody?: boolean }) {
    super(o.message);
    this.name = "UpstreamHttpError";
    this.status = o.status;
    this.code = o.code;
    this.metadata = o.metadata;
    this.retryAfter = o.retryAfter;
    this.inBody = o.inBody ?? false;
  }

  /**
   * The status that classifies the error. An error inside HTTP 200 counts as 502 whatever its body's
   * code: OpenRouter took the request, so it says nothing certain about what was created or charged
   * (errors.ts treats it as an unknown result).
   */
  get effectiveStatus(): number {
    return this.inBody ? 502 : this.status;
  }
}

/** A download larger than the caller allows; nothing more is read. */
export class DownloadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`the download is larger than ${maxBytes} bytes`);
    this.maxBytes = maxBytes;
    this.name = "DownloadTooLargeError";
  }
}

/** The request did not get an HTTP answer. */
export class UpstreamNetworkError extends Error {
  /** True when the request certainly never reached the upstream (no connection was made). */
  readonly notSent: boolean;

  constructor(message: string, notSent: boolean) {
    super(message);
    this.name = "UpstreamNetworkError";
    this.notSent = notSent;
  }
}

// Failures before a connection exists: the upstream cannot have seen the request.
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export interface ClientOptions {
  baseUrl: string;
  /** The API key, read for each request. */
  key: () => string | undefined;
  fetch?: typeof fetch;
  /** Per-request time limit. Default 60 s. */
  timeoutMs?: number;
}

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
  /** Send the key (default true). The model lists are public and are read without it. */
  auth?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class OpenRouterClient {
  readonly baseUrl: string;
  private readonly key: () => string | undefined;
  private readonly fetchImpl: () => typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = new URL(options.baseUrl).origin;
    this.key = options.key;
    // Looked up per call, so a test's guard on globalThis.fetch also covers clients made earlier.
    this.fetchImpl = () => options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** An absolute URL on the upstream's origin. Throws for anything that would leave it. */
  url(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new Error(`refusing to send a request outside ${this.baseUrl}`);
    return url;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = this.url(path);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.auth !== false) {
      const key = this.key();
      if (!key) throw new UpstreamHttpError({ status: 401, code: 401, message: "no OpenRouter key is set" });
      headers.Authorization = `Bearer ${key}`;
    }
    let body: string | FormData | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form;
    }
    const signals = [AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    try {
      return await this.fetchImpl()(url, { method, headers, body, signal: AbortSignal.any(signals), redirect: "error" });
    } catch (err) {
      const code = networkCode(err);
      throw new UpstreamNetworkError(`${method} ${url.pathname} failed: ${code ?? (err instanceof Error ? err.name : "error")}`, code !== undefined && NOT_SENT_CODES.has(code));
    }
  }

  /** A JSON answer. Non-2xx answers, and 2xx answers whose body is an error object, throw `UpstreamHttpError`. */
  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; body: T }> {
    const res = await this.request(method, path, options);
    const text = await res.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const envelope = errorEnvelope(body);
    if (!res.ok || envelope) {
      throw new UpstreamHttpError({
        status: res.status,
        code: envelope?.code,
        message: envelope?.message ?? `HTTP ${res.status}`,
        metadata: envelope?.metadata,
        retryAfter: retryAfterSeconds(res.headers.get("retry-after")),
        inBody: res.ok,
      });
    }
    if (body === undefined) throw new UpstreamHttpError({ status: 502, message: `${method} ${path}: the upstream answered with a body that is not JSON` });
    return { status: res.status, body: body as T };
  }

  /** A binary answer, for downloads. */
  /** A binary answer, at most `maxBytes` long (checked against Content-Length and while reading). */
  async bytes(path: string, options: RequestOptions & { maxBytes?: number } = {}): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
    const res = await this.request("GET", path, options);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let envelope: ReturnType<typeof errorEnvelope>;
      try {
        envelope = errorEnvelope(JSON.parse(text));
      } catch {
        envelope = undefined;
      }
      throw new UpstreamHttpError({ status: res.status, code: envelope?.code, message: envelope?.message ?? `HTTP ${res.status}`, metadata: envelope?.metadata });
    }
    const contentType = res.headers.get("content-type") ?? undefined;
    const max = options.maxBytes ?? Number.POSITIVE_INFINITY;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new DownloadTooLargeError(max);
    }
    if (!res.body) return { bytes: new Uint8Array(0), contentType };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > max) {
        await res.body.cancel().catch(() => undefined);
        throw new DownloadTooLargeError(max);
      }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), contentType };
  }
}

/** `{"error": {code, message, metadata}}`. A plain string `error` (a failed video job) is not one. */
function errorEnvelope(body: unknown): { code?: number | string; message: string; metadata?: Record<string, unknown> } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const e = (body as { error?: unknown }).error;
  if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
  const o = e as Record<string, unknown>;
  const message = typeof o.message === "string" ? o.message : "the upstream reported an error";
  const code = typeof o.code === "number" || typeof o.code === "string" ? o.code : undefined;
  const metadata = o.metadata && typeof o.metadata === "object" && !Array.isArray(o.metadata) ? (o.metadata as Record<string, unknown>) : undefined;
  return { code, message, metadata };
}

/** `Retry-After` in seconds: a number, or an HTTP date. */
export function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function networkCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
