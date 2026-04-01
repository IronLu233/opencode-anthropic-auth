import { getHeaderProfile, getDefaultBetas, getBillingHeaderBlock } from "./request-headers.mjs";

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/**
 * @param {string | undefined} body
 * @param {(parsed: any) => void} update
 * @returns {string | undefined}
 */
function updateJsonBody(body, update) {
  if (!body || typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body);
    update(parsed);
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * @param {any} input
 * @param {RequestInit} requestInit
 * @param {string} accessToken
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @param {string | undefined} modelName
 * @returns {Headers}
 */
export function buildRequestHeaders(input, requestInit, accessToken, headerConfig, modelName) {
  const requestHeaders = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }
  if (requestInit.headers) {
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(requestInit.headers)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }

  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const profile = getHeaderProfile(headerConfig.emulation_profile);
  const disabledHeaders = new Set(headerConfig.disable.map((name) => name.toLowerCase()));

  for (const [key, value] of Object.entries(profile.headers)) {
    if (!disabledHeaders.has(key.toLowerCase())) {
      requestHeaders.set(key, value);
    }
  }

  let anthropicBetaOverride = null;
  for (const [key, value] of Object.entries(headerConfig.overrides)) {
    if (key.toLowerCase() === "anthropic-beta") {
      anthropicBetaOverride = value;
      continue;
    }
    requestHeaders.set(key, value);
  }

  for (const name of disabledHeaders) {
    requestHeaders.delete(name);
  }

  const defaultBetas = getDefaultBetas(headerConfig.emulation_profile, modelName);
  const configuredBetas = anthropicBetaOverride
    ? anthropicBetaOverride
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean)
    : defaultBetas;
  const mergedBetas = [...new Set([...configuredBetas, ...incomingBetasList])].join(",");

  requestHeaders.set("authorization", `Bearer ${accessToken}`);
  if (!disabledHeaders.has("anthropic-beta")) {
    requestHeaders.set("anthropic-beta", mergedBetas);
  }
  requestHeaders.delete("x-api-key");

  return requestHeaders;
}

/**
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
export function extractModelName(body) {
  if (!body || typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.model === "string" && parsed.model) {
      return parsed.model;
    }
  } catch {
    // ignore parse errors
  }
  return undefined;
}

/**
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
export function transformRequestBody(body) {
  const TOOL_PREFIX = "mcp_";

  return updateJsonBody(body, (parsed) => {
    if (!parsed || typeof parsed !== "object") return;

    if (parsed.system && Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item) => {
        if (item.type === "text" && item.text) {
          return {
            ...item,
            text: item.text
              .replace(/^You are OpenCode, the best coding agent on the planet\.\n*/m, "")
              .replace(/OpenCode/g, "Claude Code")
              .replace(/(?<!\/)opencode/gi, "Claude"),
          };
        }
        return item;
      });
    }

    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }));
    }
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === "tool_use" && block.name) {
              return {
                ...block,
                name: `${TOOL_PREFIX}${block.name}`,
              };
            }
            return block;
          });
        }
        return msg;
      });
    }
  });
}

/**
 * @param {URL | null} requestUrl
 * @returns {boolean}
 */
function isAnthropicRequestUrl(requestUrl) {
  return requestUrl?.hostname === "api.anthropic.com";
}

/**
 * @param {string | undefined} body
 * @param {URL | null} requestUrl
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @returns {string | undefined}
 */
export function injectBillingHeaderBlock(body, requestUrl, headerConfig) {
  if (!headerConfig.billing_header) return body;
  if (!isAnthropicRequestUrl(requestUrl)) return body;

  return updateJsonBody(body, (parsed) => {
    if (!parsed || typeof parsed !== "object") return;

    /** @type {any[]} */
    const system = Array.isArray(parsed.system)
      ? parsed.system
      : typeof parsed.system === "string"
        ? [{ type: "text", text: parsed.system }]
        : [];
    parsed.system = system.filter(
      (item) =>
        !(
          (typeof item === "string" && item.startsWith(BILLING_HEADER_PREFIX)) ||
          (item?.type === "text" && typeof item.text === "string" && item.text.startsWith(BILLING_HEADER_PREFIX))
        ),
    );

    parsed.system.unshift({
      type: "text",
      text: getBillingHeaderBlock(headerConfig.emulation_profile, parsed.messages),
    });
  });
}

/**
 * @param {any} input
 * @returns {{requestInput: any, requestUrl: URL | null}}
 */
export function transformRequestUrl(input) {
  let requestInput = input;
  let requestUrl = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    }
  } catch {
    requestUrl = null;
  }

  if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
    requestUrl.searchParams.set("beta", "true");
    requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
  }

  return { requestInput, requestUrl };
}
