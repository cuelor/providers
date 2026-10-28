/** The faults the faulty fixture can inject; see faulty-provider.ts. */
export const FAULTS = [
  "no-auth",
  "short-binding",
  "ignore-stdin",
  "unchecked-references",
  "wrong-sha256",
  "unknown-job-500",
  "new-job-same-key",
  "no-conflict",
  "garbled-transcript",
  "catalog-shapes",
] as const;

export type Fault = (typeof FAULTS)[number];
