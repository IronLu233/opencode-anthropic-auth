import { describe, it, expect } from "vitest";
import {
  applyAuthenticatedAccount,
  applyLoginCredentials,
  applyOAuthCredentials,
  applyReauthCredentials,
  createOAuthAccountRecord,
  ensureAccountStorage,
  resetAccountTracking,
  adjustActiveIndexAfterRemoval,
} from "./account-state.mjs";

describe("resetAccountTracking", () => {
  it("resets rate-limit and failure fields", () => {
    const account = {
      rateLimitResetTimes: { anthropic: Date.now() + 60_000 },
      consecutiveFailures: 7,
      lastFailureTime: Date.now(),
    };

    resetAccountTracking(account);

    expect(account.rateLimitResetTimes).toEqual({});
    expect(account.consecutiveFailures).toBe(0);
    expect(account.lastFailureTime).toBeNull();
  });
});

describe("applyOAuthCredentials", () => {
  it("applies refresh/access/expiry and optional email", () => {
    const account = {
      refreshToken: "old-refresh",
      access: "old-access",
      expires: 1,
      email: "old@example.com",
    };

    applyOAuthCredentials(account, {
      refresh: "new-refresh",
      access: "new-access",
      expires: 123,
      email: "new@example.com",
    });

    expect(account).toEqual({
      refreshToken: "new-refresh",
      access: "new-access",
      expires: 123,
      tokenUpdatedAt: expect.any(Number),
      email: "new@example.com",
    });
  });

  it("preserves existing email when credentials omit email", () => {
    const account = {
      refreshToken: "old-refresh",
      access: "old-access",
      expires: 1,
      email: "old@example.com",
    };

    applyOAuthCredentials(account, {
      refresh: "new-refresh",
      access: "new-access",
      expires: 456,
    });

    expect(account.email).toBe("old@example.com");
    expect(account.refreshToken).toBe("new-refresh");
    expect(account.access).toBe("new-access");
    expect(account.expires).toBe(456);
    expect(account.tokenUpdatedAt).toEqual(expect.any(Number));
  });
});

describe("adjustActiveIndexAfterRemoval", () => {
  it("resets activeIndex to 0 when no accounts remain", () => {
    const storage = { accounts: [], activeIndex: 3 };
    adjustActiveIndexAfterRemoval(storage, 0);
    expect(storage.activeIndex).toBe(0);
  });

  it("clamps activeIndex when it falls out of range", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }],
      activeIndex: 2,
    };
    adjustActiveIndexAfterRemoval(storage, 0);
    expect(storage.activeIndex).toBe(1);
  });

  it("decrements activeIndex when removed index is before active", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      activeIndex: 2,
    };
    adjustActiveIndexAfterRemoval(storage, 0);
    expect(storage.activeIndex).toBe(1);
  });

  it("keeps activeIndex when removed index is after active", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      activeIndex: 0,
    };
    adjustActiveIndexAfterRemoval(storage, 2);
    expect(storage.activeIndex).toBe(0);
  });

  it("keeps activeIndex when removed index was the active slot", () => {
    const storage = {
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      activeIndex: 1,
    };
    adjustActiveIndexAfterRemoval(storage, 1);
    expect(storage.activeIndex).toBe(1);
  });
});

describe("ensureAccountStorage", () => {
  it("creates an empty storage object when none exists", () => {
    expect(ensureAccountStorage(null)).toEqual({ version: 1, accounts: [], activeIndex: 0 });
  });
});

describe("createOAuthAccountRecord", () => {
  it("creates a normalized enabled account record", () => {
    const account = createOAuthAccountRecord(
      { refresh: "refresh-token-123", access: "access-token", expires: 12345, email: "user@example.com" },
      1000,
    );

    expect(account).toEqual(
      expect.objectContaining({
        id: expect.stringContaining("refresh-token".slice(0, 12)),
        email: "user@example.com",
        refreshToken: "refresh-token-123",
        access: "access-token",
        expires: 12345,
        tokenUpdatedAt: 1000,
        addedAt: 1000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      }),
    );
  });
});

describe("applyAuthenticatedAccount", () => {
  it("updates credentials and resets account state", () => {
    const account = {
      refreshToken: "old-refresh",
      access: "old-access",
      expires: 1,
      enabled: false,
      rateLimitResetTimes: { anthropic: 5 },
      consecutiveFailures: 3,
      lastFailureTime: 9,
    };

    applyAuthenticatedAccount(account, {
      refresh: "new-refresh",
      access: "new-access",
      expires: 99,
    });

    expect(account).toEqual(
      expect.objectContaining({
        refreshToken: "new-refresh",
        access: "new-access",
        expires: 99,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      }),
    );
  });
});

describe("applyLoginCredentials", () => {
  it("updates an existing duplicate account", () => {
    const storage = {
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "dup-refresh",
          access: "old-access",
          expires: 1,
          enabled: false,
          rateLimitResetTimes: { anthropic: 5 },
          consecutiveFailures: 2,
          lastFailureTime: 10,
        },
      ],
    };

    const result = applyLoginCredentials(storage, {
      refresh: "dup-refresh",
      access: "new-access",
      expires: 20,
      email: "updated@example.com",
    });

    expect(result).toEqual({ storage, action: "updated", index: 0 });
    expect(storage.accounts[0]).toEqual(
      expect.objectContaining({
        access: "new-access",
        expires: 20,
        email: "updated@example.com",
        enabled: true,
        rateLimitResetTimes: {},
      }),
    );
  });

  it("adds a new account when there is capacity", () => {
    const storage = { version: 1, activeIndex: 0, accounts: [] };
    const result = applyLoginCredentials(storage, {
      refresh: "new-refresh",
      access: "new-access",
      expires: 20,
    });

    expect(result.action).toBe("added");
    expect(result.index).toBe(0);
    expect(storage.accounts).toHaveLength(1);
    expect(storage.accounts[0].refreshToken).toBe("new-refresh");
  });

  it("refuses to add a new account when at capacity", () => {
    const storage = {
      version: 1,
      activeIndex: 0,
      accounts: Array.from({ length: 10 }, (_, i) => ({ refreshToken: `refresh-${i}` })),
    };
    const result = applyLoginCredentials(storage, {
      refresh: "extra-refresh",
      access: "new-access",
      expires: 20,
    });

    expect(result.action).toBe("capacity_reached");
    expect(storage.accounts).toHaveLength(10);
  });
});

describe("applyReauthCredentials", () => {
  it("updates a specific account during reauth", () => {
    const storage = {
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-1",
          access: "old",
          expires: 1,
          enabled: false,
          rateLimitResetTimes: { anthropic: 5 },
          consecutiveFailures: 1,
          lastFailureTime: 10,
        },
      ],
    };

    const result = applyReauthCredentials(storage, 0, {
      refresh: "refresh-2",
      access: "new",
      expires: 9,
      email: "reauth@example.com",
    });

    expect(result).toEqual(expect.objectContaining({ type: "updated", index: 0, account: expect.any(Object) }));
    expect(result.account).toEqual(
      expect.objectContaining({
        refreshToken: "refresh-2",
        access: "new",
        expires: 9,
        email: "reauth@example.com",
        enabled: true,
      }),
    );
  });

  it("refuses reauth when credentials already belong to another account", () => {
    const storage = {
      version: 1,
      activeIndex: 0,
      accounts: [{ refreshToken: "refresh-1" }, { refreshToken: "refresh-2" }],
    };

    expect(
      applyReauthCredentials(storage, 0, {
        refresh: "refresh-2",
        access: "new",
        expires: 9,
      }),
    ).toEqual({ type: "duplicate", index: 1 });
  });
});
