import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The lock file in the data directory. One data directory serves one instance. */
export const INSTANCE_LOCK_FILE = "instance.lock";

interface LockContent {
  pid: number;
  host: string;
  nonce: string;
  started_at: string;
}

export interface InstanceLock {
  readonly file: string;
  /** Stops the heartbeat and removes the lock file if it is still this instance's. */
  release(): Promise<void>;
  /** `release` for a `process.on("exit")` handler. */
  releaseSync(): void;
}

export interface InstanceLockOptions {
  /** How often the holder touches the lock file. Default 10 s. */
  heartbeatMs?: number;
  /**
   * A lock whose holder cannot be checked (another host, or a file that cannot be read) is taken over
   * once it was not touched for this long. Default 60 s; at least three heartbeats.
   */
  staleMs?: number;
}

/** Thrown when another instance holds the data directory. */
export class InstanceLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceLockedError";
  }
}

/** Lock files held by this process, so a second runtime in the same process is refused too. */
const heldHere = new Set<string>();

/**
 * Takes the instance lock of a data directory, or throws `InstanceLockedError` when another instance
 * holds it. The stores are files guarded by in-process locks, so two processes on one directory could
 * break idempotency.
 *
 * A lock is stale, and taken over:
 *
 * - when it was written on this host by a process that no longer runs (for example after `kill -9`), or
 *   by this process id (a restarted container whose process is pid 1 again);
 * - otherwise (written on another host that shares the directory, or unreadable) when it was not touched
 *   for `staleMs`. The holder touches it every `heartbeatMs`.
 *
 * Two processes that take over the same stale lock at the same moment can both succeed; the window is
 * the time between reading the stale file and removing it.
 */
export async function acquireInstanceLock(dataDir: string, options: InstanceLockOptions = {}): Promise<InstanceLock> {
  const file = path.resolve(dataDir, INSTANCE_LOCK_FILE);
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const staleMs = Math.max(options.staleMs ?? 60_000, 3 * heartbeatMs);
  if (heldHere.has(file)) throw new InstanceLockedError(lockedMessage(dataDir, file, "this process"));
  const mine: LockContent = { pid: process.pid, host: os.hostname(), nonce: randomBytes(16).toString("hex"), started_at: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(mine) + "\n");
      } finally {
        await handle.close();
      }
      return held(file, mine.nonce, heartbeatMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const raw = await fs.readFile(file, "utf8").catch(() => undefined);
    const stat = await fs.stat(file).catch(() => undefined);
    if (raw === undefined || !stat) continue; // released meanwhile
    const holder = parse(raw);
    if (!isStale(holder, stat.mtimeMs, staleMs)) {
      throw new InstanceLockedError(lockedMessage(dataDir, file, holder ? `pid ${holder.pid} on ${holder.host}` : "an unreadable lock"));
    }
    // Remove the stale lock only if it is still the file that was judged stale.
    if ((await fs.readFile(file, "utf8").catch(() => undefined)) === raw) await fs.rm(file, { force: true });
  }
  throw new InstanceLockedError(`could not take ${file}: other instances keep starting on the data directory`);
}

function lockedMessage(dataDir: string, file: string, holder: string): string {
  return (
    `another instance is using the data directory ${dataDir} (${holder}; lock file ${file}). ` +
    "One data directory serves one instance: stop the other one, or give this one its own directory. " +
    "Remove the lock file only when no other instance runs."
  );
}

function parse(raw: string): LockContent | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockContent>;
    if (Number.isInteger(v.pid) && typeof v.host === "string" && typeof v.nonce === "string") return v as LockContent;
  } catch {
    // An unreadable lock is judged by its age.
  }
  return undefined;
}

function isStale(holder: LockContent | undefined, mtimeMs: number, staleMs: number): boolean {
  if (holder && holder.host === os.hostname()) return holder.pid === process.pid || !isRunning(holder.pid);
  return Date.now() - mtimeMs > staleMs;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function held(file: string, nonce: string, heartbeatMs: number): InstanceLock {
  heldHere.add(file);
  const timer = setInterval(() => {
    const now = new Date();
    void fs.utimes(file, now, now).catch(() => undefined);
  }, heartbeatMs);
  timer.unref();
  let released = false;
  const ours = (raw: string | undefined) => raw !== undefined && parse(raw)?.nonce === nonce;
  return {
    file,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      heldHere.delete(file);
      if (ours(await fs.readFile(file, "utf8").catch(() => undefined))) await fs.rm(file, { force: true });
    },
    releaseSync() {
      if (released) return;
      released = true;
      clearInterval(timer);
      heldHere.delete(file);
      let raw: string | undefined;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        return;
      }
      if (ours(raw)) rmSync(file, { force: true });
    },
  };
}
