import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, getConfigDir, getConfigPath, loadConfig } from "./config.mjs";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

describe("DEFAULT_CONFIG", () => {
  it("has the expected defaults", () => {
    expect(DEFAULT_CONFIG).toEqual({
      debug: false,
      headers: {
        emulation_profile: "claude-cli-2.0.74",
        overrides: {},
        disable: [],
        billing_header: true,
        cch_signing: false,
      },
    });
  });
});

describe("config paths", () => {
  it("returns a config dir ending with opencode", () => {
    expect(getConfigDir().endsWith("opencode")).toBe(true);
  });

  it("returns a config path ending with anthropic-auth.json", () => {
    expect(getConfigPath().endsWith("anthropic-auth.json")).toBe(true);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.OPENCODE_ANTHROPIC_DEBUG;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when the config file is missing", () => {
    existsSync.mockReturnValue(false);
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults when the config file is invalid", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("not json");
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it("merges header config values", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        debug: true,
        headers: {
          emulation_profile: "claude-cli-2.0.74",
          overrides: { "x-app": "custom-app" },
          disable: [" X-Stainless-Timeout ", 42],
          billing_header: false,
          cch_signing: true,
        },
      }),
    );

    expect(loadConfig()).toEqual({
      debug: true,
      headers: {
        emulation_profile: "claude-cli-2.0.74",
        overrides: { "x-app": "custom-app" },
        disable: ["x-stainless-timeout"],
        billing_header: false,
        cch_signing: true,
      },
    });
  });

  it("falls back to the default header profile for unknown profiles", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ headers: { emulation_profile: "unknown-profile" } }));
    expect(loadConfig().headers.emulation_profile).toBe("claude-cli-2.0.74");
  });

  it("ignores non-string override values", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({ headers: { overrides: { "x-app": true, accept: "application/json" } } }),
    );
    expect(loadConfig().headers.overrides).toEqual({ accept: "application/json" });
  });

  it("enables debug from OPENCODE_ANTHROPIC_DEBUG", () => {
    existsSync.mockReturnValue(false);
    process.env.OPENCODE_ANTHROPIC_DEBUG = "1";
    expect(loadConfig().debug).toBe(true);
  });

  it("disables debug from OPENCODE_ANTHROPIC_DEBUG even if config enables it", () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(JSON.stringify({ debug: true }));
    process.env.OPENCODE_ANTHROPIC_DEBUG = "false";
    expect(loadConfig().debug).toBe(false);
  });

  it("returns independent objects on each call", () => {
    existsSync.mockReturnValue(false);
    const first = loadConfig();
    const second = loadConfig();
    expect(first).toEqual(second);
    expect(first.headers).not.toBe(second.headers);
  });
});
