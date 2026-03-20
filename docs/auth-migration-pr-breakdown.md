# Auth Migration PR Breakdown

## Purpose

This document breaks `docs/auth-migration-implementation-plan.md` into PR-sized units that can be implemented, reviewed, and validated incrementally while keeping the repository stable.

## Planning Rules

- Each PR should have one primary objective.
- Each PR should leave the repo in a merge-safe, releasable state unless explicitly marked `stacked`.
- "Releasable" here means merge-safe and shippable if needed; it does not require that every PR be intended for external release as a user-visible migration milestone.
- Main OAuth compatibility work should land before secondary-mode cleanup.
- CLI, slash-command, and connect-provider auth flows should switch together once shared primitives are ready.
- Request-shaping behavior must not be refactored in the same PR as low-level OAuth wire changes unless required for correctness.

## PR Overview

| PR  | Title                                              | Type            | Depends on | Goal                                                                                                                                                          |
| --- | -------------------------------------------------- | --------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Baseline, auth contract, and fixtures              | docs/tests      | none       | Freeze Phase 0 baseline plus the authorize/exchange contract from `anthropic-oauth.ts` and explicit refresh/revoke migration extensions before implementation |
| 2   | Rebuild shared OAuth transport                     | code/tests      | PR 1       | Replace low-level auth semantics in `lib/oauth.mjs`                                                                                                           |
| 3   | Centralize credential application and auth sync    | code/tests      | PR 2       | Keep storage/OpenCode auth behavior stable on top of new transport                                                                                            |
| 4   | Reconnect multi-account orchestration              | code/tests      | PR 3       | Preserve account manager behavior with the new auth helper                                                                                                    |
| 5   | Unify CLI, slash, and connect-provider flows       | code/tests      | PR 3, PR 4 | Make all auth entrypoints use the same shared primitives                                                                                                      |
| 6   | Separate auth transport from request customization | code/tests      | PR 5       | Shrink loader auth responsibilities without losing request shaping                                                                                            |
| 7   | Revalidate refresh locking and concurrency         | code/tests      | PR 6       | Confirm no refresh races or disk-clobber regressions                                                                                                          |
| 8   | Revalidate logout and secondary auth modes         | code/tests/docs | PR 7       | Finish non-primary flows after main OAuth path is stable                                                                                                      |
| 9   | Final migration docs and release prep              | docs            | PR 8       | Document the resulting architecture and rollout expectations                                                                                                  |

## PR 1: Baseline, Auth Contract, And Fixtures

### Objective

Create a source-of-truth contract for the working authorize/exchange behavior from `anthropic-oauth.ts`, plus explicit migration-target extensions for refresh/revoke, and encode Phase 0 baseline expectations into fixtures/tests before changing implementation.

### Scope

- document exact authorize/exchange behavior from `anthropic-oauth.ts`
- document explicit migration-target refresh/revoke behavior needed for the shared helper rebuild
- capture the Phase 0 baseline of current entrypoints and preserved behaviors
- capture golden fixtures for request and response shapes
- document parity vs intentional post-parity enhancements

### Files

- `docs/auth-approach-migration-plan.md`
- `docs/auth-migration-implementation-plan.md`
- `docs/auth-contract-reference.md`
- fixtures under `test/fixtures/`
- `lib/oauth.test.mjs`

### Tasks

- write the canonical contract note for authorize, exchange, refresh, and revoke
- capture exact request fields, content types, headers, and body encoding
- capture representative success and failure payloads
- define parser parity with `anthropic-oauth.ts`
- mark any broader parsing as follow-up behavior, not parity behavior
- add fixture-backed tests that validate the captured contract artifacts and reference helpers without changing runtime behavior yet

### Out Of Scope

- changing `lib/oauth.mjs`
- changing CLI or plugin behavior

### Acceptance Criteria

- the contract is documented and reviewed
- the Phase 0 baseline is captured in planning docs
- tests can fail if request semantics drift from the captured contract
- parity vs enhancement is explicit

### Suggested Commit Shape

- `docs(auth): capture anthropic oauth contract and fixtures`

## PR 2: Rebuild Shared OAuth Transport

### Objective

Replace the low-level shared OAuth helper with behavior that matches the captured contract.

### Scope

- `authorize()`
- PKCE generation
- state handling
- code parsing
- authorization-code exchange
- refresh semantics
- revoke compatibility checks

### Files

- `lib/oauth.mjs`
- `lib/oauth.test.mjs`
- `lib/config.mjs` if needed for auth-specific constants only

### Tasks

- rebuild authorize behavior around the reference PKCE/state contract
- rebuild exchange around the exact captured request semantics
- rebuild refresh around the same compatibility-first transport philosophy
- preserve normalized credential output for callers
- preserve rich error reporting without changing wire behavior
- remove old helper logic that conflicts with the captured contract

### Out Of Scope

- entrypoint rewiring in `cli.mjs` or `index.mjs`
- account-storage behavior changes

### Acceptance Criteria

- `lib/oauth.test.mjs` passes with contract fixtures
- `lib/oauth.mjs` is the only low-level OAuth transport implementation
- no CLI/plugin-specific low-level token transport implementation remains, even though entrypoint flow duplication is cleaned up later in PR 5

### Suggested Commit Shape

- `fix(auth): rebuild shared oauth transport from captured contract`

## PR 3: Centralize Credential Application And Auth Sync

### Objective

Preserve storage and OpenCode auth interoperability while making both consume the new transport through one shared credential-application path.

### Scope

- account update path after successful exchange or refresh
- OpenCode `auth.json` sync behavior
- bootstrap from OpenCode auth when account storage is missing
- duplicate-account update behavior

### Files

- `lib/account-state.mjs`
- `lib/opencode-auth.mjs`
- `lib/storage.mjs`
- `lib/accounts.mjs`
- related tests

### Tasks

- extract a shared post-auth credential application helper if one does not already exist
- unify account update behavior for new login, reauth, and refresh
- preserve `token_updated_at` semantics and freshness merge rules
- preserve duplicate refresh-token update behavior
- preserve write-through to OpenCode auth from active account state
- preserve bootstrap from OpenCode auth-only environments

### Out Of Scope

- UI flow changes
- request-shaping changes

### Acceptance Criteria

- CLI/plugin interoperability via OpenCode auth remains intact
- duplicate-account reauth still updates existing entries
- storage freshness and merge behavior remain backward compatible

### Suggested Commit Shape

- `refactor(auth): centralize credential application and opencode auth sync`

## PR 4: Reconnect Multi-Account Orchestration

### Objective

Reconnect account-manager behavior to the new auth foundation without changing multi-account product behavior.

### Scope

- add/update/remove/enable/disable
- active-account switching
- failover and rate-limit handling
- health score and token bucket integration

### Files

- `lib/accounts.mjs`
- `lib/accounts.test.mjs`
- `lib/rotation.mjs`
- `lib/rotation.test.mjs`
- `lib/backoff.mjs`

### Tasks

- ensure `AccountManager` consumes normalized credentials only
- preserve duplicate-account handling and state reset rules
- preserve rate-limit/failure tracking and account recovery behavior
- preserve active-index semantics during add/remove/disable
- verify health-score and token-bucket selection remain unchanged

### Out Of Scope

- slash or CLI UX rewiring
- request transform logic

### Acceptance Criteria

- multi-account tests pass unchanged or with only compatibility-driven updates
- account orchestration has no dependence on OAuth wire details

### Suggested Commit Shape

- `refactor(accounts): reconnect multi-account orchestration to shared auth`

## PR 5: Unify CLI, Slash, And Connect-Provider Flows

### Objective

Make all user-facing auth entrypoints use the same shared authorize/exchange/application path.

### Scope

- CLI login/reauth/logout flows
- slash login/reauth flows
- connect-provider OAuth callback flow

### Files

- `cli.mjs`
- `cli.test.mjs`
- `index.mjs`
- `index.test.mjs`
- `lib/commands.mjs`

### Tasks

- remove duplicate low-level auth flow logic from entrypoint files
- route CLI login/reauth through shared primitives
- route slash start/complete through the same primitives
- route connect-provider callback through the same credential application path, while keeping full callback URL/query extraction at the entrypoint boundary unless it is later added to the shared contract
- ensure logout keeps guaranteed local cleanup plus best-effort revoke
- ensure UX differences are limited to prompting and messaging

### Out Of Scope

- request customization cleanup beyond what is needed for auth unification

### Acceptance Criteria

- one auth implementation exists across CLI, slash, and connect-provider
- auth behavior no longer differs by entrypoint
- login/reauth/logout tests all pass

### Suggested Commit Shape

- `refactor(auth): unify cli and plugin oauth entrypoints`

## PR 6: Separate Auth Transport From Request Customization

### Objective

Reduce coupling between auth transport and chat request shaping while preserving all request-level functionality.

### Scope

- header profiles
- beta handling
- billing header injection
- request URL transforms
- request body transforms
- tool prefixing
- SSE rewriting
- refresh-on-demand behavior that must remain in the loader

### Files

- `index.mjs`
- `index.test.mjs`
- `lib/request-headers.mjs`
- `lib/request-headers.test.mjs`

### Tasks

- isolate token endpoint requests from chat request header/body mutation logic
- preserve all current chat-shaping behavior for Anthropic model requests
- document what still must remain in the interceptor path
- add regression tests proving auth calls do not inherit chat-only behavior

### Out Of Scope

- changing user-facing auth UX

### Acceptance Criteria

- auth transport and chat-shaping concerns are independently maintainable
- request-shaping behavior is functionally unchanged
- auth tests and request-shaping tests are clearly separated

### Suggested Commit Shape

- `refactor(plugin): separate oauth transport from request customization`

## PR 7: Revalidate Refresh Locking And Concurrency

### Objective

Prove that the new auth foundation still behaves correctly under concurrent refresh and multi-process conditions.

### Scope

- refresh locking
- disk reconciliation
- stale-vs-fresh token resolution
- refresh failure marking

### Files

- `index.mjs`
- `lib/refresh-lock.mjs`
- `lib/refresh-lock.test.mjs`
- `lib/storage.mjs`
- `lib/storage.test.mjs`
- `lib/account-state.mjs`

### Tasks

- verify refresh lock acquisition/release remains correct
- verify only freshest disk auth wins
- verify in-memory stale state cannot clobber fresh tokens on disk
- verify refresh failures still update account state appropriately
- add concurrency-focused regression tests where coverage is weak

### Out Of Scope

- new features

### Acceptance Criteria

- no refresh race or stale-write regression is detected
- existing concurrency protections remain intact

### Suggested Commit Shape

- `test(auth): revalidate refresh locking and token freshness`

## PR 8: Revalidate Logout And Secondary Auth Modes

### Objective

Finish the non-primary auth paths only after the Claude Pro/Max path is stable.

### Scope

- logout
- logout-all
- revoke
- API-key creation flow
- manual API-key flow

### Files

- `cli.mjs`
- `index.mjs`
- relevant tests
- `README.md` only if behavior/caveats need clarification

### Tasks

- verify logout and logout-all always clean up local state
- verify revoke remains best-effort and cannot block cleanup
- verify API-key creation still works after auth refactor
- verify manual API-key mode still coexists with storage and plugin flows
- update docs if there are clarified caveats, but avoid feature changes here

### Out Of Scope

- changing the primary OAuth flow again

### Acceptance Criteria

- non-primary auth modes remain functional or are explicitly documented as unchanged pending follow-up
- no secondary flow destabilizes the main OAuth path

### Suggested Commit Shape

- `test(auth): revalidate logout and secondary auth modes`

## PR 9: Final Migration Docs And Release Prep

### Objective

Close the migration with accurate docs and release guidance once implementation is stable.

### Scope

- architecture docs
- user docs
- release note guidance

### Files

- `README.md`
- `docs/auth-approach-migration-plan.md`
- `docs/auth-migration-implementation-plan.md`
- `docs/auth-migration-pr-breakdown.md`
- any additional docs created during implementation

### Tasks

- update docs to describe the final architecture rather than the migration target state
- add release notes or release-note-ready bullets
- document any caveats discovered during implementation
- ensure docs match shipped behavior exactly

### Out Of Scope

- further auth behavior changes unless a blocker is discovered

### Acceptance Criteria

- docs reflect the implementation that actually shipped
- the migration can be understood without reading intermediate PRs

### Suggested Commit Shape

- `docs(auth): finalize migration documentation and release notes`

## Stacking Guidance

- PR 1 should merge first and stand alone.
- PR 2 can merge independently if public interfaces remain stable.
- PR 3 and PR 4 can be stacked during development, but PR 3 should merge before PR 4.
- PR 5 should merge only after PR 3 and PR 4 are green.
- PR 6 should not merge until PR 5 is stable because it depends on unified entrypoints.
- PR 7 should be the last code-heavy validation PR before secondary-mode checks.
- PR 8 should stay small and focused; if API-key flows need larger fixes, split them into follow-up PRs.
- PR 9 should merge last.

## Review Checklist Per PR

- Does this PR change exactly one layer or one boundary?
- Does it preserve OpenCode `auth.json` interoperability?
- Does it avoid mixing auth wire changes with unrelated request-shaping refactors?
- Are regression tests added or updated at the right boundary?
- Can the next PR build on this without reworking the contract again?

## Recommended First Three PRs

If implementation starts immediately, the highest-value first sequence is:

1. PR 1: contract and fixture capture
2. PR 2: shared OAuth transport rebuild
3. PR 3: credential application and OpenCode auth sync centralization

That sequence establishes the new auth foundation before touching the most user-visible UX flows.
