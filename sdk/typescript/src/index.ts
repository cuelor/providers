// @cuelor/provider-sdk: build Cuelor Provider API v1 plugins and services.

export * from "./types.ts";
export { ProviderError, NotSubmittedError, sanitizeMessage, errorBody, jobError, invalidRequest, MAX_MESSAGE_LENGTH } from "./errors.ts";
export type { ProviderErrorOptions } from "./errors.ts";
export { canonicalJson, sameJson, sha256Hex, jsonHash } from "./canonical-json.ts";
export { writeFileAtomic, writeJsonAtomic, readJsonFile } from "./atomic-file.ts";
export {
  listeningLine,
  announcePort,
  isValidHandshakeToken,
  readHandshakeToken,
  onStdinClosed,
  listenModeFromEnv,
  readTokenFile,
} from "./handshake.ts";
export type { ListenMode } from "./handshake.ts";
export { constantTimeEqual, createRequestGuard } from "./auth.ts";
export type { RequestGuard, RequestGuardOptions } from "./auth.ts";
export { MIME_ALIASES, isValidMediaType, normalizeMediaType, topLevelType, sniffMediaType } from "./media.ts";
export { ArtifactStore, MIN_OUTPUT_RETENTION_MS, hashFile } from "./artifacts.ts";
export type { ArtifactRecord, ArtifactStoreOptions } from "./artifacts.ts";
export { IdempotencyStore, MIN_KEY_RETENTION_MS, isValidIdempotencyKey, requireIdempotencyKey } from "./idempotency.ts";
export type { IdempotencyRecord, IdempotencyState, BeginResult } from "./idempotency.ts";
export { parseUpload } from "./multipart.ts";
export type { UploadedFile, ParseUploadOptions } from "./multipart.ts";
export {
  parsePromptReferences,
  numberInputs,
  countInputsByKind,
  checkPromptReferences,
  replacePromptReferences,
} from "./references.ts";
export type { PromptReference, ReferenceKind, NumberedInput } from "./references.ts";
export { validateCatalog, validateJobRequest, parameterValueProblem, largestMaxBytes } from "./catalog.ts";
export type { CatalogProblem, ValidatedRequest } from "./catalog.ts";
export { validateTranscript, normalizeTimedUnits, normalizeTranscript, TRANSCRIPT_END_TOLERANCE_MS } from "./transcript.ts";
export type { TranscriptProblem } from "./transcript.ts";
export { pngMetadata, parseWav, probeMetadata, probeFileMetadata } from "./probe.ts";
export type { WavInfo } from "./probe.ts";
export { computeBinding } from "./binding.ts";
export { keychainService, keychainSet, keychainGet, keychainDelete, quoteSecurityArg } from "./keychain.ts";
export type { KeychainOptions, SecurityRunner } from "./keychain.ts";
export { ProviderRuntime, createProviderHandler, runProvider, MIN_JOB_RETENTION_MS } from "./server.ts";
export { acquireInstanceLock, InstanceLockedError, INSTANCE_LOCK_FILE } from "./instance-lock.ts";
export type { InstanceLock, InstanceLockOptions } from "./instance-lock.ts";
export type {
  ProviderDefinition,
  ProviderContext,
  UpstreamAdapter,
  UpstreamState,
  UpstreamOutput,
  SubmitContext,
  EstimateContext,
  PollContext,
  ResolvedInput,
  HandlerOptions,
  RunOptions,
  RunningProvider,
  ProviderRuntimeOptions,
} from "./server.ts";
