import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import {
  ensureDir,
  exclusiveCreate,
  getLockPath,
  isProcessAlive,
} from "./platform.js";
import type { LockHandle } from "./types.js";
import { log } from "./logger.js";

interface LockPayload {
  token: string;
  pid: number;
  createdAt: string;
}

const LOCK_POLL_MS = 500;
const LOCK_WAIT_TIMEOUT_MS = 30_000;

export async function acquireLock(
  configDir: string,
  identity: string,
): Promise<LockHandle> {
  const lockPath = getLockPath(configDir, identity);
  await ensureDir(lockPath.replace(/[/\\][^/\\]+$/, ""));
  const token = randomUUID();
  const payload: LockPayload = {
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const created = await exclusiveCreate(
      lockPath,
      JSON.stringify(payload),
    );
    if (created) {
      await log({ event: "lock-acquired", lockPath });
      return {
        path: lockPath,
        token,
        release: () => releaseLock(lockPath, token),
      };
    }

    // Lock file exists — check the owner
    const reclaimed = await tryReclaimStaleLock(lockPath, payload);
    if (reclaimed) {
      await log({ event: "lock-reclaimed", lockPath });
      return {
        path: lockPath,
        token,
        release: () => releaseLock(lockPath, token),
      };
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for recovery lock at ${lockPath}. ` +
        `Another recovery operation may be in progress.`,
      );
    }

    await sleep(LOCK_POLL_MS);
  }
}

async function tryReclaimStaleLock(
  lockPath: string,
  newPayload: LockPayload,
): Promise<boolean> {
  let existing: LockPayload;
  try {
    const raw = await readFile(lockPath, "utf-8");
    existing = JSON.parse(raw) as LockPayload;
  } catch {
    // File vanished or corrupt — try exclusive create on next loop
    return false;
  }

  if (typeof existing.pid !== "number") {
    return false;
  }

  // Only reclaim if the owning process is confirmed dead.
  // Wall-clock age alone is not sufficient (per architecture doc).
  if (isProcessAlive(existing.pid)) {
    return false;
  }

  // Owner is dead — remove and recreate atomically.
  try {
    await unlink(lockPath);
  } catch {
    return false;
  }

  return exclusiveCreate(lockPath, JSON.stringify(newPayload));
}

async function releaseLock(lockPath: string, expectedToken: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, "utf-8");
    const payload = JSON.parse(raw) as LockPayload;
    if (payload.token !== expectedToken) {
      await log({
        event: "lock-release-skipped",
        reason: "token mismatch — lock was reclaimed by another process",
        lockPath,
      });
      return;
    }
    await unlink(lockPath);
    await log({ event: "lock-released", lockPath });
  } catch {
    // Lock file already gone — fine.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
