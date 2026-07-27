English | [简体中文](README.zh-CN.md)

# drfx

[![npm version](https://img.shields.io/npm/v/@xenonbyte/drfx.svg)](https://www.npmjs.com/package/@xenonbyte/drfx)
[![node](https://img.shields.io/node/v/@xenonbyte/drfx.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> Install document and code review-fix routes into Claude Code, Codex, Gemini, and opencode.

[Introduction](#introduction) · [Installation](#installation) · [Routes](#routes) · [Quick Start](#quick-start) · [Invocation Syntax](#invocation-syntax) · [Modes](#modes) · [Output](#output) · [Review Rules](#review-rules) · [Custom Rules](#custom-rules) · [State and Resume](#state-and-resume) · [Write Safety](#write-safety) · [Troubleshooting](#troubleshooting)

## Introduction

`@xenonbyte/drfx` installs seven review routes: four document routes (SPEC, PLAN, DESIGN, COMMON), two code routes (`review-fix-pr` for pull request diffs and `review-fix-code` for source scope review), and one requirement-plan route (`review-fix-r2p`). All routes can run a read-only review or a review-and-fix loop.

It is built for repeatable, auditable review: every fix is confined to a declared file set, guarded by git or file snapshots, and the route never claims a passing result it cannot prove.

### Features

- **Seven routes** — four document routes (SPEC, PLAN, DESIGN, COMMON), two code routes (`review-fix-pr`, `review-fix-code`), and one requirement-plan route (`review-fix-r2p`).
- **Two modes** — `read-only` review, or `review-and-fix` with a bounded repair loop.
- **Explicit invocation only** — a route starts because you typed `$review-fix-*` or `/review-fix-*`, never because the model inferred it from a request like `fix this bug`.
- **Guarded writes** — `guard=git` or `guard=snapshot` prove fixes stayed inside the target file set; otherwise the run blocks instead of writing.
- **Layered rules** — built-in rubrics plus optional user-global and project-local custom rules.
- **Safe install/uninstall** — manifest-backed and owned-only; uninstall never deletes files it does not own.

### Supported platforms

| Platform | Install form | Automatic fixing |
|---|---|---|
| Claude Code | command file | Yes |
| Codex | skill directory | Yes |
| Gemini | TOML command | No — advisory read-only only |
| opencode | command file | Yes |

> [!WARNING]
> Gemini routes are advisory read-only on every route: they never edit files, never run `review-and-fix`, and never claim a passing result. Use Claude Code, Codex, or opencode for automatic fixing.

## Installation

Requires Node.js 20 or newer and at least one supported agent platform (Claude Code, Codex, Gemini, or opencode). For automatic fixes, use `guard=git` with a tracked clean `HEAD` target, or `guard=snapshot` with a valid snapshot rollback anchor.

Install the package globally:

```bash
npm install -g @xenonbyte/drfx
```

Check the version, list the commands, and probe local platform capabilities:

```bash
drfx version
drfx help
drfx doctor
```

Install generated routes. `--platform` is optional — omit it to target all platforms (Claude, Codex, Gemini, opencode):

```bash
drfx install                                  # all platforms
drfx install --platform claude,codex,gemini,opencode # explicit list
drfx install --platform claude                # a single platform
```

`--platform` installs:

- `claude`: command files under `~/.claude/commands`.
- `codex`: generated skill directories under `~/.codex/skills/review-fix-*`.
- `gemini`: command TOML files under `~/.gemini/commands`. Gemini routes are advisory-only.
- `opencode`: command files under `~/.config/opencode/commands`.

The explicit-invocation policy is stored in the generated Claude and Codex artifacts. If those routes were installed by an earlier drfx version, upgrade them by rerunning:

```bash
drfx install --platform codex,claude
```

> [!IMPORTANT]
> Upgrading the npm package alone does not rewrite artifacts that are already installed. Until you rerun `drfx install`, previously installed Claude and Codex routes keep their old metadata and can still be selected by the model on their own.

Report what is installed per platform:

```bash
drfx status
```

Uninstall package-owned generated routes (`--platform` is likewise optional):

```bash
drfx uninstall                                # all platforms
drfx uninstall --platform claude              # a single platform
```

If uninstall finds user-modified generated files or Codex skill directory contents, it keeps those files, reports `partially uninstalled: <platform> (... manifest retained)`, and retains a narrowed manifest so a later uninstall can remove the remaining package-owned files after they are restored or deleted.

`drfx doctor` reports local platform capability status. Use `drfx doctor --platform <platform> --json` when a strict verified route needs same-flow capability proof.

## Routes

The installed user-facing routes are:

```text
review-fix-spec   SPEC documents
review-fix-plan   PLAN documents
review-fix-design DESIGN documents
review-fix-doc    COMMON documents
review-fix-pr     PR diff (base..HEAD file set)
review-fix-code   source scope file set
review-fix-r2p    r2p requirement-plan review
```

All seven routes must be invoked explicitly in agent input:

```text
Codex:                          $review-fix-*
Claude Code / Gemini / opencode: /review-fix-*
```

The leading `$` is the literal Codex skill prefix, not a shell prompt.

How the explicit form is enforced differs by platform:

- `claude` and `codex` carry generated metadata that switches model-initiated route selection off (`disable-model-invocation: true` in the command frontmatter; `policy.allow_implicit_invocation: false` in `agents/openai.yaml`). An ordinary request such as `fix this bug`, or a routine review or debugging request, does not start a drfx route.
- `gemini` and `opencode` install user-invoked custom commands and expose no equivalent switch, so the explicit `/review-fix-*` form is the only way to reach a route on those platforms.

Once a route is explicitly invoked, its arguments and defaults are unchanged. In particular, invoking `review-fix-code` without `scope=` still reviews the whole project.

The route name selects the review target. Document routes: do not pass `type=`. Code routes (`review-fix-pr`, `review-fix-code`): do not pass `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.

## Quick Start

Review and automatically fix a SPEC document on Codex (the leading `$` is the literal skill prefix):

```text
$review-fix-spec docs/spec.md
```

On Claude Code or opencode, use the slash-command form:

```text
/review-fix-spec docs/spec.md
```

Gemini also uses `/review-fix-*`, but its routes are advisory read-only. The remaining examples use slash-command syntax; on Codex, replace the leading `/` with `$`.

A bare path is shorthand for `target=<path>`. The full form remains supported:

```text
/review-fix-spec target=docs/spec.md
```

Review without editing, optionally with reference documents:

```text
/review-fix-design docs/design.md read-only
/review-fix-plan docs/plan.md ref=docs/spec.md ref=docs/design.md
```

Run strict review-and-fix, or a bounded repair loop:

```text
/review-fix-plan docs/plan.md review-and-fix strict guard=git
/review-fix-plan docs/plan.md rounds=3
```

Review a pull request diff (local git only, no fetch):

```text
/review-fix-pr base=main
/review-fix-pr base=main read-only
/review-fix-pr base=main guard=snapshot
/review-fix-pr base=main rounds=2
/review-fix-pr base=main resume
```

Review the whole project root (`scope=` omitted means whole project), or scope it to one or more directories or files. A whole-root review runs in a single pass within a budget of 300 files or 1,500,000 bytes (counted after all exclusions); a larger project is reviewed as a partitioned project review, or use `scope=<path>` or a project-root `.drfxignore` file to keep it a single pass:

```text
/review-fix-code
/review-fix-code scope=lib scope=test
/review-fix-code scope=lib read-only
/review-fix-code scope=lib guard=snapshot
/review-fix-code scope=lib resume
```

## Invocation Syntax

The signatures below omit the platform invocation prefix and show route arguments only. Prepend `$` on Codex or `/` on Claude Code, Gemini, and opencode.

### Document routes (review-fix-spec / plan / design / doc)

Supported tokens:

- A bare `<path>` is the recommended target form and is shorthand for `target=<path>`.
- `target=<path>` is the full target form. In `review-and-fix` mode, this is the only file the route may edit.
- `ref=<path>` adds a read-only reference document. Repeat `ref=` for multiple references.
- `read-only` reviews and triages without editing.
- `review-and-fix` reviews, triages, fixes accepted issues, checks the diff, and re-reviews.
- `normal` uses default strictness.
- `strict` makes low-severity findings blocking unless they are explicitly accepted as non-blocking.
- `assurance=practical` uses live platform checks suitable for normal automatic fixing on Codex, Claude Code, and opencode.
- `assurance=strict-verified` requires same-flow `drfx doctor --platform <platform> --json` proof.

> `assurance=strict-verified` requires a verified `drfx doctor` capability proof. No adapter currently
> emits verified reviewer-isolation or write-blocking proof, so strict-verified PASS is presently
> unreachable on all platforms (Claude, Codex, and opencode alike); `assurance=practical` is the
> supported automatic-fix path. strict-verified remains wired end-to-end and will activate unchanged
> once an adapter can supply verified proof.

- `assurance=advisory` allows read-only advisory review only.
- `resume` continues from target-local state.
- `reset` archives the existing target state (moved to `.drfx/archived/`, never deleted) and starts a fresh review. `resume` and `reset` are mutually exclusive.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `debug` prints redacted workflow audit details. Default output is concise.
- `root=<path>` sets the project root used for containment and state layout.
- `ledger=<path>` selects a custom issue ledger path inside the target state directory.
- `guard=git|snapshot` selects the rollback and target-only guard family. `guard=git` is the default; `guard=snapshot` uses file snapshots when a Git rollback anchor is unavailable. The route never silently switches guard modes.

### review-fix-pr

Syntax:

```text
review-fix-pr base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<path>] [debug]
```

- `base=<branch>` is required. The diff is `base..HEAD`, resolved locally with no fetch, push, or ref mutation.
- `read-only` or `review-and-fix` (default `review-and-fix` on Claude Code, Codex, and opencode; advisory read-only on Gemini).
- `guard=git` is the default; use `guard=snapshot` when a Git rollback anchor is unavailable. The route never silently switches guard modes.
- `resume` explicitly continues from saved state. Stale state is refused; there is no silent reuse.
- `reset` archives the existing target state (moved to `.drfx/archived/`, never deleted) and starts a fresh review. It is the explicit escape when stale state can no longer be resumed (for example after an exclusion-policy change shifted the file set). `resume` and `reset` are mutually exclusive.
- Auto-fix modifies only the resolved file set. If an accepted issue needs a file outside that set, leave that file unchanged and report the issue as `Not fixed` instead of expanding scope.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `root=<path>` sets the project root.
- Does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.

### review-fix-code

Syntax:

```text
review-fix-code [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<path>] [debug]
```

- `scope=<path>` names a directory to walk or a single file to include. Repeat `scope=` for multiple scopes. Empty scope means the whole project root, reviewed in a single pass within a budget of 300 files or 1,500,000 bytes (counted after all exclusions); a larger whole-root file set is reviewed as a partitioned project review — a deterministic, multi-phase, unit-by-unit review whose project PASS is earned only through the aggregate coverage gate (never a single-shot full-project PASS) — instead of blocking; narrow with `scope=<path>` or ignore rules to keep it a single pass. Explicit non-root directory/file scopes are reviewed in a single pass regardless of size; scopes that normalize to the project root, such as `scope=.`, are treated as whole-root.
- Built-in exclusions (fixed, always applied): VCS state (`.git`, `.hg`, `.svn`); this tool's state (`.drfx`, legacy `.docs-review-fix`); local agent/tool state (`.claude`, `.codex`, `.codegraph`, `.gemini`, `.opencode`, `.config/opencode`, `.req-to-plan`); dependency trees and package caches (`node_modules`, `bower_components`, `vendor`, `.pnp`, `.yarn`, `.pnpm-store`, `.gradle`, `.m2`); build outputs (`dist`, `build`, `out`, `target`, `.next`, `.nuxt`, `.svelte-kit`, `.output`); coverage and tool caches (`coverage`, `.nyc_output`, `.cache`, `.parcel-cache`, `.turbo`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`); temp and editor scratch (`tmp`, `temp`, `.tmp`, `.idea`, `.vscode`); plus the OS scratch files `.DS_Store` and `Thumbs.db`.
- Version-control-ignored files are excluded automatically: one local read-only git query (`git ls-files --others --ignored --exclude-standard`) captures the full gitignore stack — nested `.gitignore` files, the global excludes file, and `.git/info/exclude` — with git's own semantics, so tracked files are never version-ignored. In a non-git root this source is simply absent and only the built-in and `.drfxignore` exclusions apply. The two ignore sources are independent: a `.drfxignore` negation cannot re-include a version-ignored path — use an explicit `scope=` for that.
- A project-root `.drfxignore` file adds user-level exclusions using `.gitignore` syntax: `#` comments, blank lines, `!` negation with last-match-wins, leading-`/` anchoring, trailing-`/` directory-only patterns, and `*` / `?` / `[...]` / `**` globs. Only the root file is read (no nested ignore files), and it must be a regular file (a symlinked `.drfxignore` is refused). The pattern lines — order included, since negation is last-match-wins — are part of the review-target identity: editing `.drfxignore` produces a different review target, so existing state cannot be resumed across the change — start fresh (or `reset`). Raw pattern text is not stored in workflow state; ordered digests carry identity and user-facing output uses redacted pattern text.
- Explicit `scope=` always wins: a scoped directory or file is reviewed even when an ignore source covers it (the override is reported, never silent). Inside a scoped directory, independently matching ignore rules still apply.
- `read-only` or `review-and-fix` (default `review-and-fix` on Claude Code, Codex, and opencode; advisory read-only on Gemini).
- `guard=git` is the default; use `guard=snapshot` when a Git rollback anchor is unavailable. The route never silently switches guard modes.
- `resume` explicitly continues from saved state. Stale state is refused; there is no silent reuse.
- `reset` archives the existing target state (moved to `.drfx/archived/`, never deleted) and starts a fresh review. It is the explicit escape when stale state can no longer be resumed (for example after an exclusion-policy change shifted the file set). `resume` and `reset` are mutually exclusive.
- Auto-fix modifies only the resolved file set. If an accepted issue needs a file outside that set, leave that file unchanged and report the issue as `Not fixed` instead of expanding scope.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `root=<path>` sets the project root.
- Does not accept `target=`, `ref=`, `base=`, `strict`, `normal`, `assurance=`, or `ledger=`.

### review-fix-r2p

Syntax:

```text
review-fix-r2p workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<path>] [debug]
```

`review-fix-r2p` reviews an active r2p (requirement-to-PLAN) run named by `workId=<WF-...>` under `<project>/.req-to-plan/WF-*`. It judges the requirement plan (`07-plan.md`) with the PLAN rubric against its owning upstream docs (`03`–`06`), but it never edits artifacts: `03`–`07` and `run.md` are read-only, fingerprinted evidence. Accepted high/medium blocking findings map to an owning upstream stage and are repaired only through the official r2p lifecycle commands — `r2p-reopen` or `r2p-gap-open` — never by writing the docs. After a repair the route checkpoints, tells you to run `r2p-continue` so r2p regenerates artifacts, and earns a workflow PASS only on a clean rerun.

- `workId=<WF-...>` is required; a bare `WF-...` token is accepted as shorthand. It names an active run directory under `<project>/.req-to-plan/WF-*`. There is no `target=`, `ref=`, or path form — a path is rejected with `invalid-r2p-invocation`.
- `03`–`07` and `run.md` are read-only, fingerprinted evidence. drfx never writes, deletes, renames, restores, or patches them, and the review set or `run.md` changing mid-run is detected.
- Repair runs only through the r2p lifecycle. `record-r2p-repair-plan` records the repair plan; `apply-r2p-repair` invokes `r2p-reopen` or `r2p-gap-open` and refuses with `r2p-drift-detected` if review/triage state moved since the plan was recorded, or `r2p-existing-route-open` when the run already has an open route. `r2p-continue` is the required next action after a repair, not a drfx-invoked fix step.
- There is no user-facing `guard=` token; read-only drift detection is internal and always on.
- `read-only` or `review-and-fix` (default `review-and-fix` on Claude Code, Codex, and opencode; advisory read-only on Gemini).
- Advisory-only on Gemini: `review-and-fix` is unsupported, `rounds=<n>` is not accepted, workflow PASS is unavailable, and automatic fixing never runs.
- `resume` explicitly continues from saved state. Stale state is refused; there is no silent reuse.
- `reset` archives the existing target state (moved to `.drfx/archived/`, never deleted) and starts a fresh review. `resume` and `reset` are mutually exclusive.
- `rounds=<n>` sets the maximum repair-loop count (positive integer). Unsupported with `read-only`.
- `root=<path>` sets the project root.
- Does not accept `target=`, `ref=`, `base=`, `strict`, `normal`, `assurance=`, `scope=`, `ledger=`, or `guard=`.

Parsing is strict:

- The only target form is `workId=<WF-...>` or a single bare `WF-...` token; path-based input is rejected.
- A bare `WF-...` and an explicit `workId=` must not both be given, and `workId=` must not be duplicated; multiple unlabeled work IDs are ambiguous.
- Duplicate `root=` is rejected.
- Unknown `key=value` tokens and unknown dash options are rejected.

For valid target invocations, Codex, Claude Code, and opencode routes default missing mode to `review-and-fix` and missing assurance to `practical`. For document/PR/CODE routes on Codex, Claude Code, and opencode, explicit `assurance=advisory` without mode selects `read-only`; `review-fix-r2p` does not accept user-facing `assurance=`. Gemini routes default missing mode to `read-only` and missing assurance to `advisory`.

Help-style or invalid invocations explain usage only and must not read files, run `drfx workflow`, create state, run probes, or declare review results.

## Modes

`read-only`:

- Reads the target and references.
- Runs semantic review and triage.
- Does not edit files.
- Reports either `Clean:` or `Issues:`.

`review-and-fix`:

- Reads the target and references.
- Runs review, triage, fix, diff review, and full re-review.
- Document routes edit only the target document.
- PR/CODE routes edit only files in the resolved file set.
- Reports `Fixed:` when changes were applied.
- Reports `Unfixed:` when accepted issues remain.

Gemini supports advisory read-only review. Gemini does not support `review-and-fix` or `assurance=strict-verified`.

Code routes (`review-fix-pr`, `review-fix-code`) on Gemini are advisory-only: `review-and-fix` is unsupported, `rounds=<n>` is not accepted, workflow PASS is unavailable, and automatic fixing never runs. Use Claude Code, Codex, or opencode for automatic code fixing.

`read-only` paths never claim PASS and create no auto-fix state, on any platform.

## Output

Default output is designed to be short and usable by another AI agent.

Generated routes call `drfx workflow` with `--json=compact` for automated continuation. Compact JSON is the generated-route default: it keeps status, `nextAction`, state/report/context artifact paths, and other continuation fields, while omitting debug-only bodies such as `contextPackSkeleton`, raw prompts, transcripts, logs, and target bodies. For operator and debug CLI use, `drfx workflow ... --json` and `drfx workflow ... --json=full` produce the full JSON shape. Use `drfx workflow ... --json=compact` directly when you want the smaller continuation-safe shape.

Full JSON and debug output are diagnostic surfaces. `--json=full` exposes redacted artifact paths such as target state directories, manifests, ledgers, reports, guard reports, locks, and context artifacts so you can inspect those files on disk. `debug` prints redacted workflow audit details, blocker codes, runtime probe status, and relevant artifact paths. Neither surface should include raw target bodies, raw prompts, subagent transcripts, secrets, or unredacted sensitive logs.

Clean read-only review:

```text
Clean: docs/spec.md has no blocking issues.
```

Read-only review with findings:

```text
Issues:
- Location: docs/spec.md:42
  Problem: The acceptance criteria do not define the empty-state behavior.
  Why it matters: Implementers can ship incompatible behavior.
  Suggested fix: Add explicit empty-state acceptance criteria.
Next: Apply fixes manually or rerun on Codex/Claude Code/opencode in review-and-fix mode.
```

Successful review-and-fix:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Files changed:
- docs/spec.md
```

Review-and-fix with remaining issues:

```text
Fixed:
- Location: docs/spec.md:42
  Change: Added explicit empty-state acceptance criteria.
Unfixed:
- Location: docs/spec.md:88
  Problem: The rollout owner is still unspecified.
  Next: Add the accountable owner or defer with reason, owner, and next action.
Files changed:
- docs/spec.md
```

Blocked run when the target lacks a rollback anchor:

```text
Blocked: docs/spec.md cannot be auto-fixed because it lacks a clean rollback anchor.
Next: Commit or restore the target, rerun with read-only, or use guard=snapshot when Git rollback is unavailable.
```

Other guard blockers use different wording: `target-only-guard-unavailable` means the target-only guard is unavailable or unparseable, while `unexpected-worktree-change` means non-target worktree changes make automatic fixing unsafe.

`debug` may include redacted state paths, blocker codes, runtime probe status, and workflow audit details. It must not print raw target bodies, raw prompts, subagent transcripts, secrets, or unredacted sensitive logs.

## Review Rules

### Document routes

Every document route applies the COMMON rubric first. Specialized routes add one type-specific rubric:

- `review-fix-spec`: COMMON plus SPEC.
- `review-fix-plan`: COMMON plus PLAN.
- `review-fix-design`: COMMON plus DESIGN.
- `review-fix-doc`: COMMON only.

Built-in rubrics:

- COMMON: purpose, coherence, actionability, assumptions, constraints, risks, project alignment, terminology, placeholders, and external facts.
- SPEC: requirements, product behavior, API behavior, scope, actors, permissions, integrations, acceptance criteria, edge cases, and verifiability.
- PLAN: implementation steps, prerequisites, tooling, verification, rollback, failure handling, data safety, compatibility, and handoff readiness.
- DESIGN: UX, UI, product workflows, system or architecture design, states, transitions, contracts, data flow, accessibility, responsiveness, localization, constraints, and risks.

### Code routes

Code routes (`review-fix-pr`, `review-fix-code`) use self-contained rubrics with no COMMON layer:

- `review-fix-pr`: correctness, regression, safety, tests, contracts, maintainability, and platform.
- `review-fix-code`: correctness, architecture, state-and-io, safety, tests, contracts, maintainability, and platform.

Code review is actionable-only: pure style preferences, no-risk refactors, and over-abstraction opinions are not blocking findings.

### Reference Conformance

`ref=` documents are consistency sources, not mandatory upstream chains.

- SPEC does not require a DESIGN reference.
- PLAN does not require a SPEC reference.
- `Design Coverage Import` is optional unless the SPEC claims complete coverage of a reference, custom rules require it, or the SPEC becomes unverifiable without it.
- `SPEC-to-task mapping` is optional unless the PLAN claims complete coverage of a reference, custom rules require it, or the PLAN becomes unsafe or unverifiable without it.
- Missing trace tables, stable IDs, or coverage tables are not blocking by default.

Blocking reference findings are conflicts, unsupported new requirements presented as reference-backed, omitted reference constraints required for the target's stated purpose, or execution steps that would violate a reference.

Reviewer findings include enough detail for triage: severity, location, problem, why it matters, suggested fix, confidence, and sensitive-content metadata when relevant.

## Custom Rules

Supported V3 custom rule files:

```text
~/.drfx/rules/COMMON.md
~/.drfx/rules/SPEC.md
~/.drfx/rules/PLAN.md
~/.drfx/rules/DESIGN.md
~/.drfx/rules/PR.md
~/.drfx/rules/CODE.md
.drfx/rules/COMMON.md
.drfx/rules/SPEC.md
.drfx/rules/PLAN.md
.drfx/rules/DESIGN.md
.drfx/rules/PR.md
.drfx/rules/CODE.md
```

Each custom rule file is a plain Markdown fragment. It does not need a wrapping heading.

For a typed review, the loader reads only `COMMON.md` plus the current document type file from user-global and project-local rules. A `SPEC` review does not read `PLAN.md` or `DESIGN.md`; a `PLAN` review does not read `SPEC.md` or `DESIGN.md`; a `DESIGN` review does not read `SPEC.md` or `PLAN.md`; a COMMON document review reads only `COMMON.md`.

Code routes (`review-fix-pr`, `review-fix-code`) have no COMMON layer. A `PR` review reads only `PR.md`; a `CODE` review reads only `CODE.md`. The user-global and project-local rule files for code routes follow the same two-tier layout as document routes.

Legacy `RULE.md` is stale configuration. If `~/.drfx/RULE.md` or `.drfx/RULE.md` exists, workflow start blocks with `state-validation-failed` before writing target state.

Unknown Markdown files under `rules/`, such as `Spec.md`, `SPEC-RULE.md`, or `REQUIREMENTS.md`, produce a normal-mode warning and continue. In strict mode, they block before target state is written.

Rule precedence (document routes):

1. workflow hard constraints
2. built-in COMMON rubric
3. built-in document-type rubric
4. user-global COMMON rules
5. user-global document-type rules
6. project-local COMMON rules
7. project-local document-type rules

Rule precedence (code routes — no COMMON layer):

1. workflow hard constraints
2. built-in code-route rubric (PR or CODE)
3. user-global PR.md or CODE.md rules
4. project-local PR.md or CODE.md rules

Unknown Markdown files under `rules/` are a warning for code routes (`review-fix-pr`, `review-fix-code`) and do not block: these routes expose no `strict|normal` token and always use the normal policy. Symlinked or non-regular `.md` entries are still rejected.

Project-local rules are more specific than user-global rules. Custom rules cannot override workflow hard constraints.

## State and Resume

Persistent state is target-local:

```text
.drfx/targets/<target-key>/
```

The target key is derived from the normalized target path relative to the project root: a readable slug plus a 12-character SHA-256 prefix. It is path-based, not content-based.

Project-local layout:

```text
.drfx/
  rules/
    COMMON.md
    SPEC.md
    PLAN.md
    DESIGN.md
  index.md
  targets/
  archived/
```

`rules/` is shared project configuration. `index.md` is project-level index material when present. `targets/<target-key>/` is single-target workflow state. `archived/` is created by `reset` and by successful `pass` / `read-only-clean` finalization. `reset` moves prior target state there (never deletes it); terminal finalization archives completed state so the next run starts fresh without `reset`. If terminal archiving fails, finalization reports `archiveWarning` and a concrete delete/reset/retry next action while leaving the state directory in place.

Default target state layout:

```text
.drfx/targets/<target-key>/
  MANIFEST.md
  ISSUES.md
  CONTINUITY.md
  SUMMARY.md
  LOCK/
    lease.json
  stale-locks/
  rounds/
```

`MANIFEST.md` records target path, document type, strictness, mode, target key, ledger path, status, current round, file fingerprints, references, and timestamps.

The default ledger is `.drfx/targets/<target-key>/ISSUES.md`. A custom `ledger=` path must stay inside the target directory and must not point into reserved paths such as `LOCK/`, `stale-locks/`, `rounds/`, `MANIFEST.md`, `CONTINUITY.md`, or `SUMMARY.md`.

`resume` uses target-local files, not chat history. There is no runtime objective/session/platform memory dependency for resume. Resume derives the target key, reads `MANIFEST.md`, reads the ledger, loads `CONTINUITY.md` when present, rebuilds current merged rules, checks fingerprints, and continues only when state is still valid.

## Write Safety

> [!NOTE]
> `guard=git` is the default. Every automatic write must be proven to stay inside the target file set under the active guard, or the run blocks instead of writing — a passing result is earned, never assumed.

Reference documents are read-only. Document-route fixes must modify only the target document. PR/CODE fixes must modify only files in the resolved file set.

Automatic target writes require:

- `review-and-fix` mode;
- either `guard=git` with a Git worktree `HEAD` + tracked clean target, or `guard=snapshot` with a valid snapshot rollback anchor;
- a target-only guard that can prove writes stayed target-only within the selected guard mode;
- no unsafe non-target changes that make guard results ambiguous for the selected guard mode.

Before a fix, the route locks the target state directory and rechecks the target fingerprint. Concurrent edits, external changes, stale unsafe locks, or possible target replacement stop the workflow before a write is trusted.

> [!CAUTION]
> Sensitive values must never be printed or stored in ledgers, receipts, manifests, summaries, prompts, or final responses. Use `[REDACTED:<kind>]` — for example `[REDACTED:api-token]`, `[REDACTED:private-key]`, `[REDACTED:cookie]`, or `[REDACTED:credential]`.

For sensitive findings, store location anchors and secret kind, not raw values, partial prefixes, suffixes, hashes, checksums, raw logs, or transcript excerpts.

## Troubleshooting

`Blocked: target or worktree is not write-eligible.`

Commit or restore the target document, then resolve unsafe non-target worktree changes. Rerun after `git status --short` shows the target is clean and the remaining worktree state is safe for a target-only guard.

Guard blocker wording:

- `rollback-unavailable`: the target lacks a clean rollback anchor. Commit or restore the target, rerun read-only, or use `guard=snapshot` when Git rollback is unavailable.
- `target-only-guard-unavailable`: the target-only guard is unavailable or unparseable. Restore guard inputs or rerun after guard data can be read.
- `unexpected-worktree-change`: non-target worktree changes make automatic fixing unsafe. Commit, stash, or restore unrelated changes before retrying.

`Blocked: fix-report-mismatch.`

The submitted fix report did not match the required schema. When the document workflow is blocked in the fix phase with blocking reason `fix-report-mismatch`, `begin-fix` may perform a safe retry: it reuses the original passed guard baseline, verifies references and target-only guard results, revalidates that the rollback snapshot body still exists and matches the begin-fix target fingerprint, reacquires the lock, and returns `nextAction: retry end-fix with a valid fix report`. This safe retry is only a report-resubmission path; it does not increment `fixAttemptCount` or `currentRound`, does not mark issues fixed, and a corrected `end-fix` still advances to diff-review instead of PASS.

If safe retry is refused, use recovery instead: resolve the reported blocker and retry, use `reset` to archive the state and start fresh, or perform manual recovery when the target or state needs human repair. `reset` and manual recovery are broader recovery tools, not substitutes for safe retry when the existing state is still eligible.

`Blocked: state-validation-failed.`

Remove stale `RULE.md` files. Unknown Markdown files under `.drfx/rules/` and `~/.drfx/rules/` warn in normal mode but block strict runs.

`Unsupported: review-and-fix or strict-verified is unavailable on Gemini.`

Use Gemini for advisory read-only review, or use Codex/Claude Code/opencode for automatic fixing. For code routes (`review-fix-pr`, `review-fix-code`), Gemini is advisory-only on all platforms: `review-and-fix` is unsupported, workflow PASS is unavailable, and no files are edited. Use Claude Code, Codex, or opencode for code route automatic fixing.

`Unfixed:` appears after review-and-fix.

The route fixed what it could safely fix and is reporting accepted issues that remain. Deferrals include reason, owner, and next action.

`resume` refuses to continue.

The target state no longer matches the current file fingerprints, target path, references, rules, or lock state. Start a fresh run after resolving the reported blocker.
