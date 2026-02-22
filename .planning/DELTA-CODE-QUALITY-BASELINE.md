# Delta Code Quality Baseline (Phase 0)

Date: 2026-02-10  
Branch: `rmk`

## Validation Snapshot

- `npm test` -> 7 files, 359 tests passed
- `npm run lint` -> clean
- `npm run format:check` -> clean

## Duplication Baseline Metrics

- `const n = parseInt(arg, 10)` in `cli.mjs`: 8
- `if (!stored || stored.accounts.length === 0)` in `cli.mjs`: 15
- `rateLimitResetTimes = {}` in `cli.mjs`: 5
- `consecutiveFailures = 0` in `cli.mjs`: 5
- `lastFailureTime = null` in `cli.mjs`: 5
- `rateLimitResetTimes = {}` in `index.mjs`: 2
- `consecutiveFailures = 0` in `index.mjs`: 2
- `lastFailureTime = null` in `index.mjs`: 2

## Consistency Baseline Metrics

- `opencode auth login` references in `cli.mjs`: 3
- `cmdResetStats` invalid-input path uses `console.log(c.red(...))` in `cli.mjs`: 1 (line 1345)

## Notes

- This file captures pre-normalization metrics for the non-OAuth phases.
- Compare against these counts after Phases 1, 2, 3, 5, and 6.

## Post-Normalization Snapshot (Non-OAuth Scope)

Date: 2026-02-10

- `const n = parseInt(arg, 10)` in `cli.mjs`: 1 (was 8)
- `if (!stored || stored.accounts.length === 0)` in `cli.mjs`: 9 (was 15)
- Tracking reset triplet assignments in `cli.mjs`: 0 direct assignments (was 15 across three fields)
- Tracking reset triplet assignments in `index.mjs`: 0 direct assignments (was 6 across three fields)
- `opencode auth login` references in `cli.mjs`: 0 (was 3)
- `cmdResetStats` invalid-input path uses `console.error(c.red(...))` in `cli.mjs`: 1
