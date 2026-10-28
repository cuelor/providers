import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

/** A temporary directory removed after the test file finishes. */
export function tempDir(prefix = "provider-sdk-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
