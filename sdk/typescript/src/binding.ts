import { createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.ts";

const SALT_FILE = "binding-salt";

/**
 * Computes `account.binding` (v1.md section 3.2): HMAC-SHA256 of the upstream secret (key, or account
 * id) with a random salt that is created on first use and kept in the data directory. The result is 64
 * lowercase hexadecimal digits, changes when the secret changes, and does not reveal the secret.
 *
 * The binding MUST change when the account changes, and when the key changes unless the plugin still
 * finds its jobs and idempotency records under the new key: while the binding stays the same, the
 * client goes on querying its jobs and replays unknown submissions with the same `Idempotency-Key`.
 * The SDK keeps jobs and idempotency records in the data directory, scoped by the binding and not by
 * the key, so passing the account id (when the upstream gives one) meets that, and rotating a key of
 * the same account does not pause the client's jobs. Do so only when a new key of the account can
 * still reach the upstream jobs; otherwise pass the key.
 */
export async function computeBinding(secret: string, options: { dataDir: string }): Promise<string> {
  const salt = await loadSalt(options.dataDir);
  return createHmac("sha256", salt).update(secret, "utf8").digest("hex");
}

async function loadSalt(dataDir: string): Promise<Buffer> {
  const file = path.join(dataDir, SALT_FILE);
  try {
    const hex = (await fs.readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const salt = randomBytes(32);
  await writeFileAtomic(file, salt.toString("hex") + "\n");
  // Another process may have won the race; use whatever is on disk now.
  const hex = (await fs.readFile(file, "utf8")).trim();
  return Buffer.from(hex, "hex");
}
