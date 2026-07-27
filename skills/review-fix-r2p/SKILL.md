---
name: review-fix-r2p
description: Review and fix an r2p requirement plan (07-plan.md) through the shared review-fix loop workflow. Explicit invocation only — run `$review-fix-r2p`.
---

# review-fix-r2p

Review target: an active r2p run `workId` naming `<project>/.req-to-plan/WF-*`.

This entry skill reviews the requirement plan (`07-plan.md`) against its owning upstream docs (`03-06`) inside the active run directory. It has a fixed document type: PLAN. Users must not pass `type`.

Invocation syntax:

```text
review-fix-r2p workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]
```

Full form: `review-fix-r2p workId=<WF-...> ...`. A bare `WF-...` token is shorthand for `workId=<WF-...>`. This route reviews only the active `.req-to-plan/<workId>/` run and rejects path input such as `target=...`, `.req-to-plan/WF-*`, or `07-plan.md`.

This route accepts only the tokens above. It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, `base=`, or `guard=`; it has a fixed PLAN rubric and no reference-document surface.

Valid target invocations may omit mode. Codex, Claude Code, and opencode generated routes select `review-and-fix` (internally materializing `practical` assurance) by default when mode is omitted. Gemini generated routes select `read-only` and are advisory-only. Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results.

The review judges `07-plan.md`, but `03-07` and `run.md` are all read-only evidence. Direct artifact writes are forbidden for this route: drfx must not write, delete, rename, restore, or patch any run artifact itself.

`run.md` is a protected read-only gate. The route requires `r2p-status`, `r2p-reopen`, `r2p-gap-open`, and `r2p-continue`; it reviews only an active run, never an archived run.

In `review-and-fix`, repair means only an official r2p lifecycle command:

- `r2p-reopen` for closed or executing runs
- `r2p-gap-open` for open runs whose owner stage is strictly upstream of `current_stage`

Findings map to an r2p `ownerStage`, not to an editable file. After `apply-r2p-repair`, the round ends at checkpoint with `r2p-repair-applied`; the next action is to run `r2p-continue`, let r2p regenerate artifacts, then rerun `review-fix-r2p workId=<new-or-same-WF-...>`. PASS is allowed only on that clean rerun.

`rounds=<n>` sets the maximum repair-loop count for review-and-fix; it is unsupported with `read-only`.

`resume` continues target-local state. `reset` archives existing target-local state and starts fresh. `resume` and `reset` are mutually exclusive.

Pass `debug` to print redacted workflow audit details. Default output is concise and must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs in `Issues:`, `Fixed:`, or `Unfixed:` lists.

Persistent state lives under `.drfx/targets/<target-key>/`. One-shot read-only without `resume` or `reset` is no-state and keeps tokens in memory only.

Gemini is advisory-only: it produces read-only findings, does not execute r2p repair commands, does not edit files, and cannot claim a workflow PASS.

Use the shared sources:

- `shared/core.md`
- `shared/long-task.md`
- `shared/rubrics/common.md`
- `shared/rubrics/plan.md`
- `shared/prompts/reviewer.md`
- `shared/prompts/fixer.md`
- `shared/prompts/coordinator.md`

Run the loop until `pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or checkpoint.
