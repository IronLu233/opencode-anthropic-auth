# Auth Contract Reference

## Purpose

This document captures the OAuth contract for the migration target.

It uses two sources:

- the working exchange/authorize behavior proven in `anthropic-oauth.ts`
- explicit migration target extensions for refresh and revoke, recorded here so PR 1 fully freezes the auth contract before implementation

Unless a section says otherwise, references to the "reference contract" mean the exact behavior proven in `anthropic-oauth.ts` for authorize/exchange plus the explicitly documented migration-target extensions for refresh and revoke.

It is the source of truth for the migration described in:

- `docs/auth-approach-migration-plan.md`
- `docs/auth-migration-implementation-plan.md`
- `docs/auth-migration-pr-breakdown.md`

This document records the target contract, not the current `lib/oauth.mjs` behavior.

## Scope

The reference contract covers:

- authorize URL generation
- PKCE encoding rules
- state semantics
- authorization code parsing
- authorization-code exchange
- refresh-token exchange
- revoke behavior

## Contract Classifications

- `must match exactly`: migration target must preserve the same wire behavior
- `must remain functionally equivalent`: implementation can vary internally if external behavior stays compatible
- `candidate follow-up`: intentionally outside initial parity scope

## Authorize Contract

Source: `createAuthorizationRequest()` in `anthropic-oauth.ts`

Classification:

- authorize URL fields: `must match exactly`
- PKCE verifier/challenge encoding: `must match exactly`
- `state = verifier`: `must match exactly`

Expected behavior:

- authorization endpoint: `https://claude.ai/oauth/authorize`
- required query params:
  - `code=true`
  - `response_type=code`
  - `client_id=<CLIENT_ID>`
  - `redirect_uri=https://console.anthropic.com/oauth/code/callback`
  - `scope=org:create_api_key user:profile user:inference`
  - `code_challenge=<sample challenge fixture or equivalent derived value>`
  - `code_challenge_method=S256`
  - `state=<verifier>`

Encoding rules:

- verifier is generated from random bytes and encoded with base64url
- trailing `=` padding is removed
- `code_challenge` is SHA-256 of the verifier, encoded with base64url and no padding

## Authorization Code Parsing Contract

Source:

- suffix stripping from `parseAuthCode()` in `anthropic-oauth.ts`
- trim-before-parse behavior from `exchangeCodeForTokens()` in `anthropic-oauth.ts`

Classification:

- plain code input: `must match exactly`
- `code#state` input: `must match exactly`
- callback URL query parsing: `candidate follow-up`

Expected behavior:

- trim surrounding whitespace before exchange
- if input contains `#`, strip everything from `#` onward
- do not require or parse returned `state`
- do not depend on pasted `#state` to populate outbound `state`

Initial parity target:

- support raw code input
- support `code#state` input by discarding the suffix

Not part of initial parity target:

- parsing a full callback URL like `https://console.anthropic.com/oauth/code/callback?code=...`

## Authorization-Code Exchange Contract

Source: `exchangeCodeForTokens()` in `anthropic-oauth.ts`

Classification:

- request URL: `must match exactly`
- content type: `must match exactly`
- request body fields: `must match exactly`
- explicit `User-Agent: anthropic`: `must match exactly`
- response normalization: `must remain functionally equivalent`

Expected request:

- method: `POST`
- URL: `https://console.anthropic.com/v1/oauth/token`
- headers:
  - `Content-Type: application/x-www-form-urlencoded`
  - `User-Agent: anthropic`
- body fields:
  - `grant_type=authorization_code`
  - `code=<parsed code>`
  - `code_verifier=<verifier>`
  - `client_id=<CLIENT_ID>`
  - `redirect_uri=https://console.anthropic.com/oauth/code/callback`
  - `state=<verifier>`

Expected success response handling:

- parse JSON body
- normalize into:
  - `access`
  - `refresh`
  - `expires = Date.now() + expires_in * 1000`
  - `email?` when the response includes account identity information

Expected failure handling:

- read response text when available
- surface HTTP status and response text to logs/errors

## Refresh Contract

Source: migration target extension derived from the same compatibility-first transport style as `exchangeCodeForTokens()`.

Classification:

- transport style: `must match exactly`
- token endpoint compatibility rules: `must match exactly`

Expected request:

- method: `POST`
- URL: `https://console.anthropic.com/v1/oauth/token`
- headers:
  - `Content-Type: application/x-www-form-urlencoded`
  - `User-Agent: anthropic`
- body fields:
  - `grant_type=refresh_token`
  - `refresh_token=<refresh token>`
  - `client_id=<CLIENT_ID>`

Expected success response handling:

- parse JSON body
- return low-level token payload `{ access_token, refresh_token, expires_in }`
- normalize into `{ access, refresh, expires }` before shared account consumers use the refreshed credentials

Expected failure handling:

- read response text when available
- surface HTTP status and response text in the thrown error
- preserve parsed error code when the body is JSON and includes one

## Revoke Contract

Source: migration target extension based on current project semantics in `lib/oauth.mjs`.

Classification:

- best-effort semantics: `must remain functionally equivalent`
- local cleanup regardless of revoke outcome: `must remain functionally equivalent`

Expected behavior:

- attempt server-side revoke when supported
- revoke endpoint: `https://console.anthropic.com/v1/oauth/revoke`
- method: `POST`
- content type: `application/json`
- timeout expectation: 5 seconds
- return success/failure without throwing for normal revoke failures
- callers must always perform local cleanup regardless of server result

## Golden Fixtures

Canonical fixtures are stored in `test/fixtures/oauth-contract-reference.json`.

They capture:

- authorize URL fields
- PKCE/state expectations
- parser parity examples
- exchange request shape
- representative exchange success/failure payloads
- refresh request and response shape
- revoke timeout and request shape

## Current Status

The shared helper in `lib/oauth.mjs` now matches the migration target for:

- PKCE generation with Node crypto and unpadded base64url encoding
- form-encoded token exchange and refresh requests
- `User-Agent: anthropic` on token endpoint requests
- outbound `state = verifier`
- parser parity for raw code and `code#state` input

One intentional boundary remains:

- full callback URL parsing remains outside initial transport-contract parity and can stay at the entrypoint layer unless later promoted into the shared contract
