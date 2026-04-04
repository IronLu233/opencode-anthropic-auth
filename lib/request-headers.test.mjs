import { describe, it, expect } from "vitest";
import {
  computeBillingFingerprint,
  DEFAULT_HEADER_PROFILE,
  HEADER_PROFILES,
  extractFirstUserMessageText,
  getHeaderProfile,
  getDefaultBetas,
  getBillingHeaderBlock,
} from "./request-headers.mjs";

describe("request headers profile", () => {
  it("returns default profile for unknown profile names", () => {
    const profile = getHeaderProfile("unknown");
    expect(profile).toEqual(getHeaderProfile(DEFAULT_HEADER_PROFILE));
  });

  it("maps claude-cli-default alias to current pinned profile", () => {
    expect(getHeaderProfile("claude-cli-default")).toEqual(getHeaderProfile("claude-cli-2.1.92"));
  });

  it("retains the previous pinned 2.1.90 profile", () => {
    expect(getHeaderProfile("claude-cli-2.1.90").ccVersion).toBe("2.1.90");
  });

  it("adds opus-only beta for opus models", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-opus-4-1");
    expect(betas).toContain("context-management-2025-06-27");
  });

  it("does not add opus-only beta for sonnet models", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-sonnet-4-5");
    expect(betas).not.toContain("context-management-2025-06-27");
  });

  it("returns default profile when called with undefined", () => {
    expect(getHeaderProfile(undefined)).toEqual(getHeaderProfile(DEFAULT_HEADER_PROFILE));
  });

  it("returns default profile when called with empty string", () => {
    expect(getHeaderProfile("")).toEqual(getHeaderProfile(DEFAULT_HEADER_PROFILE));
  });

  it("current profiles contain expected header keys", () => {
    for (const profileName of ["claude-cli-2.1.90", "claude-cli-2.1.92"]) {
      const profile = getHeaderProfile(profileName);
      const expectedKeys = [
        "user-agent",
        "x-app",
        "x-stainless-arch",
        "x-stainless-lang",
        "x-stainless-os",
        "x-stainless-package-version",
        "x-stainless-runtime",
        "x-stainless-runtime-version",
        "x-stainless-timeout",
      ];
      for (const key of expectedKeys) {
        expect(profile.headers).toHaveProperty(key);
      }
    }
  });

  it("user-agent starts with claude-cli/", () => {
    const profile = getHeaderProfile("claude-cli-2.1.90");
    expect(profile.headers["user-agent"]).toMatch(/^claude-cli\//);
  });

  it("getDefaultBetas with null model returns base betas without opus entries", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, null);
    expect(betas).not.toContain("context-management-2025-06-27");
    expect(betas.length).toBeGreaterThan(0);
  });

  it("getDefaultBetas with undefined model returns base betas", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, undefined);
    expect(betas).not.toContain("context-management-2025-06-27");
    expect(betas.length).toBeGreaterThan(0);
  });

  it("getDefaultBetas with dated sonnet model returns base betas only", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-sonnet-4-5-20250514");
    expect(betas).not.toContain("context-management-2025-06-27");
  });

  it("getDefaultBetas with dated opus model includes opus-specific beta", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-opus-4-5-20250514");
    expect(betas.includes("context-management-2025-06-27")).toBe(true);
  });

  it("HEADER_PROFILES contains the expected profile keys", () => {
    expect(HEADER_PROFILES).toHaveProperty("claude-cli-default");
    expect(HEADER_PROFILES).toHaveProperty("claude-cli-2.1.90");
    expect(HEADER_PROFILES).toHaveProperty("claude-cli-2.1.92");
    expect(Object.keys(HEADER_PROFILES).sort()).toEqual([
      "claude-cli-2.1.90",
      "claude-cli-2.1.92",
      "claude-cli-default",
    ]);
  });

  it("beta base list contains expected entries for current default", () => {
    const profile = getHeaderProfile(DEFAULT_HEADER_PROFILE);
    const base = profile.betaBase;
    expect(base).toContain("context-1m-2025-08-07");
    expect(base).toContain("interleaved-thinking-2025-05-14");
    expect(base).toContain("prompt-caching-scope-2026-01-05");
    expect(base).toContain("claude-code-20250219");
    expect(base).toContain("oauth-2025-04-20");
    expect(base).toContain("redact-thinking-2026-02-12");
    expect(base).toContain("advanced-tool-use-2025-11-20");
    expect(base).toContain("effort-2025-11-24");
    expect(base).not.toContain("task-budgets-2026-03-13");
    expect(base).not.toContain("adaptive-thinking-2026-01-28");
  });

  it("all profiles have a ccVersion string", () => {
    for (const [name, profile] of Object.entries(HEADER_PROFILES)) {
      expect(profile.ccVersion, `profile ${name} missing ccVersion`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("keeps the 2.1.90 profile pinned for compatibility", () => {
    const profile = getHeaderProfile("claude-cli-2.1.90");
    expect(profile.headers["user-agent"]).toBe("claude-cli/2.1.90 (external, cli)");
    expect(profile.ccVersion).toBe("2.1.90");
    expect(profile.betaBase).not.toContain("task-budgets-2026-03-13");
    expect(profile.betaBase).toContain("advanced-tool-use-2025-11-20");
  });

  it("keeps the 2.1.92 profile pinned as the default alias target", () => {
    const profile = getHeaderProfile("claude-cli-2.1.92");
    expect(profile.headers["user-agent"]).toBe("claude-cli/2.1.92 (external, cli)");
    expect(profile.ccVersion).toBe("2.1.92");
    expect(profile.betaBase).toEqual(getHeaderProfile("claude-cli-2.1.90").betaBase);
  });
});

describe("getBillingHeaderBlock", () => {
  it("returns correct format matching official Claude Code pattern", () => {
    const block = getBillingHeaderBlock(DEFAULT_HEADER_PROFILE);
    expect(block).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.92\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/,
    );
  });

  it("includes cc_version from the profile", () => {
    const block = getBillingHeaderBlock("claude-cli-2.1.92");
    expect(block).toContain("cc_version=2.1.92.");
  });

  it("emits a signing placeholder cch", () => {
    const block = getBillingHeaderBlock(DEFAULT_HEADER_PROFILE);

    expect(block).toContain("cch=00000;");
  });

  it("falls back to default profile for unknown profile name", () => {
    const block = getBillingHeaderBlock("nonexistent");
    expect(block).toContain("cc_version=2.1.92.");
  });
});

describe("billing fingerprint helpers", () => {
  it("uses empty string when there is no user message", () => {
    expect(extractFirstUserMessageText([{ role: "assistant", content: "hi" }])).toBe("");
    expect(computeBillingFingerprint("", "2.1.92")).toBe("a35");
  });

  it("uses string content from the first user message", () => {
    const messages = [
      { role: "assistant", content: "ignore me" },
      { role: "user", content: "hello world" },
    ];

    expect(extractFirstUserMessageText(messages)).toBe("hello world");
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.1.92")).toBe("460");
  });

  it("uses only the first user message when later user messages differ", () => {
    const messages = [
      { role: "user", content: "hello world" },
      { role: "assistant", content: "ignore me" },
      { role: "user", content: "goodbye world" },
    ];

    expect(extractFirstUserMessageText(messages)).toBe("hello world");
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.1.92")).toBe("460");
  });

  it("uses the first text block when array content starts with a non-text block", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "ignored" },
          { type: "text", text: "hello world" },
        ],
      },
    ];

    expect(extractFirstUserMessageText(messages)).toBe("hello world");
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.1.92")).toBe("460");
  });

  it("uses empty string when array user content has no text block", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ignored" }],
      },
    ];

    expect(extractFirstUserMessageText(messages)).toBe("");
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.1.92")).toBe("a35");
  });

  it("fills missing fingerprint characters with zero for short text", () => {
    const messages = [{ role: "user", content: "abcd" }];

    expect(extractFirstUserMessageText(messages)).toBe("abcd");
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.1.92")).toBe("a35");
  });
});
