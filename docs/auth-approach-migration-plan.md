# Auth Approach Migration Plan

## Goal

Adopt the working auth approach from `anthropic-oauth.ts` while preserving the current project's higher-level functionality:

- multi-account account pool and rotation
- CLI login/reauth/refresh/logout flows
- slash-command auth flows in the plugin
- OpenCode `auth.json` sync and bootstrap compatibility
- header emulation profiles and overrides
- request/body transforms and tool prefixing
- refresh locking, disk sync, and account-state tracking
- optional API-key flows

The migration should change the OAuth/auth foundation, not remove existing product features.

## Core Diagnosis

`anthropic-oauth.ts` succeeds because its auth path is much thinner and more first-party-like than the current main implementation.

The most important differences are:

1. Authorization code exchange is treated as a small standalone handshake, not as part of a larger auth subsystem.
2. Token exchange uses the exact request shape that Anthropic appears to accept reliably.
3. Normal Anthropic chat requests are configured through lightweight plugin hooks, not through a custom auth transport layer.
4. OAuth concerns are isolated from multi-account and routing concerns.

That separation is the main architectural shift to preserve.

## Target Architecture

### 1. Split auth into two layers

Create a hard boundary between:

- `OAuth transport layer`
  - authorize URL generation
  - code parsing
  - token exchange
  - token refresh
  - revoke
- `Account orchestration layer`
  - account storage
  - duplicate detection
  - rotation strategy
  - rate-limit/failure tracking
  - refresh lock coordination
  - CLI/plugin UX

The account orchestration layer should consume tokens from the auth layer, but should not own the low-level wire protocol details for Anthropic OAuth.

### 2. Make `anthropic-oauth.ts` the reference auth contract

Treat the following behaviors in `anthropic-oauth.ts` as the canonical baseline to port into shared auth helpers:

- PKCE generated with Node crypto and explicit unpadded base64url handling
- `state` equal to the verifier
- pasted code normalized by extracting only the code value
- token exchange using the exact minimal request shape that works
- refresh using the same minimal, compatibility-first transport philosophy
- request headers set through lightweight plugin hooks where possible

Do not start from current `lib/oauth.mjs` and patch around it further; instead, rebuild the shared auth helper around the working contract.

### 3. Minimize custom request interception

Keep the current feature set, but move toward this rule:

- only intercept requests when a feature truly requires it
- otherwise prefer OpenCode plugin hooks like `chat.headers` and `experimental.chat.system.transform`

In practice, that means the OAuth login flow should be thin, while the following behaviors remain in the fetch/interceptor path until proven replaceable:

- multi-account account selection and failover
- refresh-on-demand before model requests
- request URL mutation where required by Anthropic compatibility
- request body transforms and tool prefixing
- streaming/response handling tied to transformed requests

The migration should shrink the interceptor's auth responsibilities, not remove request interception that is still required for current product behavior.

## Phase 1: Capture the working auth contract

Extract and document the exact auth behavior from `anthropic-oauth.ts` into a shared design note before changing code:

- authorize URL fields
- PKCE algorithm and encoding rules
- `state` semantics
- code parsing rules
- token exchange content type, headers, and body shape
- refresh request content type, headers, and body shape
- expected success and failure payloads
- golden request/response fixtures for authorize, exchange, and refresh
- explicit notes on which behaviors are exact parity vs intentional follow-up improvements

Deliverable:

- one small source-of-truth auth contract section in the repo docs
- captured fixtures/examples that tests can assert against

Success criteria:

- every auth callsite can reference one shared contract instead of ad hoc behavior
- the contract distinguishes parity requirements from future enhancements

## Phase 2: Rebuild shared OAuth helpers around the working contract

Replace the current shared OAuth helper implementation with a helper whose semantics match `anthropic-oauth.ts` first, then adapt it for project-wide use.

Required outcomes:

- `authorize()` follows the working PKCE/state behavior exactly
- `exchange()` follows the working code parsing and token request behavior exactly
- `refreshToken()` uses the same transport philosophy as the working auth path
- error reporting remains richer than the minimal plugin, but without changing request semantics

Important constraint:

- request semantics must be driven by compatibility with Anthropic first, not by local abstraction cleanliness

Success criteria:

- CLI and plugin both use the same rebuilt auth helper
- no auth logic duplication remains between standalone and integrated flows

## Phase 2.5: Preserve OpenCode auth-store compatibility

Before switching entrypoints, explicitly preserve the existing OpenCode `auth.json` sync/bootstrap lifecycle.

Preserve:

- CLI writes that sync credentials into OpenCode `auth.json`
- plugin bootstrap from OpenCode auth when account storage is absent
- first-login persistence before the loader depends on stored accounts
- CLI and plugin interoperability when either side updates credentials first

Success criteria:

- connect-provider, CLI login, and slash-command login all remain interoperable
- first-run bootstrap still works when only OpenCode auth exists
- OpenCode auth freshness rules remain compatible with disk account state

## Phase 3: Keep multi-account support as a consumer of the new auth layer

After the auth helper is rebuilt, reconnect the existing multi-account system without changing its product behavior.

Preserve:

- account pool persistence
- add/reauth duplicate-account handling
- account enable/disable/remove flows
- bidirectional sync with OpenCode auth state
- rotation strategies
- failure and rate-limit state
- refresh locking and disk reconciliation

Key principle:

- multi-account code should consume `{ access, refresh, expires, email? }`
- it should not know or care whether token exchange used JSON, form encoding, curl, or another transport detail

Success criteria:

- all account behaviors still work after the auth helper swap
- login and reauth are the only places aware of raw OAuth code handling

## Phase 4: Separate auth/login transport from chat request customization

Today the project blends auth responsibilities and request customization inside the plugin loader path.

Refactor toward:

- `auth/login responsibilities`
  - authorize
  - exchange
  - refresh
  - persistence of new tokens
- `chat customization responsibilities`
  - header emulation profiles
  - anthropic beta handling
  - system prompt transform
  - tool prefixing
  - billing header insertion

Where OpenCode hooks are sufficient, prefer them over custom fetch wrapping.

This does not require removing the current loader immediately; it requires shrinking its scope so the login/refresh path is no longer entangled with chat-shaping behavior.

Specifically, the fetch/interceptor path must continue to own any behavior that OpenCode hooks cannot currently express, including account routing, failover, refresh-on-demand, transformed request replay, and any response-stream adjustments required by transformed requests.

Success criteria:

- header/profile logic can evolve independently of OAuth compatibility logic
- auth regressions are easier to isolate from request-shaping regressions

## Phase 5: Unify CLI, slash-command, and connect-provider flows

All entrypoints should use the same shared auth primitives and differ only in UX.

Unify:

- CLI `login`
- CLI `reauth`
- plugin connect-provider OAuth callback
- slash commands like `/anthropic login` and `/anthropic reauth`

Each flow should:

- create the same auth request object
- collect/paste the same type of code input
- call the same shared exchange function
- hand the resulting credentials to the same shared account-application and auth-sync path

Success criteria:

- there is one auth behavior with multiple UIs, not multiple auth implementations

## Phase 6: Reintroduce optional auth modes only after the Pro/Max flow is stable

The working reference file proves the Claude Pro/Max OAuth flow. Additional modes should be revalidated only after the main flow is stable.

Order of work:

1. Claude Pro/Max OAuth
2. refresh/re-auth reliability
3. API-key creation flow
4. manual API-key mode integration checks

Logout/revoke behavior should remain stable throughout these phases:

- best-effort server revoke where supported
- guaranteed local cleanup even if server revoke fails

Success criteria:

- the main OAuth path is stable before secondary auth modes add complexity back

## Test Plan

Testing should be reorganized around the new architecture.

### Auth-contract tests

Add focused tests for:

- PKCE verifier/challenge encoding rules
- authorize URL contents
- plain code input
- parity parser behavior from `anthropic-oauth.ts`
- any intentional parser enhancements, tested separately from parity
- token exchange request shape
- refresh request shape
- exchange/refresh error propagation
- golden fixture conformance for exchange and refresh

These tests should validate the exact contract derived from `anthropic-oauth.ts`.

### Integration tests

Preserve and expand tests for:

- CLI login/reauth/logout
- plugin OAuth callback flows
- slash-command login/reauth completion
- duplicate-account updates
- refresh-token rotation and disk sync
- account failover and state reset behavior
- OpenCode `auth.json` sync and bootstrap compatibility
- logout local cleanup plus best-effort revoke behavior

### Regression tests for separation boundaries

Add tests proving that:

- chat header profiles do not affect token exchange behavior
- request/body transforms do not affect auth flows
- account orchestration does not change low-level token request semantics

## Migration Risks

### Risk 1: Reintroducing current complexity into the new auth layer

Mitigation:

- freeze the auth contract first
- reject feature-driven changes to token request semantics unless required by Anthropic compatibility

### Risk 2: Breaking refresh/rotation while simplifying auth

Mitigation:

- keep refresh lock and disk sync code unchanged initially
- swap only the low-level token transport beneath it

### Risk 3: Header-profile logic accidentally changing auth requests

Mitigation:

- explicitly separate token endpoint requests from chat request shaping
- test token requests independently from model requests

### Risk 4: Multiple runtime entrypoints drifting again

Mitigation:

- ensure CLI, plugin, and slash-command flows all import the same shared auth helper
- avoid one-off auth logic in entrypoint files

## Recommended Work Order

1. Document the auth contract from `anthropic-oauth.ts`
2. Capture golden request/response fixtures for the working flow
3. Rebuild shared auth helpers to match that contract exactly
4. Extract a shared account-application and OpenCode-auth-sync path
5. Reconnect existing account orchestration unchanged where possible
6. Switch CLI, plugin, and slash-command entrypoints over together
7. Reduce auth-specific logic inside the request loader path
8. Revalidate secondary auth modes
9. Add regression coverage for all entrypoints

## Non-Goals

This migration should not:

- remove multi-account support
- remove header emulation profiles
- remove CLI workflows
- remove slash-command management flows
- break OpenCode `auth.json` sync or first-run bootstrap
- remove account-state tracking or refresh locking
- collapse the project back to a single-account plugin

The objective is to keep the current feature surface while replacing the fragile auth foundation with the thinner, working approach proven by `anthropic-oauth.ts`.
