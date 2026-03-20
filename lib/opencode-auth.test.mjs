import { describe, expect, it } from "vitest";
import { getOpenCodeSyncAccount } from "./opencode-auth.mjs";

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
