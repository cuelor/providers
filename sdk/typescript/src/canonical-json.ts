import { createHash } from "node:crypto";

/**
 * Serialises a JSON value with object keys sorted and no whitespace, so two documents that are equal as
 * JSON values have the same text. Numbers use JavaScript's shortest round-trip form, so `1.0` and `1`
 * compare equal, as they do as JSON values.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number");
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}

/** Whether two JSON values are equal, ignoring key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of the canonical form of a JSON value. */
export function jsonHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
