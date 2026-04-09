import { createHash } from "node:crypto";

export const BILLING_FINGERPRINT_SALT = "59cf53e54c78";

/**
 * @typedef {object} HeaderProfile
 * @property {string} ccVersion
 * @property {Record<string, string>} headers
 * @property {string[]} betaBase
 * @property {{ opus?: string[] }} betaByModel
 */

/**
 * Derived from Claude Code OSS 2.1.90 (`src/constants/betas.ts`,
 * `src/utils/betas.ts`, `src/utils/http.ts`).
 *
 * Beta list reflects what a 1P external OAuth subscriber sees for a non-Haiku
 * model with ISP, 1M context, and redact-thinking support. `task-budgets`
 * exists in OSS but is intentionally omitted here because the server rejects
 * it for third-party clients.
 *
 * `context-management-2025-06-27` moved to betaBase: OSS sends it for all
 * Claude 4+ models on firstParty (modelSupportsContextManagement returns true
 * for any non-claude-3- model), not just Opus.
 * @type {HeaderProfile}
 */
const CLAUDE_CLI_2_1_90_PROFILE = {
  ccVersion: "2.1.90",
  headers: {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.1.90 (external, cli)",
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
  // Order follows CC OSS getAllModelBetas() push order for 1P external OAuth.
  betaBase: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
    "redact-thinking-2026-02-12",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "advanced-tool-use-2025-11-20",
    "effort-2025-11-24",
    // task-budgets-2026-03-13 is in Claude Code OSS but rejected by the
    // server for third-party clients (likely gated behind an internal
    // feature flag or account allowlist). Omitted to avoid 400 errors.
  ],
  betaByModel: {
    opus: [],
  },
};

/**
 * Derived from the installed Claude Code 2.1.92 binary.
 * The attribution salt, cch seed, and placeholder/gating behavior were
 * re-verified against `/Users/rmk/.local/share/claude/versions/2.1.92`.
 * Current observed request betas match the 2.1.90 baseline.
 * @type {HeaderProfile}
 */
const CLAUDE_CLI_2_1_92_PROFILE = {
  ccVersion: "2.1.92",
  headers: {
    ...CLAUDE_CLI_2_1_90_PROFILE.headers,
    "user-agent": "claude-cli/2.1.92 (external, cli)",
  },
  betaBase: [...CLAUDE_CLI_2_1_90_PROFILE.betaBase],
  betaByModel: {
    opus: [...(CLAUDE_CLI_2_1_90_PROFILE.betaByModel.opus || [])],
  },
};

/**
 * Derived from the installed Claude Code 2.1.97 binary.
 * Current observed request betas match the 2.1.92 baseline.
 * @type {HeaderProfile}
 */
const CLAUDE_CLI_2_1_97_PROFILE = {
  ccVersion: "2.1.97",
  headers: {
    ...CLAUDE_CLI_2_1_92_PROFILE.headers,
    "user-agent": "claude-cli/2.1.97 (external, cli)",
  },
  betaBase: [...CLAUDE_CLI_2_1_92_PROFILE.betaBase],
  betaByModel: {
    opus: [...(CLAUDE_CLI_2_1_92_PROFILE.betaByModel.opus || [])],
  },
};

/** @type {Record<string, HeaderProfile>} */
export const HEADER_PROFILES = {
  "claude-cli-default": CLAUDE_CLI_2_1_97_PROFILE,
  "claude-cli-2.1.90": CLAUDE_CLI_2_1_90_PROFILE,
  "claude-cli-2.1.92": CLAUDE_CLI_2_1_92_PROFILE,
  "claude-cli-2.1.97": CLAUDE_CLI_2_1_97_PROFILE,
};

export const DEFAULT_HEADER_PROFILE = "claude-cli-2.1.97";

/**
 * Adding a new profile version:
 *
 * 1. Define a new `CLAUDE_CLI_x_y_z_PROFILE` constant above with the
 *    captured headers from the target Claude CLI version.
 * 2. Add a versioned entry to `HEADER_PROFILES` (e.g. `"claude-cli-3.0.0"`).
 * 3. Point the `"claude-cli-default"` alias at the new profile constant.
 * 4. Optionally update `DEFAULT_HEADER_PROFILE` to the new versioned key.
 * 5. Update tests in `request-headers.test.mjs` to cover the new profile.
 */

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
 * @param {string | undefined} profileName
 * @returns {string}
 */
export function getCliUserAgent(profileName) {
  return getHeaderProfile(profileName).headers["user-agent"];
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

/**
 * @param {any[] | undefined} messages
 * @returns {string}
 */
export function extractFirstUserMessageText(messages) {
  if (!Array.isArray(messages)) return "";

  const firstUserMessage = messages.find((message) => message?.role === "user");
  const content = firstUserMessage?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block?.type === "text" && typeof block.text === "string");
    return textBlock?.text || "";
  }

  return "";
}

/**
 * @param {string} messageText
 * @param {string} version
 * @returns {string}
 */
export function computeBillingFingerprint(messageText, version) {
  const chars = [4, 7, 20].map((index) => messageText[index] || "0").join("");
  return createHash("sha256").update(`${BILLING_FINGERPRINT_SALT}${chars}${version}`).digest("hex").slice(0, 3);
}

/**
 * Generate a billing header system block matching official Claude Code format.
 * The `cch` value is emitted as a signing placeholder and replaced later at the
 * final serialized request boundary.
 *
 * @param {string | undefined} profileName
 * @param {any[] | undefined} messages
 * @returns {string}
 */
export function getBillingHeaderBlock(profileName, messages) {
  const profile = getHeaderProfile(profileName);
  const firstUserMessageText = extractFirstUserMessageText(messages);
  const fingerprint = computeBillingFingerprint(firstUserMessageText, profile.ccVersion);
  return `x-anthropic-billing-header: cc_version=${profile.ccVersion}.${fingerprint}; cc_entrypoint=cli; cch=00000;`;
}
