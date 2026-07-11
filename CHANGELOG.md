# Changelog

## 0.10.2 - 2026-07-11

Hardens git status parsing, mutation-lock crash recovery, ledger merges, install rollback, and state target-identity checks.

### Fixed

- **NUL-terminated `git status` parsing.** The target-only guard parses `git status --porcelain=v1 -z` instead of splitting on newlines, so paths containing spaces, newlines, or quotes are handled correctly; a missing NUL terminator is rejected and the now-unneeded C-quote branch is dropped (`lib/fix-guard.js`).
- **Mutation lock survives a crashed holder.** The `mkdir`/`rmdir` mutation mutex is replaced with a leased mutex plus an expiry-based takeover/recovery protocol, so a crashed process no longer deadlocks all future lock operations; malformed mutex metadata reports `corrupt-lock` instead of a permanent `lock-held` (`lib/lock.js`).
- **Snapshot and file-set guards track and restore file mode.** Permission bits join snapshot, monitor, and file-set baseline fingerprints and are restored via `chmod` on rollback; mode is compared only when both sides carry it, and baselines written before mode tracking are tolerated on read (a missing mode skips `chmod`, a present-but-invalid mode stays corrupt) (`lib/snapshot-guard.js`, `lib/workflow/helpers.js`).
- **Ledger merges are canonicalized and severity-safe.** Triage merge graphs canonicalize transitive merges with cycle detection, the surviving issue retains the highest blocking severity, duplicate issue ids are rejected, severities are validated on parse, and stale accepted-non-blocking-low ids are dropped (`lib/ledger.js`).
- **Install rollback preserves a pre-existing capability descriptor.** A failed install now backs up and restores the descriptor instead of unlinking it, removes a partial target before restoring the displaced original, and keeps a committed directory swap when only post-swap cleanup fails; uninstall verifies the manifest platform and the canonical descriptor path (`lib/install.js`, `lib/manifest.js`).

### Changed

- **State commands re-derive and cross-check target identity.** Document, file-set, and r2p state resolution re-derives the target key from the manifest and rejects a mismatch, hardening against a state directory pointed at the wrong target (`lib/workflow/helpers.js`, `lib/lock.js`).

## 0.10.1 - 2026-07-02

Hardens install rollback, workflow output redaction, and file-set unit-review freshness.

### Fixed

- **Shared-asset install is now atomic and fully rolled back on failure.** `copySharedAssets` writes through `atomicCopyFile` and refuses to overwrite a non-file target (`ERR_SHARED_ASSET_TARGET_KIND`). The copy runs inside the install try-block with per-file backup tracking, so a later generated-file write failure restores the prior shared assets; transient backups are discarded on success so cross-platform shared assets are never recorded in a single platform's manifest (`lib/generator.js`, `lib/install.js`).
- **Workflow output redacts sensitive strings.** `workflowJson` and `formatWorkflowError` now pass `message` and `nextAction` through `redactSensitive` before returning them (`lib/workflow-state.js`, `lib/workflow/index.js`).
- **Unit review rejects stale extra reads.** `recordUnitReview` refuses a coverage receipt whose `extraRead` contentId no longer matches on-disk content (`ERR_UNIT_REVIEW_EXTRA_READ_STALE`), and `nextUnit` invalidates a stored summary whose extra reads drifted, mirroring the existing cache-skip guard (`lib/workflow/file-set-unit-review.js`).
- **r2p gap-open live-status guard is consistent.** `statusMatchesCommandKind` gates `r2p-gap-open` on `GAP_ROUTABLE_STATUSES`, so a `next_stage` run is rejected in the drift guard exactly as in the routing check (`lib/workflow/r2p-repair.js`).

### Changed

- Removed the unused `ensureDependencyBaseline` snapshot-guard helper, and synced the public CLI command list, r2p assurance grammar, and r2p `targetContextKind` across docs and generated route fixtures (`lib/snapshot-guard.js`, `shared/`, `templates/`, docs).

## 0.10.0 - 2026-06-30

Reworks the `review-fix-r2p` route from in-place document editing into a review-only route that repairs exclusively through the official r2p lifecycle commands.

### Changed

- **`review-fix-r2p` is now review-only; repair runs only through the r2p lifecycle.** BREAKING: the route is invoked with `workId=<WF-...>` (or a bare `WF-...` shorthand) against an active run under `.req-to-plan/WF-*`, and no longer accepts `target=`, `ref=`, or any path form. It reviews the requirement plan (`07-plan.md`) against its owning upstream docs (`03–06`), but `03–07` and `run.md` are now read-only, fingerprinted evidence — drfx never writes, deletes, renames, restores, or patches them. Accepted/reopened/downgraded high/medium blocking findings map to an owning upstream stage and are repaired only by invoking `r2p-reopen` or `r2p-gap-open` through `record-r2p-repair-plan` + `apply-r2p-repair`; the route then checkpoints, directs the user to run `r2p-continue`, and earns a workflow PASS only on a clean rerun after r2p regenerates artifacts. An in-progress `review-fix-r2q`/old `review-fix-r2p` workflow state is not migrated (`lib/routes.js`, `lib/input.js`, `lib/workflow/`).
- **Manifest V2 carries an r2p target-state shape.** The persisted `targetContextKind` discriminator now recognizes `r2p`, which additionally persists `workId`, the read-only `runMdSha256` gate fingerprint, and the read-only review-set fingerprint (`lib/manifest.js`, `lib/workflow/`).

### Added

- **Recorded r2p repair plan with drift detection.** `record-r2p-repair-plan` persists the normalized repair plan; `apply-r2p-repair` re-derives the live plan and refuses with `r2p-drift-detected` if review/triage state changed in between, so a stale plan can never drive an r2p lifecycle command. The repair command runs through `execFile` with an argv array and `shell:false`, same-round PASS after a repair is blocked, and finalize resolves the round's successful repair receipt to surface the `r2p-continue` next action.
- **r2p preflight validates the requested `workId`** is present in `r2p-status` before `context`, `record-review`, `record-triage`, and `finalize`, and the route blocks `r2p-gap-open` when the run already has an open route (`r2p-existing-route-open`), matching the real `req-2-plan` CLI.

## 0.9.1 - 2026-06-25

Fixes a crash in the partitioned-review `aggregate-review` command when the target-state manifest is unreadable.

### Fixed

- **`aggregate-review` no longer throws on an unreadable target-state manifest.** `runAggregateReview` was the only `resolveFileSetStateMetadata` caller that did not guard the lookup, so a missing or corrupt `MANIFEST.md` crashed the command instead of returning a result. It now maps the failure through `stateValidationResult`, returning a structured `blocked` result (`blockingReason: state-validation-failed`) like every other state-directory command (`lib/workflow/partitioned-review.js`).

## 0.9.0 - 2026-06-25

Adds a compact JSON output mode — now the generated-route default — for token-lean automated continuation, reworks `drfx install` into a clean reinstall with full rollback, and renames the seventh route to `review-fix-r2p`.

### Added

- **Compact JSON output mode for the `workflow` dispatcher**, now the generated-route default (`--json=compact`). It keeps status, `nextAction`, and the state/report/context artifact paths needed for continuation while omitting debug-only bodies such as `contextPackSkeleton`, raw prompts, transcripts, logs, and target bodies. `drfx workflow ... --json` and `--json=full` still produce the full JSON shape for operator and debug CLI use.
- **Safe document fix-report retry.** When a document workflow blocks in the fix phase with blocking reason `fix-report-mismatch`, `begin-fix` performs a report-resubmission retry: it reuses the original passed guard baseline, revalidates references and the rollback snapshot body against the recorded post-fix target fingerprint, reacquires the lock, and returns to diff-review (never PASS). It does not increment `fixAttemptCount` or `currentRound` or mark issues fixed, and it now also recognizes a mismatch receipt written to an attempt path.

### Changed

- **Renamed the seventh route `review-fix-r2q` → `review-fix-r2p`**, naming it after the r2p (requirement-to-PLAN) workflow it reviews, in line with the `review-fix-pr`/`review-fix-code` convention. BREAKING: the route name, its generated command/skill files, and the persisted `routeKind`/`targetContextKind` discriminator all change. Reinstall to pick up the new route; an in-progress `review-fix-r2q` workflow state is not migrated.
- **`drfx install` is now a clean reinstall.** It preflights every requested platform before mutating anything, then per platform uninstalls the previous manifest-owned install before writing the new plan, so routes dropped or renamed between versions are no longer left orphaned. User-modified route files are preserved via the partial-uninstall path. The prior install is backed up before the uninstall and restored in full if the reinstall fails; the safety backups are discarded once the reinstall commits.

## 0.8.1 - 2026-06-24

Hardening fixes from code review. Broadens secret redaction to more credential keyword variants, makes install rollback and the workflow `finalize` guard fail loudly instead of silently, and drops two dead code paths.

### Fixed

- Secret redaction now covers `api`/`auth`/`jwt`/`app`/`session`/`client` secret variants and `secret_key` across credential assignment/key patterns (`lib/redaction.js`) and the api-derived fragment patterns in both receipts (`lib/receipts.js`) and the ledger (`lib/ledger.js`).
- Install rollback no longer lets a best-effort replaced-directory cleanup failure mask the original error (`lib/install.js`).
- `workflow finalize` without a target-state directory (or `--no-state`) now fails with `ERR_WORKFLOW_COMMAND` instead of silently starting a fresh run (`lib/workflow/index.js`).
- Manifest reference parsing no longer applies a redundant index decrement (`lib/target-state.js`).

### Removed

- Dropped the never-wired vestigial `fingerprintSummary` state-token field (`lib/no-state.js`).

## 0.8.0 - 2026-06-24

Adds the seventh route, `review-fix-r2q`: a requirement-to-PLAN review-fix loop over an r2p requirement directory. It reviews the requirement plan (`07-plan.md`) with the PLAN rubric and fixes findings in place across the `03–07` edit set, treating `run.md` as a read-only, fingerprinted gate.

### Added

- **`review-fix-r2q` route.** Reviews an r2p requirement directory's `07-plan.md` with the PLAN rubric and fixes findings backward into the owning upstream docs (`03–06`) in place. `run.md` is a read-only, fingerprinted gate (r2q never writes it or invokes the r2p CLI); the route gates on a generated plan that is not under `*/.req-to-plan/archive/*`, guards the `03–07` edit set with `snapshot` (default) or `git`, and is advisory-only on Gemini.

### Fixed

- `atomicCopyFile` now shares the non-regular-target refusal (`ERR_ATOMIC_WRITE_TARGET_KIND`) and
  destination-mode preservation that `atomicWriteFile` already had, making the "every atomic write …
  refuses to clobber non-regular targets and preserves existing file permissions" guarantee true for
  snapshot rollback bodies (`lib/snapshot-guard.js`) as well.

## 0.7.1 - 2026-06-23

Internal hardening of how drfx writes its own files. Every atomic write — capability descriptors, install manifests, leases, workflow state, snapshot rollback bodies, and generated route files — now flows through one shared helper that refuses to clobber non-regular targets and preserves existing file permissions.

### Changed

- All atomic file writes are consolidated into a single `lib/atomic-write.js` helper, replacing several copy-pasted stage-to-temp-then-rename implementations across the installer, doctor, lock, manifest, snapshot guard, and workflow state.

### Fixed

- Atomic writes now refuse to replace a symlink, directory, or other non-regular file (`ERR_ATOMIC_WRITE_TARGET_KIND`) instead of silently swapping it for a regular file, reinforcing drfx's existing symlink-hostile posture. When replacing an existing file, the write now preserves that file's permission bits.

## 0.7.0 - 2026-06-22

Two features: a fourth platform (opencode) and partitioned project review for `review-fix-code`, which lets whole-root reviews scale past the single-pass budget instead of blocking.

### Added

- **opencode platform.** `drfx install --platform opencode` generates the six review-fix routes as single-file commands under `~/.config/opencode/commands/`. opencode is a full review-and-fix platform with earned PASS (parity with Claude Code and Codex, unlike advisory-only Gemini): it passes the practical and strict-verified runtime trust gates, supports strict-verified capability descriptors, and threads `--runtime-platform opencode` through the generated workflow commands. `install`, `uninstall`, `status`, and `doctor` all default to including opencode.
- **Partitioned project review for `review-fix-code`.** A whole-root review whose file set exceeds the single-pass budget (300 files or 1,500,000 bytes) is no longer blocked as `file-set-too-large`; it runs as a deterministic, multi-phase, unit-by-unit review: a partition plan, bounded per-unit review with coverage receipts, then aggregate review → triage → fix → bounded re-review of affected units → re-aggregate. Project PASS is earned only through the aggregate coverage gate (never a single-shot full-project claim); when coverage cannot span every unit the run finalizes as `stopped-with-deferrals` with reason `coverage-incomplete`.
- **Oversize-file chunking.** A text file too large for one unit is split into deterministic line-window chunks reviewed independently; the coordinator reads only each chunk's line range into the reviewer prompt without persisting slice bodies. A single unconfirmed chunk keeps the whole file a coverage blocker, and unsplittable files (one huge line, or binary) remain honest `oversize_file` blockers.

### Fixed

- The write-eligibility preflight for an over-cap whole-root CODE review now returns write-eligible (partitioning-deferred) instead of blocking, so `review-and-fix` actually reaches partitioned project review.
- CODE exclusions are path-aware: opencode's `.config/opencode` config directory is excluded from CODE traversal and snapshot-guard monitoring (the single-name `.opencode` entry never matched the real two-segment path), while `.config` itself is still traversed.

## 0.6.4 - 2026-06-08

The `reset` token (shipped in v0.4.1) is now visible at every route surface: invocation grammars, source skills, generated workflow start commands, and the shared no-state rules — and Gemini route contracts stop pointing at persistent state they never support.

### Fixed

- Generated Claude/Codex routes now advertise `[resume|reset]` in the invocation grammar and prose, state that `resume` and `reset` are mutually exclusive, and thread a `<stateControlToken>` placeholder through the strict-verified and practical `drfx workflow start` command lines — materialized as `reset` only when the invocation includes `reset`. The workflow CLI has accepted the token since v0.4.1, but no generated route ever showed it, so coordinators had no documented way to issue a reset start.
- No-state review-backed workflow commands now reject `reset` explicitly (`ERR_NO_STATE_RESET`), matching the existing `resume` rejection instead of silently dropping the token.
- Gemini route contracts no longer say "For resume, read `.drfx/targets/<target-key>/`" — Gemini routes are no-state advisory and support neither `resume` nor `reset`.

### Changed

- `shared/core.md`, `shared/long-task.md`, both READMEs, and the six source skills now define one-shot no-state read-only as running without `ledger=`, without `resume`, and without `reset`.

## 0.6.3 - 2026-06-06

Development tooling housekeeping: honest naming for the syntax check script and CI coverage for the current Node LTS line.

### Changed

- The `typecheck` npm script is renamed to `syntaxcheck` (`scripts/syntaxcheck.js`): it runs per-file `node --check`, so the name now says what it does. Published package contents are unaffected.
- CI now also tests on Node 24 — the current LTS line users install on — alongside Node 20 and 22. Node 20 stays in the matrix while `engines` still declares `>=20`.

## 0.6.2 - 2026-06-06

Template/prompt consistency for the PR/CODE file-set routes, reason-aware blocker next actions, and a minimal CI workflow.

### Fixed

- The shared final-response machine block now documents both finalize formats: a single target path for document routes, and `Target: none` plus comma-separated in-set relative paths for PR/CODE file-set routes — matching what the payload parser already accepted, so file-set coordinators are no longer steered into a rejected single-target payload.
- Generated PR/CODE routes no longer inherit document-only fix-loop prose: new route-aware placeholders render the resolved-file-set write boundary ("edit only files inside the resolved target file set") and the real file-set guard contract (clean worktree before the first fix, route-owned in-set changes afterward). Document route output stays byte-identical.
- `file-set-too-large` and other CODE resolve blockers now carry the reason-aware next action (for example `pass scope=<path> to narrow the review`) across no-state context/preflight/record-review/record-triage/finalize, persistent context, start, and resume — instead of the generic "resolve a valid base/scope file set" line. The message already named the cause; now the suggested remedy matches it.

### Changed

- The PR/CODE source skill descriptions use the route-neutral "review-fix loop" naming, matching the generated route text.

### Added

- A minimal GitHub Actions CI workflow runs `npm run typecheck` and `npm test` on Node 20 and 22 for pushes to `main` and pull requests.

## 0.6.1 - 2026-06-06

`review-fix-code` file-set discovery now honors version-control ignores, gives `.drfxignore` full gitignore syntax, and accepts file scopes — with scope always winning over every ignore source.

### Added

- Version-control-ignored files are excluded from CODE review automatically: one local read-only `git ls-files --others --ignored --exclude-standard --directory` query captures the full gitignore stack (nested `.gitignore` files, the global excludes file, `.git/info/exclude`) with git's own semantics — tracked files are never version-ignored. Non-git roots simply skip this source.
- The project-root `.drfxignore` file uses gitignore syntax: `#` comments, blank lines, `!` negation with last-match-wins, leading-`/` anchoring, trailing-`/` directory-only patterns, and `*` / `?` / `[...]` / `**` globs. The zero-dependency matcher is differential-tested against real `git check-ignore`, including character classes never matching `/` and the `dir/**` (re-inclusion allowed) vs `dir/` (pruned) contrast.
- `scope=` accepts a single file in addition to directories. Explicit scopes always win over both ignore sources; scopes an ignore source would have covered — including under a directory-only ignored parent — are reported as `scopeIgnoreOverrides`, never silently re-included. Built-in exclusions stay policy: scoping an excluded directory or an OS scratch file (`.DS_Store`, `Thumbs.db`) still blocks as `excluded-scope`.
- Privacy: the target identity and manifest carry ordered, domain-separated sha256 digests of the `.drfxignore` pattern lines (duplicates preserved — a repeated rule changes last-match-wins semantics); raw pattern text never enters workflow state, user-facing output shows redacted pattern text, and `--json` results surface `userExcludes` / `scopeIgnoreOverrides`.

### Changed

- The whole-root CODE cap (300 files / 1,500,000 bytes) counts after all exclusions, and the `file-set-too-large` message reports its early-termination counts as a floor (`at least N files / N+ bytes (counting stopped at the cap)`) with `.drfxignore` as a suggested remedy. Scopes that normalize to the project root (such as `scope=.`) remain capped.
- A symlinked, non-regular, or unreadable `.drfxignore` blocks strict resolution loudly instead of being silently treated as empty; identity derivation stays lenient and deterministic.
- Both READMEs document the complete built-in exclusion list (bound to the source constants by a parity test), the version-ignore and `.drfxignore` contracts, and directory-or-file scopes.
- Gemini code-route invocation gates materialize the documented `read-only`/`advisory` defaults directly instead of describing a review-and-fix default rendered as unsupported; explicit `review-and-fix` renders the unsupported result.

## 0.6.0 - 2026-06-05

Make the PR/CODE code routes more engineering-grade: actionable rubric standards, route-neutral prompts, a whole-root size gate, broader redaction, and a resolved-set-only fixer.

### Added

- The PR and CODE rubrics gain an `## Engineering standards` section: tiered (high/medium/low) hardcoded-value findings with allowed contract-constant cases, plus error-handling and logging rules. It is gated by the existing actionable-only boundary, so it does not turn into a style war.
- `review-fix-code` whole-root review is capped at 300 files or 1,500,000 bytes. Larger whole-root file sets block as `file-set-too-large` and ask for a narrower `scope=<path>` instead of claiming a full review they cannot prove. The gate blocks during traversal, before any file content is read, and the cap is surfaced in the generated route text and README. The cap wording is bound to the source constants by a test.
- Redaction now covers AWS access key IDs and Slack incoming webhook URLs (GCP service-account private keys were already covered; a regression test locks this). A negative test guards against redacting high-entropy non-secrets such as git OIDs and SHA-256 digests.
- A byte-for-byte snapshot regression guard for the embedded shared prompts/rubrics/core across every route and platform, plus a Codex copied-shared-asset fidelity test.

### Changed

- PR/CODE unknown Markdown rule files under `rules/` now warn and continue instead of blocking — these routes expose no `strict|normal` token, so the normal policy applies. Symlinked or non-regular `.md` entries are still rejected, and `loadRouteRuleContext` now surfaces the warnings.
- The shared reviewer/coordinator/fixer prompts and `shared/core.md` are route-neutral (target document vs resolved file set), so PR/CODE reviews no longer inherit a document-first framing. Output schemas are unchanged.
- Code-route invocation text no longer describes a "bare project root" token; omitting `scope=` reviews the whole project root.

### Removed

- The recorded-dependency mechanism for PR/CODE auto-fix. The fixer write boundary is now exactly the resolved file set; an accepted issue that needs a file outside that set is reported `Not fixed` rather than edited.

## 0.5.0 - 2026-06-05

Archive passed/clean workflow state at finalization so a re-run starts fresh without `reset`.

### Added

- On `finalize`, a `pass` or `read-only-clean` run archives its target state directory to `.drfx/archived/<target-key>-<timestamp>` (renamed, never deleted) so the next run starts fresh without an explicit `reset`. Archiving is best-effort: if the rename fails, finalization still reports the terminal status plus an `archiveWarning` and a concrete delete/reset/retry next action, leaving the state directory in place.
- `resume` over a leftover live `pass`/`read-only-clean` manifest (a pre-upgrade leftover or an archive-failed finalize) archives it and starts a fresh review instead of re-reporting PASS or re-reviewing in place; if archiving fails it blocks with a repair next action. When the post-archive fresh start itself fails or throws, the result still carries `archivedStatePath` so callers learn the old state was already moved.
- Archive-root hardening: a symlinked or non-directory `.drfx/archived` is refused rather than followed.

### Changed

- Generated route output (Claude/Codex/Gemini) and the shared workflow docs document finalize-time archiving and the `archiveWarning` default-output contract. README/README.zh-CN note that `.drfx/archived/` is now populated by successful `pass`/`read-only-clean` finalization, not only by `reset`.

### Removed

- Dead `stalePass` resume field and the now-unreachable `validateResumeState` pass branch, plus the orphaned `evaluateResumeState`/`compareManifestTarget` helpers.

## 0.4.2 - 2026-06-05

Close a finalize gap in the generated PR/CODE coordinator loop: a clean initial review still requires a full re-review before PASS.

### Fixed

- Generated Claude/Codex route instructions now document that an initial `record-review` PASS is not terminal: the coordinator must run a full re-review before finalization. Previously only the post-`DIFF-OK` re-review path was documented, so a clean initial review with no fix round could attempt `finalize` and hit `ERR_FINAL_FULL_REVIEW_REQUIRED`. This matches the enforced state machine (`triageOutcome` → `full-re-review`; `validatePass` requires `requiredFullReReviewComplete` even with no fix round).

## 0.4.1 - 2026-06-04

File-set (PR/CODE) review-fix lifecycle hardening, agent/tool state exclusions, and a new `reset` token.

### Added

- `reset` token (PR/CODE/document routes): archives the existing target state to `.drfx/archived/<target-key>-<timestamp>` — never deleting it — and starts fresh under the current resolver policy. It is the explicit escape when stale state can no longer be resumed, and is mutually exclusive with `resume`.
- CODE review and snapshot monitoring now exclude local agent/tool state directories (`.claude`, `.codex`, `.codegraph`, `.gemini`, `.req-to-plan`) so their churn no longer destabilizes the file-set fingerprint.

### Changed

- `record-review` re-anchors the stored file-set identity to the validated reviewed set, so `begin-fix` and `finalize` compare against what was actually reviewed rather than the start-time snapshot. This removes spurious `unexpected-worktree-change` blocks after benign or policy drift.
- CODE resume tolerates additive default-exclusion drift when the file-set fingerprint is unchanged.

### Fixed

- `abort-fix` restores monitored files from the persisted baseline bodies instead of blocking as `rollback-unavailable`.
- A fix round blocked as `fix-report-mismatch` or `unexpected-worktree-change` can be retried through `begin-fix` without consuming a fix attempt.
- Workflow `--*-stdin` payload flags now read piped stdin; previously they always received empty input.

## 0.4.0 - 2026-06-04

Renamed to `@xenonbyte/drfx` and added code review routes. This is a breaking release; see Migration below.

### Added

- `review-fix-pr` route: review a `base..HEAD` pull request diff (local git only — never fetches).
- `review-fix-code` route: review a source scope or the whole project root.
- File-set review-and-fix workflow for PR/CODE routes: git or snapshot guards, a `rounds=<n>` repair limit, worktree-content identity, explicit/stale resume, and a no-COMMON 4-layer rule stack.
- CLI commands `drfx version`, `drfx status` (installed routes per platform), and `drfx help`.
- MIT `LICENSE`.

### Changed

- Renamed the package `@xenonbyte/document-review-fix` to `@xenonbyte/drfx`.
- Renamed the runtime state directory `~/.docs-review-fix` to `~/.drfx` and the ownership marker `.document-review-loop-owned` to `.drfx-owned`.
- Renamed `drfx check` to `drfx doctor`; the strict-verified proof is now `drfx doctor --platform <platform> --json`.
- Made `--platform` optional for `install` and `uninstall` (omit it to target all platforms).
- Restructured the English and Chinese READMEs into a usage-doc layout.

### Fixed

- `drfx status` no longer reports a corrupt or incomplete manifest as installed; it validates the manifest shape and reports an invalid manifest instead.

### Migration

Uninstall with the old `@xenonbyte/document-review-fix` package first, then `npm install -g @xenonbyte/drfx` and re-run `drfx install`. Old capability descriptors and `~/.docs-review-fix` / `.document-review-loop-owned` state are not recognized by the renamed runtime.

## 0.3.0 - 2026-05-31

### Added

- Manifest schema v2 records Codex skill directory tree metadata so uninstall can verify generated directory contents before removal.
- Snapshot guard monitoring now supports opaque file symlink entries and reports infrastructure directory exclusions through `monitorScope`.

### Fixed

- Uninstall now keeps user-modified generated files, retains a narrowed manifest for those files, and reports partial uninstall status.
- Snapshot guard now excludes common infrastructure directories unless the target or explicit references live inside them, while continuing to block unsupported directory symlinks.

### Internal

- Removed `test/` from the npm package whitelist and added package-content coverage.
- Added audit remediation docs and implementation plan updates for the 2026-05-31 review pass.

## 0.2.1 - 2026-05-31

### Added

- Review-and-fix convergence controls, including fix-attempt caps and stopped-no-progress outcomes.
- Fix-effectiveness checks, severity anchors, and re-review regression guidance for generated workflows.

### Fixed

- Rejected no-op subsequent fixes during multi-cycle review-and-fix runs.
- Scoped coverage wording to PASS Summary output.
- Preserved `guard=git` rollback behavior across multi-cycle review-and-fix flows.

### Internal

- Added and refined implementation plans for review-fix workflow quality improvements.

## 0.2.0 - 2026-05-27

### Added

- `guard=snapshot` opt-in route mode for non-git rollback/guard flows, including snapshot capture/restore and end-to-end workflow coverage.
- Bare-path invocation as the recommended form, for example `review-fix-spec docs/spec.md`.
- Simplified Chinese README at `docs/README.zh-CN.md`.

### Changed

- Split `lib/workflow.js` into `lib/workflow/*` modules while preserving existing public CLI behavior.
- Distinguished user-facing blocker wording for `rollback-unavailable`, `target-only-guard-unavailable`, and `unexpected-worktree-change`.
- Downgraded unknown `.md` custom rules to warnings in `normal` strictness (still blocking in `strict`).
- Shared Codex runtime-flag documentation through `shared/runtime-flags.md`.

### Fixed

- Propagated `guard=snapshot` through generated Claude, Codex, and Gemini workflow commands.
- Hardened snapshot guard restore and target-only checks against symlink parent replacement and cross-directory non-target edits.
- Removed package lifecycle hooks that hid tracked localized README files during `npm pack`.

### Internal

- Archived `design/DESIGN-v1.md` and `design/DESIGN-v2.md` to `design/archive/`.
- Compacted and refreshed `CONTINUITY.md` for 0.2.0 handoff state.
