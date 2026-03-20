import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { delay } from "./util.mjs";

/**
 * @typedef {{
 *   acquired: boolean,
 *   lockPath: string | null,
 *   owner: string | null,
 *   lockInode: number | null,
 * }} FileLock
 */

/**
 * Acquire a cross-process file lock via atomic create.
 * @param {string} lockPath
 * @param {{
 *   timeoutMs?: number,
 *   backoffMs?: number,
 *   staleMs?: number,
 *   jitterMs?: number,
 *   metadata?: Record<string, unknown>,
 *   throwOnTimeout?: boolean,
 * }} [options]
 * @returns {Promise<FileLock>}
 */
export async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const backoffMs = options.backoffMs ?? 50;
  const staleMs = options.staleMs ?? 20_000;
  const jitterMs = options.jitterMs ?? 0;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const owner = randomBytes(12).toString("hex");

  await fs.mkdir(dirname(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner, ...(options.metadata || {}) }),
          "utf-8",
        );
        const stat = await handle.stat();
        return { acquired: true, lockPath, owner, lockInode: stat.ino };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== "EEXIST") throw error;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // Lock may have disappeared concurrently; retry.
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
      await delay(Math.min(remaining, backoffMs + jitter));
    }
  }

  if (options.throwOnTimeout) {
    throw new Error(`Timed out acquiring lock: ${lockPath}`);
  }

  return { acquired: false, lockPath: null, owner: null, lockInode: null };
}

/**
 * Release a lock acquired by `acquireFileLock`.
 * @param {FileLock | string | null} lock
 * @returns {Promise<void>}
 */
export async function releaseFileLock(lock) {
  const lockPath = typeof lock === "string" || lock === null ? lock : lock.lockPath;
  const owner = typeof lock === "object" && lock ? (lock.owner ?? null) : null;
  const lockInode = typeof lock === "object" && lock ? (lock.lockInode ?? null) : null;

  if (!lockPath) return;

  if (owner) {
    try {
      const content = await fs.readFile(lockPath, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || parsed.owner !== owner) return;

      if (lockInode) {
        const stat = await fs.stat(lockPath);
        if (stat.ino !== lockInode) return;
      }
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === "ENOENT") return;
      return;
    }
  }

  try {
    await fs.unlink(lockPath);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== "ENOENT") throw error;
  }
}
