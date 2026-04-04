import { promises as fs } from "node:fs";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getConfigDir } from "./config.mjs";
import { createDiskAccountMatcher } from "./account-state.mjs";

/**
 * @typedef {object} AccountStats
 * @property {number} requests
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} lastReset
 */

/**
 * @typedef {object} AccountMetadata
 * @property {string} id
 * @property {string} [email]
 * @property {string} [accountUuid]
 * @property {string} refreshToken
 * @property {string} [access]
 * @property {number} [expires]
 * @property {number} tokenUpdatedAt
 * @property {number} addedAt
 * @property {number} lastUsed
 * @property {boolean} enabled
 * @property {Record<string, number>} rateLimitResetTimes
 * @property {number} consecutiveFailures
 * @property {number | null} lastFailureTime
 * @property {string} [lastSwitchReason]
 * @property {AccountStats} stats
 */

/**
 * @typedef {object} AccountStorage
 * @property {number} version
 * @property {AccountMetadata[]} accounts
 * @property {number} activeIndex
 */

const CURRENT_VERSION = 1;

/**
 * Create a fresh stats object.
 * @param {number} [now]
 * @returns {AccountStats}
 */
export function createDefaultStats(now) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset: now ?? Date.now(),
  };
}

/**
 * Validate and normalise a stats object, filling in missing fields.
 * @param {unknown} raw
 * @param {number} now
 * @returns {AccountStats}
 */
function validateStats(raw, now) {
  if (!raw || typeof raw !== "object") return createDefaultStats(now);
  const s = /** @type {Record<string, unknown>} */ (raw);
  const safeNum = (/** @type {unknown} */ v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  return {
    requests: safeNum(s.requests),
    inputTokens: safeNum(s.inputTokens),
    outputTokens: safeNum(s.outputTokens),
    cacheReadTokens: safeNum(s.cacheReadTokens),
    cacheWriteTokens: safeNum(s.cacheWriteTokens),
    lastReset: typeof s.lastReset === "number" && Number.isFinite(s.lastReset) ? s.lastReset : now,
  };
}

const GITIGNORE_ENTRIES = [
  ".gitignore",
  "anthropic-accounts.json",
  "anthropic-accounts.json.*.tmp",
  "anthropic-device-id",
  "anthropic-device-id.*.tmp",
];

/**
 * Get the path to the accounts storage file.
 * @returns {string}
 */
export function getStoragePath() {
  return join(getConfigDir(), "anthropic-accounts.json");
}

/**
 * @returns {boolean}
 */
export function hasAccountsStorageFile() {
  return existsSync(getStoragePath());
}

/**
 * Ensure .gitignore in the config directory includes our files.
 * @param {string} configDir
 */
export function ensureGitignore(configDir) {
  const gitignorePath = join(configDir, ".gitignore");
  try {
    let content = "";
    /** @type {string[]} */
    let existingLines = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    }

    const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));

    if (missingEntries.length === 0) return;

    if (content === "") {
      writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missingEntries.join("\n") + "\n", "utf-8");
    }
  } catch {
    // Ignore gitignore errors
  }
}

/**
 * Deduplicate accounts by refresh token, keeping the most recently used.
 * @param {AccountMetadata[]} accounts
 * @returns {AccountMetadata[]}
 */
export function deduplicateByRefreshToken(accounts) {
  /** @type {Map<string, AccountMetadata>} */
  const tokenMap = new Map();

  for (const acc of accounts) {
    if (!acc.refreshToken) continue;
    const existing = tokenMap.get(acc.refreshToken);
    if (!existing || (acc.lastUsed || 0) > (existing.lastUsed || 0)) {
      tokenMap.set(acc.refreshToken, acc);
    }
  }

  return Array.from(tokenMap.values());
}

/**
 * Validate a single account entry.
 * @param {unknown} raw
 * @param {number} now
 * @returns {AccountMetadata | null}
 */
function validateAccount(raw, now) {
  if (!raw || typeof raw !== "object") return null;
  const acc = /** @type {Record<string, unknown>} */ (raw);

  if (typeof acc.refreshToken !== "string" || !acc.refreshToken) return null;

  const addedAt = typeof acc.addedAt === "number" && Number.isFinite(acc.addedAt) ? acc.addedAt : now;

  const id = typeof acc.id === "string" && acc.id ? acc.id : `${addedAt}:${acc.refreshToken.slice(0, 12)}`;

  return {
    id,
    email: typeof acc.email === "string" ? acc.email : undefined,
    accountUuid:
      typeof acc.account_uuid === "string"
        ? acc.account_uuid
        : typeof acc.accountUuid === "string"
          ? acc.accountUuid
          : undefined,
    refreshToken: acc.refreshToken,
    access: typeof acc.access === "string" ? acc.access : undefined,
    expires: typeof acc.expires === "number" && Number.isFinite(acc.expires) ? acc.expires : undefined,
    tokenUpdatedAt:
      typeof acc.token_updated_at === "number" && Number.isFinite(acc.token_updated_at)
        ? acc.token_updated_at
        : typeof acc.tokenUpdatedAt === "number" && Number.isFinite(acc.tokenUpdatedAt)
          ? acc.tokenUpdatedAt
          : addedAt,
    addedAt,
    lastUsed: typeof acc.lastUsed === "number" && Number.isFinite(acc.lastUsed) ? acc.lastUsed : 0,
    enabled: acc.enabled !== false,
    rateLimitResetTimes:
      acc.rateLimitResetTimes && typeof acc.rateLimitResetTimes === "object" && !Array.isArray(acc.rateLimitResetTimes)
        ? /** @type {Record<string, number>} */ (acc.rateLimitResetTimes)
        : {},
    consecutiveFailures:
      typeof acc.consecutiveFailures === "number" ? Math.max(0, Math.floor(acc.consecutiveFailures)) : 0,
    lastFailureTime: typeof acc.lastFailureTime === "number" ? acc.lastFailureTime : null,
    lastSwitchReason: typeof acc.lastSwitchReason === "string" ? acc.lastSwitchReason : undefined,
    stats: validateStats(acc.stats, now),
  };
}

/**
 * Load accounts from disk.
 * @returns {Promise<AccountStorage | null>}
 */
export async function loadAccounts() {
  const storagePath = getStoragePath();

  try {
    const content = await fs.readFile(storagePath, "utf-8");
    const data = JSON.parse(content);

    if (!data || typeof data !== "object" || !Array.isArray(data.accounts)) {
      return null;
    }

    if (data.version !== CURRENT_VERSION) {
      // Future: handle migrations here
      return null;
    }

    const now = Date.now();
    const accounts = data.accounts
      .map((raw) => validateAccount(raw, now))
      .filter(/** @returns {acc is AccountMetadata} */ (acc) => acc !== null);

    const deduped = deduplicateByRefreshToken(accounts);

    let activeIndex = typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex) ? data.activeIndex : 0;

    if (deduped.length > 0) {
      activeIndex = Math.max(0, Math.min(activeIndex, deduped.length - 1));
    } else {
      activeIndex = 0;
    }

    return {
      version: CURRENT_VERSION,
      accounts: deduped,
      activeIndex,
    };
  } catch (error) {
    // ENOENT (file doesn't exist) and JSON parse errors are expected — return null.
    // Other errors (EACCES, EIO) indicate real problems — surface to caller.
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Save accounts to disk atomically.
 * @param {AccountStorage} storage
 * @returns {Promise<AccountStorage>}
 */
export async function saveAccounts(storage) {
  const storagePath = getStoragePath();
  const configDir = dirname(storagePath);

  await fs.mkdir(configDir, { recursive: true });
  ensureGitignore(configDir);

  /** @type {AccountStorage} */
  let storageToWrite = storage;

  // Merge auth fields against disk by freshness to avoid stale-process clobber.
  // We do not resurrect removed accounts; only merge for accounts present in
  // the incoming storage payload.
  try {
    const disk = await loadAccounts();
    if (disk && storage.accounts.length > 0) {
      const findDiskMatch = createDiskAccountMatcher(disk.accounts);

      const mergedAccounts = storage.accounts.map((acc) => {
        const diskAcc = findDiskMatch(acc);
        const memTs =
          typeof acc.tokenUpdatedAt === "number" && Number.isFinite(acc.tokenUpdatedAt)
            ? acc.tokenUpdatedAt
            : acc.addedAt;
        const diskTs = diskAcc?.tokenUpdatedAt || 0;
        const useDiskAuth = !!diskAcc && diskTs > memTs;

        return {
          ...acc,
          accountUuid: useDiskAuth || !acc.accountUuid ? (diskAcc?.accountUuid ?? acc.accountUuid) : acc.accountUuid,
          refreshToken: useDiskAuth ? diskAcc.refreshToken : acc.refreshToken,
          access: useDiskAuth ? diskAcc.access : acc.access,
          expires: useDiskAuth ? diskAcc.expires : acc.expires,
          tokenUpdatedAt: useDiskAuth ? diskTs : memTs,
        };
      });

      let activeIndex = storage.activeIndex;
      if (mergedAccounts.length > 0) {
        activeIndex = Math.max(0, Math.min(activeIndex, mergedAccounts.length - 1));
      } else {
        activeIndex = 0;
      }

      storageToWrite = {
        ...storage,
        accounts: mergedAccounts,
        activeIndex,
      };
    }
  } catch {
    // If merge read fails, continue with caller-provided storage payload.
  }

  const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
  const content = JSON.stringify(storageToWrite, null, 2);

  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tempPath, storagePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }

  return storageToWrite;
}

/**
 * Save accounts to disk and sync to OpenCode's auth store.
 *
 * This is a convenience wrapper that combines `saveAccounts` with
 * `syncOpenCodeAuthFromStorage` — the two calls that almost every CLI
 * mutation needs.  Uses a dynamic import to avoid a circular dependency
 * (storage.mjs does not otherwise import from opencode-auth.mjs).
 *
 * @param {AccountStorage} stored
 * @param {{ clearIfMissing?: boolean }} [options]
 * @returns {Promise<AccountStorage>}
 */
export async function saveAndSync(stored, options = {}) {
  const persisted = await saveAccounts(stored);
  const { syncOpenCodeAuthFromStorage } = await import("./opencode-auth.mjs");
  await syncOpenCodeAuthFromStorage(persisted, { clearIfMissing: true, ...options });
  return persisted;
}

/**
 * Clear all accounts from disk.
 * @returns {Promise<void>}
 */
export async function clearAccounts() {
  const storagePath = getStoragePath();
  try {
    await fs.unlink(storagePath);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== "ENOENT") throw error;
  }
}
