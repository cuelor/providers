// The OpenRouter key: where it is kept, and the account the protocol reports for it (v1.md section 3.2,
// plugins.md section 5).

import path from "node:path";
import {
  computeBinding,
  keychainGet,
  keychainService,
  keychainSet,
  readJsonFile,
  writeJsonAtomic,
  type Account,
  type KeychainOptions,
} from "@cuelor/provider-sdk";
import { PROVIDER_ID, testKeyFromEnv } from "./config.ts";

/** The keychain item: service `cuelor-provider:cuelor.openrouter`, account `api_key`. */
export const KEYCHAIN_ACCOUNT = "api_key";

/** Kept in the data directory: the OpenRouter user a key was issued to by the OAuth login. */
const IDENTITY_FILE = "account.json";

interface Identity {
  /** `computeBinding("key-fingerprint\n" + key)`: says which key the user id belongs to, without the key. */
  key_fingerprint: string;
  user_id: string;
}

export interface CredentialOptions {
  keychain?: KeychainOptions;
  env?: NodeJS.ProcessEnv;
  /** Default `process.platform`. The keychain is used on macOS only. */
  platform?: string;
  log?: (message: string) => void;
}

export interface StoredKey {
  key: string;
  source: "env" | "keychain";
}

export class Credentials {
  private readonly options: CredentialOptions;
  /** The key last read, for redaction and for requests; never logged. */
  private last: string | undefined;
  /** Fingerprints of keys OpenRouter answered 401 for. */
  private readonly rejected = new Set<string>();

  constructor(options: CredentialOptions = {}) {
    this.options = options;
  }

  current(): string | undefined {
    return this.last;
  }

  /** The key: the test key from the environment (CONTRIBUTING.md), else the keychain item. */
  async read(): Promise<StoredKey | undefined> {
    const env = testKeyFromEnv(this.options.env ?? process.env);
    if (env) {
      this.last = env;
      return { key: env, source: "env" };
    }
    if ((this.options.platform ?? process.platform) !== "darwin") {
      this.last = undefined;
      return undefined;
    }
    let key: string | undefined;
    try {
      key = await keychainGet(keychainService(PROVIDER_ID), KEYCHAIN_ACCOUNT, this.options.keychain);
    } catch (err) {
      this.options.log?.(`reading the keychain failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.last = key?.trim() || undefined;
    return this.last ? { key: this.last, source: "keychain" } : undefined;
  }

  /** Writes the key to the keychain. With `userId` (OAuth) the user id is recorded for the binding. */
  async save(key: string, o: { dataDir?: string; userId?: string | null } = {}): Promise<void> {
    const clean = key.trim();
    if (clean === "" || /[\s\0]/.test(clean)) throw new Error("the key is empty or contains spaces");
    if ((this.options.platform ?? process.platform) !== "darwin") throw new Error("the keychain is only available on macOS; set CUELOR_PROVIDER_TEST_KEY for development");
    await keychainSet(keychainService(PROVIDER_ID), KEYCHAIN_ACCOUNT, clean, this.options.keychain);
    this.last = clean;
    if (o.dataDir && o.userId) {
      const identity: Identity = { key_fingerprint: await fingerprint(clean, o.dataDir), user_id: o.userId };
      await writeJsonAtomic(path.join(o.dataDir, IDENTITY_FILE), identity);
    }
  }

  async markRejected(dataDir: string): Promise<void> {
    if (this.last) this.rejected.add(await fingerprint(this.last, dataDir));
  }

  /**
   * The protocol's account. The binding is the HMAC of the OpenRouter user id when the key came from the
   * OAuth login, else of the key (VALIDATION.md, "Account"). It needs no network: the key is checked
   * when it is set, and a 401 from any call marks it `invalid_credentials`.
   */
  async account(dataDir: string): Promise<Account> {
    const stored = await this.read();
    if (!stored) {
      return { status: "needs_setup", label: "No OpenRouter key", binding: await computeBinding("", { dataDir }) };
    }
    const fp = await fingerprint(stored.key, dataDir);
    const identity = await readJsonFile<Identity>(path.join(dataDir, IDENTITY_FILE)).catch(() => undefined);
    const binding =
      identity && identity.key_fingerprint === fp && identity.user_id
        ? await computeBinding("user\n" + identity.user_id, { dataDir })
        : await computeBinding("key\n" + stored.key, { dataDir });
    const label = `OpenRouter key …${stored.key.slice(-4)}${stored.source === "env" ? " (test key)" : ""}`;
    return { status: this.rejected.has(fp) ? "invalid_credentials" : "ready", label, binding };
  }
}

function fingerprint(key: string, dataDir: string): Promise<string> {
  return computeBinding("key-fingerprint\n" + key, { dataDir });
}
