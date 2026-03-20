import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { acquireFileLock, releaseFileLock } from "./file-lock.mjs";

const PROVIDER_ID = "anthropic";
const AUTH_LOCK_TIMEOUT_MS = 2_000;
const AUTH_LOCK_BACKOFF_MS = 50;
const AUTH_LOCK_STALE_MS = 20_000;

/**
 * Get OpenCode's XDG-style data directory.
 * Mirrors OpenCode's auth storage location.
 * @returns {string}
 */
function getOpenCodeDataDir() {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode");
}

/**
 * Get OpenCode's auth.json path.
 * @returns {string}
 */
function getOpenCodeAuthPath() {
  return join(getOpenCodeDataDir(), "auth.json");
}

/**
 * Read auth.json as an object.
 * @returns {Promise<Record<string, unknown>>}
 */
async function readOpenCodeAuthFile() {
  try {
    const raw = await readFile(getOpenCodeAuthPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    throw new Error("OpenCode auth.json is not a JSON object");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function createTempAuthPath(authPath) {
  return `${authPath}.${randomBytes(6).toString("hex")}.tmp`;
}

function getOpenCodeAuthLockPath() {
  return `${getOpenCodeAuthPath()}.lock`;
}

async function acquireOpenCodeAuthLock() {
  return acquireFileLock(getOpenCodeAuthLockPath(), {
    timeoutMs: AUTH_LOCK_TIMEOUT_MS,
    backoffMs: AUTH_LOCK_BACKOFF_MS,
    staleMs: AUTH_LOCK_STALE_MS,
    throwOnTimeout: true,
  });
}

async function releaseOpenCodeAuthLock(lock) {
  await releaseFileLock(lock);
}

async function withOpenCodeAuthLock(fn) {
  const lock = await acquireOpenCodeAuthLock();
  try {
    return await fn();
  } finally {
    await releaseOpenCodeAuthLock(lock);
  }
}

async function setFilePermissions(path) {
  try {
    await chmod(path, 0o600);
  } catch {
    // Ignore chmod failures on unsupported filesystems/platforms.
  }
}

/**
 * Write auth.json with secure permissions.
 * @param {Record<string, unknown>} data
 */
async function writeOpenCodeAuthFile(data) {
  const authPath = getOpenCodeAuthPath();
  const tempPath = createTempAuthPath(authPath);
  await mkdir(getOpenCodeDataDir(), { recursive: true });
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    await setFilePermissions(tempPath);
    await rename(tempPath, authPath);
    await setFilePermissions(authPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Read auth.json as an object for best-effort sync paths.
 * Returns null instead of risking clobber on read/parse failure.
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readOpenCodeAuthFileBestEffort() {
  try {
    return await readOpenCodeAuthFile();
  } catch {
    return null;
  }
}

/**
 * Pick the account that should back OpenCode's provider auth state.
 * Prefers the active enabled account, then the first enabled account.
 * @param {{ accounts?: Array<Record<string, any>>, activeIndex?: number } | null | undefined} storage
 * @returns {{ refreshToken: string, access?: string, expires?: number } | null}
 */
export function getOpenCodeSyncAccount(storage) {
  if (!storage || !Array.isArray(storage.accounts) || storage.accounts.length === 0) return null;

  const now = Date.now();
  const isUsable = (account) =>
    !!account?.refreshToken && typeof account.access === "string" && typeof account.expires === "number";
  const isFresh = (account) => isUsable(account) && account.expires > now;

  const activeIndex =
    typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex)
      ? Math.floor(storage.activeIndex)
      : 0;
  const active = activeIndex >= 0 && activeIndex < storage.accounts.length ? storage.accounts[activeIndex] : null;
  if (active && active.enabled !== false && isFresh(active)) return active;

  const freshEnabled = storage.accounts.find((account) => account?.enabled !== false && isFresh(account));
  if (freshEnabled) return freshEnabled;

  if (active && active.enabled !== false && isUsable(active)) return active;

  return storage.accounts.find((account) => account?.enabled !== false && isUsable(account)) || null;
}

/**
 * Persist a specific Anthropic OAuth credential into OpenCode's auth store.
 * @param {{ refresh: string, access: string, expires: number }} input
 */
export async function setOpenCodeAuth(input) {
  await withOpenCodeAuthLock(async () => {
    const records = await readOpenCodeAuthFile();
    records[PROVIDER_ID] = {
      type: "oauth",
      refresh: input.refresh,
      access: input.access,
      expires: input.expires,
      tokenUpdatedAt: Date.now(),
    };
    await writeOpenCodeAuthFile(records);
  });
}

/**
 * Read Anthropic's persisted OpenCode auth entry.
 * @returns {Promise<{type: "oauth", refresh: string, access: string, expires: number} | null>}
 */
export async function getOpenCodeAuth() {
  const records = await readOpenCodeAuthFileBestEffort();
  const entry = records?.[PROVIDER_ID];
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "oauth") return null;
  if (typeof entry.refresh !== "string") return null;
  if (typeof entry.access !== "string") return null;
  if (typeof entry.expires !== "number") return null;
  return {
    type: "oauth",
    refresh: entry.refresh,
    access: entry.access,
    expires: entry.expires,
  };
}

/**
 * Remove Anthropic from OpenCode's auth store.
 */
export async function clearOpenCodeAuth() {
  await withOpenCodeAuthLock(async () => {
    const records = await readOpenCodeAuthFile();
    delete records[PROVIDER_ID];
    await writeOpenCodeAuthFile(records);
  });
}

/**
 * Sync OpenCode's auth.json from plugin account storage.
 * Removes the auth entry when no usable account remains.
 * @param {{ accounts?: Array<Record<string, any>>, activeIndex?: number } | null | undefined} storage
 * @param {{ clearIfMissing?: boolean }} [options]
 */
export async function syncOpenCodeAuthFromStorage(storage, options = {}) {
  await withOpenCodeAuthLock(async () => {
    const account = getOpenCodeSyncAccount(storage);
    // Single read — used for both current-entry inspection and write-back.
    const records = await readOpenCodeAuthFileBestEffort();
    if (!records) return;

    // Only freshness fields are needed from the current entry here.
    const entry = records[PROVIDER_ID];
    const isOAuthEntry =
      entry &&
      typeof entry === "object" &&
      entry.type === "oauth" &&
      typeof entry.refresh === "string" &&
      typeof entry.access === "string" &&
      typeof entry.expires === "number";
    const currentExpires = isOAuthEntry && typeof entry.expires === "number" ? entry.expires : 0;
    const currentTs = isOAuthEntry
      ? typeof entry.tokenUpdatedAt === "number"
        ? entry.tokenUpdatedAt
        : typeof entry.token_updated_at === "number"
          ? entry.token_updated_at
          : 0
      : 0;

    if (!account?.refreshToken || !account.access || !account.expires) {
      if (options.clearIfMissing) {
        delete records[PROVIDER_ID];
        await writeOpenCodeAuthFile(records);
      }
      return;
    }

    const accountTs = account.tokenUpdatedAt || 0;
    if (currentTs > accountTs || (currentTs === accountTs && currentExpires >= account.expires)) return;

    records[PROVIDER_ID] = {
      type: "oauth",
      refresh: account.refreshToken,
      access: account.access,
      expires: account.expires,
      tokenUpdatedAt: accountTs || Date.now(),
    };
    await writeOpenCodeAuthFile(records);
  });
}
