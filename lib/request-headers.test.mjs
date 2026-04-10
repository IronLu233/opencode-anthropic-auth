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
    expect(getHeaderProfile("unknown")).toEqual(getHeaderProfile(DEFAULT_HEADER_PROFILE));
  });

  it("uses the captured 2.0.74 sdk-cli profile by default", () => {
    const profile = getHeaderProfile(DEFAULT_HEADER_PROFILE);
    expect(profile.ccVersion).toBe("2.0.74");
    expect(profile.headers["user-agent"]).toBe("claude-cli/2.0.74 (external, sdk-cli)");
    expect(profile.headers["x-stainless-arch"]).toBe("x64");
    expect(profile.headers["x-stainless-os"]).toBe("Linux");
    expect(profile.headers["x-stainless-package-version"]).toBe("0.70.0");
    expect(profile.headers["x-stainless-timeout"]).toBe("3000");
    expect(profile.headers["x-stainless-helper-method"]).toBe("stream");
  });

  it("contains only the current token-auth profile keys", () => {
    expect(Object.keys(HEADER_PROFILES).sort()).toEqual(["claude-cli-2.0.74", "claude-cli-default"]);
  });

  it("uses only interleaved-thinking for haiku", () => {
    expect(getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-haiku-4-5-20251001")).toEqual([
      "interleaved-thinking-2025-05-14",
    ]);
  });

  it("adds claude-code beta for sonnet", () => {
    expect(getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-sonnet-4-5-20250929")).toEqual([
      "interleaved-thinking-2025-05-14",
      "claude-code-20250219",
    ]);
  });

  it("adds claude-code beta for opus", () => {
    expect(getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-opus-4-6")).toEqual([
      "interleaved-thinking-2025-05-14",
      "claude-code-20250219",
    ]);
  });

  it("uses base betas when model is missing", () => {
    expect(getDefaultBetas(DEFAULT_HEADER_PROFILE, undefined)).toEqual(["interleaved-thinking-2025-05-14"]);
  });
});

describe("getBillingHeaderBlock", () => {
  it("returns correct format using the active profile version", () => {
    const block = getBillingHeaderBlock(DEFAULT_HEADER_PROFILE);
    expect(block).toMatch(/^x-anthropic-billing-header: cc_version=2\.0\.74\.[0-9a-f]{3}; cc_entrypoint=cli;$/);
  });

  it("does not include cch field", () => {
    expect(getBillingHeaderBlock(DEFAULT_HEADER_PROFILE)).not.toContain("cch=");
  });
});

describe("billing fingerprint helpers", () => {
  it("uses empty string when there is no user message", () => {
    expect(extractFirstUserMessageText([{ role: "assistant", content: "hi" }])).toBe("");
    expect(computeBillingFingerprint("", "2.0.74")).toBe("a45");
  });

  it("uses string content from the first user message", () => {
    const messages = [
      { role: "assistant", content: "ignore me" },
      { role: "user", content: "hello world" },
    ];

    expect(extractFirstUserMessageText(messages)).toBe("hello world");
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.0.74")).toBe("2f2");
  });

  it("uses the first text block for array content", () => {
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
    expect(computeBillingFingerprint(extractFirstUserMessageText(messages), "2.0.74")).toBe("2f2");
  });
});
