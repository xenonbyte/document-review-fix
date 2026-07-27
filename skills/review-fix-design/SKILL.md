---
name: review-fix-design
description: Review and fix DESIGN documents through the shared review-fix loop workflow. Explicit invocation only — run `$review-fix-design`.
---

# review-fix-design

Fixed document type: DESIGN.

Users must not pass type. This entry skill always treats the target as a `DESIGN` for UX, UI, product design, architecture design, system design, and workflow design documents.

Invocation syntax:

```text
$review-fix-design <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [resume|reset] [rounds=<n>] [ledger=<target-local path>] [root=<project-root>] [debug]
```

Full form: `$review-fix-design target=<path> ...`. A bare path is shorthand for `target=<path>`.

Valid target invocations may omit mode. Codex, Claude Code, and opencode generated routes select `review-and-fix assurance=practical` by default when mode and assurance are omitted; missing mode selects `review-and-fix` and missing assurance selects `practical`. Explicit `assurance=advisory` without mode selects `read-only` on Codex, Claude Code, and opencode. Gemini generated routes select `read-only assurance=advisory` by default. Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results.

Reference Conformance: `ref=` documents are consistency sources, not mandatory upstream chains. This route checks whether the target conflicts with references or invents unsupported reference-backed claims; it does not require coverage tables, stable IDs, `Design Coverage Import`, or `SPEC-to-task mapping` unless the target explicitly claims complete coverage, custom rules require that structure, or the document becomes unverifiable for its stated purpose.

A DESIGN does not require downstream SPEC or PLAN handoff tables.

`assurance=practical|strict-verified|advisory` controls runtime assurance. `strict` and `normal` are review strictness only.

`rounds=<n>` sets the maximum repair-loop count for review-and-fix; it is unsupported with `read-only`.

`resume` continues target-local state. `reset` archives existing target-local state and starts fresh. `resume` and `reset` are mutually exclusive.

Pass `debug` to print redacted workflow audit details. Default output is concise and must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs in `Issues:`, `Fixed:`, or `Unfixed:` lists.

Practical Mode requires a live reviewer subagent probe that returns exactly `DRFX_REVIEWER_READY`, plus verified stdin handoff for semantic payloads. If subagent delegation is unavailable or invalid, downgrade only through the allowed advisory downgrade reasons. If fingerprint guard or stdin handoff is unavailable, fail closed; stdin handoff failure is `unsafe-handoff-file`.

Strict Verified requires same-flow `drfx doctor --json` values: `descriptorPath`, `descriptorDirectory`, and `runId`. It does not use cached or installer-default descriptors. The internal workflow command decides whether strict proof is valid.

Automatic writes require `review-and-fix` plus a selected guard mode: use `guard=git` with a tracked clean HEAD-backed git target, or `guard=snapshot` with a valid snapshot rollback anchor. Target-only guard checks and target-local lock refresh must still pass. Fixers and coordinators may modify only the target document; references remain read-only.

Persistent state lives under `.drfx/targets/<target-key>/`. One-shot read-only without `ledger=`, `resume`, or `reset` is no-state and keeps tokens in memory only.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/design.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
