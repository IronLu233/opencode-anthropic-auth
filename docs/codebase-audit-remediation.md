# Codebase Audit & Remediation Plan

**Date:** 2026-03-20
**Scope:** Full structural audit — abstractions, DRY, dead code, complexity, state management, error handling, test gaps
**Tests at time of audit:** 520 passing across 13 files
**Current implementation status:** major remediation pass completed, 512 passing tests

---

## Executive Summary

The codebase is well-engineered with solid module separation, thoughtful multi-process coordination (refresh locks, freshness-based merge-on-save, single-flight dedup), and thorough happy-path test coverage. The main structural problems are:

1. **A single massive file** (`index.mjs`, 2025 lines) mixing 5+ abstraction levels
2. **20+ repetitions** of the `saveAccounts` + `syncOpenCodeAuthFromStorage` pair
3. **Dual naming convention** (`token_updated_at` vs `tokenUpdatedAt`) creating fragile translation at every disk/memory boundary
4. **Four dead `AccountManager` methods** (never called in production) that imply a usage pattern that doesn't exist
5. **Unvalidated token refresh response** — malformed `expires_in` silently produces `NaN`
6. **Unlocked read-modify-write** in `saveAccounts` — CLI commands can race and lose non-auth changes

## Current Status

Implemented in the current remediation pass:

- Phase 1 correctness fixes
- Phase 2 `saveAndSync` extraction
- Phase 3 shared file lock extraction (`lib/file-lock.mjs`)
- Phase 4 dead code cleanup, dependency removal, and internal export cleanup
- Phase 5 partial `index.mjs` split via `lib/request-transform.mjs`, `lib/sse-stream.mjs`, and `lib/token-refresh.mjs`
- Phase 6 naming unification to `tokenUpdatedAt` with backward-compatible reads for legacy `token_updated_at`
- Phase 7 shared token refresh path used by plugin and CLI
- Phase 9 additional test coverage for OpenCode auth sync paths
- Phase 10 AccountManager role clarified as runtime selection/merge logic rather than mutation authority

Still intentionally not completed in this pass:

- A full storage write lock around `saveAccounts` read-merge-write
- Additional extraction of slash-command handling into its own module
- Expanded dedicated tests for SSE edge cases and config atomic-write behavior beyond current coverage

---

## Findings

### Priority 1 — Correctness & Safety

| #   | Category       | File:Line                   | Finding                                                                                                                                                                                                                                                                           | Severity    |
| --- | -------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | error-handling | `lib/oauth.mjs:180`         | `refreshToken()` returns `resp.json()` without validating shape. Missing `access_token` or non-numeric `expires_in` silently produces `undefined`/`NaN` that corrupts account state and can trigger infinite refresh loops.                                                       | **Blocker** |
| 2   | state          | `lib/storage.mjs:256-294`   | `saveAccounts` has an unlocked read-modify-write window. Two concurrent CLI commands (e.g., `disable 1` and `switch 2`) can race; the loser's non-auth changes are silently dropped. Auth fields are protected by freshness merge, but `enabled`, `activeIndex`, `stats` are not. | **Issue**   |
| 3   | edge-case      | `index.mjs:817-825`         | Lock result normalization defaults to `acquired: true` when return is unexpected. Safe default should be `acquired: false` — assuming lock success on failure is dangerous.                                                                                                       | **Issue**   |
| 4   | state          | `index.mjs:981-984`         | `reloadAccountManagerFromDisk()` discards all in-memory state: health scores, token buckets, pending stats deltas. After a slash command like `/anthropic switch 2`, all health tracking resets.                                                                                  | **Issue**   |
| 5   | data-flow      | `lib/opencode-auth.mjs:284` | `syncOpenCodeAuthFromStorage` compares `expires` for freshness but should compare `token_updated_at`. A rotated refresh token with shorter-lived access token gets skipped, leaving auth.json with stale refresh token.                                                           | **Issue**   |
| 6   | edge-case      | `index.mjs:1643`            | `maxAttempts = accountManager.getTotalAccountCount()` includes disabled accounts, wasting retry iterations. Should use `getAccountCount()` (enabled only).                                                                                                                        | **Nit**     |

### Priority 2 — DRY Violations

| #   | Category | File:Line                                                      | Finding                                                                                                                                                                          | Severity  |
| --- | -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 7   | DRY      | `cli.mjs` (21 sites) + `index.mjs` (7 sites)                   | `saveAccounts(stored)` + `syncOpenCodeAuthFromStorage(stored, ...)` repeated 20+ times. If sync is forgotten, auth.json drifts.                                                  | **Issue** |
| 8   | DRY      | `lib/opencode-auth.mjs:64-134` + `lib/refresh-lock.mjs:33-123` | ~150 lines of near-identical file locking logic (owner verification, stale detection, inode check, backoff).                                                                     | **Issue** |
| 9   | DRY      | `index.mjs:811-889` + `cli.mjs:159-171`                        | Two separate token refresh implementations with different error handling, locking, and field naming. CLI version has no lock — risks token rotation race with concurrent plugin. | **Issue** |
| 10  | DRY      | `cli.mjs:87-100` + `index.mjs:672-684`                         | Two duration formatting functions (`formatDuration` / `formatDurationShort`) with different rounding.                                                                            | **Nit**   |
| 11  | DRY      | `lib/opencode-auth.mjs:11` + `lib/refresh-lock.mjs:14`         | Identical `delay(ms)` implementations.                                                                                                                                           | **Nit**   |
| 12  | DRY      | `cli.mjs` (~10 cmd functions)                                  | Repeated `loadAccounts()` → null check → error pattern.                                                                                                                          | **Nit**   |

### Priority 3 — Dead Code

| #   | Category  | File:Line                     | Finding                                                                                                                                     | Severity  |
| --- | --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 13  | dead-code | `lib/accounts.mjs:343-396`    | `AccountManager.addAccount()` — 54-line method never called in production. All adds go through `applyLoginCredentials` + `saveAccounts`.    | **Issue** |
| 14  | dead-code | `lib/accounts.mjs:403-436`    | `AccountManager.removeAccount()` — never called in production. Removal uses `stored.accounts.splice()` + `adjustActiveIndexAfterRemoval()`. | **Issue** |
| 15  | dead-code | `lib/accounts.mjs:443-449`    | `AccountManager.toggleAccount()` — never called in production. Toggle uses direct `stored.accounts[idx].enabled` mutation.                  | **Issue** |
| 16  | dead-code | `lib/accounts.mjs:721-748`    | `AccountManager.resetStats()` — never called in production. Reset uses direct `stored.accounts[idx].stats = createDefaultStats()`.          | **Issue** |
| 17  | dead-code | `package.json:38`             | `@openauthjs/openauth` listed as production dependency but never imported. PKCE uses native `crypto`.                                       | **Issue** |
| 18  | dead-code | `lib/opencode-auth.mjs:20,32` | `getOpenCodeDataDir()` and `getOpenCodeAuthPath()` exported but only used internally.                                                       | **Nit**   |

### Priority 4 — Abstraction & Complexity

| #   | Category    | File:Line                | Finding                                                                                                                                                                                                                                                                                                      | Severity  |
| --- | ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 19  | abstraction | `index.mjs` (2025 lines) | File mixes 5+ abstraction levels: request transforms, SSE parsing, response wrapping, token refresh, slash commands, toast management, idle refresh, plugin entry point.                                                                                                                                     | **Issue** |
| 20  | abstraction | `lib/accounts.mjs`       | `AccountManager` has a dual-path mutation problem: it exposes `addAccount`/`removeAccount`/`toggleAccount`/`resetStats` that are never used — all mutations go through raw `loadAccounts`/`saveAccounts`. The class implies it's the authority for mutations but is actually read/selection-only at runtime. | **Issue** |
| 21  | naming      | Everywhere               | `token_updated_at` (disk/snake_case) vs `tokenUpdatedAt` (memory/camelCase) requires manual translation at 27+ locations. `addAccount` has an explicit `delete existing.token_updated_at` cleanup step.                                                                                                      | **Issue** |
| 22  | complexity  | `index.mjs:1372-1385`    | `parseRefreshFailure` duck-types error objects instead of using a typed `RefreshError` class.                                                                                                                                                                                                                | **Nit**   |
| 23  | naming      | `cli.mjs:131-145`        | `pad()` right-pads (left-aligns), `rpad()` left-pads (right-aligns). Names are backwards from convention.                                                                                                                                                                                                    | **Nit**   |
| 24  | naming      | `index.mjs:1232`         | `primaryToken` means "command word" but reads as "auth token" in an OAuth codebase.                                                                                                                                                                                                                          | **Nit**   |
| 25  | boundary    | `lib/config.mjs:100`     | `CLIENT_ID` is an OAuth constant exported from the config module. Belongs in `lib/oauth.mjs`.                                                                                                                                                                                                                | **Nit**   |

### Priority 5 — Error Handling & Robustness

| #   | Category       | File:Line             | Finding                                                                                                                                                                       | Severity  |
| --- | -------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 26  | error-handling | `lib/storage.mjs:233` | `loadAccounts` returns `null` for ALL errors including `EACCES`. Permission errors are indistinguishable from "file doesn't exist."                                           | **Issue** |
| 27  | error-handling | `index.mjs:858-865`   | `onTokensUpdated` failure silently swallowed. If debounced retry also fails, rotated token is lost on disk with no logging.                                                   | **Issue** |
| 28  | error-handling | `cli.mjs:694`         | `saveAccounts(stored).catch(() => {})` after token refresh silently swallows save failure. Lost refresh token rotation means old token is invalid and new one only in memory. | **Issue** |
| 29  | edge-case      | `index.mjs:293-306`   | `transformRequestBody` mutates message content on parsed objects. Safe today but fragile if signature changes.                                                                | **Nit**   |
| 30  | robustness     | `index.mjs:946-951`   | In-memory Maps (`debouncedToastTimestamps`, `idleRefreshLastAttempt`) grow unbounded, never pruned. Theoretical with ≤10 accounts.                                            | **Nit**   |

### Priority 6 — Test Coverage Gaps

| #   | Category | File:Line                | Finding                                                                                                                                                         | Severity  |
| --- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 31  | test-gap | `lib/opencode-auth.mjs`  | Lock contention, stale lock recovery, timeout, `syncOpenCodeAuthFromStorage` freshness logic — all untested. Only 3 tests exist (for `getOpenCodeSyncAccount`). | **Issue** |
| 32  | test-gap | `index.mjs:512-642`      | SSE stream processing edge cases: malformed payloads, chunk splits, CRLF normalization, empty chunks — not unit tested.                                         | **Issue** |
| 33  | test-gap | `index.mjs:811-889`      | `refreshAccountToken` cross-process coordination tested only via integration. No unit tests for lock-held fallback, disk-read failure, stale reference.         | **Issue** |
| 34  | test-gap | `cli.mjs:1482-1666`      | `cmdManage` interactive loop: disable, remove, reset, strategy sub-commands untested.                                                                           | **Issue** |
| 35  | test-gap | `lib/config.mjs:334-349` | `saveConfig` atomic write and merge behavior untested.                                                                                                          | **Nit**   |

---

## Implementation Plan

### Phase 1: Correctness Fixes (Findings 1-6)

**Estimated effort:** Small — focused fixes, no restructuring.

#### 1A. Validate token refresh response shape (#1)

**File:** `lib/oauth.mjs:180`

```js
// Before:
return resp.json();

// After:
const json = await resp.json();
if (!json?.access_token || typeof json.expires_in !== "number") {
  const error = new Error("Malformed token response: missing access_token or expires_in");
  error.status = resp.status;
  throw error;
}
return json;
```

Also validate in `exchange()` return path (line 105-110) — ensure `json.access_token` and `json.expires_in` exist before returning `type: "success"`.

#### 1B. Fix lock result default (#3)

**File:** `index.mjs:817-825`

Change the fallback from `acquired: true` to `acquired: false`:

```js
: { acquired: false, lockPath: null, owner: null, lockInode: null };
```

#### 1C. Fix `syncOpenCodeAuthFromStorage` freshness guard (#5)

**File:** `lib/opencode-auth.mjs:284`

Add `token_updated_at` comparison alongside `expires`:

```js
const accountTs = account.token_updated_at || 0;
const currentTs = entry && typeof entry.token_updated_at === "number" ? entry.token_updated_at : 0;
if (currentExpires > account.expires && currentTs >= accountTs) return;
```

Also write `token_updated_at` into the auth.json entry so future comparisons work.

#### 1D. Fix `reloadAccountManagerFromDisk` to flush state (#4)

**File:** `index.mjs:981-984`

Before creating new manager, flush pending stats:

```js
async function reloadAccountManagerFromDisk() {
  if (!accountManager) return;
  await accountManager.saveToDisk({ preserveDiskState: true }).catch(() => {});
  accountManager = await AccountManager.load(config, null);
}
```

#### 1E. Fix `maxAttempts` to use enabled count (#6)

**File:** `index.mjs:1643`

```js
const maxAttempts = accountManager.getAccountCount(); // enabled only
```

---

### Phase 2: Extract `saveAndSync` Helper (#7)

**Estimated effort:** Small — mechanical replacement across 20+ call sites.

Create a helper that atomically pairs save and sync:

**File:** `lib/storage.mjs` (or `lib/account-state.mjs`)

```js
export async function saveAndSync(stored, options = {}) {
  await saveAccounts(stored);
  await syncOpenCodeAuthFromStorage(stored, { clearIfMissing: true, ...options });
}
```

Replace all 20+ `saveAccounts` + `syncOpenCodeAuthFromStorage` pairs in `cli.mjs` and `index.mjs`. This is the single highest-impact DRY fix.

---

### Phase 3: Extract Shared File Lock (#8, #11)

**Estimated effort:** Medium — extract generic lock, update two consumers, add tests.

Create `lib/file-lock.mjs`:

```js
export async function acquireFileLock(lockPath, { timeoutMs, staleMs, backoffMs }) { ... }
export async function releaseFileLock(lock) { ... }
export async function withFileLock(lockPath, options, fn) { ... }
```

Refactor `opencode-auth.mjs` and `refresh-lock.mjs` to use the shared lock. Also move `delay()` to `lib/util.mjs`.

---

### Phase 4: Clean Up Dead Code (#13-18)

**Estimated effort:** Small — deletions and one dependency removal.

#### 4A. Remove unused `AccountManager` mutation methods (#13-16)

Remove `addAccount`, `removeAccount`, `toggleAccount`, `resetStats` from `lib/accounts.mjs`. Update `lib/accounts.test.mjs` — remove tests for these methods, or move them to a separate "deprecated API" test file if keeping for regression.

Add a JSDoc comment to `AccountManager` documenting it as a **read/selection runtime**, not a mutation authority:

```js
/**
 * In-memory account pool for selection and health tracking.
 * Mutations go through loadAccounts/saveAccounts on disk storage directly.
 * This class is responsible for: account selection strategy, health scoring,
 * token bucket tracking, stats delta accumulation, and disk merge-on-save.
 */
```

#### 4B. Remove `@openauthjs/openauth` dependency (#17)

```bash
npm uninstall @openauthjs/openauth
```

#### 4C. Un-export internal functions (#18)

Remove `export` from `getOpenCodeDataDir()` and `getOpenCodeAuthPath()` in `lib/opencode-auth.mjs`.

---

### Phase 5: Split `index.mjs` (#19)

**Estimated effort:** Large — careful extraction with test updates.

Extract from the 2025-line `index.mjs` into focused modules:

| New Module                  | Extracted From        | Responsibility                                                                                      |
| --------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| `lib/request-transform.mjs` | `index.mjs:157-340`   | `buildRequestHeaders`, `transformRequestBody`, `transformUrl`                                       |
| `lib/sse-stream.mjs`        | `index.mjs:355-642`   | SSE parsing, `processSSEBuffer`, `rewriteSSEChunk`, `extractUsageFromSSEEvent`, `transformResponse` |
| `lib/token-refresh.mjs`     | `index.mjs:746-889`   | `refreshAccountToken`, `readDiskAccountAuth`, `applyDiskAuthIfFresher`                              |
| `lib/slash-commands.mjs`    | `index.mjs:1087-1326` | Slash command dispatch and argument parsing                                                         |

After extraction, `index.mjs` becomes ~800 lines of orchestration: plugin factory, loader, fetch interceptor, and auth flow coordination.

---

### Phase 6: Unify Naming Convention (#21)

**Estimated effort:** Medium — rename field across disk format + all references.

**Decision:** Standardize on `tokenUpdatedAt` (camelCase) everywhere, matching the rest of the codebase.

1. Add migration in `validateAccount` (`lib/storage.mjs`): if `token_updated_at` exists, copy to `tokenUpdatedAt` and delete.
2. Update `AccountMetadata` typedef to use `tokenUpdatedAt`.
3. Update `applyOAuthCredentials` and `createOAuthAccountRecord` in `account-state.mjs`.
4. Remove all `token_updated_at` → `tokenUpdatedAt` translation code in `accounts.mjs`.
5. Update `saveAccounts` merge logic in `storage.mjs`.
6. Update test fixtures.

The migration handles backward compatibility — old disk files with `token_updated_at` are normalized on read.

---

### Phase 7: Unify Token Refresh (#9)

**Estimated effort:** Medium — extract shared refresh, add locking to CLI path.

Extract into `lib/token-refresh.mjs` (or extend the one from Phase 5):

```js
export async function refreshAccountTokenSafe(account, { lock = true } = {}) {
  // If lock requested, acquire refresh lock
  // Read disk auth, adopt if fresher
  // Call refreshToken()
  // Validate response shape
  // Apply credentials
  // Release lock
  // Return new access token
}
```

Both `index.mjs` and `cli.mjs` call this. The CLI path gets locking for free, preventing token rotation races with concurrent plugin instances.

---

### Phase 8: Error Handling Improvements (#26-28)

**Estimated effort:** Small.

#### 8A. Distinguish ENOENT from EACCES in `loadAccounts` (#26)

```js
} catch (err) {
  if (err?.code === "ENOENT") return null;
  if (err instanceof SyntaxError) return null; // JSON parse error
  throw err; // EACCES, EIO, etc. — surface to caller
}
```

#### 8B. Add logging to `onTokensUpdated` catch (#27)

```js
} catch (callbackErr) {
  debugLog("onTokensUpdated failed, debounced retry scheduled:", callbackErr?.message);
}
```

#### 8C. Log save failures after CLI refresh (#28)

```js
await saveAccounts(stored).catch((err) => {
  console.error("Warning: failed to save refreshed tokens:", err.message);
});
```

---

### Phase 9: Add Missing Tests (#31-34)

**Estimated effort:** Medium.

| Gap                                   | Tests to Add                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `opencode-auth.mjs` lock & sync (#31) | Lock timeout, stale cleanup, `syncOpenCodeAuthFromStorage` freshness guard, clear-if-missing, concurrent write |
| SSE stream edge cases (#32)           | Malformed payloads, CRLF, chunk splits, empty chunks, `EMPTY_CHUNK` path                                       |
| `refreshAccountToken` unit (#33)      | Lock-held fallback, disk-read failure, `onTokensUpdated` throw, stale reference                                |
| `cmdManage` interactive (#34)         | Disable, remove, reset, strategy sub-commands                                                                  |

---

### Phase 10: Resolve `AccountManager` Dual-Path Problem (#20)

**Estimated effort:** Medium — choose direction and refactor.

**Option A (recommended): Remove mutation methods, document as read-only runtime.**
This is consistent with Phase 4 (dead code removal). `AccountManager` becomes:

- Account selection (strategy-based)
- Health score / token bucket tracking
- Stats delta accumulation
- Disk merge-on-save
- Active index sync from disk

All mutations (add, remove, toggle, reset) go through `loadAccounts` → mutate → `saveAndSync`.

**Option B: Migrate all mutations to go through `AccountManager`.**
This would require `AccountManager` to own `syncOpenCodeAuthFromStorage` internally and expose `save()`, `addAccount()`, etc. as the only mutation API. Higher effort, higher abstraction payoff.

---

## Priority Order

| Phase | Effort | Risk Reduction                | Recommendation      |
| ----- | ------ | ----------------------------- | ------------------- |
| 1     | Small  | High (correctness)            | **Do first**        |
| 2     | Small  | High (DRY, consistency)       | **Do second**       |
| 4     | Small  | Medium (dead code)            | **Do third**        |
| 8     | Small  | Medium (error handling)       | **Do with Phase 1** |
| 3     | Medium | Medium (DRY, maintainability) | Do fourth           |
| 6     | Medium | Medium (naming, complexity)   | Do fifth            |
| 7     | Medium | Medium (DRY, safety)          | Do sixth            |
| 9     | Medium | Medium (coverage)             | Do seventh          |
| 5     | Large  | Medium (maintainability)      | Do eighth           |
| 10    | Medium | Low (abstraction clarity)     | Do last             |

Phases 1, 2, 4, and 8 can be done in a single session. Phases 3, 6, 7 form a natural second session. Phases 5, 9, 10 are a third session.
