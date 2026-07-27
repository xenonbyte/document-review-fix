---
name: review-fix-code
description: Review and fix a source scope (the file set under one or more scope roots) through the shared review-fix loop workflow. Explicit invocation only — run `$review-fix-code`.
---

# review-fix-code

Reviews a source scope: the file set under one or more `scope=<path>` roots, or the whole project root when `scope=` is omitted. This is a code route, not a document route. It has no document type and no reference documents.

Users must not pass `target=`, `type`, `ref=`, `base=`, `assurance=`, `strict`, `normal`, or `ledger=`.

Invocation syntax:

```text
review-fix-code [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]
```

`scope=<path>` names a source root to review; repeat `scope=<path>` for multiple roots. Omit `scope=` to review the whole project root within a single-pass budget of 300 files or 1,500,000 bytes; a larger whole-root file set is reviewed as a partitioned project review (a deterministic, multi-phase, unit-by-unit review) instead of blocking — narrow with `scope=<path>` to keep it a single pass. There is no bare-path or `target=` form.

Valid invocations may omit mode. On Codex, Claude Code, and opencode, missing mode selects `review-and-fix`. This code route exposes no user-facing `assurance=` token; for `review-and-fix` it internally materializes `practical` assurance (or `strict-verified` only on the same-flow strict proof path), so code auto-fix is never rejected as `advisory-review-and-fix-unsupported`. Gemini generated routes are advisory-only and render `review-and-fix` as unsupported; they produce read-only findings only and must not claim workflow PASS. Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results.

Code review is actionable-only: pure style preferences, no-risk refactors, and over-abstraction are not blocking. Discover the in-scope source files deterministically, then review correctness, architecture, state-and-io, safety, tests, contracts, and maintainability.

`rounds=<n>` sets the maximum repair-loop count for review-and-fix; it is unsupported with `read-only`.

`resume` continues target-local state. `reset` archives existing target-local state and starts fresh. `resume` and `reset` are mutually exclusive.

Pass `debug` to print redacted workflow audit details. Default output is concise and must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs in `Issues:`, `Fixed:`, or `Unfixed:` lists.

Do not call, wrap, or delegate to a platform-native code-review command; this route runs the deterministic `drfx workflow` protocol itself.

For partitioned project review, do not use a single `--phase initial-review` result to claim workflow PASS. Drive bounded unit contexts with `drfx workflow context review-fix-code <scopeTokens> review-and-fix ... --phase unit-review --json`, record each unit with `drfx workflow record-review ... --phase unit-review --unit <unitId>` plus both reviewer findings and coverage receipt payloads, then run crosscutting backstops with `--phase crosscutting --backstop <backstopId>`. Omit `--unit` when recording crosscutting backstops so the workflow spans every planned unit. Only after all units and backstops are recorded may the route run `drfx workflow aggregate-review <targetStateDir> --json`; the aggregate verdict is authoritative, and project PASS is allowed only when it returns `verdict: PASS`.

Practical Mode requires a live reviewer subagent probe that returns exactly `DRFX_REVIEWER_READY`, plus verified stdin handoff for semantic payloads. If subagent delegation is unavailable or invalid, downgrade only through the allowed advisory downgrade reasons. If fingerprint guard or stdin handoff is unavailable, fail closed; stdin handoff failure is `unsafe-handoff-file`.

Automatic writes require `review-and-fix` plus a selected guard mode: use `guard=git` with a clean HEAD-backed git worktree, or `guard=snapshot` with a valid snapshot rollback anchor. File-set guard checks and lock refresh must still pass.

Persistent state lives under `.drfx/targets/<target-key>/`. One-shot read-only without `resume` or `reset` is no-state and keeps tokens in memory only.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/code.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
