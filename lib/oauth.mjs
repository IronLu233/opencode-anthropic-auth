import { createHash, randomBytes } from "node:crypto";
import { CLIENT_ID } from "./config.mjs";
import { DEFAULT_HEADER_PROFILE, getCliUserAgent } from "./request-headers.mjs";

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": getCliUserAgent(DEFAULT_HEADER_PROFILE),
};

function base64url(input) {
  return input.toString("base64url").replace(/=+$/u, "");
}

function createPKCEPair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Parse an auth code like the working anthropic-oauth.ts flow.
 * Trimming remains an exchange-boundary concern.
 * @param {string} raw
 * @returns {string}
 */
function parseAuthCode(raw) {
  const hashIdx = raw.indexOf("#");
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
}

/**
 * @param {string} text
 * @returns {{ status?: number, code?: string }}
 */
function parseFailureMetadata(text) {
  try {
    const parsed = JSON.parse(text);
    const code = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.type;
    return { ...(code ? { code } : {}) };
  } catch {
    return {};
  }
}

/**
 * Build an OAuth authorization URL with PKCE challenge.
 * @param {"max" | "console"} mode
 * @returns {Promise<{url: string, verifier: string}>}
 */
export async function authorize(mode) {
  const pkce = createPKCEPair();
  const origin = mode === "console" ? "https://console.anthropic.com" : "https://claude.ai";
  const url = new URL(`${origin}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
  };
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @param {string} verifier
 * @returns {Promise<{type: "success", refresh: string, access: string, expires: number, email?: string} | {type: "failed", error?: string}>}
 */
export async function exchange(code, verifier) {
  try {
    const parsedCode = parseAuthCode(code.trim());
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: parsedCode,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: verifier,
    });

    const result = await fetch(TOKEN_URL, {
      method: "POST",
      headers: FORM_HEADERS,
      body: body.toString(),
    });

    if (!result.ok) {
      const raw = await result.text().catch(() => "");
      const text = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
      const statusText = result.statusText ? ` ${result.statusText}` : "";
      return {
        type: "failed",
        error: `Token exchange failed: ${result.status}${statusText}${text ? ` - ${text}` : ""}`,
      };
    }

    const json = await result.json();
    if (!json?.access_token || typeof json.expires_in !== "number") {
      return {
        type: "failed",
        error: "Malformed token response: missing access_token or invalid expires_in",
      };
    }
    return {
      type: "success",
      refresh: json.refresh_token,
      access: json.access_token,
      expires: Date.now() + json.expires_in * 1000,
      email: json.account?.email_address || undefined,
    };
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Attempt to revoke a refresh token server-side (best-effort, RFC 7009).
 *
 * Anthropic may or may not support this endpoint. The function returns
 * `true` on a 2xx response and `false` otherwise — callers should always
 * proceed with local cleanup regardless of the result.
 *
 * @param {string} refreshToken
 * @returns {Promise<boolean>}
 */
export async function revoke(refreshToken) {
  try {
    const resp = await fetch("https://console.anthropic.com/v1/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Refresh an OAuth access token.
 * @param {string} refreshTokenValue
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
 */
export async function refreshToken(refreshTokenValue, options = {}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: CLIENT_ID,
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: body.toString(),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!resp.ok) {
    const raw = await resp.text().catch(() => "");
    const text = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
    const statusText = resp.statusText ? ` ${resp.statusText}` : "";
    const error = new Error(`Token refresh failed (HTTP ${resp.status}${statusText}): ${text}`);
    error.status = resp.status;
    const meta = parseFailureMetadata(raw);
    if (meta.code) error.code = meta.code;
    throw error;
  }

  const json = await resp.json();
  if (!json?.access_token || typeof json.expires_in !== "number") {
    const error = new Error("Malformed token response: missing access_token or invalid expires_in");
    error.status = resp.status;
    throw error;
  }
  return json;
}
