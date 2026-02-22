import { describe, it, expect } from "vitest";
import { DEFAULT_HEADER_PROFILE, HEADER_PROFILES, getHeaderProfile, getDefaultBetas } from "./request-headers.mjs";

describe("request headers profile", () => {
  it("returns default profile for unknown profile names", () => {
    const profile = getHeaderProfile("unknown");
    expect(profile).toEqual(getHeaderProfile(DEFAULT_HEADER_PROFILE));
  });

  it("maps claude-cli-default alias to current pinned profile", () => {
    expect(getHeaderProfile("claude-cli-default")).toEqual(getHeaderProfile("claude-cli-2.1.50"));
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

  it("claude-cli-2.1.50 profile contains expected header keys", () => {
    const profile = getHeaderProfile("claude-cli-2.1.50");
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
  });

  it("user-agent starts with claude-cli/", () => {
    const profile = getHeaderProfile("claude-cli-2.1.50");
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

  it("HEADER_PROFILES contains both expected keys", () => {
    expect(HEADER_PROFILES).toHaveProperty("claude-cli-default");
    expect(HEADER_PROFILES).toHaveProperty("claude-cli-2.1.50");
  });

  it("beta base list contains expected entries", () => {
    const profile = getHeaderProfile(DEFAULT_HEADER_PROFILE);
    const base = profile.betaBase;
    expect(base).toContain("interleaved-thinking-2025-05-14");
    expect(base).toContain("prompt-caching-scope-2026-01-05");
    expect(base).toContain("claude-code-20250219");
    expect(base).toContain("oauth-2025-04-20");
  });
});
