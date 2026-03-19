import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const PROVIDER_ID = "anthropic";

/**
 * Get OpenCode's XDG-style data directory.
 * Mirrors OpenCode's auth storage location.
 * @returns {string}
 */
export function getOpenCodeDataDir() {
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
export function getOpenCodeAuthPath() {
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write auth.json with secure permissions.
 * @param {Record<string, unknown>} data
 */
async function writeOpenCodeAuthFile(data) {
  const authPath = getOpenCodeAuthPath();
  await mkdir(getOpenCodeDataDir(), { recursive: true });
  await writeFile(authPath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    await chmod(authPath, 0o600);
  } catch {
    // Ignore chmod failures on unsupported filesystems/platforms.
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

  const activeIndex =
    typeof storage.activeIndex === "number" && Number.isFinite(storage.activeIndex)
      ? Math.floor(storage.activeIndex)
      : 0;
  const active = activeIndex >= 0 && activeIndex < storage.accounts.length ? storage.accounts[activeIndex] : null;
  if (active && active.enabled !== false) return active;

  return storage.accounts.find((account) => account?.enabled !== false) || null;
}

/**
 * Persist a specific Anthropic OAuth credential into OpenCode's auth store.
 * @param {{ refresh: string, access: string, expires: number }} input
 */
export async function setOpenCodeAuth(input) {
  const records = await readOpenCodeAuthFile();
  records[PROVIDER_ID] = {
    type: "oauth",
    refresh: input.refresh,
    access: input.access,
    expires: input.expires,
  };
  await writeOpenCodeAuthFile(records);
}

/**
 * Remove Anthropic from OpenCode's auth store.
 */
export async function clearOpenCodeAuth() {
  const records = await readOpenCodeAuthFile();
  delete records[PROVIDER_ID];
  await writeOpenCodeAuthFile(records);
}

/**
 * Sync OpenCode's auth.json from plugin account storage.
 * Removes the auth entry when no usable account remains.
 * @param {{ accounts?: Array<Record<string, any>>, activeIndex?: number } | null | undefined} storage
 * @param {{ clearIfMissing?: boolean }} [options]
 */
export async function syncOpenCodeAuthFromStorage(storage, options = {}) {
  const account = getOpenCodeSyncAccount(storage);
  if (!account?.refreshToken || !account.access || !account.expires) {
    if (options.clearIfMissing) {
      await clearOpenCodeAuth();
    }
    return;
  }

  await setOpenCodeAuth({
    refresh: account.refreshToken,
    access: account.access,
    expires: account.expires,
  });
}
