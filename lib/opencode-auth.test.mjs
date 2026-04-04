import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getOpenCodeAuth,
  clearOpenCodeAuth,
  getOpenCodeSyncAccount,
  syncOpenCodeAuthFromStorage,
} from "./opencode-auth.mjs";

const baseDir = join(tmpdir(), `opencode-auth-test-${process.pid}`);
const dataDir = join(baseDir, "xdg-data");
const authPath = join(dataDir, "opencode", "auth.json");

beforeEach(async () => {
  process.env.XDG_DATA_HOME = dataDir;
  await fs.rm(baseDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe("getOpenCodeSyncAccount", () => {
  it("prefers the active enabled account when it has usable auth", () => {
    const account = getOpenCodeSyncAccount({
      activeIndex: 1,
      accounts: [
        { refreshToken: "refresh-1", access: "access-1", expires: 1, enabled: true },
        { refreshToken: "refresh-2", access: "access-2", expires: 2, enabled: true },
      ],
    });

    expect(account?.refreshToken).toBe("refresh-2");
  });

  it("falls back to the first enabled account with complete auth", () => {
    const account = getOpenCodeSyncAccount({
      activeIndex: 0,
      accounts: [
        { refreshToken: "refresh-1", enabled: true },
        { refreshToken: "refresh-2", access: "access-2", expires: 2, enabled: true },
      ],
    });

    expect(account?.refreshToken).toBe("refresh-2");
  });

  it("returns null when no enabled account has complete auth", () => {
    expect(
      getOpenCodeSyncAccount({
        activeIndex: 0,
        accounts: [
          { refreshToken: "refresh-1", enabled: true },
          { refreshToken: "refresh-2", enabled: false },
        ],
      }),
    ).toBeNull();
  });
});

describe("syncOpenCodeAuthFromStorage", () => {
  it("writes the selected account into auth.json", async () => {
    await syncOpenCodeAuthFromStorage({
      activeIndex: 1,
      accounts: [
        { refreshToken: "refresh-1", access: "access-1", expires: 1000, enabled: true, tokenUpdatedAt: 10 },
        {
          refreshToken: "refresh-2",
          access: "access-2",
          expires: Date.now() + 60_000,
          accountUuid: "account-uuid-2",
          enabled: true,
          tokenUpdatedAt: 20,
        },
      ],
    });

    await expect(getOpenCodeAuth()).resolves.toEqual({
      type: "oauth",
      refresh: "refresh-2",
      access: "access-2",
      expires: expect.any(Number),
      accountUuid: "account-uuid-2",
    });

    const raw = JSON.parse(await fs.readFile(authPath, "utf-8"));
    expect(raw.anthropic.accountUuid).toBe("account-uuid-2");
    expect(raw.anthropic.tokenUpdatedAt).toBe(20);
  });

  it("prefers newer tokenUpdatedAt even when expires is shorter", async () => {
    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-old",
          access: "access-old",
          expires: Date.now() + 120_000,
          enabled: true,
          tokenUpdatedAt: 10,
        },
      ],
    });

    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-new",
          access: "access-new",
          expires: Date.now() + 60_000,
          enabled: true,
          tokenUpdatedAt: 20,
        },
      ],
    });

    await expect(getOpenCodeAuth()).resolves.toEqual({
      type: "oauth",
      refresh: "refresh-new",
      access: "access-new",
      expires: expect.any(Number),
    });
  });

  it("does not overwrite newer auth.json tokens with older storage tokens that expire later", async () => {
    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-new",
          access: "access-new",
          expires: Date.now() + 60_000,
          enabled: true,
          tokenUpdatedAt: 20,
        },
      ],
    });

    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-old",
          access: "access-old",
          expires: Date.now() + 120_000,
          enabled: true,
          tokenUpdatedAt: 10,
        },
      ],
    });

    await expect(getOpenCodeAuth()).resolves.toEqual({
      type: "oauth",
      refresh: "refresh-new",
      access: "access-new",
      expires: expect.any(Number),
    });
  });

  it("clears the auth entry when clearIfMissing is true and no usable account remains", async () => {
    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-1",
          access: "access-1",
          expires: Date.now() + 60_000,
          enabled: true,
          tokenUpdatedAt: 10,
        },
      ],
    });

    await syncOpenCodeAuthFromStorage({ activeIndex: 0, accounts: [] }, { clearIfMissing: true });
    await expect(getOpenCodeAuth()).resolves.toBeNull();
  });

  it("honors legacy token_updated_at when comparing freshness", async () => {
    await fs.mkdir(join(dataDir, "opencode"), { recursive: true });
    await fs.writeFile(
      authPath,
      JSON.stringify(
        {
          anthropic: {
            type: "oauth",
            refresh: "legacy-refresh",
            access: "legacy-access",
            expires: Date.now() + 60_000,
            token_updated_at: 25,
          },
        },
        null,
        2,
      ),
    );

    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-old",
          access: "access-old",
          expires: Date.now() + 120_000,
          enabled: true,
          tokenUpdatedAt: 10,
        },
      ],
    });

    await expect(getOpenCodeAuth()).resolves.toEqual({
      type: "oauth",
      refresh: "legacy-refresh",
      access: "legacy-access",
      expires: expect.any(Number),
    });
  });

  it("clearOpenCodeAuth removes the provider entry", async () => {
    await syncOpenCodeAuthFromStorage({
      activeIndex: 0,
      accounts: [
        {
          refreshToken: "refresh-1",
          access: "access-1",
          expires: Date.now() + 60_000,
          enabled: true,
          tokenUpdatedAt: 10,
        },
      ],
    });

    await clearOpenCodeAuth();
    await expect(getOpenCodeAuth()).resolves.toBeNull();
  });
});
