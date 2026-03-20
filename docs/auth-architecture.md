# Auth Architecture

## Overview

The project now uses a thin OAuth transport modeled on the working `anthropic-oauth.ts` flow while keeping the existing multi-account, CLI, slash-command, and request-customization features.

## Layers

### OAuth Transport

Files:

- `lib/oauth.mjs`
- `docs/auth-contract-reference.md`
- `test/fixtures/oauth-contract-reference.json`

Responsibilities:

- PKCE generation with Node crypto and unpadded base64url
- authorize URL creation
- auth-code parsing at the transport boundary
- authorization-code exchange
- refresh-token exchange
- best-effort revoke

Contract highlights:

- exchange uses `application/x-www-form-urlencoded`
- exchange uses `User-Agent: anthropic`
- outbound `state` is the locally generated verifier
- returned `#state` is no longer required to complete the flow

### Account Application And Sync

Files:

- `lib/account-state.mjs`
- `lib/opencode-auth.mjs`
- `lib/storage.mjs`

Responsibilities:

- normalize and apply exchanged credentials
- add-vs-update decisions for login
- targeted reauth with duplicate-account protection
- OpenCode `auth.json` sync/bootstrap compatibility
- storage persistence and token freshness rules

### Account Orchestration

Files:

- `lib/accounts.mjs`
- `lib/rotation.mjs`
- `lib/backoff.mjs`
- `lib/refresh-lock.mjs`

Responsibilities:

- account selection and failover
- rate-limit and failure tracking
- cross-process refresh locking
- disk reconciliation and stale-token protection

### Entrypoints And Request Customization

Files:

- `cli.mjs`
- `index.mjs`
- `lib/request-headers.mjs`

Responsibilities:

- CLI login/reauth/logout/manage flows
- slash-command and connect-provider flows
- header profiles and beta handling
- request URL/body transforms
- tool prefixing and SSE rewriting

The entrypoints now share the same low-level OAuth transport and the same storage-level credential application rules.

## Behavioral Guarantees

- login updates an existing account when the refresh token already exists
- reauth refuses to overwrite one account with credentials that already belong to another account
- CLI, slash-command, and connect-provider flows use the same exchange semantics
- OpenCode `auth.json` stays in sync after login, reauth, refresh, switch, enable, disable, remove, and logout flows
- fresh-start auth clears both account storage and OpenCode auth compatibility state before beginning a new login
- chat request shaping stays separate from token endpoint semantics

## Verification Status

Validated by the current automated suite:

- `npm test`

Coverage includes:

- OAuth transport contract tests
- account-state and storage tests
- multi-account orchestration tests
- CLI auth and management tests
- plugin lifecycle, slash auth, refresh, retry, and request-transform tests

## Migration Notes

- `docs/auth-approach-migration-plan.md` records the original migration direction
- `docs/auth-migration-implementation-plan.md` records the execution plan
- `docs/auth-migration-pr-breakdown.md` records the PR-sized breakdown used to implement the work
- `docs/auth-contract-reference.md` is the long-term source of truth for OAuth transport behavior
