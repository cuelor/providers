import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export const SAMPLES = new URL("../../../conformance/samples/", import.meta.url);

/** A temporary directory removed after the test file finishes. */
export function tempDir(prefix = "fake-provider-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
