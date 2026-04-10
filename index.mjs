import { loadConfig } from "./lib/config.mjs";
import {
  buildRequestHeaders,
  extractModelName,
  transformBodySinglePass,
  transformRequestUrl,
} from "./lib/request-transform.mjs";
import { transformResponse, isEventStreamResponse } from "./lib/sse-stream.mjs";
import { getBestEffortDeviceId } from "./lib/server-visible-identity.mjs";

/**
 * @param {any} input
 * @param {RequestInit} requestInit
 * @returns {Promise<string | undefined>}
 */
async function readRequestBody(input, requestInit) {
  if (typeof requestInit.body === "string") return requestInit.body;
  if (requestInit.body != null) {
    try {
      return await new Response(requestInit.body).text();
    } catch {
      return undefined;
    }
  }
  if (input instanceof Request) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * @param {string | undefined} body
 * @param {RequestInit} [requestInit]
 * @returns {boolean}
 */
function isStreamingRequest(body, requestInit) {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return parsed?.stream === true;
    } catch {
      // ignore
    }
  }
  // Fallback: check headers for streaming accept
  const accept = requestInit?.headers?.["accept"] || "";
  return accept.includes("text/event-stream");
}

/**
 * @type {import('@opencode-ai/plugin').Plugin}
 */
export async function AnthropicAuthPlugin() {
  const config = loadConfig();

  return {
    "experimental.chat.system.transform": () => {},

    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const stored = await getAuth();

        return {
          apiKey: stored?.key ?? "",
          async fetch(input, init) {
            const requestInit = init ?? {};
            const { requestInput, requestUrl } = transformRequestUrl(input);
            const originalBody = await readRequestBody(requestInput, requestInit);
            const modelName = extractModelName(originalBody);

            const deviceId = await getBestEffortDeviceId();
            const body = await transformBodySinglePass(originalBody, requestUrl, config.headers, deviceId);

            const headers = buildRequestHeaders(
              requestInput,
              requestInit,
              null,
              config.headers,
              modelName,
              requestUrl,
              isStreamingRequest(originalBody, requestInit),
            );

            const response = await fetch(requestInput, {
              method: requestInit.method || "POST",
              body: typeof body === "undefined" ? undefined : body,
              headers,
              signal: requestInit.signal,
            });

            return isEventStreamResponse(response) ? transformResponse(response) : response;
          },
        };
      },
      methods: [
        {
          type: "api",
          label: "Anthropic API Key",
        },
      ],
    },
  };
}
