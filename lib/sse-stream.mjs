import { TOOL_NAME_ALIASES_IN } from "./request-transform.mjs";

/**
 * @typedef {object} UsageStats
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 */

/**
 * @param {any} parsed
 * @param {UsageStats} stats
 */
export function extractUsageFromSSEEvent(parsed, stats) {
  if (parsed?.type === "message_delta" && parsed.usage) {
    const usage = parsed.usage;
    if (typeof usage.input_tokens === "number") stats.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") stats.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number") stats.cacheReadTokens = usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === "number")
      stats.cacheWriteTokens = usage.cache_creation_input_tokens;
    return;
  }

  if (parsed?.type === "message_start" && parsed.message?.usage) {
    const usage = parsed.message.usage;
    if (stats.inputTokens === 0 && typeof usage.input_tokens === "number") stats.inputTokens = usage.input_tokens;
    if (stats.cacheReadTokens === 0 && typeof usage.cache_read_input_tokens === "number") {
      stats.cacheReadTokens = usage.cache_read_input_tokens;
    }
    if (stats.cacheWriteTokens === 0 && typeof usage.cache_creation_input_tokens === "number") {
      stats.cacheWriteTokens = usage.cache_creation_input_tokens;
    }
  }
}

/**
 * @param {string} eventBlock
 * @returns {string | null}
 */
export function getSSEDataPayload(eventBlock) {
  if (!eventBlock) return null;

  const dataLines = [];
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function stripMcpPrefixFromSSE(text) {
  return text.replace(/^data:\s*(.+)$/gm, (match, jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      // pass through
    }
    return match;
  });
}

/**
 * @param {any} parsed
 * @returns {boolean}
 */
export function stripMcpPrefixFromParsedEvent(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  let modified = false;

  // Rename disguised tool names back to OpenCode originals
  const renameBlock = (block) => {
    if (block?.type === "tool_use" && typeof block.name === "string" && TOOL_NAME_ALIASES_IN[block.name]) {
      block.name = TOOL_NAME_ALIASES_IN[block.name];
      modified = true;
    }
  };

  if (parsed.content_block) renameBlock(parsed.content_block);

  if (parsed.message && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) renameBlock(block);
  }

  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) renameBlock(block);
  }

  // Also handle mcp_ prefix stripping (legacy)
  if (
    parsed.content_block &&
    parsed.content_block.type === "tool_use" &&
    typeof parsed.content_block.name === "string" &&
    parsed.content_block.name.startsWith("mcp_")
  ) {
    parsed.content_block.name = parsed.content_block.name.slice(4);
    modified = true;
  }

  if (parsed.message && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) {
      if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("mcp_")) {
        block.name = block.name.slice(4);
        modified = true;
      }
    }
  }

  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith("mcp_")) {
        block.name = block.name.slice(4);
        modified = true;
      }
    }
  }

  return modified;
}

/**
 * @param {Response} response
 * @param {((stats: UsageStats) => void) | null} [onUsage]
 * @returns {Response}
 */
export function transformResponse(response, _onUsage) {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      const text = decoder.decode(value, { stream: true });
      controller.enqueue(encoder.encode(stripMcpPrefixFromSSE(text)));
    },
    cancel() {
      try {
        reader.cancel();
      } catch {
        // ignore cancel errors
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * @param {Response} response
 * @returns {boolean}
 */
export function isEventStreamResponse(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}
