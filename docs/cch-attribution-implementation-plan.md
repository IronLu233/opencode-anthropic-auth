# Claude Attribution Header Implementation Plan

**Version:** 1.0
**Date:** 2026-04-01
**Status:** Implemented (pending commit)
**Branch:** `rmk`
**Source:** Claude Code OSS attribution/header implementation plus provided reverse-engineered `cch` hypothesis
**Estimated total effort:** 3-5 hours (2-3 sessions)
**Dependencies:** Bun runtime, Node/Bun crypto, `xxhash-wasm`, Vitest

---

## How to Use This Document

This plan is designed for execution by an **orchestrator agent** that
delegates implementation to specialized agents (`@code-writer`,
`@code-review-opus`, `@code-review-gpt5`, `@docs-writer`) while maintaining full project context.

The orchestrator NEVER writes implementation code directly. Every line of
code is delegated. The orchestrator's job is to sequence work, provide
context, verify output, enforce quality gates, and maintain this plan.

### Orchestrator Workflow

For **every task**, follow this exact sequence:

```
1. DELEGATE  ->  @code-writer (with detailed prompt from this plan)
2. BUILD     ->  Verify: npm test passes with zero failures
3. TEST      ->  Smoke test the relevant functionality
4. LOOK      ->  N/A (no UI)
5. REVIEW    ->  @code-review-opus and @code-review-gpt5 in parallel
6. FIX       ->  @code-writer (with specific review findings from both)
7. DOCS      ->  @docs-writer when public docs/config behavior changes
8. RE-REVIEW ->  if fixes were substantial or either reviewer found issues
9. COMMIT    ->  Only after zero blockers/issues from both reviewers
10. UPDATE   ->  Mark status table done, record commit SHA
```

**No exceptions.**

### Context Window Strategy

- Load all referenced docs and source files before delegating.
- Never compact mid-project.
- Include exact file paths and current helper signatures in every prompt.
- Carry forward current plugin behavior, especially header transform and
  request serialization details.

### Resuming Mid-Plan

An agent resuming mid-plan should:

1. Read this entire document
2. Read all design/spec docs listed in Authoritative References
3. Check the per-task status tables for the first incomplete step
4. Run `git log --oneline -20` and `git status`
5. Read source files created by completed tasks
6. Resume from the first incomplete step

### Authoritative References

| Document                                                        | Purpose                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `docs/cch-attribution-implementation-plan.md`                   | This execution plan                                                   |
| `/Users/rmk/projects/oss/claudecode/src/constants/system.ts`    | Claude Code billing/attribution header format                         |
| `/Users/rmk/projects/oss/claudecode/src/utils/fingerprint.ts`   | Exact fingerprint algorithm for `cc_version` suffix                   |
| `/Users/rmk/projects/oss/claudecode/src/services/api/claude.ts` | Main system prompt insertion path                                     |
| `/Users/rmk/projects/oss/claudecode/src/utils/sideQuery.ts`     | Secondary attribution insertion path and standalone block requirement |
| `lib/request-headers.mjs`                                       | Current billing header generator                                      |
| `index.mjs`                                                     | Current `experimental.chat.system.transform` path                     |
| `index.test.mjs`                                                | Current system transform coverage                                     |
| User-provided `cch` algorithm text                              | Reverse-engineered `xxhash` hypothesis with seed `0x6E52736AC806831E` |

### Validation Commands

```bash
# Build / verify
npm test

# Lint / format sanity
npx eslint .
npx prettier --check .

# Focused smoke tests
npx vitest run index.test.mjs lib/request-headers.test.mjs

# DRY checks
rg -n "x-anthropic-billing-header|cc_version=|cch=" .
```

---

## Plan Maintenance Protocol

This document is a living artifact. Keep it accurate:

1. **Status tables** — update immediately after each step
2. **Notes column** — record review findings and commit SHAs
3. **Decision log** — record decisions before implementation
4. **Plan version** — bump when changing structure

---

## Decision Log

| #   | Topic           | Decision                                                                                             | Rationale                                                                                             |
| --- | --------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `cc_version`    | Make `cc_version` Claude-Code-accurate, not just profile-version-close                               | Claude Code computes `cc_version=<version>.<fingerprint>`; current plugin only emits static version   |
| 2   | `cch` source    | Treat the `xxhash` algorithm as a reverse-engineered hypothesis behind a config flag until validated | Claude Code OSS proves only the `cch=00000` placeholder and native overwrite, not the exact algorithm |
| 3   | Block placement | Keep billing header in its own standalone system block                                               | Claude Code explicitly isolates it to avoid parser ambiguity around `cc_entrypoint`                   |
| 4   | Rollout         | Implement behind config flag first, then consider making default                                     | `cch` replication is based on reverse-engineered behavior and should be easy to disable               |

---

## DRY Invariants

1. All attribution-header formatting lives in one helper module.
   Canonical location: `lib/request-headers.mjs`
   Grep check: `rg -n 'x-anthropic-billing-header|cc_version=|cch=' . | rg -v 'lib/request-headers.mjs|test|docs'`

2. All Claude-style fingerprint logic lives in one helper.
   Canonical location: `lib/request-headers.mjs`
   Grep check: `rg -n 'FINGERPRINT_SALT|computeFingerprint|xxhash|CCH_SEED' lib/`

3. Request-body signing for `cch` happens in one request path only.
   Canonical location: final Anthropic fetch boundary
   Grep check: `rg -n 'signAnthropicRequest|CCH_PATTERN|00000' lib/ index.mjs`

4. No TODO/FIXME in committed code.
   Canonical location: Everywhere
   Grep check: `rg -n 'TODO|FIXME|HACK|XXX' .`

---

## DRY Verification Checklist

```bash
# Invariant 1
rg -n "x-anthropic-billing-header|cc_version=|cch=" . | rg -v "lib/request-headers.mjs|test|docs"

# Invariant 2
rg -n "FINGERPRINT_SALT|computeFingerprint|xxhash|CCH_SEED" lib/

# Invariant 3
rg -n "signAnthropicRequest|CCH_PATTERN|00000" lib/ index.mjs

# Invariant 4
rg -n "TODO|FIXME|HACK|XXX" .
```

---

## Execution Sequence

```
Phase 1: Attribution Correctness
  ATTR-01 -> build -> review -> commit
  ATTR-02 -> build -> review -> commit

Phase 2: cch Signing
  ATTR-03 -> build -> review -> commit
  ATTR-04 -> build -> review -> commit

Phase 3: Rollout and Documentation
  ATTR-05 -> build -> review -> fix -> docs -> re-review -> fix -> commit
```

---

## Phases

### Phase 1: Attribution Correctness

**Goal:** The plugin emits a Claude-Code-like billing header with accurate
`cc_version` structure and standalone block placement, while preserving current
functionality.

---

### ATTR-01: Move Attribution Header Construction to the Final Request Boundary

**Estimated effort:** 60-90 minutes
**Dependencies:** None
**References:** `claudecode/src/services/api/claude.ts`, `claudecode/src/utils/sideQuery.ts`, `index.mjs`
**Files:** `index.mjs`, extracted request helper if needed, `index.test.mjs`

**Delegation prompt for `@code-writer`:**

> Move attribution-header construction out of `experimental.chat.system.transform`
> and into the final Anthropic request-body path where outbound `messages` are
> actually available.
>
> Claude Code computes the fingerprint from the first outbound user message
> before synthetic prompt insertion, then prepends the attribution header as
> a standalone system block. Replicate that architecture first.
>
> Requirements:
>
> - Identify the final serialized Anthropic request path.
> - Ensure attribution-header generation has access to outbound `messages`.
> - Preserve standalone billing-header block semantics.
> - Preserve non-Anthropic provider behavior.
> - Do not yet implement fingerprinting or `cch` signing in this task.
> - Add tests proving the header is built from the final Anthropic request path,
>   not the earlier system-transform-only hook.

**Review criteria for `@code-review-opus` and `@code-review-gpt5`:**

> Verify the architecture now matches Claude Code's sequencing: derive
> attribution from outbound messages first, then inject the standalone block.
> Check for regressions in system-transform behavior and Anthropic-only scoping.

**Acceptance criteria:**

- Attribution-header construction no longer depends solely on the early system hook
- Final request path has access to outbound message content
- Existing system transform tests still pass or are updated intentionally

**Status:**

| Step                          | Status  | Notes                                                       |
| ----------------------------- | ------- | ----------------------------------------------------------- |
| Delegate to @code-writer      | done    | Implemented via delegated code writer                       |
| Build verification            | done    | `npm test` passed                                           |
| Smoke test                    | done    | Final Anthropic request path verified via integration tests |
| Visual verification (if UI)   | skipped | No UI                                                       |
| Delegate to @code-review-opus | done    | Final pass returned no actionable findings                  |
| Delegate to @code-review-gpt5 | done    | Found 2 blockers; fixed                                     |
| Fix review findings           | done    | Added `fetch(Request)` + system preservation coverage       |
| Commit                        | pending | SHA:                                                        |
| Plan updated                  | done    | Status synchronized with implementation                     |

---

### ATTR-02: Implement Claude-Style Fingerprint for `cc_version`

**Estimated effort:** 45-75 minutes
**Dependencies:** `ATTR-01`
**References:** `claudecode/src/utils/fingerprint.ts`, `lib/request-headers.mjs`, final request path from `ATTR-01`
**Files:** `lib/request-headers.mjs`, `lib/request-headers.test.mjs`, `index.test.mjs` if needed

**Delegation prompt for `@code-writer`:**

> Implement Claude Code's exact fingerprint algorithm for `cc_version` now that
> the final request path has access to outbound messages.
>
> Requirements:
>
> - Match Claude Code semantics exactly:
>   - first `user` message only
>   - string content directly, or first `text` block from array content
>   - otherwise empty string
>   - chars at indices `[4, 7, 20]`, fallback `'0'`
>   - SHA256(`${salt}${chars}${version}`).slice(0, 3)
> - Emit `cc_version=<profile.ccVersion>.<fingerprint>`.
> - Add tests for:
>   - no user message
>   - string user message
>   - array user message with first text block not first block overall
>   - array with no text block
>   - short text requiring `'0'` fill
> - Preserve standalone block placement.

**Review criteria for `@code-review-opus` and `@code-review-gpt5`:**

> Verify exact fingerprint semantics against Claude Code OSS and that tests
> cover all extraction edge cases.

**Acceptance criteria:**

- `cc_version` is emitted as `<profile.ccVersion>.<3hex>`
- Fingerprint matches Claude Code algorithm exactly
- Edge-case tests cover all Claude extraction semantics
- Block placement remains standalone and deduped

**Status:**

| Step                          | Status  | Notes                                                  |
| ----------------------------- | ------- | ------------------------------------------------------ |
| Delegate to @code-writer      | done    | Implemented via delegated code writer                  |
| Build verification            | done    | `npm test` passed                                      |
| Smoke test                    | done    | Fingerprint verified in unit + fetch-path tests        |
| Visual verification (if UI)   | skipped | No UI                                                  |
| Delegate to @code-review-opus | done    | Final pass returned no findings                        |
| Delegate to @code-review-gpt5 | done    | Found 2 test nits; fixed                               |
| Fix review findings           | done    | Added first-user regression + tighter format assertion |
| Commit                        | pending | SHA:                                                   |
| Plan updated                  | done    | Status synchronized with implementation                |

---

### Phase 2: cch Signing

**Goal:** Replace fake/random `cch` behavior with an experimental request-body
signing step that matches the reverse-engineered `xxhash` algorithm as closely
as our runtime allows.

---

### ATTR-03: Add Request-Body `cch` Signing Helper

**Estimated effort:** 60-90 minutes
**Dependencies:** `ATTR-01`, `ATTR-02`
**References:** user-provided reverse-engineered algorithm text, `index.mjs` request send path
**Files:** `lib/request-headers.mjs` or `lib/cch-signing.mjs`, tests

**Delegation prompt for `@code-writer`:**

> Implement a helper that signs serialized request bodies by replacing
> `cch=00000` with the `xxhash`-derived 5-hex-char value.
>
> Reverse-engineered algorithm to implement behind an explicit config flag:
>
> - Seed: `0x6E52736AC806831E`
> - Regex: `(x-anthropic-billing-header:[^"]*?\bcch=)00000(?=;)`
> - Hash input: exact serialized request body bytes before replacement
> - Hash function: `xxhash-wasm` `h64Raw`
> - Result: `Number(hash & 0xFFFFFn).toString(16).padStart(5, '0')`
>
> Requirements:
>
> - Add `xxhash-wasm` dependency only if needed for runtime compatibility.
> - Keep signing isolated in one helper.
> - Do not sign bodies without `cch=00000`.
> - Add tests for deterministic output and no-op behavior.

**Review criteria for `@code-review-opus` and `@code-review-gpt5`:**

> Verify algorithm fidelity to the provided hypothesis, body-byte correctness,
> no double-signing, and safe gating behind config.

**Acceptance criteria:**

- Deterministic 5-hex `cch` generated from exact body bytes when the feature is enabled
- No signing when pattern absent
- No double-signing on retries/reuse
- Unit tests cover repeatability, no-op behavior, and placeholder-only replacement

**Status:**

| Step                          | Status  | Notes                                                    |
| ----------------------------- | ------- | -------------------------------------------------------- |
| Delegate to @code-writer      | done    | Implemented via delegated code writer                    |
| Build verification            | done    | `npm test` passed                                        |
| Smoke test                    | done    | Helper isolated and validated with dedicated tests       |
| Visual verification (if UI)   | skipped | No UI                                                    |
| Delegate to @code-review-opus | done    | Final pass returned no findings                          |
| Delegate to @code-review-gpt5 | done    | Found regex/test issues; fixed                           |
| Fix review findings           | done    | Tightened regex, synced bun lock, deterministic fixtures |
| Commit                        | pending | SHA:                                                     |
| Plan updated                  | done    | Status synchronized with implementation                  |

---

### ATTR-04: Apply Signing at the Final Serialized Anthropic Request Boundary

**Estimated effort:** 60-90 minutes
**Dependencies:** `ATTR-03`
**References:** `index.mjs`, request transform/send path
**Files:** `index.mjs`, `index.test.mjs`, maybe extracted request helper module

**Delegation prompt for `@code-writer`:**

> Wire `cch` signing into the final serialized body path for Anthropic
> requests only.
>
> Requirements:
>
> - Sign the exact body string that is sent over fetch.
> - Ensure signing runs after all system/body transforms are complete.
> - Ensure signing does not change request semantics beyond replacing `00000`.
> - Preserve non-Anthropic provider behavior.
> - Add tests verifying the sent body contains the signed `cch` and that the
>   hash changes when the request body changes.

**Review criteria for `@code-review-opus` and `@code-review-gpt5`:**

> Verify final-boundary placement, no stale pre-sign hashes, and no accidental
> double-serialization or header/body mismatches.

**Acceptance criteria:**

- Signed `cch` is derived from the final outgoing body string actually passed to `fetch`
- Non-Anthropic requests remain untouched
- Tests prove body-sensitive hash changes
- Tests prove only the `00000` placeholder is replaced
- Tests prove no double-signing on retries/reuse

**Status:**

| Step                          | Status  | Notes                                                      |
| ----------------------------- | ------- | ---------------------------------------------------------- |
| Delegate to @code-writer      | done    | Implemented via delegated code writer                      |
| Build verification            | done    | `npm test` passed                                          |
| Smoke test                    | done    | Final serialized-body signing verified in fetch-path tests |
| Visual verification (if UI)   | skipped | No UI                                                      |
| Delegate to @code-review-opus | done    | Final pass returned no findings                            |
| Delegate to @code-review-gpt5 | done    | Zero findings — review complete                            |
| Fix review findings           | done    | No fixes required after signoff                            |
| Commit                        | pending | SHA:                                                       |
| Plan updated                  | done    | Status synchronized with implementation                    |

---

### Phase 3: Rollout and Documentation

**Goal:** Make the behavior configurable, documented, and safe to compare
against the previous approximation.

---

### ATTR-05: Add Config, Docs, and Comparison Notes

**Estimated effort:** 45-60 minutes
**Dependencies:** `ATTR-04`
**References:** `README.md`, `CONTRIBUTING.md`, existing config docs
**Files:** config docs, tests, maybe config module

**Delegation prompt for `@code-writer`:**

> Add configuration and documentation for the new attribution behavior.
>
> Requirements:
>
> - Add a config toggle for Claude-style billing-header signing if not already
>   implicit in `billing_header`.
> - Document what is Claude-Code-accurate now:
>   - `cc_version` fingerprinting
>   - `cch` signing algorithm
> - Document any remaining approximation, especially if `cc_entrypoint` or
>   `cc_workload` remain simplified.
> - Update tests for config defaults and behavior.

**Delegation prompt for `@docs-writer`:**

> Update all affected docs after implementation lands.
>
> Requirements:
>
> - Reflect the new attribution-header behavior in `README.md` and `CONTRIBUTING.md`.
> - Clearly distinguish Claude Code OSS-confirmed behavior from the
>   reverse-engineered `cch` hypothesis.
> - Document any config flag controlling `cch` signing.
> - Keep terminology consistent with this plan.

**Review criteria for `@code-review-opus` and `@code-review-gpt5`:**

> Initial review: verify implementation and config defaults preserve backward
> compatibility unless explicitly intended otherwise.
>
> Re-review after `@docs-writer`: verify docs match the final implementation.

**Acceptance criteria:**

- Config/documentation updated
- Behavior is test-covered and understandable to future maintainers
- README/CONTRIBUTING accurately describe attribution handling

**Status:**

| Step                          | Status  | Notes                                               |
| ----------------------------- | ------- | --------------------------------------------------- |
| Delegate to @code-writer      | done    | Existing `billing_header` flag confirmed sufficient |
| Build verification            | done    | `npm test` passed after docs updates                |
| Smoke test                    | done    | Docs checked against implemented behavior           |
| Visual verification (if UI)   | skipped | No UI                                               |
| Delegate to @code-review-opus | done    | Final pass returned no findings                     |
| Delegate to @code-review-gpt5 | done    | Zero findings — review complete                     |
| Fix review findings           | done    | No fixes required                                   |
| Delegate to @docs-writer      | done    | README + CONTRIBUTING + plan status updated         |
| Re-review post-docs state     | done    | Docs reviewed against implementation                |
| Fix post-docs findings        | done    | No fixes required                                   |
| Commit                        | pending | SHA:                                                |
| Plan updated                  | done    | Status synchronized with implementation             |

---

## Current Assessment

### Is our current `cc_version` already close enough?

**Format:** yes.

**Behavior:** yes.

Current plugin behavior:

- emits `cc_version=<profile.ccVersion>.<fingerprint>`
- computes the fingerprint from the first user message using Claude Code OSS semantics
- preserves the selected profile version prefix

Claude Code behavior:

- emits `cc_version=<version>.<fingerprint>`
- fingerprint is deterministic from first user message text plus version

So this part is now **Claude Code OSS-aligned**.

### Is our current `cch` close?

Mostly, with an implementation-status caveat.

Current plugin behavior:

- emits `cch=00000` as a placeholder in the billing-header block
- signs `cch` at the final serialized Anthropic request boundary
- still skips the entire billing-header block when `billing_header` is disabled

Target behavior from provided reverse-engineered algorithm hypothesis:

- emits a deterministic 5-hex value derived from the exact serialized request
  body bytes using `xxhash`

This gap is now implemented, but the exact algorithm remains reverse-engineered rather than OSS-confirmed.
