import { getHeaderProfile, getDefaultBetas, getBillingHeaderBlock } from "./request-headers.mjs";
import { applyServerVisibleHeaders, isAnthropicRequestUrl } from "./server-visible-identity.mjs";
import { replaceBoundedAnthropicSystemPrompt } from "./anthropic-system-prompt.mjs";

/**
 * @param {string} text
 * @returns {string | null}
 */
function stripLeadingBillingHeaderLine(text) {
  const headerLineRe =
    /^[ \t]*x-anthropic-billing-header: cc_version=[^;\n]+; cc_entrypoint=[^;\n]+;(?: cch=[^;\n]+;)?(?: cc_workload=[^;\n]+;)?[ \t]*$/u;

  /** @param {number} start */
  function nextLine(start) {
    const end = text.indexOf("\n", start);
    const next = end === -1 ? text.length : end + 1;
    return { line: text.slice(start, end === -1 ? text.length : end), next };
  }

  let scan = 0;
  while (scan < text.length) {
    const { line, next } = nextLine(scan);
    if (line.trim() !== "") break;
    scan = next;
  }

  const firstHeader = nextLine(scan);
  if (!headerLineRe.test(firstHeader.line)) {
    return text;
  }

  let stripUntil = firstHeader.next;
  let probe = stripUntil;

  while (probe < text.length) {
    let whitespaceProbe = probe;
    while (whitespaceProbe < text.length) {
      const { line, next } = nextLine(whitespaceProbe);
      if (line.trim() !== "") break;
      whitespaceProbe = next;
    }

    if (whitespaceProbe >= text.length) break;

    const candidate = nextLine(whitespaceProbe);
    if (!headerLineRe.test(candidate.line)) {
      break;
    }

    stripUntil = candidate.next;
    probe = candidate.next;
  }

  const stripped = text.slice(stripUntil);
  return stripped.length > 0 ? stripped : null;
}

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
 * @param {URL | null} requestUrl
 * @returns {Headers}
 */
export function buildRequestHeaders(input, requestInit, accessToken, headerConfig, modelName, requestUrl) {
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
  applyServerVisibleHeaders(requestHeaders, requestUrl);
  for (const name of disabledHeaders) {
    requestHeaders.delete(name);
  }

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
            text: replaceBoundedAnthropicSystemPrompt(item.text),
          };
        }
        return item;
      });
    } else if (typeof parsed.system === "string") {
      parsed.system = replaceBoundedAnthropicSystemPrompt(parsed.system);
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
 * @param {string | undefined} body
 * @param {URL | null} requestUrl
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @returns {string | undefined}
 */
export function injectBillingHeaderBlock(body, requestUrl, headerConfig) {
  if (!isAnthropicRequestUrl(requestUrl)) return body;

  return updateJsonBody(body, (parsed) => {
    if (!parsed || typeof parsed !== "object") return;

    /** @type {any[]} */
    const system = Array.isArray(parsed.system)
      ? parsed.system
      : typeof parsed.system === "string"
        ? [{ type: "text", text: parsed.system }]
        : [];
    parsed.system = system.flatMap((item) => {
      if (typeof item === "string") {
        const text = stripLeadingBillingHeaderLine(item);
        return text === null ? [] : [text];
      }
      if (item?.type === "text" && typeof item.text === "string") {
        const text = stripLeadingBillingHeaderLine(item.text);
        return text === null ? [] : [{ ...item, text }];
      }
      return [item];
    });

    if (!headerConfig.billing_header) {
      if (parsed.system.length === 0) {
        delete parsed.system;
      }
      return;
    }

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
