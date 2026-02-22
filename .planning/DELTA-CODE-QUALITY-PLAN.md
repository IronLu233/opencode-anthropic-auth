# Delta Code Quality Normalization Plan (master...HEAD)

Status: Proposed  
Created: 2026-02-09  
Last Updated: 2026-02-10  
Branch: `rmk`  
Baseline Commit: `14bc352be1d543d204558ddc2cde5a093f20b0cf`  
Merge Base vs `master`: `d5a1ab46ac58c93d0edf5c9eea46f3e72981f1fd`

---

## 1) Objective

Run a structured code quality pass over the full `master...HEAD` delta to reduce duplication, normalize repeated patterns, and align inconsistent behavior between CLI and plugin slash command surfaces.

This plan is implementation-ready and designed so work can be resumed at any time without re-discovery.

---

## 2) Scope

### In Scope

- Code changed in `master...HEAD` (currently 36 files)
- Source + test normalization
- Refactors that are behavior-preserving by default
- Explicitly approved behavior changes only when fixing inconsistency bugs

### Out of Scope

- New user-facing features unrelated to normalization
- Broad architecture rewrites not tied to current delta pain points
- Performance tuning unless discovered as part of normalization

---

## 3) Risk Model

| Risk   | Definition                                                       | Typical Examples                                                 | Merge Gate                             |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| Low    | Localized, behavior-preserving extraction or message consistency | string fixes, helper extraction with same call flow              | unit tests + lint + format             |
| Medium | Cross-command refactor or shared helper used by many call sites  | account index resolver, shared state reset helper                | targeted tests + full suite            |
| High   | Changes affecting auth/network/routing behavior across surfaces  | OAuth contract unification, command registry shared by CLI/slash | full suite + focused manual validation |

---

## 4) Current State Snapshot

- Delta size (from `master...HEAD`): large, multi-file feature expansion (CLI auth mgmt, slash command routing, docs, tests).
- Working tree currently contains local modifications in `index.mjs` and `index.test.mjs` (not part of this planning deliverable).
- Existing quality baseline is strong (high test coverage), but normalization debt is visible.

### Measured duplication hotspots (current)

- `const n = parseInt(arg, 10)` in CLI: 8 occurrences (`cli.mjs:429`, `557`, `617`, `838`, `875`, `912`, `976`, `1067`)
- `if (!stored || stored.accounts.length === 0)` in CLI: 15 occurrences (example: `cli.mjs:436`, `569`, `845`, `983`, `1366`)
- account tracking reset triplet (`rateLimitResetTimes`, `consecutiveFailures`, `lastFailureTime`):
  - CLI: 15 occurrences (`cli.mjs:596-598`, `651-653`, `1057-1059`, `1079-1081`, `1436-1438`)
  - Plugin: 6 occurrences (`index.mjs:814-816`, `866-868`)

---

## 5) Findings and Evidence

## F-001: OAuth account upsert logic duplicated across CLI and slash flow (P1)

**Risk:** Medium  
**Impact:** Divergence risk and inconsistent state reset behavior

**Evidence**

- CLI login duplicate/add paths: `cli.mjs:356-413`
- Slash OAuth completion duplicate/add paths: `index.mjs:781-870`

**Current divergence**

- Slash duplicate-login path resets tracking fields (`index.mjs:814-816`), while CLI duplicate-login path does not (`cli.mjs:374-377`).

---

## F-002: CLI account argument validation is copy-pasted (P1)

**Risk:** Medium  
**Impact:** Message drift, inconsistent validation semantics, harder maintenance

**Evidence**

- Repeated parse/bounds logic: `cli.mjs:429`, `557`, `617`, `838`, `875`, `912`, `976`, `1067`
- Repeated empty storage checks: `cli.mjs:436`, `569`, `624`, `845`, `882`, `919`, `983`, `1049`, `1366`

---

## F-003: OAuth HTTP logic has inconsistent contracts (P2)

**Risk:** High  
**Impact:** Different failure modes and diagnostics by call path

**Evidence**

- CLI refresh helper (returns `null`): `cli.mjs:148-171`
- Plugin refresh helper (throws enriched error object): `index.mjs:545-600`
- Shared oauth exchange/revoke contract (`{ type: "failed" }` / boolean): `lib/oauth.mjs:37-93`

---

## F-004: Repeated state mutation blocks (P2)

**Risk:** Low to Medium  
**Impact:** Missed updates and subtle behavior skew

**Evidence**

- Repeated tracking reset triplets in CLI and plugin (see section 4 metrics)
- Active index adjustment after remove appears in multiple command paths (`cli.mjs:480-486`, `1016-1022`, `1511-1517`)

---

## F-005: User-facing messaging inconsistencies (P3)

**Risk:** Low  
**Impact:** UX confusion

**Evidence**

- Mixed binary references: `opencode auth login` appears in `cli.mjs:680`, `1031`, `1368`
- Canonical CLI identity is `opencode-anthropic-auth` (`cli.mjs:1559`)
- Inconsistent error channel at least once: `console.log(c.red(...))` in `cli.mjs:1345`

---

## F-006: Test fixture duplication (P3)

**Risk:** Medium  
**Impact:** Higher maintenance and drift in test assumptions

**Evidence**

- Similar account fixture builders:
  - `index.test.mjs:91-114`
  - `lib/accounts.test.mjs:17-41`

---

## 6) Target Normalization Outcomes

By the end of this roadmap, the codebase should have:

1. One shared source of truth for OAuth credential application to account state.
2. One shared CLI account-target resolution pattern (or helper) for commands taking `<N>`.
3. One shared account tracking reset helper used across CLI/plugin flows.
4. Aligned OAuth network contract (success/failure semantics and diagnostics) across CLI/plugin/shared lib.
5. Consistent user-facing command references and error output channels.
6. Shared test fixture helpers for account storage payload construction.

---

## 7) Execution Roadmap (Incremental, Resume-Friendly)

Each phase is independently shippable.

## Phase 0 - Baseline and Guardrails

**Risk:** Low  
**Goal:** Lock in baseline so refactors do not mask regressions.

### Tasks

- [x] Capture current test baseline and command-level behavior snapshots.
- [x] Record current duplication metrics (counts listed in section 4) for before/after comparison.
- [x] Add this plan file as the working source of truth.

### Validation

- `npm test`
- `npm run lint`
- `npm run format:check`

### Exit Criteria

- Baseline is reproducible and documented.

---

## Phase 1 - Quick Consistency Wins

**Risk:** Low  
**Goal:** Remove obvious inconsistencies with minimal code movement.

### Candidate Changes

- [x] Normalize binary references from `opencode auth login` to `opencode-anthropic-auth login` in `cli.mjs:680`, `1031`, `1368`.
- [x] Standardize error channel usage (`console.error`) for invalid-input failure in `cmdResetStats` (`cli.mjs:1345`).
- [x] Normalize numeric validation style (prefer one pattern consistently in CLI).

### Files

- `cli.mjs`
- `cli.test.mjs` (message assertions where needed)

### Validation

- Focused tests for touched commands + full `npm test`

### Exit Criteria

- No user-facing mixed command guidance remains.
- Error outputs follow consistent channel/style for failures.

---

## Phase 2 - Shared Account Mutation Helpers

**Risk:** Medium  
**Goal:** Remove duplicated account state mutation blocks.

### Proposed Extractions

- [x] `resetAccountTracking(account)`
  - sets `rateLimitResetTimes = {}`
  - sets `consecutiveFailures = 0`
  - sets `lastFailureTime = null`
- [x] `adjustActiveIndexAfterRemoval(storage, removedIndex)`
  - centralize active index normalization behavior
- [x] optional: `applyOAuthCredentials(account, credentials, options)`

### Candidate Module

- New helper module under `lib/` (name to decide, e.g. `lib/account-state.mjs`)

### Call Sites

- CLI: `cmdReauth`, `cmdRefresh`, `cmdReset`, `cmdManage` flows (`cli.mjs` refs in section 4)
- Plugin slash OAuth completion paths (`index.mjs:814-816`, `866-868`)

### Validation

- Existing command tests + any parity tests added in phase

### Exit Criteria

- Duplicate triplet reset logic replaced by shared helper in both CLI and plugin.

---

## Phase 3 - CLI Account Target Resolver Normalization

**Risk:** Medium  
**Goal:** Centralize account index parsing/validation and reduce command boilerplate.

### Proposed Helper Shape

```js
resolveAccountIndex(arg, stored, {
  commandName,
  allowAll = false,
  min = 1,
})
```

### Tasks

- [x] Introduce helper in `cli.mjs` (or `lib/` if reusable elsewhere).
- [x] Migrate one command at a time (recommended order: `switch`, `enable`, `disable`, `remove`, `logout`, `reauth`, `refresh`, `reset`).
- [x] Keep user-facing wording stable unless explicitly improving consistency.

### Validation

- Command-by-command tests in `cli.test.mjs`
- Full suite after migration

### Exit Criteria

- Repeated parse/bounds boilerplate removed from command handlers.

---

## Phase 4 - OAuth Contract Unification

**Risk:** High  
**Goal:** Align refresh/exchange/revoke semantics and diagnostics.

### Current Problem

- CLI and plugin refresh paths differ in timeout, return shape, and error detail.

### Proposed Direction

- [ ] Extend `lib/oauth.mjs` to expose shared refresh function with structured result:
  - success: token payload
  - failure: structured error (`status`, `errorCode`, `message`, `body`)
- [ ] Migrate CLI refresh helper to use shared function.
- [ ] Migrate plugin refresh helper to same shared function (preserve current behavior contracts where needed).
- [ ] Keep backward compatibility with existing command output text unless intentionally changed.

### Validation

- Existing refresh failure/success tests (`cli.test.mjs`, `index.test.mjs`)
- Add explicit parity tests for same simulated API errors through both surfaces.

### Exit Criteria

- One canonical refresh behavior and diagnostics path.

---

## Phase 5 - Command Routing and Alias Normalization (Optional but Recommended)

**Risk:** High  
**Goal:** Reduce drift between CLI command aliases and slash command routing.

### Current State

- CLI dispatch switch in `cli.mjs:1682-1738`
- Slash command routing in `index.mjs:893-989`

### Tasks

- [x] Introduce command metadata registry (command name, aliases, flags, interactive constraints).
- [x] Use registry for CLI dispatch and slash validation/routing as feasible.
- [x] Preserve slash-specific behavior (two-step OAuth, forced `--force` on destructive commands, interactive blocking for `manage`).

### Validation

- Existing slash routing tests in `index.test.mjs`
- CLI alias tests in `cli.test.mjs`

### Exit Criteria

- Alias mapping and command availability can be changed in one place.

---

## Phase 6 - Test Fixture Consolidation

**Risk:** Medium  
**Goal:** Consolidate repeated fixture builders and bootstrap helpers.

### Tasks

- [x] Create shared test helper module(s), e.g. `test/helpers/accounts-fixtures.mjs`.
- [x] Move reusable builders used by:
  - `index.test.mjs`
  - `lib/accounts.test.mjs`
  - optionally `lib/storage.test.mjs`
- [x] Keep tests explicit and readable; avoid over-abstracting assertions.

### Validation

- Full `npm test`

### Exit Criteria

- Fixture definitions are centralized and consistent.

---

## 8) PR Slicing Strategy

Recommended order for safe incremental delivery:

1. PR-1: Phase 1 (quick consistency)
2. PR-2: Phase 2 (shared mutation helpers)
3. PR-3: Phase 3 (CLI resolver)
4. PR-4: Phase 4 (OAuth contract unification)
5. PR-5: Phase 6 (test fixture consolidation)
6. PR-6 (optional): Phase 5 (routing registry)

Each PR should include:

- scope statement
- behavior impact statement (expected: none unless explicitly noted)
- test delta summary
- rollback note

---

## 9) Validation Matrix

For every phase:

- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run format:check`

Phase-specific:

- OAuth-related phases: include mocked error parity tests in both `cli.test.mjs` and `index.test.mjs`.
- Routing-related phase: ensure slash command behavior remains deterministic in-process.

---

## 10) Rollback and Safety

## General rollback rule

- Keep each phase in its own commit(s)/PR so rollback is surgical.

## High-risk rollback triggers

- Any regression in login/reauth/refresh/logout behavior
- Any change to slash OAuth completion semantics
- Any mismatch in account persistence format

## Rollback procedure

1. Revert offending PR commit(s).
2. Re-run full test/lint/format checks.
3. Re-open a narrower follow-up PR with additional parity tests.

---

## 11) Open Questions (Resolve Before/During Execution)

1. Should CLI duplicate-login path reset tracking fields to match slash behavior, or should slash preserve existing tracking like CLI currently does?
2. Should account-target resolver live in `cli.mjs` only, or in `lib/` for potential slash reuse?
3. Do we want strict preservation of all existing message text, or allow minor wording normalization as part of consistency work?
4. Is command registry normalization (Phase 5) worth risk now, or defer until after parity is guaranteed in Phases 2-4?

---

## 12) Resume Guide (How to Pick Up Later)

From repo root:

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git diff --name-only master...HEAD
git diff --stat master...HEAD
npm test
```

Then:

1. Open this file and pick the next unchecked phase/task.
2. Execute only one phase per PR.
3. Update this file with date + completion notes at end of phase.

---

## 13) Tracking Table

| Phase | Name                            | Risk   | Status                 | Notes                                                                      |
| ----- | ------------------------------- | ------ | ---------------------- | -------------------------------------------------------------------------- |
| 0     | Baseline and guardrails         | Low    | Completed (2026-02-10) | Baseline captured in `.planning/DELTA-CODE-QUALITY-BASELINE.md`            |
| 1     | Quick consistency wins          | Low    | Completed (2026-02-10) | CLI references + error channel + numeric validation normalized             |
| 2     | Shared account mutation helpers | Medium | Completed (2026-02-10) | Shared reset/index/credential helpers extracted to `lib/account-state.mjs` |
| 3     | CLI account target resolver     | Medium | Completed (2026-02-10) | Shared account target resolver added in `cli.mjs`                          |
| 4     | OAuth contract unification      | High   | Deferred (excluded)    | Skipped per request: "except the oauth high risk items"                    |
| 5     | Routing/alias normalization     | High   | Completed (2026-02-10) | Shared command registry powers CLI + slash alias resolution                |
| 6     | Test fixture consolidation      | Medium | Completed (2026-02-10) | Shared fixture helpers moved to `test/helpers/accounts-fixtures.mjs`       |

---

## 14) Definition of Done

- Duplication hotspots in sections 4 and 5 are measurably reduced.
- CLI and slash paths use shared normalization points for account mutation and (where chosen) validation.
- OAuth behavior and diagnostics are aligned by design, not by accidental divergence.
- All tests pass, lint/format clean, docs remain accurate.
