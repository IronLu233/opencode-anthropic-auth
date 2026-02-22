import { describe, it, expect } from "vitest";
import { DEFAULT_HEADER_PROFILE, getHeaderProfile, getDefaultBetas } from "./request-headers.mjs";

describe("request headers profile", () => {
  it("returns default profile for unknown profile names", () => {
    const profile = getHeaderProfile("unknown");
    expect(profile).toEqual(getHeaderProfile(DEFAULT_HEADER_PROFILE));
  });

  it("maps claude-cli-latest alias to current pinned profile", () => {
    expect(getHeaderProfile("claude-cli-latest")).toEqual(getHeaderProfile("claude-cli-2.1.50"));
  });

  it("adds opus-only beta for opus models", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-opus-4-1");
    expect(betas).toContain("context-management-2025-06-27");
  });

  it("does not add opus-only beta for sonnet models", () => {
    const betas = getDefaultBetas(DEFAULT_HEADER_PROFILE, "claude-sonnet-4-5");
    expect(betas).not.toContain("context-management-2025-06-27");
  });
});
