import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "./config.mjs";

const DEVICE_ID_FILENAME = "anthropic-device-id";
const runtimeSessionId = randomUUID();
const runtimeFallbackDeviceId = randomBytes(32).toString("hex");
let deviceIdPromise;

function isValidDeviceId(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function getDeviceIdPath() {
  return join(getConfigDir(), DEVICE_ID_FILENAME);
}

async function createAndPersistDeviceId() {
  const deviceId = randomBytes(32).toString("hex");
  const deviceIdPath = getDeviceIdPath();
  const tempPath = `${deviceIdPath}.${randomBytes(6).toString("hex")}.tmp`;

  await mkdir(getConfigDir(), { recursive: true });

  try {
    await writeFile(tempPath, `${deviceId}\n`, { mode: 0o600 });
    await rename(tempPath, deviceIdPath);
    return deviceId;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function isAnthropicRequestUrl(requestUrl) {
  // Match any Anthropic-compatible endpoint (official or proxy) by path.
  // The hostname check (api.anthropic.com) is too restrictive for proxy setups.
  if (!requestUrl) return false;
  const pathname = requestUrl.pathname || "";
  return pathname === "/v1/messages" || pathname.startsWith("/v1/");
}

export function getRuntimeSessionId() {
  return runtimeSessionId;
}

export function createClientRequestId() {
  return randomUUID();
}

export async function getPersistentDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      try {
        const existing = (await readFile(getDeviceIdPath(), "utf-8")).trim().toLowerCase();
        if (isValidDeviceId(existing)) {
          return existing;
        }
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
          throw error;
        }
      }

      return createAndPersistDeviceId();
    })().catch((error) => {
      deviceIdPromise = undefined;
      throw error;
    });
  }

  return deviceIdPromise;
}

export async function getBestEffortDeviceId() {
  try {
    return await getPersistentDeviceId();
  } catch {
    return runtimeFallbackDeviceId;
  }
}

export function buildServerVisibleUserId({ deviceId, sessionId = getRuntimeSessionId(), accountUuid = "" }) {
  return `user_${deviceId}_account_${accountUuid}_session_${sessionId}`;
}

export function applyServerVisibleHeaders(headers, requestUrl) {
  if (!isAnthropicRequestUrl(requestUrl)) return headers;
  return headers;
}

export async function injectServerVisibleMetadata(body, requestUrl, options = {}) {
  if (!isAnthropicRequestUrl(requestUrl) || typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return body;

    const metadata =
      parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : {};

    parsed.metadata = {
      ...metadata,
      user_id: buildServerVisibleUserId({
        deviceId: await getBestEffortDeviceId(),
        sessionId: options.sessionId ?? getRuntimeSessionId(),
        accountUuid: options.accountUuid ?? "",
      }),
    };

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
