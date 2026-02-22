/**
 * @typedef {object} HeaderProfile
 * @property {Record<string, string>} headers
 * @property {string[]} betaBase
 * @property {{ opus?: string[] }} betaByModel
 */

/** @type {HeaderProfile} */
const CLAUDE_CLI_2_1_50_PROFILE = {
  headers: {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.50 (external, cli)",
    "x-app": "cli",
    "x-stainless-arch": "arm64",
    "x-stainless-lang": "js",
    "x-stainless-os": "MacOS",
    "x-stainless-package-version": "0.74.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "x-stainless-timeout": "600",
  },
  betaBase: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "effort-2025-11-24",
    "adaptive-thinking-2026-01-28",
  ],
  betaByModel: {
    opus: ["context-management-2025-06-27"],
  },
};

/** @type {Record<string, HeaderProfile>} */
export const HEADER_PROFILES = {
  "claude-cli-latest": CLAUDE_CLI_2_1_50_PROFILE,
  "claude-cli-2.1.50": CLAUDE_CLI_2_1_50_PROFILE,
};

export const DEFAULT_HEADER_PROFILE = "claude-cli-2.1.50";

/**
 * @param {string | undefined} profileName
 * @returns {HeaderProfile}
 */
export function getHeaderProfile(profileName) {
  if (profileName && HEADER_PROFILES[profileName]) {
    return HEADER_PROFILES[profileName];
  }
  return HEADER_PROFILES[DEFAULT_HEADER_PROFILE];
}

/**
 * @param {string | undefined} model
 * @returns {"opus" | null}
 */
function detectModelFamily(model) {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return "opus";
  return null;
}

/**
 * @param {string | undefined} profileName
 * @param {string | undefined} model
 * @returns {string[]}
 */
export function getDefaultBetas(profileName, model) {
  const profile = getHeaderProfile(profileName);
  const family = detectModelFamily(model);
  const familyBetas = family ? profile.betaByModel[family] || [] : [];
  return [...profile.betaBase, ...familyBetas];
}
