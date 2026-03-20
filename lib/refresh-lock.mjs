import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";
import { getStoragePath } from "./storage.mjs";

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_BACKOFF_MS = 50;
const DEFAULT_STALE_LOCK_MS = 20_000;

/**
 * @param {string} accountId
 * @returns {string}
 */
function getLockPath(accountId) {
  const hash = createHash("sha1").update(accountId).digest("hex").slice(0, 24);
  return join(dirname(getStoragePath()), "locks", `refresh-${hash}.lock`);
}

/**
 * Try to acquire a per-account cross-process lock.
 * @param {string} accountId
 * @param {{ timeoutMs?: number, backoffMs?: number, staleMs?: number }} [options]
 * @returns {Promise<{ acquired: boolean, lockPath: string | null, owner: string | null, lockInode: number | null }>}
 */
export async function acquireRefreshLock(accountId, options = {}) {
  return acquireFileLock(getLockPath(accountId), {
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    backoffMs: options.backoffMs ?? DEFAULT_LOCK_BACKOFF_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_LOCK_MS,
    jitterMs: 25,
  });
}

/**
 * Release a lock acquired by acquireRefreshLock.
 * @param {{ lockPath: string | null, owner?: string | null, lockInode?: number | null } | string | null} lock
 * @returns {Promise<void>}
 */
export async function releaseRefreshLock(lock) {
  await releaseFileLock(lock);
}
