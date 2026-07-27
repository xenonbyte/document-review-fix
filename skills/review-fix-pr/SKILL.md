---
name: review-fix-pr
description: Review and fix a PR diff (the base..HEAD changed file set) through the shared review-fix loop workflow. Explicit invocation only — run `$review-fix-pr`.
---

# review-fix-pr

Reviews a PR diff: the file set changed between `base=<branch>` and `HEAD`. This is a code route, not a document route. It has no document type and no reference documents.

Users must not pass `target=`, `type`, `ref=`, `assurance=`, `strict`, `normal`, or `ledger=`.

Invocation syntax:

```text
$review-fix-pr base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]
```

`base=<branch>` is required and names the merge base for the diff; `HEAD` is the other end. There is no bare-path or `target=` form.

Valid invocations may omit mode. On Codex, Claude Code, and opencode, missing mode selects `review-and-fix`. This code route exposes no user-facing `assurance=` token; for `review-and-fix` it internally materializes `practical` assurance (or `strict-verified` only on the same-flow strict proof path), so code auto-fix is never rejected as `advisory-review-and-fix-unsupported`. Gemini generated routes are advisory-only and render `review-and-fix` as unsupported; they produce read-only findings only and must not claim workflow PASS. Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results.

Code review is actionable-only: pure style preferences, no-risk refactors, and over-abstraction are not blocking. Judge the changed file set for correctness, regressions, safety, tests, contracts, and maintainability.

`rounds=<n>` sets the maximum repair-loop count for review-and-fix; it is unsupported with `read-only`.

`resume` continues target-local state. `reset` archives existing target-local state and starts fresh. `resume` and `reset` are mutually exclusive.

Pass `debug` to print redacted workflow audit details. Default output is concise and must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs in `Issues:`, `Fixed:`, or `Unfixed:` lists.

Do not call, wrap, or delegate to a platform-native code-review command; this route runs the deterministic `drfx workflow` protocol itself.

Practical Mode requires a live reviewer subagent probe that returns exactly `DRFX_REVIEWER_READY`, plus verified stdin handoff for semantic payloads. If subagent delegation is unavailable or invalid, downgrade only through the allowed advisory downgrade reasons. If fingerprint guard or stdin handoff is unavailable, fail closed; stdin handoff failure is `unsafe-handoff-file`.

Automatic writes require `review-and-fix` plus a selected guard mode: use `guard=git` with a clean HEAD-backed git worktree, or `guard=snapshot` with a valid snapshot rollback anchor. File-set guard checks and lock refresh must still pass.

Persistent state lives under `.drfx/targets/<target-key>/`. One-shot read-only without `resume` or `reset` is no-state and keeps tokens in memory only.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/pr.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
