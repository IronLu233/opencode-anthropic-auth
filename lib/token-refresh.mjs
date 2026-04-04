import { loadAccounts } from "./storage.mjs";
import { refreshToken } from "./oauth.mjs";
import { acquireRefreshLock, releaseRefreshLock } from "./refresh-lock.mjs";
import { setOpenCodeAuth } from "./opencode-auth.mjs";
import { createDiskAccountMatcher } from "./account-state.mjs";

/**
 * @param {import('./accounts.mjs').ManagedAccount} account
 * @returns {Promise<{refreshToken: string, access?: string, expires?: number, tokenUpdatedAt: number, accountUuid?: string} | null>}
 */
export async function readDiskAccountAuth(account) {
  try {
    const diskData = await loadAccounts();
    if (!diskData) return null;
    const findDiskAccount = createDiskAccountMatcher(diskData.accounts);
    const diskAccount = findDiskAccount(account);
    if (!diskAccount) return null;
    return {
      refreshToken: diskAccount.refreshToken,
      access: diskAccount.access,
      expires: diskAccount.expires,
      tokenUpdatedAt: diskAccount.tokenUpdatedAt,
      accountUuid: diskAccount.accountUuid,
    };
  } catch {
    return null;
  }
}

/**
 * @param {import('./accounts.mjs').ManagedAccount} account
 * @param {number} [now]
 */
export function markTokenStateUpdated(account, now = Date.now()) {
  account.tokenUpdatedAt = now;
}

/**
 * @param {import('./accounts.mjs').ManagedAccount} account
 * @param {{refreshToken: string, access?: string, expires?: number, tokenUpdatedAt: number, accountUuid?: string} | null} diskAuth
 * @param {{ allowExpiredFallback?: boolean }} [options]
 * @returns {boolean}
 */
export function applyDiskAuthIfFresher(account, diskAuth, options = {}) {
  if (!diskAuth) return false;
  const diskTokenUpdatedAt = diskAuth.tokenUpdatedAt || 0;
  const memTokenUpdatedAt = account.tokenUpdatedAt || 0;
  const diskHasDifferentAuth = diskAuth.refreshToken !== account.refreshToken || diskAuth.access !== account.access;
  const memAuthExpired = !account.expires || account.expires <= Date.now();
  const allowExpiredFallback = options.allowExpiredFallback === true;
  if (diskTokenUpdatedAt <= memTokenUpdatedAt && !(allowExpiredFallback && diskHasDifferentAuth && memAuthExpired)) {
    return false;
  }
  account.refreshToken = diskAuth.refreshToken;
  account.access = diskAuth.access;
  account.expires = diskAuth.expires;
  account.tokenUpdatedAt = Math.max(memTokenUpdatedAt, diskTokenUpdatedAt);
  account.accountUuid = diskAuth.accountUuid ?? account.accountUuid;
  return true;
}

/**
 * @param {import('./accounts.mjs').ManagedAccount} account
 * @param {ReturnType<typeof import('@opencode-ai/plugin').createOpencodeClient> | null} client
 * @param {"foreground" | "idle"} [source]
 * @param {{ onTokensUpdated?: () => Promise<void>, debugLog?: (...args: any[]) => void }} [options]
 * @returns {Promise<string>}
 */
export async function refreshAccountToken(account, client, source = "foreground", { onTokensUpdated, debugLog } = {}) {
  const lockResult = await acquireRefreshLock(account.id, {
    timeoutMs: 2_000,
    backoffMs: 60,
    staleMs: 20_000,
  });
  if (!lockResult?.acquired) {
    const diskAuth = await readDiskAccountAuth(account);
    const adopted = applyDiskAuthIfFresher(account, diskAuth, { allowExpiredFallback: true });
    if (adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }
    throw new Error("Refresh lock busy");
  }

  try {
    const diskAuthBeforeRefresh = await readDiskAccountAuth(account);
    const adopted = applyDiskAuthIfFresher(account, diskAuthBeforeRefresh);
    if (source === "foreground" && adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }

    const json = await refreshToken(account.refreshToken, { signal: AbortSignal.timeout(10_000) });

    account.access = json.access_token;
    account.expires = Date.now() + json.expires_in * 1000;
    if (typeof json.account?.uuid === "string") {
      account.accountUuid = json.account.uuid;
    }
    if (json.refresh_token) {
      account.refreshToken = json.refresh_token;
    }
    markTokenStateUpdated(account);

    if (onTokensUpdated) {
      try {
        await onTokensUpdated();
      } catch (callbackErr) {
        debugLog?.("onTokensUpdated failed, debounced retry scheduled:", callbackErr?.message);
      }
    }

    if (client?.auth?.set) {
      try {
        await client.auth.set({
          path: { id: "anthropic" },
          body: { type: "oauth", refresh: account.refreshToken, access: account.access, expires: account.expires },
        });
      } catch {
        // best effort
      }
    }
    try {
      await setOpenCodeAuth({
        refresh: account.refreshToken,
        access: account.access,
        expires: account.expires,
        accountUuid: account.accountUuid,
      });
    } catch {
      // best effort
    }

    return json.access_token;
  } finally {
    await releaseRefreshLock(lockResult);
  }
}
