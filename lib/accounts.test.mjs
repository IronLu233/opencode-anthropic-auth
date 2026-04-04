import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountManager } from "./accounts.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";
import { makeAccountsData as makeFixtureAccountsData } from "../test/helpers/accounts-fixtures.mjs";

// Mock storage module — pass through pure helpers, mock I/O
vi.mock("./storage.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    hasAccountsStorageFile: vi.fn(() => false),
    loadAccounts: vi.fn(),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
  };
});

import { loadAccounts, saveAccounts } from "./storage.mjs";

/** Build a stored accounts payload from an array of per-account overrides. */
function makeAccountsData(overrides = [{}], extra = {}) {
  return makeFixtureAccountsData(overrides, extra, {
    tokenFactory: (index) => `token${index + 1}`,
  });
}

async function loadManagerFromStored(overrides = [{}], extra = {}, config = DEFAULT_CONFIG, fallback = null) {
  loadAccounts.mockResolvedValue(makeAccountsData(overrides, extra));
  return AccountManager.load(config, fallback);
}

// ---------------------------------------------------------------------------
// AccountManager.load
// ---------------------------------------------------------------------------

describe("AccountManager.load", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  it("creates empty manager when no stored accounts and no fallback", async () => {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getAccountCount()).toBe(0);
    expect(manager.getTotalAccountCount()).toBe(0);
  });

  it("bootstraps from auth fallback when no stored accounts", async () => {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "refresh-token-1",
      access: "access-token-1",
      expires: Date.now() + 3600_000,
    });
    expect(manager.getAccountCount()).toBe(1);
    expect(manager.getTotalAccountCount()).toBe(1);
    expect(manager.getCurrentIndex()).toBe(0);
  });

  it("does not bootstrap from auth fallback when storage exists but is empty", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData([], { activeIndex: 0 }));
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "refresh-token-1",
      access: "access-token-1",
      expires: Date.now() + 3600_000,
    });
    expect(manager.getAccountCount()).toBe(0);
    expect(manager.getTotalAccountCount()).toBe(0);
    expect(manager.getCurrentIndex()).toBe(-1);
  });

  it("loads stored accounts from disk", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData([{ lastUsed: 2000 }, { lastUsed: 4000 }], { activeIndex: 1 }));
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getAccountCount()).toBe(2);
    expect(manager.getCurrentIndex()).toBe(1);
  });

  it("matches auth fallback to existing stored account", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData([{ lastUsed: 2000 }]));
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "fresh-access",
      expires: Date.now() + 3600_000,
    });
    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0].access).toBe("fresh-access");
  });

  it("does not let stale/partial fallback override fresher stored auth", async () => {
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          lastUsed: 2000,
          access: "disk-access",
          expires: Date.now() + 6 * 3600_000,
          tokenUpdatedAt: Date.now() + 6 * 3600_000,
        },
      ]),
    );

    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "stale-fallback-access",
      expires: Date.now() - 60_000,
    });

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot[0].access).toBe("disk-access");
    expect(snapshot[0].expires).toBeGreaterThan(Date.now());
  });

  it("clamps activeIndex to valid range", async () => {
    loadAccounts.mockResolvedValue(makeAccountsData([{ lastUsed: 2000 }], { activeIndex: 99 }));
    const manager = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(manager.getCurrentIndex()).toBe(0);
  });
});

describe("AccountManager snapshots", () => {
  it("getAccountsSnapshot returns copies", async () => {
    loadAccounts.mockResolvedValue(null);
    const manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
    const snapshot = manager.getAccountsSnapshot();
    snapshot[0].email = "modified";
    const snapshot2 = manager.getAccountsSnapshot();
    expect(snapshot2[0].email).not.toBe("modified");
  });
});

// ---------------------------------------------------------------------------
// Account selection
// ---------------------------------------------------------------------------

describe("AccountManager account selection", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    loadAccounts.mockResolvedValue(null);
    manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
  });

  it("getCurrentAccount returns an account", () => {
    const account = manager.getCurrentAccount();
    expect(account).not.toBeNull();
    expect(account.refreshToken).toBe("token1");
  });

  it("getCurrentAccount returns null when no accounts", async () => {
    loadAccounts.mockResolvedValue(null);
    const empty = await AccountManager.load(DEFAULT_CONFIG, null);
    expect(empty.getCurrentAccount()).toBeNull();
  });

  it("getCurrentAccount updates lastUsed", () => {
    const before = manager.getAccountsSnapshot()[0].lastUsed;
    vi.advanceTimersByTime(1000);
    manager.getCurrentAccount();
    const after = manager.getAccountsSnapshot()[0].lastUsed;
    expect(after).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting and health
// ---------------------------------------------------------------------------

describe("AccountManager rate limiting", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    manager = await loadManagerFromStored([{}, { refreshToken: "token2", access: "access2" }]);
  });

  it("markRateLimited sets backoff and returns duration", () => {
    const account = manager.getCurrentAccount();
    const backoffMs = manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(backoffMs).toBeGreaterThan(0);
    expect(account.consecutiveFailures).toBe(1);
  });

  it("markRateLimited increments consecutive failures", () => {
    const account = manager.getCurrentAccount();
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(2);
  });

  it("markSuccess resets consecutive failures", () => {
    const account = manager.getCurrentAccount();
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(1);
    manager.markSuccess(account);
    expect(account.consecutiveFailures).toBe(0);
    expect(account.lastFailureTime).toBeNull();
  });

  it("markFailure reduces health score and repeated failures affect hybrid selection", async () => {
    // Switch to hybrid strategy so health scores affect selection
    const hybridConfig = { ...DEFAULT_CONFIG, account_selection_strategy: "hybrid" };
    const hybridManager = await loadManagerFromStored(
      [{}, { refreshToken: "token2", access: "access2" }],
      {},
      hybridConfig,
    );

    // Get account 0 and hammer it with failures
    // failure_penalty is -20, initial is 70, min_usable is 50
    // After 2 failures: 70 - 40 = 30, which is below min_usable (50)
    const account = hybridManager.getAccountsSnapshot()[0];
    hybridManager.markFailure(account);
    hybridManager.markFailure(account);

    // With hybrid strategy, the degraded account should be skipped
    const selected = hybridManager.getCurrentAccount();
    expect(selected).not.toBeNull();
    expect(selected.index).toBe(1); // Should prefer the healthy account
  });

  it("failure TTL resets consecutive failures after timeout", () => {
    const account = manager.getCurrentAccount();
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(1);

    // Advance past failure TTL (3600 seconds)
    vi.advanceTimersByTime(3601_000);

    // Next rate limit should reset the counter first
    manager.markRateLimited(account, "RATE_LIMIT_EXCEEDED", null);
    expect(account.consecutiveFailures).toBe(1); // Reset to 0, then +1
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("AccountManager persistence", () => {
  /** @type {AccountManager} */
  let manager;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    loadAccounts.mockResolvedValue(null);
    saveAccounts.mockResolvedValue(undefined);
    manager = await AccountManager.load(DEFAULT_CONFIG, {
      refresh: "token1",
      access: "access1",
      expires: Date.now() + 3600_000,
    });
  });

  it("saveToDisk calls saveAccounts with correct format", async () => {
    await manager.saveToDisk();
    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        accounts: expect.arrayContaining([
          expect.objectContaining({
            refreshToken: "token1",
            enabled: true,
          }),
        ]),
        activeIndex: expect.any(Number),
      }),
    );
  });

  it("requestSaveToDisk debounces saves", async () => {
    manager.requestSaveToDisk();
    manager.requestSaveToDisk();
    manager.requestSaveToDisk();

    // Should not have saved yet
    expect(saveAccounts).not.toHaveBeenCalled();

    // Advance past debounce timeout
    vi.advanceTimersByTime(1100);

    // Should have saved once
    // Wait for the async save to complete
    await vi.runAllTimersAsync();
    expect(saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("requestSaveToDisk resets timer on subsequent calls", async () => {
    manager.requestSaveToDisk();
    vi.advanceTimersByTime(500); // Half the debounce window
    manager.requestSaveToDisk(); // Should reset the timer
    vi.advanceTimersByTime(500); // 500ms after second call (total 1000ms)
    expect(saveAccounts).not.toHaveBeenCalled(); // Timer was reset
    vi.advanceTimersByTime(600); // Now past the debounce window
    await vi.runAllTimersAsync();
    expect(saveAccounts).toHaveBeenCalledTimes(1);
  });

  it("syncActiveIndexFromDisk picks up CLI changes", async () => {
    manager = await loadManagerFromStored([
      { email: "a@test.com" },
      { email: "b@test.com", refreshToken: "token2", access: "access2" },
    ]);

    // Currently on account 0
    expect(manager.getCurrentIndex()).toBe(0);

    // CLI changes activeIndex to 1 on disk
    loadAccounts.mockResolvedValue(
      makeAccountsData([{ email: "a@test.com" }, { email: "b@test.com" }], { activeIndex: 1 }),
    );

    await manager.syncActiveIndexFromDisk();
    expect(manager.getCurrentIndex()).toBe(1);
  });

  it("syncActiveIndexFromDisk ignores disabled target account", async () => {
    manager = await loadManagerFromStored([
      { email: "a@test.com" },
      { email: "b@test.com", refreshToken: "token2", access: "access2" },
    ]);

    expect(manager.getCurrentIndex()).toBe(0);

    loadAccounts.mockResolvedValue(
      makeAccountsData([{ email: "a@test.com" }, { email: "b@test.com", enabled: false }], { activeIndex: 1 }),
    );

    await manager.syncActiveIndexFromDisk();
    // Should stay on 0 because account 1 is disabled
    expect(manager.getCurrentIndex()).toBe(0);
  });

  it("syncActiveIndexFromDisk no-ops when disk matches memory", async () => {
    manager = await loadManagerFromStored([
      { email: "a@test.com" },
      { email: "b@test.com", refreshToken: "token2", access: "access2" },
    ]);

    expect(manager.getCurrentIndex()).toBe(0);

    loadAccounts.mockResolvedValue(makeAccountsData([{ email: "a@test.com" }, { email: "b@test.com" }]));

    await manager.syncActiveIndexFromDisk();
    expect(manager.getCurrentIndex()).toBe(0);
  });

  it("syncActiveIndexFromDisk reconciles removed accounts from disk", async () => {
    manager = await loadManagerFromStored([
      { email: "a@test.com" },
      { email: "b@test.com", refreshToken: "token2", access: "access2" },
    ]);

    loadAccounts.mockResolvedValue(makeAccountsData([{ email: "a@test.com" }]));

    await manager.syncActiveIndexFromDisk();
    await manager.saveToDisk();

    const saved = saveAccounts.mock.calls.at(-1)?.[0];
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0].refreshToken).toBe("token1");
  });

  it("syncActiveIndexFromDisk updates enabled state from disk", async () => {
    manager = await loadManagerFromStored([
      { email: "a@test.com" },
      { email: "b@test.com", refreshToken: "token2", access: "access2" },
    ]);

    loadAccounts.mockResolvedValue(
      makeAccountsData([{ email: "a@test.com", enabled: false }, { email: "b@test.com" }], { activeIndex: 1 }),
    );

    await manager.syncActiveIndexFromDisk();
    expect(manager.getCurrentIndex()).toBe(1);
  });

  it("syncActiveIndexFromDisk reconciles by stable id when refresh token rotates", async () => {
    const current = manager.getAccountsSnapshot()[0];

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: current.id,
          refreshToken: "token1-rotated",
          access: "rotated-access",
          expires: Date.now() + 7200_000,
          tokenUpdatedAt: Date.now() + 5_000,
        },
      ]),
    );

    await manager.syncActiveIndexFromDisk();
    const snapshot = manager.getAccountsSnapshot();

    expect(snapshot[0].id).toBe(current.id);
    expect(snapshot[0].refreshToken).toBe("token1-rotated");
    expect(snapshot[0].access).toBe("rotated-access");
  });

  it("syncActiveIndexFromDisk picks up accountUuid changes from disk", async () => {
    const current = manager.getAccountsSnapshot()[0];

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: current.id,
          refreshToken: current.refreshToken,
          access: current.access,
          accountUuid: "acc-uuid-123",
        },
      ]),
    );

    await manager.syncActiveIndexFromDisk();
    const snapshot = manager.getAccountsSnapshot();

    expect(snapshot[0].accountUuid).toBe("acc-uuid-123");
  });
});

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

describe("AccountManager usage stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createManagerWithAccounts(n = 2) {
    const overrides = Array.from({ length: n }, (_, index) => ({
      refreshToken: `tok-${index + 1}`,
      access: `access-${index + 1}`,
      email: index === 0 ? undefined : `user${index + 1}@test.com`,
    }));
    return loadManagerFromStored(overrides);
  }

  it("recordUsage increments stats for the given account", async () => {
    const manager = await createManagerWithAccounts(2);
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 });

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(1);
    expect(snap[0].stats.inputTokens).toBe(100);
    expect(snap[0].stats.outputTokens).toBe(50);
    expect(snap[0].stats.cacheReadTokens).toBe(10);
    expect(snap[0].stats.cacheWriteTokens).toBe(5);
    // Account 1 should be untouched
    expect(snap[1].stats.requests).toBe(0);
  });

  it("recordUsage accumulates over multiple calls", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50 });
    manager.recordUsage(0, { inputTokens: 200, outputTokens: 100 });

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(2);
    expect(snap[0].stats.inputTokens).toBe(300);
    expect(snap[0].stats.outputTokens).toBe(150);
  });

  it("recordUsage handles missing fields gracefully", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, {});

    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(1);
    expect(snap[0].stats.inputTokens).toBe(0);
  });

  it("recordUsage ignores invalid index", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(99, { inputTokens: 100 });
    // Should not throw
    const snap = manager.getAccountsSnapshot();
    expect(snap[0].stats.requests).toBe(0);
  });

  it("stats are included in saveToDisk output", async () => {
    const manager = await createManagerWithAccounts(1);
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50 });

    await manager.saveToDisk();

    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({
            stats: expect.objectContaining({
              requests: 1,
              inputTokens: 100,
              outputTokens: 50,
            }),
          }),
        ]),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Merge-on-save (concurrent instance support)
// ---------------------------------------------------------------------------

describe("AccountManager merge-on-save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function createManagerWithAccounts(n = 1) {
    const overrides = Array.from({ length: n }, (_, index) => ({
      refreshToken: `tok-${index + 1}`,
      access: `access-${index + 1}`,
      email: index === 0 ? undefined : `user${index + 1}@test.com`,
    }));
    const manager = await loadManagerFromStored(overrides);
    // Save once to establish baseline, then clear mocks
    await manager.saveToDisk();
    vi.clearAllMocks();
    return manager;
  }

  it("merges stats with disk values on save", async () => {
    const manager = await createManagerWithAccounts(1);
    const snap = manager.getAccountsSnapshot();
    const accountId = snap[0].id;

    // Simulate another instance having written stats to disk
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: accountId,
          refreshToken: "tok-1",
          stats: {
            requests: 50,
            inputTokens: 10000,
            outputTokens: 5000,
            cacheReadTokens: 1000,
            cacheWriteTokens: 500,
            lastReset: 1000,
          },
        },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    // This instance records 3 requests
    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 });
    manager.recordUsage(0, { inputTokens: 200, outputTokens: 100 });
    manager.recordUsage(0, { inputTokens: 300, outputTokens: 150 });

    await manager.saveToDisk();

    const saved = saveAccounts.mock.calls[0][0];
    const stats = saved.accounts[0].stats;

    // Should be disk values + our deltas
    expect(stats.requests).toBe(53); // 50 + 3
    expect(stats.inputTokens).toBe(10600); // 10000 + 100 + 200 + 300
    expect(stats.outputTokens).toBe(5300); // 5000 + 50 + 100 + 150
    expect(stats.cacheReadTokens).toBe(1010); // 1000 + 10
    expect(stats.cacheWriteTokens).toBe(505); // 500 + 5
    expect(stats.lastReset).toBe(1000); // Preserved from disk
  });

  it("clears deltas after save", async () => {
    const manager = await createManagerWithAccounts(1);
    const snap = manager.getAccountsSnapshot();
    const accountId = snap[0].id;

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: accountId,
          refreshToken: "tok-1",
          stats: {
            requests: 10,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            lastReset: 1000,
          },
        },
      ]),
    );
    saveAccounts.mockResolvedValue(undefined);

    manager.recordUsage(0, { inputTokens: 100 });
    await manager.saveToDisk();

    // First save: 10 + 1 = 11 requests
    expect(saveAccounts.mock.calls[0][0].accounts[0].stats.requests).toBe(11);

    // Second save with no new usage should write disk values as-is (no delta)
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: accountId,
          refreshToken: "tok-1",
          stats: {
            requests: 11,
            inputTokens: 1100,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            lastReset: 1000,
          },
        },
      ]),
    );

    await manager.saveToDisk();
    // No delta, so stats should match what's on disk
    expect(saveAccounts.mock.calls[1][0].accounts[0].stats.requests).toBe(11);
  });

  it("falls through to absolute values when disk read fails", async () => {
    const manager = await createManagerWithAccounts(1);

    // Disk read fails
    loadAccounts.mockRejectedValue(new Error("disk error"));
    saveAccounts.mockResolvedValue(undefined);

    manager.recordUsage(0, { inputTokens: 100, outputTokens: 50 });
    await manager.saveToDisk();

    // Should write in-memory stats as-is
    const stats = saveAccounts.mock.calls[0][0].accounts[0].stats;
    expect(stats.requests).toBe(1);
    expect(stats.inputTokens).toBe(100);
  });

  it("does not let stale in-memory auth overwrite fresher disk auth", async () => {
    const manager = await createManagerWithAccounts(1);
    const account = manager.getAccountsSnapshot()[0];

    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: account.id,
          refreshToken: "disk-rotated-refresh",
          access: "disk-fresh-access",
          expires: Date.now() + 9_000_000,
          tokenUpdatedAt: Date.now() + 10_000,
        },
      ]),
    );

    await manager.saveToDisk();

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].refreshToken).toBe("disk-rotated-refresh");
    expect(saved.accounts[0].access).toBe("disk-fresh-access");
    expect(saved.accounts[0].tokenUpdatedAt).toBeGreaterThan(account.tokenUpdatedAt);
  });

  it("matches id-less disk records by addedAt when merging auth freshness", async () => {
    const manager = await createManagerWithAccounts(1);
    const account = manager.getAccountsSnapshot()[0];

    // Simulate legacy/id-less disk record after token rotation.
    loadAccounts.mockResolvedValue(
      makeAccountsData([
        {
          id: undefined,
          addedAt: account.addedAt,
          refreshToken: "disk-rotated-no-id",
          access: "disk-fresh-no-id",
          expires: Date.now() + 9_000_000,
          tokenUpdatedAt: Date.now() + 10_000,
        },
      ]),
    );

    await manager.saveToDisk();

    const saved = saveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].refreshToken).toBe("disk-rotated-no-id");
    expect(saved.accounts[0].access).toBe("disk-fresh-no-id");
  });
});
