/**
 * Unit tests for lib/oauth.mjs — shared OAuth helpers.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { authorize, exchange, revoke, refreshToken, fetchOAuthProfile } from "./oauth.mjs";
import { CLIENT_ID } from "./config.mjs";
import { getCliUserAgent, DEFAULT_HEADER_PROFILE } from "./request-headers.mjs";

const contractFixture = JSON.parse(
  readFileSync(new URL("../test/fixtures/oauth-contract-reference.json", import.meta.url), "utf8"),
);

function parseReferenceAuthCode(raw) {
  const hashIdx = raw.indexOf("#");
  return hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
}

function parseExchangeBoundaryReferenceAuthCode(raw) {
  return parseReferenceAuthCode(raw.trim());
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("reference contract fixtures", () => {
  it("captures the target authorize contract from anthropic-oauth.ts", () => {
    expect(contractFixture.authorize.endpoint).toBe("https://claude.ai/oauth/authorize");
    expect(contractFixture.authorize.query.client_id).toBe(CLIENT_ID);
    expect(contractFixture.authorize.query.code).toBe("true");
    expect(contractFixture.authorize.query.response_type).toBe("code");
    expect(contractFixture.authorize.query.redirect_uri).toBe("https://console.anthropic.com/oauth/code/callback");
    expect(contractFixture.authorize.query.scope).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
    expect(contractFixture.authorize.query.code_challenge).toBe(
      contractFixture.authorize.reference_values.sample_code_challenge,
    );
    expect(contractFixture.authorize.query.code_challenge_method).toBe("S256");
    expect(contractFixture.authorize.query.state_source).toBe("verifier");
    expect(contractFixture.authorize.query.code_challenge_source).toBe("sha256(verifier)");
    expect(contractFixture.authorize.pkce.verifier_encoding).toBe("base64url-no-padding");
    expect(contractFixture.authorize.pkce.challenge_encoding).toBe("base64url-no-padding");
    expect(
      createHash("sha256")
        .update(contractFixture.authorize.reference_values.sample_verifier)
        .digest("base64url")
        .replace(/=+$/u, ""),
    ).toBe(contractFixture.authorize.reference_values.sample_code_challenge);
  });

  it("captures auth-code suffix stripping parity from parseAuthCode", () => {
    for (const sample of contractFixture.parser.samples) {
      expect(parseReferenceAuthCode(sample.input)).toBe(sample.output);
    }
  });

  it("captures the trim-before-parse behavior at the exchange boundary", () => {
    for (const sample of contractFixture.parser.trim_samples) {
      expect(parseExchangeBoundaryReferenceAuthCode(sample.input)).toBe(sample.output);
    }
  });

  it("captures the target exchange, refresh, and revoke fixture details", () => {
    expect(contractFixture.exchange.request.headers.Accept).toBe("application/json, text/plain, */*");
    expect(contractFixture.exchange.request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(contractFixture.exchange.request.headers["User-Agent"]).toBe("claude-cli/<version> (external, cli)");
    expect(contractFixture.exchange.request.body_fields).toContain("state=<verifier>");
    expect(contractFixture.exchange.success_response.access_token).toBe("access-123");
    expect(contractFixture.exchange.failure_response.status).toBe(429);
    expect(contractFixture.exchange.failure_response.body.error.type).toBe("rate_limit_error");
    expect(contractFixture.refresh.request.headers.Accept).toBe("application/json, text/plain, */*");
    expect(contractFixture.refresh.request.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(contractFixture.refresh.request.headers["User-Agent"]).toBe("claude-cli/<version> (external, cli)");
    expect(contractFixture.refresh.request.body_fields).toContain("grant_type=refresh_token");
    expect(contractFixture.refresh.success_response.refresh_token).toBe("refresh-123");
    expect(contractFixture.refresh.failure_response.status).toBe(400);
    expect(contractFixture.refresh.failure_response.body.error).toBe("invalid_grant");
    expect(contractFixture.revoke.request.headers.Accept).toBe("application/json, text/plain, */*");
    expect(contractFixture.revoke.request.timeout_ms).toBe(5000);
    expect(contractFixture.revoke.request.url).toBe("https://console.anthropic.com/v1/oauth/revoke");
  });
});

// ---------------------------------------------------------------------------
// refreshToken
// ---------------------------------------------------------------------------

describe("refreshToken", () => {
  it("returns token data on successful refresh", async () => {
    const tokenData = {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => tokenData,
    });

    const result = await refreshToken("old-refresh");

    expect(result).toEqual(tokenData);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Accept).toBe("application/json, text/plain, */*");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.headers["User-Agent"]).toBe(getCliUserAgent(DEFAULT_HEADER_PROFILE));

    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("refresh_token")).toBe("old-refresh");
  });

  it("throws with status and error code on HTTP 400", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    });

    const error = await refreshToken("bad-refresh").catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Token refresh failed");
    expect(error.message).toContain("400 Bad Request");
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_grant");
  });

  it("throws with status on HTTP 401 (no error code in body)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Unauthorized",
    });

    const error = await refreshToken("expired-refresh").catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("401");
    expect(error.status).toBe(401);
    expect(error.code).toBeUndefined();
  });

  it("propagates network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));

    await expect(refreshToken("any-refresh")).rejects.toThrow("network failure");
  });

  it("passes AbortSignal through to fetch", async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-val", { signal: controller.signal });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBe(controller.signal);
  });

  it("does not include signal when not provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
    });

    await refreshToken("refresh-val");

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.signal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// authorize
// ---------------------------------------------------------------------------

describe("authorize", () => {
  it("returns url and verifier shape", async () => {
    const result = await authorize("max");

    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("verifier");
    expect(typeof result.url).toBe("string");
    expect(typeof result.verifier).toBe("string");
  });

  it("constructs URL with correct client_id for max mode", async () => {
    const result = await authorize("max");
    const url = new URL(result.url);

    expect(url.origin).toBe("https://claude.ai");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.anthropic.com/oauth/code/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(result.verifier);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(url.searchParams.get("code_challenge")).not.toContain("=");
    expect(result.verifier).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(result.verifier).not.toContain("=");
    expect(url.searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
  });

  it("constructs URL with console origin for console mode", async () => {
    const result = await authorize("console");
    const url = new URL(result.url);

    expect(url.origin).toBe("https://console.anthropic.com");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
  });
});

// ---------------------------------------------------------------------------
// exchange
// ---------------------------------------------------------------------------

describe("exchange", () => {
  it("returns success credentials on successful exchange", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "access-123",
        refresh_token: "refresh-123",
        expires_in: 3600,
        account: { email_address: "user@example.com", uuid: "account-uuid-123" },
      }),
    });

    const result = await exchange("code#state", "verifier-abc");

    expect(result.type).toBe("success");
    expect(result.refresh).toBe("refresh-123");
    expect(result.access).toBe("access-123");
    expect(result.expires).toBeGreaterThan(Date.now());
    expect(result.email).toBe("user@example.com");
    expect(result.accountUuid).toBe("account-uuid-123");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://console.anthropic.com/v1/oauth/token");
    expect(opts.headers.Accept).toBe("application/json, text/plain, */*");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(opts.headers["User-Agent"]).toBe(getCliUserAgent(DEFAULT_HEADER_PROFILE));
    const body = new URLSearchParams(opts.body);
    expect(body.get("code")).toBe("code");
    expect(body.get("state")).toBe("verifier-abc");
    expect(body.get("code_verifier")).toBe("verifier-abc");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("returns failed on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => '{"error":"invalid_grant"}',
    });

    const result = await exchange("bad-code#state", "verifier");

    expect(result).toEqual({
      type: "failed",
      error: 'Token exchange failed: 400 Bad Request - {"error":"invalid_grant"}',
    });
  });

  it("returns failed on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network failure"));

    const result = await exchange("bad-code#state", "verifier");

    expect(result).toEqual({ type: "failed", error: "network failure" });
  });
});

// ---------------------------------------------------------------------------
// fetchOAuthProfile
// ---------------------------------------------------------------------------

describe("fetchOAuthProfile", () => {
  it("returns profile identity fields on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        account: { uuid: "account-uuid-123", email: "user@example.com" },
        organization: { uuid: "org-uuid-123" },
      }),
    });

    const result = await fetchOAuthProfile("access-token");

    expect(result).toEqual({
      accountUuid: "account-uuid-123",
      email: "user@example.com",
      organizationUuid: "org-uuid-123",
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
    expect(opts.method).toBe("GET");
    expect(opts.headers.Accept).toBe("application/json, text/plain, */*");
    expect(opts.headers.Authorization).toBe("Bearer access-token");
  });

  it("returns null on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(fetchOAuthProfile("access-token")).resolves.toBeNull();
  });

  it("returns null when a 2xx profile response lacks identity fields", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ account: {}, organization: {} }),
    });
    await expect(fetchOAuthProfile("access-token")).resolves.toBeNull();
  });

  it("returns null on network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchOAuthProfile("access-token")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

describe("revoke", () => {
  it("returns true on successful revocation", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await revoke("refresh-to-revoke");

    expect(result).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://console.anthropic.com/v1/oauth/revoke");
    expect(opts.headers.Accept).toBe("application/json, text/plain, */*");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.token).toBe("refresh-to-revoke");
    expect(body.token_type_hint).toBe("refresh_token");
    expect(body.client_id).toBe(CLIENT_ID);
  });

  it("returns false on HTTP error (does not throw)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await revoke("unknown-token");

    expect(result).toBe(false);
  });

  it("returns false on network error (does not throw)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const result = await revoke("any-token");

    expect(result).toBe(false);
  });
});
