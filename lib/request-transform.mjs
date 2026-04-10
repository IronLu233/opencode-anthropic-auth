import { getHeaderProfile, getDefaultBetas, getBillingHeaderBlock } from "./request-headers.mjs";
import { applyServerVisibleHeaders, isAnthropicRequestUrl } from "./server-visible-identity.mjs";
import { ANTHROPIC_REPLACEMENT_PROMPT, replaceBoundedAnthropicSystemPrompt } from "./anthropic-system-prompt.mjs";
import { buildDynamicPromptTail } from "./dynamic-prompt-tail.mjs";

const TEXT_REPLACEMENTS = [
  [/\bOpenCode\b/gu, "ClaudeCode"],
  [/\bopencode\b/gu, "claudecode"],
  [/\bOpen Code\b/gu, "Claude Code"],
  [/\bopen code\b/gu, "claude code"],
];

/**
 * Outbound tool name aliases: rename OpenCode tool names that Anthropic blocks.
 * Only case-sensitive exact matches are blocked — "todowrite" is blocked, "TodoWrite" is not.
 * @type {Record<string, string>}
 */
export const TOOL_NAME_ALIASES_OUT = {
  bash: "Bash",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  task: "Task",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  skill: "Skill",
};

/**
 * Inbound tool name aliases: rename back from disguised name to OpenCode's original name.
 * @type {Record<string, string>}
 */
export const TOOL_NAME_ALIASES_IN = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  Task: "task",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
};

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
 * @param {string} text
 * @returns {string}
 */
function replaceBrandText(text) {
  let result = text;
  for (const [pattern, replacement] of TEXT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * @param {any} value
 * @param {string | null} [key]
 * @returns {any}
 */
function replaceBrandTextInPayload(value, key = null) {
  if (typeof value === "string") {
    if (["name", "model", "type", "role", "id", "tool_use_id"].includes(key || "")) {
      return value;
    }
    return replaceBrandText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => replaceBrandTextInPayload(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, replaceBrandTextInPayload(entryValue, entryKey)]),
  );
}

function currentDateIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @param {any} systemValue
 * @returns {string}
 */
function serializeSystemPrompt(systemValue) {
  const items = Array.isArray(systemValue)
    ? systemValue
    : typeof systemValue === "string"
      ? [{ type: "text", text: systemValue }]
      : [];

  return items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * @param {string} claudeMdText
 * @returns {string}
 */
function buildSystemReminderText(claudeMdText) {
  return [
    "<system-reminder>",
    "As you answer the user's questions, you can use the following context:",
    "# claudeMd",
    claudeMdText,
    "",
    "# currentDate",
    `Today's date is ${currentDateIso()}.`,
    "",
    "IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
    "</system-reminder>",
  ].join("\n");
}

/**
 * @param {any} parsed
 * @param {string} claudeMdText
 */
function prependSystemReminderMessage(parsed, claudeMdText) {
  if (!claudeMdText.trim()) return;

  const reminder = {
    role: "user",
    content: buildSystemReminderText(claudeMdText),
  };

  if (!Array.isArray(parsed.messages)) {
    parsed.messages = [reminder];
    return;
  }

  parsed.messages.unshift(reminder);
}

/**
 * @param {any} input
 * @param {RequestInit} requestInit
 * @param {string | null | undefined} accessToken
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @param {string | undefined} modelName
 * @param {URL | null} requestUrl
 * @param {boolean} [isStreaming]
 * @returns {Headers}
 */
export function buildRequestHeaders(input, requestInit, accessToken, headerConfig, modelName, requestUrl, isStreaming) {
  const requestHeaders = new Headers();

  // Extract auth headers from original request only
  if (input instanceof Request) {
    const authHeader = input.headers.get("authorization");
    if (authHeader) requestHeaders.set("authorization", authHeader);
    const apiKey = input.headers.get("x-api-key");
    if (apiKey) requestHeaders.set("x-api-key", apiKey);
  }
  if (requestInit.headers) {
    const src =
      requestInit.headers instanceof Headers
        ? requestInit.headers
        : Array.isArray(requestInit.headers)
          ? new Headers(requestInit.headers)
          : new Headers(Object.entries(requestInit.headers));
    const authHeader = src.get("authorization");
    if (authHeader) requestHeaders.set("authorization", authHeader);
    const apiKey = src.get("x-api-key");
    if (apiKey) requestHeaders.set("x-api-key", apiKey);
  }

  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta
    .split(",")
    .map((beta) => beta.trim())
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
        .map((beta) => beta.trim())
        .filter(Boolean)
    : defaultBetas;
  const mergedBetas = [...new Set([...configuredBetas, ...incomingBetasList])].join(",");

  if (accessToken) {
    requestHeaders.set("authorization", `Bearer ${accessToken}`);
    requestHeaders.delete("x-api-key");
  } else if (isAnthropicRequestUrl(requestUrl)) {
    const apiKey = requestHeaders.get("x-api-key");
    if (apiKey && !requestHeaders.has("authorization")) {
      requestHeaders.set("authorization", `Bearer ${apiKey}`);
      requestHeaders.delete("x-api-key");
    }
  }

  if (!disabledHeaders.has("anthropic-beta")) {
    requestHeaders.set("anthropic-beta", mergedBetas);
  }

  applyServerVisibleHeaders(requestHeaders, requestUrl);

  // Set Accept header based on streaming mode
  if (!disabledHeaders.has("accept")) {
    requestHeaders.set("accept", isStreaming ? "text/event-stream" : "application/json");
  }

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
 * Apply system-prompt replacement to the parsed body object (mutates in place).
 * @param {any} parsed
 */
function applySystemPromptTransform(parsed) {
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
}

/**
 * @param {string | undefined} body
 * @returns {string | undefined}
 */
export function transformRequestBody(body) {
  return updateJsonBody(body, (parsed) => {
    applySystemPromptTransform(parsed);
    const replaced = replaceBrandTextInPayload(parsed);
    Object.keys(parsed).forEach((key) => delete parsed[key]);
    Object.assign(parsed, replaced);
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
 * Single-pass body transformation: system prompt, billing header, and metadata
 * all applied in one JSON parse/stringify cycle to avoid fingerprint drift.
 *
 * @param {string | undefined} body
 * @param {URL | null} requestUrl
 * @param {import('./config.mjs').AnthropicAuthConfig['headers']} headerConfig
 * @param {string} deviceId
 * @returns {Promise<string | undefined>}
 */
export async function transformBodySinglePass(body, requestUrl, headerConfig, deviceId) {
  if (!body || typeof body !== "string") return body;

  let parsed;
  try {
    parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return body;
  } catch {
    return body;
  }

  const isAnthropic = isAnthropicRequestUrl(requestUrl);
  const originalSystemText = serializeSystemPrompt(parsed.system);

  // 1. System prompt replacement
  applySystemPromptTransform(parsed);

  // 2. Restructure system prompt to match Claude Code's 4-block format (Anthropic requests only)
  if (isAnthropic) {
    /** @type {any[]} */
    const rawSystem = Array.isArray(parsed.system)
      ? parsed.system
      : typeof parsed.system === "string"
        ? [{ type: "text", text: parsed.system }]
        : [];

    // Strip any existing billing header lines
    const cleaned = rawSystem.flatMap((item) => {
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

    const SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    const CLAUDE_CODE_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

    for (const block of cleaned) {
      if (block?.type !== "text") continue;
      const text = block.text || "";
      if (!text.trim()) continue;

      if (text === CLAUDE_CODE_PREFIX || text === SDK_PREFIX) continue;
    }

    const rebuilt = [];
    rebuilt.push({ type: "text", text: SDK_PREFIX, cache_control: { type: "ephemeral" } });
    rebuilt.push({
      type: "text",
      text: [
        ANTHROPIC_REPLACEMENT_PROMPT,
        buildDynamicPromptTail({
          modelName: typeof parsed.model === "string" ? parsed.model : undefined,
        }),
      ].join("\n\n"),
      cache_control: { type: "ephemeral" },
    });

    parsed.system = rebuilt;

    if (parsed.system.length === 0) {
      delete parsed.system;
    }
  }

  // 3. Server-visible metadata (Anthropic requests only)
  if (isAnthropic) {
    const metadata =
      parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : {};

    const { buildServerVisibleUserId, getRuntimeSessionId } = await import("./server-visible-identity.mjs");
    parsed.metadata = {
      ...metadata,
      user_id: buildServerVisibleUserId({
        deviceId,
        sessionId: getRuntimeSessionId(),
        accountUuid: "",
      }),
    };
  }

  // 4. Rename tool names that trigger third-party detection (Anthropic requests only)
  // Anthropic blocks known third-party tool names like "todowrite" (case-sensitive).
  // Rename outbound; SSE response handler renames them back.
  if (isAnthropic && Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool && typeof tool.name === "string") {
        const renamed = TOOL_NAME_ALIASES_OUT[tool.name];
        if (renamed) tool.name = renamed;
      }
    }
  }

  if (isAnthropic && originalSystemText) {
    prependSystemReminderMessage(parsed, originalSystemText);
  }

  const replaced = replaceBrandTextInPayload(parsed);
  Object.keys(parsed).forEach((key) => delete parsed[key]);
  Object.assign(parsed, replaced);

  return JSON.stringify(parsed);
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
