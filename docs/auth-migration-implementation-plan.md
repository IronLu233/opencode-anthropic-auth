# Auth Migration Implementation Plan

## Purpose

This document turns `docs/auth-approach-migration-plan.md` into an execution-ready engineering plan for migrating the OAuth foundation to the thinner auth contract defined in `docs/auth-contract-reference.md` while preserving the current product surface.

## Goals

- Replace the low-level OAuth transport in `lib/oauth.mjs` with behavior derived from `anthropic-oauth.ts` for authorize/exchange and from the documented migration-target extensions for refresh/revoke in `docs/auth-contract-reference.md`.
- Preserve current multi-account behavior in `lib/accounts.mjs`, `lib/rotation.mjs`, and `lib/storage.mjs`.
- Preserve OpenCode `auth.json` bootstrap and sync behavior in `lib/opencode-auth.mjs`.
- Preserve CLI flows in `cli.mjs`: `login`, `reauth`, `refresh`, `logout`, `logout --all`, account switching, enable/disable, and stats flows.
- Preserve slash-command and connect-provider flows in `index.mjs`, including pending OAuth state handling.
- Preserve request shaping in `index.mjs`: header profiles, beta headers, billing header insertion, request URL/body transforms, MCP/tool prefixing, and response-stream rewriting.
- Preserve refresh coordination and state handling in `index.mjs`, `lib/refresh-lock.mjs`, and `lib/account-state.mjs`.
- Preserve optional API-key and manual auth modes as supported secondary flows.

## Non-Goals

- No reduction of the supported feature set.
- No redesign of account rotation strategies.
- No replacement of storage formats unless required for compatibility.
- No broad rewrite of request interception that is unrelated to auth separation.
- No UX redesign beyond changes needed to route existing flows through shared primitives.
- No shipping of new auth modes before the Claude Pro/Max OAuth path is stable.

## Current Functional Surface To Preserve

The migration is complete only if all of the following still work after cutover:

- Multi-account add, update, remove, enable, disable, switch, rotation, failover, and duplicate detection.
- OpenCode `auth.json` write-through from CLI/plugin flows and bootstrap from existing OpenCode auth when account storage is absent.
- CLI auth and management flows in `cli.mjs`.
- Slash-command auth flows and connect-provider callback handling in `index.mjs`.
- Header emulation profiles and overrides from `lib/request-headers.mjs` and `lib/config.mjs`.
- Request URL/body transforms, tool prefixing, SSE response rewriting, and usage extraction in `index.mjs`.
- Refresh locking, disk reconciliation, and token freshness handling in `index.mjs`, `lib/refresh-lock.mjs`, and `lib/storage.mjs`.
- Account-state tracking and reset helpers in `lib/account-state.mjs`.
- Optional API-key flows and manual API-key mode integration.

## Architecture Boundaries

### Layer 1: OAuth Transport

Scope:

- Authorization URL creation
- PKCE generation and encoding
- OAuth code parsing
- Authorization-code exchange
- Refresh-token exchange
- Revoke
- Exact request semantics for Anthropic OAuth compatibility

Primary targets:

- `anthropic-oauth.ts`
- `lib/oauth.mjs`
- `lib/oauth.test.mjs`

Rules:

- This layer owns wire compatibility.
- This layer must not own account pooling, rotation, storage policy, or UI.
- Request semantics are allowed to be "ugly but compatible" if needed.

### Layer 2: Account Orchestration

Scope:

- Account persistence and deduplication
- Active-account selection and failover
- Failure and rate-limit tracking
- Stats tracking
- Disk merge and token freshness reconciliation
- OpenCode auth sync/bootstrap
- Refresh coordination and lock usage

Primary targets:

- `lib/accounts.mjs`
- `lib/storage.mjs`
- `lib/rotation.mjs`
- `lib/account-state.mjs`
- `lib/opencode-auth.mjs`
- `lib/refresh-lock.mjs`

Rules:

- This layer consumes normalized credentials: `{ refresh, access, expires, email? }`.
- This layer must not know token endpoint body shape or PKCE details.

### Layer 3: UX And Request Customization

Scope:

- CLI UX
- Slash-command UX
- Connect-provider UX
- Request headers and beta selection
- Request URL/body transforms
- Tool prefixing and SSE rewriting

Primary targets:

- `cli.mjs`
- `index.mjs`
- `lib/commands.mjs`
- `lib/request-headers.mjs`
- `lib/config.mjs`

Rules:

- UX entrypoints may collect input and display status.
- UX entrypoints must call shared auth/account primitives rather than reimplement auth behavior.
- Chat request shaping must remain isolated from token exchange semantics.

## Module Inventory And Migration Impact

| Module                    | Current role                                                        | Migration impact                                                              |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `anthropic-oauth.ts`      | Known-good thin OAuth reference plus plugin example                 | Source contract for authorize, exchange, refresh behavior                     |
| `lib/oauth.mjs`           | Shared OAuth helper used by CLI and plugin                          | Primary implementation replacement                                            |
| `cli.mjs`                 | CLI auth/account UX and direct token refresh flows                  | Must be rewired to shared auth/application primitives                         |
| `index.mjs`               | Plugin loader, slash commands, request transforms, refresh handling | Must stop owning low-level auth semantics while keeping request customization |
| `lib/accounts.mjs`        | Multi-account manager, persistence coordination, state merge        | Should remain behaviorally stable; consume normalized credentials only        |
| `lib/storage.mjs`         | Disk format, atomic saves, freshness merge, dedupe                  | Must remain backward compatible during migration                              |
| `lib/opencode-auth.mjs`   | OpenCode auth.json read/write/sync helpers                          | Must keep interoperability intact                                             |
| `lib/request-headers.mjs` | Header profiles, beta defaults, billing header generation           | Must remain independent from auth transport                                   |
| `lib/refresh-lock.mjs`    | Cross-process refresh locking                                       | Must remain unchanged until transport swap is stable                          |
| `lib/account-state.mjs`   | Token application and tracking reset helpers                        | Likely extraction point for shared post-auth application                      |
| `lib/commands.mjs`        | CLI/slash command resolution                                        | Low-risk; preserve behavior while shared auth handlers change                 |
| `lib/rotation.mjs`        | Account selection strategies                                        | No planned behavior change                                                    |

## Workstreams

### Workstream A: Auth Contract Capture

Deliverables:

- Written auth contract derived from `anthropic-oauth.ts`
- Golden authorize/exchange/refresh fixtures
- Parity matrix: exact parity vs allowed follow-up enhancement

Dependencies:

- None; starts first

Primary files:

- `anthropic-oauth.ts`
- `docs/auth-approach-migration-plan.md`
- New contract/fixture docs under `docs/`

### Workstream B: Shared OAuth Helper Rebuild

Deliverables:

- Reworked `lib/oauth.mjs`
- Contract-focused tests in `lib/oauth.test.mjs`
- Shared normalized credential result contract

Dependencies:

- Workstream A complete

Primary files:

- `lib/oauth.mjs`
- `lib/oauth.test.mjs`
- `lib/config.mjs`

### Workstream C: Shared Credential Application And Sync

Deliverables:

- Shared account-application path used by CLI and plugin
- Preserved OpenCode auth sync/bootstrap behavior
- Explicit first-login and fallback rules

Dependencies:

- Workstream B complete

Primary files:

- `lib/account-state.mjs`
- `lib/opencode-auth.mjs`
- `lib/storage.mjs`
- `lib/accounts.mjs`

### Workstream D: Entrypoint Unification

Deliverables:

- Common auth flow used by CLI, slash commands, and connect-provider callback
- Removal of low-level auth duplication from `cli.mjs` and `index.mjs`

Dependencies:

- Workstreams B and C complete

Primary files:

- `cli.mjs`
- `index.mjs`
- `lib/commands.mjs`

### Workstream E: Request-Customization Boundary Cleanup

Deliverables:

- Clear separation between auth transport and chat request shaping
- Regression coverage proving header/body transforms do not affect auth behavior

Dependencies:

- Workstream D complete

Primary files:

- `index.mjs`
- `lib/request-headers.mjs`
- `index.test.mjs`

### Workstream F: Secondary Auth Modes Revalidation

Deliverables:

- Verified optional API-key and manual-mode compatibility
- Logout/revoke behavior rechecked across modes

Dependencies:

- Main OAuth path stable in production-like verification

Primary files:

- `cli.mjs`
- `index.mjs`
- `README.md` and user docs only if behavior needs clarification

## Phase Plan

### Phase 0: Baseline And Freeze

Objective:

- Establish the current behavior baseline before code movement starts.

Tasks:

- Inventory every current auth entrypoint and map it to concrete functions in `cli.mjs` and `index.mjs`.
- Record existing tests covering OAuth, accounts, slash commands, request headers, storage, refresh locks, and account state.
- Identify any current behavior that is intentionally more permissive than `anthropic-oauth.ts`.
- Freeze acceptance criteria and regression checklist in this document before implementation begins.

Exit criteria:

- Team agrees on preserved behavior list.
- No undocumented auth entrypoints remain.

### Phase 1: Capture The Working Auth Contract

Objective:

- Convert `anthropic-oauth.ts` into a precise implementation contract.

Tasks:

- Document authorize URL generation, PKCE algorithm, unpadded base64url rules, `state` behavior, and code parsing.
- Capture exact exchange request fields, content type, headers, and body encoding.
- Capture exact refresh request fields, content type, headers, and body encoding as migration-target extensions to the working `anthropic-oauth.ts` contract.
- Capture revoke behavior and timeout expectations as migration-target extensions to the working `anthropic-oauth.ts` contract.
- Add golden fixtures for authorize URL, exchange request, refresh request, success payloads, and representative failures.
- Mark each contract item as `must match exactly`, `must remain functionally equivalent`, or `candidate follow-up`.

File/module targets:

- `anthropic-oauth.ts`
- `docs/auth-contract-reference.md`
- `test/fixtures/` contract fixtures

Dependencies:

- Phase 0

Exit criteria:

- A single contract exists for all auth callsites.
- Golden fixtures are ready for test assertions.

### Phase 2: Rebuild Shared OAuth Helpers

Objective:

- Implement the auth transport around the captured contract.

Tasks:

- Replace `lib/oauth.mjs` authorize logic to match the reference PKCE/state behavior.
- Replace code parsing and exchange logic to match the reference flow.
- Update refresh behavior to follow the same compatibility-first philosophy.
- Keep error surfacing rich, but do not change network semantics to achieve it.
- Ensure helper outputs remain normalized for upstream consumers.
- Expand `lib/oauth.test.mjs` to assert request shapes and failure propagation.

File/module targets:

- `lib/oauth.mjs`
- `lib/oauth.test.mjs`
- `lib/config.mjs`

Dependencies:

- Phase 1

Exit criteria:

- Shared helper behavior matches contract fixtures.
- No entrypoint owns a separate token exchange implementation.

### Phase 3: Preserve Storage, Sync, And Credential Application

Objective:

- Make credential persistence and sync consume the new auth helper without changing storage behavior.

Tasks:

- Extract or formalize a single credential-application path for newly exchanged tokens.
- Ensure duplicate refresh-token updates still refresh existing accounts instead of creating duplicates.
- Preserve `token_updated_at` freshness semantics.
- Preserve OpenCode `auth.json` write-through from active account state.
- Preserve first-run bootstrap from OpenCode auth when account storage is missing.
- Preserve disk merge behavior that avoids stale-process clobber in `lib/storage.mjs`.

File/module targets:

- `lib/account-state.mjs`
- `lib/storage.mjs`
- `lib/opencode-auth.mjs`
- `lib/accounts.mjs`

Dependencies:

- Phase 2

Exit criteria:

- CLI and plugin can both create or update accounts without sync regressions.
- Bootstrap still works from existing OpenCode auth only.

### Phase 4: Reconnect Multi-Account Orchestration

Objective:

- Keep the existing account manager and rotation system behaviorally stable while moving auth beneath it.

Tasks:

- Confirm `AccountManager.load()` continues to reconcile fallback auth with disk state.
- Preserve `addAccount()`, duplicate handling, enable/disable, remove, and save-to-disk behavior.
- Preserve health-score and token-bucket strategy behavior in `lib/rotation.mjs`.
- Preserve rate-limit backoff and account disable/reenable flows.
- Preserve stats accumulation and merge-on-save behavior.

File/module targets:

- `lib/accounts.mjs`
- `lib/rotation.mjs`
- `lib/storage.mjs`
- `lib/backoff.mjs`

Dependencies:

- Phase 3

Exit criteria:

- Multi-account features behave the same with the new auth helper underneath.
- Account orchestration never reaches into low-level OAuth request details.

### Phase 5: Unify CLI, Slash, And Connect-Provider Flows

Objective:

- Route every auth entrypoint through the same shared primitives.

Tasks:

- Replace direct auth flow differences in `cli.mjs` with shared authorize/exchange/application helpers.
- Update slash OAuth start/completion in `index.mjs` to use the same shared flow object and exchange path.
- Update connect-provider callback handling in `index.mjs` to use the same credential application path as CLI/slash flows, while allowing full callback URL/query extraction to remain an entrypoint concern unless it is explicitly promoted into the shared contract later.
- Ensure reauth targets an existing account consistently across CLI and slash flows.
- Preserve current logout/revoke behavior so shared primitives do not regress local cleanup guarantees; exhaustive revalidation of logout variants remains a dedicated later phase.

File/module targets:

- `cli.mjs`
- `index.mjs`
- `lib/account-state.mjs`
- `lib/commands.mjs`

Dependencies:

- Phase 4

Exit criteria:

- One auth implementation exists with multiple UIs.
- CLI and slash behavior differ only in interaction method.

### Phase 6: Separate Auth Transport From Request Customization

Objective:

- Keep request customization intact while removing auth coupling from the loader path.

Tasks:

- Isolate token exchange and refresh semantics from `buildRequestHeaders()`, `transformRequestBody()`, `transformRequestUrl()`, and SSE rewriting.
- Preserve header profile, beta, billing, and override behavior in `lib/request-headers.mjs` and `index.mjs`.
- Preserve body transforms, tool prefixing, and response rewrite behavior in `index.mjs`.
- Preserve refresh-on-demand and transformed request replay where hooks cannot replace fetch interception.
- Add regression coverage proving auth requests are untouched by chat request customization.

File/module targets:

- `index.mjs`
- `lib/request-headers.mjs`
- `index.test.mjs`
- `lib/request-headers.test.mjs`

Dependencies:

- Phase 5

Exit criteria:

- Header and body customization can evolve without changing OAuth semantics.
- Auth regressions are isolated from chat-shaping regressions.

### Phase 7: Refresh Reliability And Locking Revalidation

Objective:

- Reconfirm cross-process token refresh correctness after the transport swap.

Tasks:

- Verify `refreshAccountToken()` in `index.mjs` still respects disk freshness checks.
- Verify `acquireRefreshLock()` and `releaseRefreshLock()` usage remains correct around refresh.
- Verify fresh disk auth wins over stale in-memory auth.
- Verify background/foreground refresh paths use the same helper semantics.
- Verify refresh failure handling still marks account state correctly and does not corrupt storage.

File/module targets:

- `index.mjs`
- `lib/refresh-lock.mjs`
- `lib/storage.mjs`
- `lib/account-state.mjs`
- `lib/refresh-lock.test.mjs`

Dependencies:

- Phase 6

Exit criteria:

- No concurrent refresh regression remains.
- Token freshness and disk reconciliation still behave correctly.

### Phase 8: Revalidate Optional API-Key Modes

Objective:

- Restore confidence in non-primary auth modes only after the main flow is stable.

Tasks:

- Verify API-key creation flow still works from the new auth foundation.
- Verify manual API-key mode still coexists with account storage and plugin flows.
- Verify secondary-mode docs remain accurate if behavior or caveats change.

File/module targets:

- `cli.mjs`
- `index.mjs`
- relevant tests and docs

Dependencies:

- Phase 7

Exit criteria:

- Secondary modes do not regress the primary OAuth path.

## Dependency And Sequencing Plan

| Sequence | Phase   | Why it must happen here                                                      |
| -------- | ------- | ---------------------------------------------------------------------------- |
| 1        | Phase 0 | Prevents hidden behaviors from being lost during refactor                    |
| 2        | Phase 1 | Freezes the compatibility contract before implementation                     |
| 3        | Phase 2 | Rebuilds the low-level helper first                                          |
| 4        | Phase 3 | Makes persistence and sync consume the new helper safely                     |
| 5        | Phase 4 | Reconnects multi-account behavior after persistence is stable                |
| 6        | Phase 5 | Unifies all entrypoints on top of stable auth and storage                    |
| 7        | Phase 6 | Shrinks auth coupling from request customization only after flow unification |
| 8        | Phase 7 | Revalidates concurrency-sensitive refresh behavior after full integration    |
| 9        | Phase 8 | Reintroduces secondary auth complexity last                                  |

Parallelization guidance:

- Workstream A is standalone.
- Test fixture authoring can begin during Phase 1 and continue through Phase 2.
- Request-boundary cleanup should not start before shared auth usage is unified.
- Secondary-mode work must not run in parallel with unresolved main OAuth regressions.

## Engineering Task Breakdown

### Contract And Test Tasks

- Add a contract note documenting exact authorize/exchange/refresh behavior.
- Add fixture-backed tests for request shape and parser behavior.
- Add regression tests that separate auth semantics from request transforms.

### Core Auth Tasks

- Replace PKCE generation and `state` handling in `lib/oauth.mjs`.
- Replace code parsing/exchange semantics in `lib/oauth.mjs`.
- Keep revoke and refresh semantics compatibility-first.

### Persistence And Sync Tasks

- Centralize post-exchange credential application.
- Keep `token_updated_at` and disk freshness merge rules intact.
- Keep OpenCode bootstrap and sync rules intact.

### Entrypoint Tasks

- Refactor `cli.mjs` login/reauth/refresh/logout flows to call shared primitives.
- Refactor `index.mjs` slash OAuth and connect-provider flows to call the same primitives.
- Remove duplicate low-level auth logic from entrypoint files.

### Runtime Boundary Tasks

- Keep header/profile and body transform logic in request customization only.
- Ensure auth requests do not inherit chat-only headers or transforms.
- Keep SSE response rewriting tied only to transformed chat flows.

### Reliability Tasks

- Reconfirm single-flight refresh behavior.
- Reconfirm lock ownership and stale-lock cleanup behavior.
- Reconfirm disk-vs-memory token freshness resolution.

## Verification Checklist

### Unit And Contract Coverage

- `lib/oauth.test.mjs` verifies authorize URL, PKCE, parser, exchange, refresh, and revoke semantics.
- `lib/request-headers.test.mjs` still verifies profile/beta/billing behavior.
- `lib/account-state.test.mjs` still verifies credential application and active-index adjustments.
- `lib/refresh-lock.test.mjs` still verifies ownership-safe lock handling.
- `lib/storage.test.mjs` still verifies dedupe, atomic writes, and freshness merge.
- `lib/accounts.test.mjs` still verifies multi-account behaviors.

### Entrypoint Verification

- `cli.test.mjs` covers `login`, `reauth`, `refresh`, `logout`, `logout --all`, `switch`, `enable`, `disable`, `remove`, `reset`, and stats-related commands.
- `index.test.mjs` covers slash login, slash reauth, connect-provider callback, request transforms, header injection, and stream rewriting.

### Manual Or End-To-End Checks

- First-run bootstrap succeeds with only OpenCode `auth.json` present.
- Fresh CLI login is visible to plugin flow without manual intervention.
- Fresh slash login is visible to CLI/account storage without manual intervention.
- Duplicate-account reauth updates existing account credentials rather than adding a second account.
- Active account sync to OpenCode `auth.json` stays correct after switch/disable/remove.
- Refresh under concurrent processes updates disk once and preserves freshest tokens.
- Request transforms and tool prefixing still produce expected Anthropic-compatible payloads.
- Header profiles and overrides still shape chat requests exactly as before.
- Optional API-key paths still work after the OAuth migration is complete.

## Rollout Strategy

### Development Rollout

- Land the contract and tests first.
- Land the shared OAuth helper behind the existing public interfaces.
- Land persistence/sync extraction next.
- Switch CLI and plugin entrypoints in one coordinated change set.
- Land request-boundary cleanup only after green regression coverage.

### Release Rollout

- Ship as one migration-focused release rather than multiple partially migrated releases.
- Include a release note that calls out "auth foundation replaced, feature surface preserved".
- Keep storage format backward compatible so existing users do not need manual migration.
- Avoid enabling any new secondary auth mode in the same release as the OAuth foundation swap.

### Rollback Plan

- Preserve the pre-migration implementation until the new helper passes full verification.
- If production regressions appear, revert to the previous `lib/oauth.mjs` behavior while keeping contract docs and new tests for diagnosis.
- Do not roll back storage compatibility changes in a way that strands refreshed tokens on disk.

## Risks And Mitigations

| Risk                                                         | Impact                                         | Mitigation                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Contract capture misses a behavior from `anthropic-oauth.ts` | Rebuilt helper still fails against Anthropic   | Freeze fixtures first and review request shapes before implementation            |
| CLI and plugin drift during refactor                         | Different login outcomes by entrypoint         | Create shared primitives before switching entrypoints                            |
| OpenCode auth sync breaks                                    | First-run or cross-tool interoperability fails | Preserve `lib/opencode-auth.mjs` semantics and add explicit bootstrap tests      |
| Disk freshness merge regresses                               | Stale tokens overwrite fresh ones              | Keep `token_updated_at` merge rules and add concurrency tests                    |
| Refresh lock behavior regresses                              | Cross-process refresh corruption               | Revalidate `lib/refresh-lock.mjs` unchanged before optimizing anything           |
| Header/body transforms leak into auth calls                  | OAuth exchange breaks intermittently           | Add strict regression tests separating auth and chat requests                    |
| Multi-account behavior subtly changes                        | Routing/failover regressions                   | Treat `lib/accounts.mjs` and `lib/rotation.mjs` as behavior-preservation modules |
| Secondary auth modes re-add complexity too early             | Main OAuth path destabilizes                   | Gate API-key revalidation until main flow is stable                              |

## Explicit Acceptance Criteria

The migration is accepted only when all of the following are true:

1. `lib/oauth.mjs` authorize, exchange, refresh, and revoke behavior matches the captured contract from `anthropic-oauth.ts`.
2. CLI, slash-command, and connect-provider auth flows use the same shared auth primitives.
3. Multi-account add/update/remove/enable/disable/switch/rotation behavior is unchanged from the current release.
4. OpenCode `auth.json` sync and bootstrap behavior remains interoperable with account storage.
5. Header profiles, request/body transforms, tool prefixing, and SSE rewriting remain functionally unchanged for chat requests.
6. Refresh locking, disk freshness reconciliation, and account-state reset/application behavior remain correct under concurrency.
7. Duplicate-account handling still updates existing credentials instead of creating unintended extra accounts.
8. Logout and logout-all still guarantee local cleanup even if revoke fails server-side.
9. Optional API-key flows still work, or are explicitly held unchanged behind post-migration verification before release.
10. All relevant unit, integration, and regression tests pass, and manual verification items are checked off.

## Definition Of Done

The migration is done when:

- The new auth foundation is in place.
- Existing users do not lose data or features.
- Auth behavior is contract-tested.
- Entrypoint-specific auth logic has been consolidated.
- Request customization and auth transport are independently maintainable.
- Release notes and implementation docs accurately describe the resulting architecture.
