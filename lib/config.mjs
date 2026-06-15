import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_HEADER_PROFILE, HEADER_PROFILES } from "./request-headers.mjs";

/**
 * @typedef {object} HeaderConfig
 * @property {string} emulation_profile
 * @property {Record<string, string>} overrides
 * @property {string[]} disable
 * @property {boolean} billing_header
 * @property {boolean} cch_signing
 */

/**
 * @typedef {object} AnthropicAuthConfig
 * @property {HeaderConfig} headers
 */

/** @type {AnthropicAuthConfig} */
export const DEFAULT_CONFIG = {
  headers: {
    emulation_profile: DEFAULT_HEADER_PROFILE,
    overrides: {},
    disable: [],
    billing_header: true,
    cch_signing: false,
  },
};

export function getConfigDir() {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

export function getConfigPath() {
  return join(getConfigDir(), "anthropic-auth.json");
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {AnthropicAuthConfig}
 */
function validateConfig(raw) {
  const config = {
    ...DEFAULT_CONFIG,
    headers: {
      emulation_profile: DEFAULT_CONFIG.headers.emulation_profile,
      overrides: { ...DEFAULT_CONFIG.headers.overrides },
      disable: [...DEFAULT_CONFIG.headers.disable],
      billing_header: DEFAULT_CONFIG.headers.billing_header,
      cch_signing: DEFAULT_CONFIG.headers.cch_signing,
    },
  };

  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const headers = /** @type {Record<string, unknown>} */ (raw.headers);

    if (typeof headers.emulation_profile === "string" && HEADER_PROFILES[headers.emulation_profile.trim()]) {
      config.headers.emulation_profile = headers.emulation_profile.trim();
    }

    if (headers.overrides && typeof headers.overrides === "object" && !Array.isArray(headers.overrides)) {
      /** @type {Record<string, string>} */
      const overrides = {};
      for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (headers.overrides))) {
        if (key && typeof value === "string") {
          overrides[key] = value;
        }
      }
      config.headers.overrides = overrides;
    }

    if (Array.isArray(headers.disable)) {
      config.headers.disable = headers.disable
        .filter((value) => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    }

    if (typeof headers.billing_header === "boolean") {
      config.headers.billing_header = headers.billing_header;
    }

    if (typeof headers.cch_signing === "boolean") {
      config.headers.cch_signing = headers.cch_signing;
    }
  }

  return config;
}

/**
 * @param {AnthropicAuthConfig} config
 * @returns {AnthropicAuthConfig}
 */
function applyEnvOverrides(config) {
  const next = {
    ...config,
    headers: {
      ...config.headers,
      overrides: { ...config.headers.overrides },
      disable: [...config.headers.disable],
    },
  };

  return next;
}

export function loadConfig() {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    }
    return applyEnvOverrides(validateConfig(raw));
  } catch {
    return applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
  }
}

/**
 * @returns {Record<string, unknown>}
 */
function loadRawConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    const content = readFileSync(configPath, "utf-8");
    const raw = JSON.parse(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, unknown>} updates
 */
export function saveConfig(updates) {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });

  const merged = { ...loadRawConfig(), ...updates };
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, configPath);
}
