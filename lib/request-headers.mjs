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
 * Captured from a real Claude Code token-auth request sent through a custom
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` setup.
 * @type {HeaderProfile}
 */
const CLAUDE_CLI_2_0_74_PROFILE = {
  ccVersion: "2.0.74",
  headers: {
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/2.0.74 (external, sdk-cli)",
    "x-app": "cli",
    "x-stainless-arch": "x64",
    "x-stainless-helper-method": "stream",
    "x-stainless-lang": "js",
    "x-stainless-os": "Linux",
    "x-stainless-package-version": "0.70.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.3.0",
    "x-stainless-timeout": "3000",
  },
  betaBase: ["interleaved-thinking-2025-05-14"],
  betaByModel: {
    opus: ["claude-code-20250219"],
    sonnet: ["claude-code-20250219"],
  },
};

/** @type {Record<string, HeaderProfile>} */
export const HEADER_PROFILES = {
  "claude-cli-default": CLAUDE_CLI_2_0_74_PROFILE,
  "claude-cli-2.0.74": CLAUDE_CLI_2_0_74_PROFILE,
};

export const DEFAULT_HEADER_PROFILE = "claude-cli-2.0.74";

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
 * @returns {"haiku" | "sonnet" | "opus" | null}
 */
function detectModelFamily(model) {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("sonnet")) return "sonnet";
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
  return `x-anthropic-billing-header: cc_version=${profile.ccVersion}.${fingerprint}; cc_entrypoint=cli;`;
}
