# Document Review Loop Core

This file is the shared workflow source for every route: the document routes `review-fix-spec`, `review-fix-plan`, `review-fix-design`, and `review-fix-doc`, the file-set routes `review-fix-pr` and `review-fix-code`, and the requirement route `review-fix-r2p`. Document entry skills fix the document type; users must not pass type. File-set routes (PR/CODE) have no fixed document type and resolve a file set rather than a single target document; the loop, guards, and terminal states below apply to that file set as the target context. The r2p route resolves an active `workId=<WF-...>` run under `.req-to-plan/`: it reviews the `07-plan.md` anchor against the COMMON+PLAN document rules, treats `03-07` and `run.md` as read-only evidence, forbids direct artifact writes, and repairs only through the r2p lifecycle.

## Loop

Canonical loop:

```text
review -> triage -> fix -> diff review -> full re-review -> repeat until PASS or a defined terminal/pause state
```

The initial `review` and every `full re-review` must inspect the whole target context through an isolated read-only reviewer task. The target context is the target document for document routes, or the resolved file set for PR/CODE routes; for the r2p route it is the `07-plan.md` anchor plus its `03-06` upstream chain, all read-only. A `diff review` after fixes is mandatory for document/PR/CODE routes, but r2p does not use a direct-write diff loop: it goes review -> triage -> repair plan -> r2p command -> checkpoint, then PASS is possible only on a clean rerun after `r2p-continue`.

The fix loop is bounded: after a deterministic fix-attempt cap (default 5 fixes per target), or when a previously fixed high/medium finding recurs, the loop stops as `stopped-no-progress` rather than fixing indefinitely.

## V2 Operational Boundary

The generated route coordinates host LLM work with deterministic `drfx workflow ...` commands. The CLI validates inputs, guards, state, tokens, and machine payload shapes. It does not perform semantic review, semantic triage, target edits, diff judgment, or final coordinator agreement.

Generated Codex, Claude Code, and opencode routes default a valid target invocation to `review-and-fix assurance=practical` when mode and assurance are omitted. For document/PR/CODE routes on Codex, Claude Code, and opencode, explicit `assurance=advisory` without mode selects `read-only`; `review-fix-r2p` has its own invocation grammar and does not accept user-facing `assurance=`. Generated Gemini routes default a valid target invocation to `read-only assurance=advisory`. Help-style or invalid invocations explain usage only and must not read target/reference bodies, run workflow commands, run probes, create state, or declare a review result.

Usage prefers a bare path target after the explicit route name for document routes, for example `$review-fix-spec docs/spec.md` on Codex or `/review-fix-spec docs/spec.md` on Claude Code, Gemini, and opencode. The full form `target=<path>` remains supported there; a bare path is shorthand for `target=<path>`. The r2p route is different: it uses `workId=<WF-...>` or a bare `WF-...` token and exposes no `guard=` token. For document/PR/CODE routes, `guard=git|snapshot` selects the rollback and target-only guard family. `guard=snapshot` monitors the target, explicit `ref=` documents, ordinary project files, and unrelated file symlinks as opaque entries. Well-known infrastructure directories (`.git`, `node_modules`, `.pnpm-store`, `.yarn`, `.cache`, `dist`, `build`, `coverage`) are excluded from monitoring unless the target or a reference lives inside one; when any directory is excluded the guard reports `monitorScope: project-tree-files-and-references-excluding-infrastructure`. Directory symlinks are not supported and block the guard. Opaque file-symlink entries are checked by symlink metadata and `readlink` target text, but they do not detect writes made through the symlink to its resolved target; directory symlinks remain unsupported for that reason.

Default user output uses concise Route Output and is user-focused. It must not print handoff blocks, raw workflow JSON, probe transcripts, prompt text, raw subagent transcripts, internal issue IDs, or the final-response machine block. The explicit `debug` route token may surface redacted workflow audit details and the redacted final-response machine block after validation, but it must not print raw document bodies, raw prompts, raw transcripts, secrets, tokens, or raw logs.

`assurance=practical|strict-verified|advisory` selects runtime assurance. `strict` and `normal` select review strictness only.

## Reference Conformance

Reference documents supplied through `ref=` are consistency sources, not mandatory upstream chains. A `ref=design.md` does not require a SPEC target to include `Design Coverage Import`; a `ref=spec.md` does not require a PLAN target to include `SPEC-to-task mapping`.

Use references to check whether the target contradicts declared facts, scope, non-goals, behavior, constraints, risks, acceptance expectations, terminology, or safety boundaries.

Blocking reference conflict findings are limited to:

- the target directly conflicts with a reference on a material point;
- the target introduces an unsupported new requirement, product decision, design decision, or execution decision while presenting it as reference-backed;
- the target omits a reference constraint that is required for the target document's stated purpose;
- execution or implementation following the target would violate a reference;
- the target makes a complete coverage claim for a reference but materially omits required referenced content.

These are not blocking by default:

- missing trace tables;
- missing stable IDs;
- missing coverage matrices;
- missing `Design Coverage Import`;
- missing `SPEC-to-task mapping`;
- missing DESIGN references in SPEC documents;
- missing SPEC references in PLAN documents.

Treat those structural items as low-severity improvements unless the target document itself makes a complete coverage claim, the user's custom rules require them, or their absence makes the document unverifiable for its own stated purpose.

## Roles

- Coordinator: owns the loop, reads instructions and rules, dispatches reviewer work, triages findings, manages target state, applies fixes by default, performs diff review, and decides terminal status.
- Reviewer: mandatory isolated read-only critic for every initial review and full target-context re-review. The reviewer reports `PASS` or structured `FAIL` findings and must not edit files.
- Fixer: the coordinator by default. A fixer subagent is optional, bounded, serial, and may modify only files in the target context: the target document for document routes or the resolved file set for PR/CODE routes. For the r2p route, the fixer authors no file edits; it may only help refine owner-stage mapping, repair-plan wording, or checkpoint next actions for accepted issue IDs.

The coordinator is the only role allowed to mark workflow PASS.

## PASS Criteria

General PASS requires:

- The relevant full target-context review returns `PASS`, or returns only low issues that the coordinator explicitly accepts as non-blocking in normal mode.
- The coordinator independently agrees with the reviewer result.
- No unresolved high or medium issues remain.
- Accepted high and medium issues are fixed, merged into fixed issues, downgraded with rationale, or rejected with rationale.
- Deferred high or medium issues are not treated as PASS; they stop as `stopped-with-deferrals`.
- Required sections contain no blocking placeholders such as `TBD`, `TODO`, `later`, or "to be discussed".
- Scope, constraints, assumptions, risks, and verification path are clear enough for the selected route/rubric.
- Reference documents, when provided, have been checked for material conformance without treating them as mandatory upstream chains.

Strict PASS additionally requires unresolved low issues to be fixed or explicitly accepted as non-blocking and carried into later reviewer context.

## Terminal And Pause States

The loop stops only at one of these states:

- `pass`: the full target-context review gate passes and the coordinator agrees. On `finalize`, `pass` archives its target-local state directory under `.drfx/archived/` so the next run starts fresh without `reset`.
- `read-only-clean`: read-only mode found no blocking findings under selected strictness; this is not workflow PASS. On `finalize`, `read-only-clean` archives its target-local state directory under `.drfx/archived/` so the next run starts fresh without `reset`.
- `stopped-with-deferrals`: high or medium issues are intentionally deferred with reason and owner; the internal workflow payload may include redacted issue IDs, reasons, owners, and next action. Default user output uses concise Unfixed/Next without internal issue IDs; debug may show redacted internal IDs and audit details.
- `stopped-no-progress`: the fix loop hit the fix-attempt cap or a recurring unresolved finding; high or medium issues remain. This is a pause state, not PASS.
- `read-only-findings`: read-only mode found issues that block PASS under the selected strictness.
- `blocked`: the workflow cannot continue until a concrete blocker is resolved.
- `unsupported`: the runtime lacks verified reviewer isolation for automatic review-fix work.
- `externally-changed`: the target changed outside the current lock or known fix round.
- `possible-target-replacement`: the same path appears to contain a different document.
- user stop: the user explicitly stops the loop.
- `checkpoint`: the task pauses with durable target-local state and a concrete next action.

Blocking reasons include `reviewer-mutated-file`, `lock-held`, `corrupt-lock`, `lock-release-failed`, `reviewer-output-unparseable`, `fingerprint-guard-unavailable`, `fingerprint-guard-output-invalid`, `state-validation-failed`, `state-token-too-large`, `final-validation-failed`, `target-only-guard-unavailable`, `unexpected-worktree-change`, `reference-mutated-file`, `fix-report-mismatch`, `diff-review-failed`, `rollback-unavailable`, and `unsafe-handoff-file`. Status reasons include `none`, `strict-proof-validation-failed`, `target-fingerprint-mismatch`, `manifest-fingerprint-mismatch`, `stale-fingerprint-mismatch`, `same-path-replacement-suspected`, `read-only-blocking-findings`, `deferred-findings`, `coverage-incomplete`, `no-progress-detected`, `unsupported-runtime-capability`, and `checkpoint-requested`.

Blocker wording must distinguish guard failures: `rollback-unavailable` means the target lacks a clean rollback anchor, `target-only-guard-unavailable` means the target-only guard is unavailable or unparseable, and `unexpected-worktree-change` means non-target worktree changes make automatic fixing unsafe.

Unknown Markdown rule files under `.drfx/rules/` or `~/.drfx/rules/` are a normal-mode warning and a strict-mode blocker before target state is written.

## Reviewer Guard

Before dispatching a reviewer, record SHA-256, file size, and modified timestamp for the target and all reference documents. After the reviewer returns, recompute the same fingerprints.

If any target or reference fingerprint changed and the coordinator did not intentionally write the file, stop as `blocked: reviewer-mutated-file`. Report the changed path and ask for user confirmation before restoring, continuing, or discarding state. Do not fix or claim PASS after a reviewer mutation.

Prompt-only read-only instructions are not enough for automatic PASS. Automatic review-fix work requires verified isolated reviewer execution, verified reviewer write blocking, and an available fingerprint guard. Runtimes without those capabilities may provide advisory review only.

## Triage

The coordinator triages every reviewer finding before fixing:

- `accepted`: valid and should be fixed.
- `merged`: duplicate or covered by another issue.
- `downgraded`: valid but lower severity, with rationale.
- `rejected`: incorrect, out of scope, or based on a false premise, with rationale.
- `deferred`: valid but intentionally not fixed now, with reason and owner.

Accepted high and medium issues block PASS until resolved. Deferred high and medium issues stop as `stopped-with-deferrals`, not PASS. Low issues are non-blocking in normal mode unless they affect the objective; low issues block strict PASS unless explicitly accepted as non-blocking.

Triage payload schema. For r2p routes, every `accepted` or `reopened` finding must carry `owner_stage`; use `reason` for `r2p-reopen` wording and `required_action` for `r2p-gap-open` wording when known. Use `none` for non-r2p or not applicable.

```text
Triage:
- reviewer_id: R001
  issue_id: ISSUE-001
  decision: accepted | reopened | merged | downgraded | rejected | deferred
  severity: high | medium | low
  original_severity: high | medium | low | none
  rationale: <required except plain accepted with non_blocking=false>
  merged_into: ISSUE-### | none
  deferred_owner: <owner or none>
  deferred_next_action: <next action or none>
  non_blocking: true | false
  owner_stage: raw_requirement | requirement_brief | risk_discovery | design | spec | plan | none
  reason: <r2p-reopen repair wording or none>
  required_action: <r2p-gap-open repair wording or none>
```

## Fixer Constraints

Fix accepted issues directly by default. Use one serial fixer subagent only when the accepted issue list is bounded, every issue has a clear ID and location, and the fixer can work from a compact context pack.

Fixers must:

- Modify only the target document for document routes or files inside the resolved file set for PR/CODE routes. For the r2p route, direct artifact writes are forbidden: do not modify `03-07`, `run.md`, or any other run artifact.
- Treat reference documents as read-only.
- Fix only coordinator-accepted issue IDs unless the coordinator expands scope.
- Preserve intent, terminology, and structure where possible.
- Avoid broad rewrites unless a confirmed issue requires structural repair.
- Not invent background, goals, requirements, external facts, product decisions, or risk decisions.
- Redact sensitive values as `[REDACTED:<kind>]` in reports, ledgers, receipts, and final responses.

## Diff Review

After each fix round, the coordinator reviews the changed target and confirms:

- Every claimed fix maps to an accepted issue.
- No unrelated scope was introduced.
- Terminology and structure remain coherent.
- No required-section placeholder was added.
- Sensitive values were not copied into workflow state or responses.
- Every claimed fix actually resolves the original finding's `why_it_matters`, not merely that an edit was made at its location. If a claimed fix does not resolve its finding, record it as a `DIFF-FAIL` using the existing fields (`problem` = why the change does not resolve the original finding; `required_action` = the concrete next step). Do not add new fields.

Diff review is not sufficient for PASS. It only allows the next full target-context re-review.

## Full Re-Review Context Pack

When a context pack includes `Changed since last review`, it carries a redacted hint for regression hunting: the fixed issue IDs and section anchors from the latest fix round. It is not a scope limiter. The reviewer must still review the whole target context; the hint directs additional focus on those sections and issue IDs for regressions or new contradictions introduced by the last fix, but it must not replace full target-context re-review.

The `changedSinceLastReview` field is populated only when the target has already been fixed this session (i.e., the persisted content fingerprint differs from the initial fingerprint and a latest fix report exists). It is absent on first review. It carries only issue IDs and redacted section anchors — never document body text.

Diff review contract:

```text
DIFF-OK
Summary: <one redacted sentence or none>
```

or:

```text
DIFF-FAIL
Findings:
- issue_id: ISSUE-001
  problem: <specific problem>
  required_action: <specific next action>
```

## Final Response Contract

The payload submitted to `drfx workflow finalize ... --final-response-stdin` is an internal workflow final-response payload only. It remains required for workflow validation and audit, and it may carry redacted internal issue IDs needed to reconcile ledgers and receipts. It is not the default user-visible output.

The internal workflow final-response payload records:

- Final status: one of the terminal or pause states above.
- Changes made and fixed issue IDs when available.
- Files changed, limited to files actually modified.
- Verification performed, including reviewer passes and any local checks.
- Not fixed items, deferrals with issue IDs, reason, owner, and next action, blockers, or unsupported capability reasons.
- Residual risk, or `none identified`.

Do not print raw secrets, credentials, cookies, tokens, private keys, raw sensitive logs, or partial secret values. Use `[REDACTED:<kind>]` and location anchors.

Internal workflow final-response payload machine block:

```text
Final status: pass | read-only-clean | read-only-findings | stopped-with-deferrals | stopped-no-progress | blocked | unsupported | externally-changed | possible-target-replacement | checkpoint
Assurance: practical | strict-verified | advisory
Runtime platform: codex | claude-code | gemini | opencode | manual
Mode: review-and-fix | read-only
Target: <target path for document routes, none for PR/CODE file-set routes, or workId=<WF-...> for r2p>
Files changed: <none, the exact target path for document routes, comma-separated in-set relative paths for PR/CODE file-set routes, or none for r2p>
Fixed issue IDs: <none or comma-separated ISSUE-### values>
Verification performed: <redacted summary>
Deferrals or blockers: <none or redacted issue/blocker summary with owner and next action when applicable>
Blocking reason: <allowed blocker code or none>
Status reason: <allowed status reason or none>
Residual risk: <risk or none identified>
Redaction statement: <statement or none>
Coordinator agreement: <required when Final status is pass; otherwise none>
```

Internal payload checklist: include final status, assurance, runtime platform, mode, target, files changed, fixed issue IDs, verification performed, deferrals or blockers, blocker/status reason, residual risk, redaction statement, and coordinator agreement. Read-only finalization uses `read-only-clean` or `read-only-findings`, never `pass`.

Default user output uses concise Route Output after workflow finalization. It must summarize status, locations, problems, fixes or needed actions, and verification without printing the 14-line machine block or internal issue IDs. If workflow finalization returns `archiveWarning`, the concise default output must include an archive warning line and one concrete repair/reset/rerun next action. Debug output may additionally show the redacted `archiveWarning` field and redacted audit details.

## Read-Only Behavior

In `read-only` mode, review and triage only. Do not modify the target document, resolved file set, any r2p run artifact (`03-07` or `run.md`), or reference documents. If blocking findings remain, stop as `read-only-findings`. Codex, Claude Code, and opencode routes may tell users to rerun the same route with `review-and-fix`; Gemini routes must tell users to apply fixes manually or rerun with a Codex/Claude Code/opencode review-and-fix route.

One-shot `read-only` without `ledger=`, without `resume`, and without `reset` must not create `.drfx`, `MANIFEST.md`, `ISSUES.md`, `CONTINUITY.md`, `SUMMARY.md`, or `rounds/`. Keep fingerprints in memory unless a guard failure must be reported.

No-state read-only flow keeps `reviewGuard` and `stateToken` in coordinator memory only. Do not write tokens to disk, do not hand-edit tokens, and repeat the same runtime platform, assurance, subagent probe, stdin handoff, and downgrade fields on no-state `record-review`, `record-triage`, and `finalize`. A no-state finalizer that consumes `--final-response-stdin` must pass `--runtime-stdin-handoff ready`.

## Runtime Independence

The workflow must not depend on runtime objective/session/platform memory. Durable state for long work is file-backed under `.drfx/targets/<target-key>/`, and each reviewer or fixer context pack must be self-contained enough to work without chat history.
