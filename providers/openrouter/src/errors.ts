// Maps OpenRouter's errors to the protocol (v1.md sections 3.5.2, 3.8 and 3.10).

import { NotSubmittedError, ProviderError, type ErrorObject } from "@cuelor/provider-sdk";
import { UpstreamHttpError, UpstreamNetworkError } from "./client.ts";

// Words of a free-text failure that mean content moderation (v1.md section 3.10: such a classification
// is inferred and says so).
const MODERATION_WORDS = /content[ _-]?polic|moderat|safety|nsfw|unsafe|inappropriate|prohibited|policy violation|flagged|sexual|violen/i;
const MODERATION_CODES = new Set(["content_policy_violation", "refusal", "moderation", "content_filter"]);

export interface Moderation {
  stage: "input" | "output";
  source: "upstream";
  category?: string;
  inferred?: true;
}

/** Whether a free-text failure message reads like moderation. */
export function looksModerated(message: string): boolean {
  return MODERATION_WORDS.test(message);
}

/**
 * The moderation signal of an error, when it is one. OpenRouter's typed signals (a 403 whose code is
 * `content_policy_violation` or `refusal`, or whose metadata has `reasons` or `flagged_input`) are
 * taken as they are; a message that only reads like moderation is marked `inferred`.
 */
export function moderationOf(err: UpstreamHttpError): Moderation | undefined {
  const status = err.effectiveStatus;
  const code = typeof err.code === "string" ? err.code : typeof err.metadata?.error_type === "string" ? (err.metadata.error_type as string) : undefined;
  const reasons = err.metadata?.reasons;
  const typed = (code !== undefined && MODERATION_CODES.has(code)) || Array.isArray(reasons) || err.metadata?.flagged_input !== undefined;
  if (typed && (status === 403 || status === 400 || status === 422)) {
    const m: Moderation = { stage: "input", source: "upstream" };
    const category = Array.isArray(reasons) && typeof reasons[0] === "string" ? reasons[0] : code;
    if (category) m.category = category.slice(0, 64);
    return m;
  }
  // Words alone only where moderation is plausible (403, 422): a plain 400 about an "unsafe" parameter
  // is an invalid request, not a rejection.
  if ((status === 403 || status === 422) && looksModerated(err.message)) return { stage: "input", source: "upstream", inferred: true };
  return undefined;
}

/** A 402 from the in-flight budget: temporary, retried after `Retry-After`, unlike an empty balance. */
export function isInFlightBudget(err: UpstreamHttpError): boolean {
  return err.effectiveStatus === 402 && (err.metadata?.limit_source === "openrouter_in_flight_budget" || err.retryAfter !== undefined);
}

/**
 * A temporary refusal: the upstream did not take the request and a retry later may work. Never an error
 * inside HTTP 200, whatever its code: the request was taken and may already be running.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof UpstreamNetworkError) return err.notSent;
  return err instanceof UpstreamHttpError && !err.inBody && (err.effectiveStatus === 429 || isInFlightBudget(err));
}

/** The message for an error inside HTTP 200, whose result is unknown. */
function inBodyMessage(err: UpstreamHttpError): string {
  return `OpenRouter answered HTTP 200 with an error (code ${String(err.code)}: ${err.message}); it may have run and been charged`;
}

// Gateway errors of a call OpenRouter had taken: the generation behind it may go on, and be charged.
const GATEWAY: Record<number, string> = { 408: "gateway_timeout", 504: "gateway_timeout", 524: "gateway_timeout", 502: "gateway_error" };

function forbiddenReason(message: string): string | undefined {
  if (/region|countr|jurisdiction|not available in your/i.test(message)) return "region_restricted";
  if (/suspend|banned|disabled account/i.test(message)) return "account_suspended";
  return undefined;
}

/**
 * The answer to a submission that OpenRouter answered at once (the video endpoint). 4xx only when
 * nothing was created upstream; a timeout or a 5xx leaves the result unknown (a plain error).
 */
export function submissionError(err: unknown, onInvalidKey: () => void): Error {
  if (err instanceof UpstreamNetworkError) {
    return err.notSent ? new NotSubmittedError("could not reach OpenRouter; retry later") : new Error(err.message);
  }
  if (!(err instanceof UpstreamHttpError)) return err instanceof Error ? err : new Error(String(err));
  // Taken, then an error: unknown, never 4xx (the client would drop the key and submit again).
  if (err.inBody) return new Error(inBodyMessage(err));
  const status = err.effectiveStatus;
  const params = { upstream_status: status };
  const retryHeaders = err.retryAfter !== undefined ? { "Retry-After": String(err.retryAfter) } : undefined;
  const moderation = moderationOf(err);
  if (moderation) return new ProviderError(422, "content_moderated", err.message, { params: { ...moderation } });
  if (status === 401) {
    onInvalidKey();
    return new ProviderError(403, "provider_not_ready", "OpenRouter rejected the key; set it again");
  }
  if (isInFlightBudget(err)) {
    return new ProviderError(429, "rate_limited", "the OpenRouter key's in-flight budget is used up; retry later", { reason: "in_flight_budget", params, headers: retryHeaders });
  }
  if (status === 402) return new ProviderError(402, "insufficient_credits", err.message, { params });
  if (status === 403) return new ProviderError(403, "forbidden", err.message, { reason: forbiddenReason(err.message), params });
  if (status === 429) return new ProviderError(429, "rate_limited", "OpenRouter is rate limiting this key; retry later", { params, headers: retryHeaders });
  if (status === 404) return new ProviderError(400, "invalid_request", err.message, { reason: "model_unavailable", params });
  if (status === 400 || status === 413 || status === 422) return new ProviderError(400, "invalid_request", err.message, { reason: "upstream_rejected", params });
  // 5xx, 408 and anything else: the upstream may have taken the job.
  return new Error(`OpenRouter answered HTTP ${status}: ${err.message}`);
}

export interface JobFailure {
  status: "failed" | "rejected";
  error: ErrorObject;
}

/**
 * The end of a job whose upstream call ran in the background (images, transcription): the client
 * already has the job, so every failure becomes a job state.
 */
export function backgroundFailure(err: unknown, onInvalidKey: () => void): JobFailure {
  const failed = (code: string, message: string, reason?: string, params?: Record<string, unknown>): JobFailure => ({
    status: "failed",
    error: { code, message, ...(reason ? { reason } : {}), ...(params ? { params } : {}) },
  });
  if (err instanceof UpstreamNetworkError) {
    // Not sent: nothing was charged and a new submission is safe. Sent: the upstream may have run it.
    return err.notSent
      ? failed("upstream_failed", "could not reach OpenRouter", "not_submitted")
      : failed("submission_unknown", "the connection to OpenRouter broke during the call; it may have run and been charged");
  }
  if (!(err instanceof UpstreamHttpError)) return failed("upstream_failed", err instanceof Error ? err.message : String(err));
  if (err.inBody) return failed("submission_unknown", inBodyMessage(err), "error_in_body", { upstream_code: err.code ?? null });
  const status = err.effectiveStatus;
  const params = { upstream_status: status };
  const gateway = GATEWAY[status];
  if (gateway) return failed("submission_unknown", `OpenRouter's gateway answered HTTP ${status} (${err.message}); the generation may go on and be charged`, gateway, params);
  const moderation = moderationOf(err);
  if (moderation) return { status: "rejected", error: { code: "content_moderated", message: err.message, params: { ...moderation } } };
  if (status === 401) {
    onInvalidKey();
    return failed("upstream_failed", "OpenRouter rejected the key", "not_submitted", params);
  }
  if (status === 429 || isInFlightBudget(err)) return failed("upstream_failed", "OpenRouter did not take the job (rate limit or in-flight budget)", "not_submitted", params);
  if (status === 402) return failed("insufficient_credits", err.message, undefined, params);
  if (status === 403) return failed("forbidden", err.message, forbiddenReason(err.message), params);
  if (status === 400 || status === 404 || status === 413 || status === 422) return failed("invalid_input", err.message, undefined, params);
  return failed("upstream_failed", err.message, undefined, params);
}
