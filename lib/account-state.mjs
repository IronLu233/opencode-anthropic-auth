/**
 * @typedef {import('./storage.mjs').AccountMetadata} AccountMetadata
 * @typedef {import('./storage.mjs').AccountStorage} AccountStorage
 */

import { createDefaultStats } from "./storage.mjs";

/** Maximum number of OAuth accounts the plugin will manage. */
export const MAX_ACCOUNTS = 10;

/**
 * Build lookup indexes from an array of disk accounts and return a match function.
 *
 * Match priority: stable id > unique addedAt > refresh token > first addedAt bucket entry.
 *
 * @param {AccountMetadata[]} diskAccounts
 * @returns {(account: { id?: string, addedAt?: number, refreshToken?: string }) => AccountMetadata | null}
 */
export function createDiskAccountMatcher(diskAccounts) {
  const byId = new Map(diskAccounts.map((a) => [a.id, a]));
  /** @type {Map<number, AccountMetadata[]>} */
  const byAddedAt = new Map();
  const byToken = new Map(diskAccounts.map((a) => [a.refreshToken, a]));
  for (const d of diskAccounts) {
    const bucket = byAddedAt.get(d.addedAt) || [];
    bucket.push(d);
    byAddedAt.set(d.addedAt, bucket);
  }

  return (account) => {
    const matchById = byId.get(account.id);
    if (matchById) return matchById;

    const matchByAddedAt = byAddedAt.get(account.addedAt);
    if (matchByAddedAt?.length === 1) return matchByAddedAt[0];

    const matchByToken = byToken.get(account.refreshToken);
    if (matchByToken) return matchByToken;

    if (matchByAddedAt && matchByAddedAt.length > 0) return matchByAddedAt[0];
    return null;
  };
}

/**
 * Reset transient account tracking fields.
 * @param {AccountMetadata} account
 */
export function resetAccountTracking(account) {
  account.rateLimitResetTimes = {};
  account.consecutiveFailures = 0;
  account.lastFailureTime = null;
}

/**
 * Normalize active index after removing one account.
 * @param {AccountStorage} storage
 * @param {number} removedIndex
 */
export function adjustActiveIndexAfterRemoval(storage, removedIndex) {
  if (storage.accounts.length === 0) {
    storage.activeIndex = 0;
    return;
  }

  if (storage.activeIndex >= storage.accounts.length) {
    storage.activeIndex = storage.accounts.length - 1;
    return;
  }

  if (storage.activeIndex > removedIndex) {
    storage.activeIndex -= 1;
  }
}

/**
 * Apply OAuth credentials to an existing account record.
 * @param {AccountMetadata} account
 * @param {{refresh: string, access: string, expires: number, email?: string, accountUuid?: string}} credentials
 */
export function applyOAuthCredentials(account, credentials) {
  account.refreshToken = credentials.refresh;
  account.access = credentials.access;
  account.expires = credentials.expires;
  account.tokenUpdatedAt = Date.now();
  if (credentials.email) {
    account.email = credentials.email;
  }
  if (typeof credentials.accountUuid === "string") {
    account.accountUuid = credentials.accountUuid;
  }
}

/**
 * Apply a successful OAuth login/reauth to an existing storage account.
 * @param {AccountMetadata} account
 * @param {{refresh: string, access: string, expires: number, email?: string, accountUuid?: string}} credentials
 */
export function applyAuthenticatedAccount(account, credentials) {
  applyOAuthCredentials(account, credentials);
  account.enabled = true;
  resetAccountTracking(account);
}

/**
 * Create a new storage account record from OAuth credentials.
 * @param {{refresh: string, access: string, expires: number, email?: string, accountUuid?: string}} credentials
 * @param {number} [now]
 * @returns {AccountMetadata}
 */
export function createOAuthAccountRecord(credentials, now = Date.now()) {
  return {
    id: `${now}:${credentials.refresh.slice(0, 12)}`,
    email: credentials.email,
    accountUuid: credentials.accountUuid,
    refreshToken: credentials.refresh,
    access: credentials.access,
    expires: credentials.expires,
    tokenUpdatedAt: now,
    addedAt: now,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    stats: createDefaultStats(now),
  };
}

/**
 * Ensure a storage object exists.
 * @param {AccountStorage | null | undefined} storage
 * @returns {AccountStorage}
 */
export function ensureAccountStorage(storage) {
  return storage || { version: 1, accounts: [], activeIndex: 0 };
}

/**
 * Apply credentials to storage for a login flow.
 * Updates an existing matching refresh token or adds a new account.
 * @param {AccountStorage | null | undefined} input
 * @param {{refresh: string, access: string, expires: number, email?: string, accountUuid?: string}} credentials
 * @returns {{ storage: AccountStorage, action: "updated" | "added" | "capacity_reached", index: number }}
 */
export function applyLoginCredentials(input, credentials) {
  const storage = ensureAccountStorage(input);
  const existingIdx = storage.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
  if (existingIdx >= 0) {
    applyAuthenticatedAccount(storage.accounts[existingIdx], credentials);
    return { storage, action: "updated", index: existingIdx };
  }

  if (storage.accounts.length >= MAX_ACCOUNTS) {
    return { storage, action: "capacity_reached", index: -1 };
  }

  storage.accounts.push(createOAuthAccountRecord(credentials));
  return { storage, action: "added", index: storage.accounts.length - 1 };
}

/**
 * Apply credentials to a specific account during reauthentication.
 * @param {AccountStorage} storage
 * @param {number} index
 * @param {{refresh: string, access: string, expires: number, email?: string, accountUuid?: string}} credentials
 * @returns {{ type: "updated", account: AccountMetadata, index: number } | { type: "duplicate", index: number } | { type: "missing" }}
 */
export function applyReauthCredentials(storage, index, credentials) {
  if (!storage || index < 0 || index >= storage.accounts.length) {
    return { type: "missing" };
  }

  const duplicateIndex = storage.accounts.findIndex(
    (account, accountIndex) => accountIndex !== index && account.refreshToken === credentials.refresh,
  );
  if (duplicateIndex >= 0) {
    return { type: "duplicate", index: duplicateIndex };
  }

  const account = storage.accounts[index];
  applyAuthenticatedAccount(account, credentials);
  return { type: "updated", account, index };
}
