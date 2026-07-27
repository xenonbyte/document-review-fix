'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicCopyFile } = require('./atomic-write');
const {
  explicitRouteInvocation,
  getRouteDescriptor,
  listDocumentRoutes,
  listRoutes
} = require('./routes');

const PACKAGE_NAME = '@xenonbyte/drfx';
const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const FRAGMENT_DIR = path.join(TEMPLATE_DIR, 'fragments');
const SHARED_DIR = path.join(ROOT, 'shared');
const CODEX_AGENTS_METADATA_PATH = path.join('agents', 'openai.yaml');
const CODEX_AGENTS_METADATA_SOURCE = path.join('templates', 'codex-openai.yaml');
const CODEX_SHARED_OWNERSHIP_MARKER = path.join('shared', '.drfx-owned');

// ROUTES is kept as a backwards-compatible export derived from the shared registry.
// It contains only the four document routes so existing consumers are unaffected.
const ROUTES = Object.freeze(
  Object.fromEntries(
    listDocumentRoutes().map((route) =>
      [route.routeName, Object.freeze({ routeName: route.routeName, documentType: route.documentType, rubric: route.rubric })]
    )
  )
);

const PLATFORM_TEMPLATES = Object.freeze({
  claude: 'claude-command.md.tmpl',
  codex: 'codex-skill.md.tmpl',
  gemini: 'gemini-command.toml.tmpl',
  opencode: 'opencode-command.md.tmpl'
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizePlatform(platform) {
  if (!Object.hasOwn(PLATFORM_TEMPLATES, platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
  return platform;
}

function routeFor(routeName) {
  // Delegate to the shared registry. All seven route kinds (document/pr/code/r2p) are
  // generatable; getRouteDescriptor throws ERR_ROUTE for completely unknown names.
  return getRouteDescriptor(routeName);
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return packageJson.version;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// Resolve the embedded/copied shared asset paths for a route descriptor.
// Document routes layer COMMON before their specific rubric. PR/CODE rubrics
// are self-contained route-kind rubrics and intentionally have no COMMON layer.
function sharedRelativePathsForRoute(route) {
  const paths = [
    path.join('shared', 'core.md'),
    path.join('shared', 'long-task.md')
  ];
  if (route.routeKind === 'document' || route.routeKind === 'r2p') paths.push(path.join('shared', 'rubrics', 'common.md'));
  if (route.rubric) paths.push(path.join('shared', 'rubrics', `${route.rubric}.md`));
  paths.push(
    path.join('shared', 'prompts', 'reviewer.md'),
    path.join('shared', 'prompts', 'fixer.md'),
    path.join('shared', 'prompts', 'coordinator.md')
  );
  return paths;
}

// Back-compat overload used by copySharedAssets({ documentType }): resolve by
// document type, then delegate to the descriptor-keyed resolver.
function sharedRelativePaths(documentType) {
  const route = listDocumentRoutes().find((candidate) => candidate.documentType === documentType);
  if (!route) fail('ERR_DOCUMENT_TYPE', `unsupported document type: ${documentType}`);
  return sharedRelativePathsForRoute(route);
}

function allSharedRelativePaths() {
  const paths = new Set();
  for (const route of listRoutes()) {
    for (const relativePath of sharedRelativePathsForRoute(route)) paths.add(relativePath);
  }
  return [...paths].sort();
}

function embeddedSharedContent(route) {
  return sharedRelativePathsForRoute(route)
    .map((relativePath) => {
      const content = embeddedSharedFileContent(relativePath, route).trimEnd();
      return `<!-- ${relativePath} -->\n\n${content}`;
    })
    .join('\n\n---\n\n');
}

function embeddedSharedFileContent(relativePath, route) {
  const content = readText(relativePath);
  if (route.routeKind !== 'r2p') return content;

  if (relativePath === path.join('shared', 'core.md')) {
    return content
      .replace(
        'Blocking reasons include `reviewer-mutated-file`, `lock-held`, `corrupt-lock`, `lock-release-failed`, `reviewer-output-unparseable`, `fingerprint-guard-unavailable`, `fingerprint-guard-output-invalid`, `state-validation-failed`, `state-token-too-large`, `final-validation-failed`, `target-only-guard-unavailable`, `unexpected-worktree-change`, `reference-mutated-file`, `fix-report-mismatch`, `diff-review-failed`, `rollback-unavailable`, and `unsafe-handoff-file`. Status reasons include `none`, `strict-proof-validation-failed`, `target-fingerprint-mismatch`, `manifest-fingerprint-mismatch`, `stale-fingerprint-mismatch`, `same-path-replacement-suspected`, `read-only-blocking-findings`, `deferred-findings`, `coverage-incomplete`, `no-progress-detected`, `unsupported-runtime-capability`, and `checkpoint-requested`.',
        'Blocking reasons include `reviewer-mutated-file`, `lock-held`, `corrupt-lock`, `lock-release-failed`, `reviewer-output-unparseable`, `fingerprint-guard-unavailable`, `fingerprint-guard-output-invalid`, `state-validation-failed`, `state-token-too-large`, `final-validation-failed`, `reference-mutated-file`, `fix-report-mismatch`, `diff-review-failed`, `unsafe-handoff-file`, `invalid-project-root`, `invalid-r2p-invocation`, `r2p-command-unavailable`, `r2p-json-contract-unavailable`, `r2p-run-status-unsupported`, `r2p-existing-route-open`, `r2p-repair-plan-ambiguous`, `r2p-direct-artifact-write-forbidden`, `r2p-workspace-not-found`, `unsafe-r2p-workspace`, `r2p-work-id-conflict`, `r2p-run-archived`, `r2p-run-not-found`, `unsafe-r2p-run-dir`, `r2p-artifact-missing-or-unsafe`, `r2p-drift-detected`, and `r2p-command-failed`. Status reasons include `none`, `strict-proof-validation-failed`, `target-fingerprint-mismatch`, `manifest-fingerprint-mismatch`, `stale-fingerprint-mismatch`, `same-path-replacement-suspected`, `read-only-blocking-findings`, `deferred-findings`, `coverage-incomplete`, `no-progress-detected`, `unsupported-runtime-capability`, and `checkpoint-requested`.'
      )
      .replace(
        'Blocker wording must distinguish guard failures: `rollback-unavailable` means the target lacks a clean rollback anchor, `target-only-guard-unavailable` means the target-only guard is unavailable or unparseable, and `unexpected-worktree-change` means non-target worktree changes make automatic fixing unsafe.',
        'For `review-fix-r2p`, blocker wording must stay in the workId/run-state/repair-command model. Describe blocker recovery in terms of the active run state, the allowlisted r2p commands, and direct-write prohibition; do not describe rollback anchors or target-only guards.'
      );
  }

  if (relativePath === path.join('shared', 'prompts', 'coordinator.md')) {
    return content.replace(
      '- For blockers, distinguish `rollback-unavailable` as a missing clean rollback anchor, `target-only-guard-unavailable` as unavailable target-only guard proof, and `unexpected-worktree-change` as unsafe non-target worktree changes.',
      '- For `review-fix-r2p` blockers, keep wording in the workId/run-state/repair-command model: name the active run state, the allowlisted `r2p-reopen` / `r2p-gap-open` repair boundary, or the direct-write prohibition; do not restate rollback-anchor or target-only-guard wording.'
    );
  }

  return content;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function codexCopiedSharedContent(route) {
  const requiredPaths = sharedRelativePathsForRoute(route).map(toPosix);
  return [
    'Codex copied shared source mode is active. The full shared prompt, rubric, and workflow text is intentionally not embedded inline in this `SKILL.md`.',
    '',
    'Before reading target/reference bodies, running probes, or invoking any `drfx workflow` command, resolve this skill directory offline and verify both ownership markers are present and readable:',
    '',
    '- `.drfx-owned`',
    '- `shared/.drfx-owned`',
    '',
    'Then read these required copied shared source files from this skill directory, in this order:',
    '',
    ...requiredPaths.map((relativePath) => `- \`${relativePath}\``),
    '',
    'If any ownership marker or required copied shared source file is missing, unreadable, outside this skill directory, or not a regular file, fail closed with a concise `Blocked:` result before workflow invocation.',
    '',
    'Do not silently fall back to package source files, `~/.drfx/shared`, runtime memory, chat history, network fetches, or stale copies. Debug output may include the verified copied-source artifact paths, but it must not print raw shared source bodies unless explicitly requested for diagnosis.'
  ].join('\n');
}

function embeddedSharedContentForPlatform(platform, route, options) {
  if (platform === 'codex' && options.codexSharedMode !== 'embedded') {
    return codexCopiedSharedContent(route);
  }
  return embeddedSharedContent(route);
}

function runtimePlatformFor(platform) {
  if (platform === 'claude') return 'claude-code';
  return platform;
}

// ---------------------------------------------------------------------------
// Route-varying placeholder content (PLAN-TASK-008)
//
// These helpers fill snapshot-tested generator placeholders that differ by
// route kind and platform.
// ---------------------------------------------------------------------------

// The leading target token used by every `drfx workflow` command and the
// usage prose. Document routes use `target=<path>`; PR/CODE override in Phase 3.
function targetTokenFor(route) {
  if (route.routeKind === 'pr') return 'base=<branch>';
  if (route.routeKind === 'code') return '<scopeTokens>';
  if (route.routeKind === 'r2p') return 'workId=<WF-...>';
  return 'target=<path>';
}

function workflowTargetTokenFor(route) {
  if (route.routeKind === 'r2p') return 'workId=<WF-...> <rootToken>';
  return targetTokenFor(route);
}

function workflowGuardTokenFor(route) {
  return route.routeKind === 'r2p' ? '' : ' guard=<selectedGuard>';
}

function readFragment(name) {
  return fs.readFileSync(path.join(FRAGMENT_DIR, name), 'utf8').replace(/\n$/, '');
}

// The Route Contract bullet body. Stored as verbatim fragment files keyed by
// route kind + platform so document output is byte-identical and code-route
// contract text lives in reviewable files rather than JS string literals.
function routeContractFor(platform, route) {
  const fragment = readFragment(`route-contract.${route.routeKind}.${platform}.md`);
  return renderTemplate(fragment, {
    ROUTE_NAME: route.routeName,
    DOCUMENT_TYPE: route.documentType,
    TARGET_TOKEN: targetTokenFor(route)
  });
}

function runtimeFlagsContent(platform, route) {
  const template = readText(path.join('shared', route.routeKind === 'r2p' ? 'runtime-flags.r2p.md' : 'runtime-flags.md'));
  return renderTemplate(template, {
    ROUTE_NAME: route.routeName,
    RUNTIME_PLATFORM: runtimePlatformFor(platform),
    TARGET_TOKEN: targetTokenFor(route),
    WORKFLOW_TARGET_TOKEN: workflowTargetTokenFor(route)
  });
}

function preflightAssuranceTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For r2p, this internal preflight command accepts materialized `--assurance practical` and `--assurance strict-verified` workflow values before runtime probes and strict proof because it does not create target state. The route must not accept or forward a user `assurance=` token; the Invocation Gate rejects it.';
  }
  return 'This command accepts `assurance=practical` and `assurance=strict-verified` before runtime probes and strict proof because it does not create target state. It returns `unsupported` for explicit `review-and-fix assurance=advisory`.';
}

function preflightBlockedOutputFor(platform, route) {
  if (route.routeKind === 'r2p') {
    // The blocked template is shown to the user, so it must echo the same explicit
    // invocation the Invocation Gate grammar teaches on this platform.
    const invocation = explicitRouteInvocation(route.routeName, platform, 'workId=<WF-...>');
    return [
      `Blocked: \`${invocation}\` cannot run repair commands from the current run state.`,
      '',
      'Next: rerun with `read-only` to inspect findings, or restore the active run so `r2p-reopen` or `r2p-gap-open` can run, then rerun `review-and-fix`.'
    ].join('\n');
  }
  return [
    'Blocked: <target> cannot be auto-fixed because it lacks a clean rollback anchor.',
    '',
    'Next: commit or restore the target, rerun with read-only, or use guard=snapshot when Git rollback is unavailable.'
  ].join('\n');
}

function preflightBlockerWordingFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For r2p preflight blockers, keep wording in the workId/run-state/repair-command model. Do not mention rollback anchors, target-only guards, or `guard=snapshot` recovery.';
  }
  return 'If the normalized blocking reason is `target-only-guard-unavailable`, render that the target-only guard is unavailable or unparseable and ask the user to restore guard inputs or rerun after guard data can be read. If it is `unexpected-worktree-change`, render that non-target worktree changes make automatic fixing unsafe and ask the user to commit, stash, or restore unrelated worktree changes before retrying.';
}

function runtimeProbeAssuranceTextFor(platform, route) {
  const probeKind = platform === 'codex' ? 'live reviewer subagent probe' : 'live reviewer subagent or Task-style reviewer probe';
  if (route.routeKind === 'r2p') {
    return `For materialized \`practical\` and \`strict-verified\` assurance, run a ${probeKind} before workflow start. The probe prompt must not read target/reference files and must not write files. It must require exactly this single output line:`;
  }
  return `For \`assurance=practical\` and \`assurance=strict-verified\`, run a ${probeKind} before workflow start. The probe prompt must not read target/reference files and must not write files. It must require exactly this single output line:`;
}

function advisoryProbeSkipTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'r2p exposes no advisory assurance token. A materialized read-only r2p flow uses the practical no-state path unless an internal strict-verified state-backed path is selected.';
  }
  return 'Explicit `assurance=advisory read-only` skips the subagent probe and passes `--runtime-subagent-probe not-required --runtime-downgrade-reason none`.';
}

function strictVerifiedIntroTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'Only the internal same-flow strict proof branch may use `strict-verified` for r2p. Do not accept a user `assurance=` token to request it. In that branch, run:';
  }
  return 'Only explicit `assurance=strict-verified` requests strict verified mode. In the same-flow route invocation, run:';
}

function strictVerifiedSelectedModeTextFor(platform, route) {
  const descriptorPath = `platforms.${platform}.descriptorPath`;
  if (route.routeKind === 'r2p') {
    return `Read the JSON object, then extract \`runId\`, \`descriptorDirectory\`, and \`${descriptorPath}\`. Let \`<selectedMode>\` be the effective mode from the Invocation Gate. In this strict verified branch, \`<selectedAssurance>\` is \`strict-verified\`. Materialize \`<stateControlToken>\` as \`reset\` only when the current invocation includes \`reset\`; otherwise omit it. Pass those current-run values to workflow start:`;
  }
  return `Read the JSON object, then extract \`runId\`, \`descriptorDirectory\`, and \`${descriptorPath}\`. Let \`<selectedMode>\` be the effective mode from the Invocation Gate, including defaults and advisory override. In this strict verified branch, \`<selectedAssurance>\` is \`strict-verified\`. Materialize \`<stateControlToken>\` as \`reset\` only when the current invocation includes \`reset\`; otherwise omit it. Pass those current-run values to workflow start:`;
}

function strictVerifiedReviewAndFixTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For an internal strict-verified `review-and-fix` r2p start, `<selectedMode>` must be `review-and-fix`; do not silently substitute `read-only`. After strict verified start succeeds, continue the persistent review-and-fix loop from the returned `targetStateDir`; the manifest carries the effective strict verified assurance.';
  }
  return 'For `review-and-fix assurance=strict-verified`, `<selectedMode>` must be `review-and-fix`; do not silently substitute `read-only`. After strict verified start succeeds, continue the persistent review-and-fix loop from the returned `targetStateDir`; the manifest carries the effective strict verified assurance.';
}

function persistentPracticalIntroTextFor(route) {
  if (route.routeKind === 'r2p') {
    return 'For the materialized practical path, after successful probes, start persistent state:';
  }
  return 'For `assurance=practical`, after successful probes, start persistent state:';
}

function persistentPracticalSummaryTextFor(route, defaultGuard) {
  if (route.routeKind === 'r2p') {
    return 'This persistent practical command is the materialized default path: `<selectedMode>` is `review-and-fix`, `<selectedAssurance>` is `practical`, and `<stateControlToken>` is `reset` only for explicit reset starts. The route exposes no `guard=` token; drift detection is internal and always on. If the internal strict-verified branch is selected, use the strict verified start command above with effective `<selectedMode>` set to `review-and-fix`.';
  }
  return `This persistent practical command is the materialized default path: \`<selectedMode>\` is \`review-and-fix\`, \`<selectedAssurance>\` is \`practical\`, \`<selectedGuard>\` is explicit guard or default \`${defaultGuard}\`, and \`<stateControlToken>\` is \`reset\` only for explicit reset starts. For \`assurance=strict-verified\`, use the strict verified start command above with effective \`<selectedMode>\` set to \`review-and-fix\`.`;
}

function roundsTokenFor(platform) {
  return platform === 'gemini' ? '' : ' rounds=<roundLimit>';
}

function stateControlTokenFor(platform) {
  return platform === 'gemini' ? '' : ' <stateControlToken>';
}

// The single-line invocation grammar shown in the Invocation Gate / Invocation
// section. Document routes keep their full token set; PR/CODE use their reduced
// grammar, and every route carries the platform's explicit invocation prefix.
function invocationGrammarFor(platform, route) {
  const name = explicitRouteInvocation(route.routeName, platform);
  if (route.routeKind === 'pr') {
    // Gemini PR routes are advisory read-only: their grammar must not advertise
    // review-and-fix, resume, or rounds (which the gate body / contract prohibit).
    if (platform === 'gemini') {
      return `${name} base=<branch> [read-only] [guard=git|snapshot] [root=<project-root>] [debug]`;
    }
    return `${name} base=<branch> [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (route.routeKind === 'code') {
    if (platform === 'gemini') {
      return `${name} [scope=<path>...] [read-only] [guard=git|snapshot] [root=<project-root>] [debug]`;
    }
    return `${name} [scope=<path>...] [read-only|review-and-fix] [guard=git|snapshot] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (route.routeKind === 'r2p') {
    // r2p reviews an active workId-backed run (07-plan.md anchor) and has a fixed
    // PLAN rubric: no target= path, ref=, strict/normal, assurance=, ledger=, or
    // guard= surface. Gemini is advisory read-only and does not advertise review-and-fix/rounds/resume.
    if (platform === 'gemini') {
      return `${name} workId=<WF-...> [read-only] [root=<project-root>] [debug]`;
    }
    return `${name} workId=<WF-...> [read-only|review-and-fix] [resume|reset] [rounds=<n>] [root=<project-root>] [debug]`;
  }
  if (platform === 'gemini') {
    // Gemini is advisory read-only; rounds=<n> loop semantics are unsupported in
    // read-only mode, so its grammar does not advertise the rounds token.
    return `${name} <path> [ref=<path>...] [read-only] [strict|normal] [assurance=advisory] [guard=git|snapshot] [root=<project-root>] [debug]`;
  }
  return `${name} <path> [ref=<path>...] [read-only|review-and-fix] [strict|normal] [assurance=practical|strict-verified|advisory] [guard=git|snapshot] [resume|reset] [rounds=<n>] [ledger=<target-local path>] [root=<project-root>] [debug]`;
}

// The Invocation Gate prose paragraphs after the grammar line. Document routes
// render their verbatim fragment (mode/assurance/strict semantics); PR/CODE
// render a reduced gate body in Phase 3.
function invocationGateBodyFor(platform, route) {
  const fragment = readFragment(`invocation-gate.${route.routeKind}.${platform}.md`);
  return renderTemplate(fragment, {
    ROUTE_NAME: route.routeName,
    ROUTE_INVOCATION: explicitRouteInvocation(route.routeName, platform),
    DOCUMENT_TYPE: route.documentType,
    TARGET_TOKEN: targetTokenFor(route)
  });
}

// Short human summary used in Gemini's description line. Document routes
// describe the document type; PR/CODE describe the review target.
function routeSummaryFor(route) {
  if (route.routeKind === 'pr') return 'PR diffs';
  if (route.routeKind === 'code') return 'source scopes';
  if (route.routeKind === 'r2p') return 'r2p requirement plans (07-plan.md)';
  return `${route.documentType} documents`;
}

// The Gemini [metadata] type line. Document routes keep `document_type`;
// PR/CODE record their review target kind instead.
function metadataTypeFor(route) {
  if (route.routeKind === 'pr') return 'review_target = "pr-diff"';
  if (route.routeKind === 'code') return 'review_target = "source-scope"';
  if (route.routeKind === 'r2p') return 'review_target = "r2p-requirement"';
  return `document_type = "${route.documentType}"`;
}

// PLAN-TASK-009 (Phase C3): route-aware wording for the few review-unit nouns that would
// otherwise leak a document-only frame ("full-document", "document review", "document
// bodies") into PR/CODE output. Document routes return the EXACT prior text so their golden
// shell snapshot stays byte-identical; PR/CODE get file-set wording.
function reviewUnitVerificationFor(route) {
  if (route.routeKind === 'pr') return 'Verification: full file-set read-only review completed.';
  if (route.routeKind === 'code') return 'Verification: full file-set read-only review completed.';
  return 'Verification: full-document read-only review completed.';
}

function reviewSemanticNounFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') return 'semantic file-set review';
  return 'semantic document review';
}

function reviewBodyNounFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') return 'file body text';
  return 'document bodies';
}

// The fix-loop write-boundary sentence in the persistent flow. Document routes keep
// the EXACT prior target-only wording; PR/CODE bound writes to the resolved file set
// so the route prose matches the fixer guard (resolved-set-only, no scope expansion).
function fixWriteBoundaryFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return 'Edit only files inside the resolved target file set directly by default; never expand the write scope beyond it.';
  }
  if (route.routeKind === 'r2p') {
    return 'Do not edit run artifacts directly. For r2p, accepted findings flow into owner-stage mapping and an r2p repair plan only.';
  }
  return 'Edit only the target directly by default.';
}

// The automatic-write guard requirement paragraph. Document routes keep the EXACT
// prior single-target guard wording; PR/CODE describe the file-set guard (clean
// whole-worktree git status before the first fix, or snapshot rollback anchor).
function guardWriteRequirementFor(route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return 'Automatic file-set writes require `review-and-fix` and a selected guard mode: use `guard=git` with a clean worktree before the first fix and route-owned changes that stay inside the resolved file set afterward, or `guard=snapshot` with a valid snapshot rollback anchor. The file-set guard must remain available and parseable before and after writes.';
  }
  if (route.routeKind === 'r2p') {
    return 'Direct artifact writes are forbidden for r2p. Do not materialize or pass `guard=`. The route still performs internal drift detection over `run.md` and `03-07` before repair commands, and it may repair only through `r2p-reopen` or `r2p-gap-open`.';
  }
  return 'Automatic target writes require `review-and-fix` and a selected guard mode: use `guard=git` with a tracked, clean, HEAD-backed git target, or `guard=snapshot` with a valid snapshot rollback anchor. The target-only guard must remain available and parseable before and after writes.';
}

function defaultGuardFor(route) {
  return route.routeKind === 'r2p' ? 'snapshot' : 'git';
}

// The header identity lines under the title. Document routes show the fixed
// `Document type:`; PR/CODE replace it with a route-kind line and no type.
function routeHeaderFor(route) {
  if (route.routeKind === 'pr') {
    return `Route name: ${route.routeName}\nReview target: PR diff (base..HEAD file set)`;
  }
  if (route.routeKind === 'code') {
    return `Route name: ${route.routeName}\nReview target: source scope file set`;
  }
  if (route.routeKind === 'r2p') {
    return `Route name: ${route.routeName}\nReview target: active r2p workId run (07-plan.md vs 03-06, no direct artifact writes)`;
  }
  return `Route name: ${route.routeName}\nDocument type: ${route.documentType}`;
}

function platformInvocationText(platform, route) {
  if (route.routeKind === 'pr' || route.routeKind === 'code') {
    return codeRouteInvocationText(platform, route);
  }
  if (route.routeKind === 'r2p') {
    return r2pInvocationText(platform, route);
  }
  if (platform === 'claude') {
    return [
      'Use this Claude Code command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume` or `reset`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, Claude Code selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  if (platform === 'codex') {
    return [
      'Use this Codex skill with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume` or `reset`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, Codex selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.',
      'Before any target read or workflow command, read the copied shared source files from this skill directory offline; if the skill or shared source ownership markers are missing, fail closed instead of falling back.'
    ].join('\n');
  }
  if (platform === 'gemini') {
    return [
      'Use this Gemini command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only`, optional `assurance=advisory`, optional `guard=git|snapshot`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode is omitted, Gemini selects `read-only`; when assurance is omitted, Gemini selects `advisory`.',
      'Gemini remains advisory-only: `review-and-fix` is unsupported, workflow PASS is unavailable, and Gemini must not edit target files.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  if (platform === 'opencode') {
    return [
      'Use this opencode command with a bare `<path>` target as the recommended form, or full `target=<path>`, optional repeated `ref=<path>`, `strict` or `normal`,',
      'optional `read-only` or `review-and-fix`, optional `assurance=practical|strict-verified|advisory`,',
      'optional `guard=git|snapshot`, optional `resume` or `reset`, optional `ledger=<target-local path>`, optional `root=<project-root>`, and optional `debug`.',
      'When a valid target is present and mode plus assurance are omitted, opencode selects `review-and-fix` and `practical`.',
      'Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets.',
      'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
      'Advisory read-only skips the subagent probe but still proves stdin handoff before semantic payload commands.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
}

// Top-of-route usage prose for the code routes (review-fix-pr / review-fix-code).
// Reduced grammar: no ref=, strict/normal, assurance=, or ledger=. Claude/Codex
// default omitted mode to review-and-fix and materialize practical internally;
// Gemini is advisory-only.
function codeRouteInvocationText(platform, route) {
  const token = route.routeKind === 'pr' ? 'base=<branch>' : 'scope=<path>';
  const tokenRequirement = route.routeKind === 'pr'
    ? `required \`${token}\``
    : 'optional `scope=<path>` tokens (repeat `scope=<path>` for multiple roots; omit scope to review the project root)';
  const wholeRootCapText = route.routeKind === 'code'
    ? 'A whole-root CODE review within the single-pass budget of 300 files or 1,500,000 bytes (counted after all exclusions) runs in one pass; a larger whole-root file set is reviewed as a partitioned project review (a deterministic, multi-phase, unit-by-unit review) instead of blocking — narrow with `scope=<path>` or ignore rules to keep it a single pass. Version-control-ignored files are excluded automatically via local read-only git queries (tracked files are never ignored; non-git roots skip this source). A project-root `.drfxignore` file adds user exclusions with `.gitignore` syntax (globs, `!` negation, `/` anchoring, trailing-`/` directory-only patterns). An explicit `scope=` always wins: a scoped directory or file is reviewed even when an ignore source covers it.'
    : null;
  if (platform === 'gemini') {
    return [
      `Use this Gemini command with ${tokenRequirement}, optional \`read-only\`, optional \`guard=git|snapshot\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
      wholeRootCapText,
      'This is a code route and is advisory-only on Gemini: `review-and-fix` is unsupported, workflow PASS is unavailable, Gemini must not edit files, and it must not claim workflow PASS.',
      'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, or `rounds=`.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].filter(Boolean).join('\n');
  }
  const surface = platform === 'codex'
    ? 'Codex skill'
    : platform === 'opencode'
      ? 'opencode command'
      : 'Claude Code command';
  const subject = platform === 'codex' ? 'Codex' : platform === 'opencode' ? 'opencode' : 'Claude Code';
  return [
    `Use this ${surface} with ${tokenRequirement}, optional \`read-only\` or \`review-and-fix\`, optional \`guard=git|snapshot\`, optional \`resume\` or \`reset\`, optional \`rounds=<n>\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
    wholeRootCapText,
    route.routeKind === 'pr'
      ? `When a valid ${token} is present and mode is omitted, ${subject} selects \`review-and-fix\`.`
      : `When mode is omitted, ${subject} selects \`review-and-fix\`.`,
    'This code route exposes no `assurance=` token; for `review-and-fix` it internally materializes `practical` assurance, so auto-fix is not rejected as `advisory-review-and-fix-unsupported`.',
    'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, or `ledger=`.',
    'The generated route must materialize effective mode, assurance, and guard before workflow calls; never pass omitted values through to `drfx workflow`.',
    'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
  ].filter(Boolean).join('\n');
}

// Top-of-route usage prose for review-fix-r2p. r2p reviews an r2p requirement
// directory (the 07-plan.md anchor) and fixes backward into the owning upstream
// docs (03–06); run.md is a read-only gate. Fixed PLAN rubric: no ref=, strict/
// normal, assurance=, or ledger= surface. Default guard is snapshot. Gemini is
// advisory-only.
function r2pInvocationText(platform, route) {
  const name = route.routeName;
  if (platform === 'gemini') {
    return [
      'Use this Gemini command with `workId=<WF-...>` naming an active r2p run (`<project>/.req-to-plan/WF-*`), optional `read-only`, optional `root=<project-root>`, and optional `debug`.',
      'A bare `WF-...` token is valid shorthand. Gemini is advisory-only: `review-and-fix` is unsupported, workflow PASS is unavailable, Gemini must not edit files, and it must not claim workflow PASS.',
      'This route reviews the `07-plan.md` anchor against `03-06`; `03-07` and `run.md` are read-only evidence. It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, `base=`, `guard=`, `resume`, `reset`, or `rounds=`.',
      'Before workflow calls, materialize `<rootToken>` as the original `root=<project-root>` token when supplied, otherwise omit it.',
      'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
    ].join('\n');
  }
  const surface = platform === 'codex'
    ? 'Codex skill'
    : platform === 'opencode'
      ? 'opencode command'
      : 'Claude Code command';
  const subject = platform === 'codex' ? 'Codex' : platform === 'opencode' ? 'opencode' : 'Claude Code';
  return [
    `Use this ${surface} with \`workId=<WF-...>\` naming an active r2p run (\`<project>/.req-to-plan/WF-*\`), optional \`read-only\` or \`review-and-fix\`, optional \`resume\` or \`reset\`, optional \`rounds=<n>\`, optional \`root=<project-root>\`, and optional \`debug\`.`,
    `A bare \`WF-...\` token is valid shorthand. When a valid \`workId=<WF-...>\` is present and mode is omitted, ${subject} selects \`review-and-fix\`.`,
    'This route reviews the `07-plan.md` anchor against `03-06`, but `03-07` and `run.md` remain read-only evidence. Repair means `r2p-reopen` or `r2p-gap-open` only, followed by `r2p-continue` and a rerun before PASS.',
    'This route has a fixed PLAN rubric and exposes no `assurance=` or `guard=` token; for `review-and-fix` it internally materializes `practical` assurance.',
    'It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, `base=`, or `guard=`.',
    'The generated route must materialize effective mode, assurance, and `<rootToken>` before workflow calls; `<rootToken>` is the original `root=<project-root>` token when supplied, otherwise omitted.',
    'Help-style or invalid invocations explain usage without reading files, running probes, creating state, or declaring review results.'
  ].join('\n');
}

function reviewAndFixFlowFor(platform, route) {
  const runtimePlatform = runtimePlatformFor(platform);
  const routeName = route.routeName;
  const targetToken = targetTokenFor(route);
  const workflowTargetToken = workflowTargetTokenFor(route);
  const guardToken = workflowGuardTokenFor(route);

  if (route.routeKind === 'r2p') {
    const explicitInvocation = explicitRouteInvocation(routeName, platform);
    return [
      'Then coordinate this loop:',
      '',
      `1. Run persistent context with \`drfx workflow context ${routeName} ${workflowTargetToken} review-and-fix --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json=compact\`.`,
      '2. Build the reviewer prompt in memory from the context manifest plus review-file reads. Do not write prompt text or run artifacts to disk.',
      `3. Spawn a read-only reviewer subagent and submit its exact output with \`drfx workflow record-review ${routeName} ${workflowTargetToken} review-and-fix --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --result-stdin --json=compact\`.`,
      '4. If `record-review` returns `PASS`, finalize through `drfx workflow finalize <targetStateDir> --final-response-stdin --json=compact`; PASS is allowed only when this rerun is clean and no repair command ran in the current round.',
      `5. If \`record-review\` returns \`FAIL\`, triage every finding semantically and submit the triage with \`drfx workflow record-triage ${routeName} ${workflowTargetToken} review-and-fix --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --triage-stdin --json=compact\`.`,
      '6. If accepted, reopened, or downgraded high/medium blocking issues remain, run `drfx workflow record-r2p-repair-plan <targetStateDir> --json=compact`.',
      '7. Apply the validated repair command with `drfx workflow apply-r2p-repair <targetStateDir> --json=compact`. Direct artifact writes are forbidden: do not run `begin-fix`, `refresh-lock`, `end-fix`, `abort-fix`, or `record-diff-review` for r2p.',
      `8. After \`apply-r2p-repair\`, stop at checkpoint. Tell the user to run \`r2p-continue\`, let r2p regenerate artifacts, then follow the returned next action: for \`r2p-reopen\`, rerun \`${explicitInvocation} workId=<new-WF-...> <rootToken>\`; for \`r2p-gap-open\`, rerun \`${explicitInvocation} workId=<same-WF-...> resume <rootToken>\`.`,
      `9. If triage leaves no accepted, reopened, or downgraded high/medium blocking issues after a reviewer \`FAIL\`, run full re-review context with \`drfx workflow context ${routeName} ${workflowTargetToken} review-and-fix --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase full-re-review --json=compact\`, then record the full re-review with \`drfx workflow record-review ${routeName} ${workflowTargetToken} review-and-fix --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase full-re-review --result-stdin --json=compact\`. Finalize only if that latest reviewer result is \`PASS\`.`
    ].join('\n');
  }

  const partitioned = partitionedReviewFlowFor(platform, route);
  return [
    partitioned,
    'Then coordinate this loop:',
    '',
    `1. Run persistent context with \`drfx workflow context ${routeName} ${targetToken} review-and-fix${guardToken} --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json=compact\`.`,
    `2. Build the reviewer prompt in memory from the context manifest plus target/reference reads. Do not write prompt text or ${reviewBodyNounFor(route)} to disk.`,
    `3. Spawn a read-only reviewer subagent and submit its exact output with \`drfx workflow record-review ${routeName} ${targetToken} review-and-fix${guardToken} --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --result-stdin --json=compact\`.`,
    `4. Triage every finding semantically and submit the triage with \`drfx workflow record-triage ${routeName} ${targetToken} review-and-fix${guardToken} --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --triage-stdin --json=compact\`.`,
    '5. For accepted or reopened blocking issues, run `drfx workflow begin-fix <targetStateDir> --json=compact`.',
    `6. ${fixWriteBoundaryFor(route)} Use a bounded serial fixer only when lock refresh rules can be satisfied and the issue list is scoped.`,
    '7. Run `drfx workflow refresh-lock <targetStateDir> --json=compact` before writes after 60 seconds, before a delegated fixer writes, and before ending a long fix.',
    '8. Submit a valid fix report with `drfx workflow end-fix <targetStateDir> --fix-report-stdin --json=compact`.',
    '9. If interruption, blocker, checkpoint, context pressure, or user stop happens before a valid fix report, run `drfx workflow abort-fix <targetStateDir> --status checkpoint --reason checkpoint-requested --next-action <redacted next action> --json=compact` or use `--status blocked` with an allowed blocking reason.',
    '10. Review the diff and submit with `drfx workflow record-diff-review <targetStateDir> --result-stdin --json=compact`.',
    `11. If initial \`record-review\` returns \`PASS\`, the workflow is not terminal yet: run full re-review using \`drfx workflow context ${routeName} ${targetToken} review-and-fix${guardToken} --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase full-re-review --json=compact\`, then record the full re-review with \`--phase full-re-review --result-stdin\` before finalization.`,
    `12. After \`DIFF-OK\`, run full re-review using \`drfx workflow context ${routeName} ${targetToken} review-and-fix${guardToken} --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase full-re-review --json=compact\`, then record the full re-review with \`--phase full-re-review --result-stdin\`.`,
    '13. Repeat triage, fix, diff review, and full re-review until terminal status (`pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, user stop, or `checkpoint`).',
    '14. Finalize only through `drfx workflow finalize <targetStateDir> --final-response-stdin --json=compact`.'
  ].join('\n');
}

function partitionedReviewFlowFor(platform, route) {
  if (route.routeKind !== 'code' || platform === 'gemini') return '';

  const runtimePlatform = runtimePlatformFor(platform);
  const routeName = route.routeName;
  const targetToken = targetTokenFor(route);

  return [
    '',
    '### Partitioned CODE Review Flow',
    '',
    'For `review-fix-code`, when workflow start or context reports `reviewMode: partitioned`, run this partitioned loop before the generic non-partitioned loop. Do not run `--phase initial-review` to claim a project PASS for a partitioned project review.',
    '',
    `1. Request the next bounded unit with \`drfx workflow context ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase unit-review --json=compact\`. Omit \`--unit\` for the resume cursor; add \`--unit <unitId>\` only when retrying a named unit.`,
    `2. For a normal unit, spawn a read-only reviewer over only that unit context and record both semantic payloads with \`drfx workflow record-review ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase unit-review --unit <unitId> --result-stdin --payload-file <safe-coverage-receipt-file> --json=compact\`. The reviewer findings and coverage receipt are both required; if the runtime cannot safely deliver the two payloads, fail closed before recording.`,
    '3. When a unit context carries a `chunk` block on a member, read exactly that member\'s `chunk.contextLineRange` slice from disk into the reviewer prompt in memory; never ask the reviewer to read the whole file and never persist the slice. Treat lines outside `chunk.primaryLineRange` as overlap context only, and report line-specific findings at `<path>:<line>`.',
    '4. If a unit context returns `oversize: true`, do not read the oversize file body and do not mark it clean. Record a FAIL reviewer result plus a coverage receipt with `Reviewed: false`, `Coverage risk: high`, and the skipped path/reason so aggregation remains coverage-incomplete.',
    `5. Repeat \`--phase unit-review\` until context returns \`status: all-units-reviewed\`, then request each required backstop with \`drfx workflow context ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase crosscutting --backstop <backstopId> --json=compact\`.`,
    `6. Record each backstop with \`drfx workflow record-review ${routeName} ${targetToken} review-and-fix guard=<selectedGuard> --assurance practical --runtime-platform ${runtimePlatform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase crosscutting --backstop <backstopId> --result-stdin --payload-file <safe-coverage-receipt-file> --json=compact\`. Omit \`--unit\` so the workflow spans every planned unit; a partial span must stay \`coverage_risk: high\`.`,
    '7. After all units and backstops are recorded, run `drfx workflow aggregate-review <targetStateDir> --json=compact`. Treat the aggregate verdict as authoritative: only `verdict: PASS` may proceed to clean finalization. If `reason: coverage-incomplete`, review the uncovered units/backstops and do not run `record-triage` or `begin-fix` for that aggregate-only deferral. If active mode is `read-only` and aggregate returns `stopped-with-deferrals` with a `reviewerReportPath`, run `record-triage` for the accepted findings so ledger issue ids exist, then finalize the read-only findings; do not run `begin-fix`. If active mode is `review-and-fix` and aggregate returns `stopped-with-deferrals` with a reviewer report path, record-triage the accepted findings and run `begin-fix`; after partitioned `end-fix` returns `reviewMode: partitioned`, do not run the generic `record-diff-review` step. Instead, return to step 1 so only the affected units and backstops are re-reviewed before re-aggregating.',
    ''
  ].join('\n');
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!Object.hasOwn(values, key)) fail('ERR_TEMPLATE_PLACEHOLDER', `unknown template placeholder: ${key}`);
    return values[key];
  });
}

function renderPlatformRoute(platform, routeName, options = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const route = routeFor(routeName);
  const packageVersion = options.packageVersion || readPackageVersion();
  const template = fs.readFileSync(path.join(TEMPLATE_DIR, PLATFORM_TEMPLATES[normalizedPlatform]), 'utf8');
  const values = {
    ROUTE_NAME: route.routeName,
    PACKAGE_VERSION: packageVersion,
    ROUTE_HEADER: routeHeaderFor(route),
    TARGET_TOKEN: targetTokenFor(route),
    WORKFLOW_TARGET_TOKEN: workflowTargetTokenFor(route),
    WORKFLOW_GUARD_TOKEN: workflowGuardTokenFor(route),
    INVOCATION_GRAMMAR: invocationGrammarFor(normalizedPlatform, route),
    ROUTE_CONTRACT: routeContractFor(normalizedPlatform, route),
    INVOCATION_GATE_BODY: invocationGateBodyFor(normalizedPlatform, route),
    ROUTE_SUMMARY: routeSummaryFor(route),
    METADATA_TYPE: metadataTypeFor(route),
    ROUNDS_TOKEN: roundsTokenFor(normalizedPlatform),
    STATE_CONTROL_TOKEN: stateControlTokenFor(normalizedPlatform),
    EMBEDDED_SHARED_CONTENT: embeddedSharedContentForPlatform(normalizedPlatform, route, options),
    PLATFORM_INVOCATION_TEXT: platformInvocationText(normalizedPlatform, route),
    RUNTIME_FLAGS: runtimeFlagsContent(normalizedPlatform, route),
    PREFLIGHT_ASSURANCE_TEXT: preflightAssuranceTextFor(route),
    PREFLIGHT_BLOCKED_OUTPUT: preflightBlockedOutputFor(normalizedPlatform, route),
    PREFLIGHT_BLOCKER_WORDING: preflightBlockerWordingFor(route),
    RUNTIME_PROBE_ASSURANCE_TEXT: runtimeProbeAssuranceTextFor(normalizedPlatform, route),
    ADVISORY_PROBE_SKIP_TEXT: advisoryProbeSkipTextFor(route),
    STRICT_VERIFIED_INTRO_TEXT: strictVerifiedIntroTextFor(route),
    STRICT_VERIFIED_SELECTED_MODE_TEXT: strictVerifiedSelectedModeTextFor(normalizedPlatform, route),
    STRICT_VERIFIED_REVIEW_AND_FIX_TEXT: strictVerifiedReviewAndFixTextFor(route),
    PERSISTENT_PRACTICAL_INTRO_TEXT: persistentPracticalIntroTextFor(route),
    PERSISTENT_PRACTICAL_SUMMARY_TEXT: persistentPracticalSummaryTextFor(route, defaultGuardFor(route)),
    REVIEW_UNIT_VERIFICATION: reviewUnitVerificationFor(route),
    REVIEW_SEMANTIC_NOUN: reviewSemanticNounFor(route),
    REVIEW_BODY_NOUN: reviewBodyNounFor(route),
    FIX_WRITE_BOUNDARY: fixWriteBoundaryFor(route),
    GUARD_WRITE_REQUIREMENT: guardWriteRequirementFor(route),
    DEFAULT_GUARD: defaultGuardFor(route),
    REVIEW_AND_FIX_FLOW: reviewAndFixFlowFor(normalizedPlatform, route)
  };
  return renderTemplate(template, values);
}

function generatedFile(relativePath, content, extra = {}) {
  return { kind: 'file', relativePath, content, ...extra };
}

function generateCodexSkill(route, packageVersion, options = {}) {
  const skillText = renderPlatformRoute('codex', route.routeName, {
    packageVersion,
    codexSharedMode: options.codexSharedMode
  });
  return {
    kind: 'directory',
    platform: 'codex',
    routeName: route.routeName,
    documentType: route.documentType,
    relativePath: path.join('skills', route.routeName),
    requiresOwnedSharedSource: options.codexSharedMode !== 'embedded',
    files: [
      generatedFile('SKILL.md', skillText),
      generatedFile(CODEX_AGENTS_METADATA_PATH, readText(CODEX_AGENTS_METADATA_SOURCE)),
      generatedFile('.drfx-owned', `${PACKAGE_NAME}\n`),
      generatedFile(CODEX_SHARED_OWNERSHIP_MARKER, `${PACKAGE_NAME}\n`),
      ...sharedRelativePathsForRoute(route).map((relativePath) =>
        generatedFile(relativePath, readText(relativePath), { sourcePath: relativePath })
      )
    ]
  };
}

function generatePlatformFiles(platform, options = {}) {
  const normalizedPlatform = normalizePlatform(platform);
  const packageVersion = options.packageVersion || readPackageVersion();
  // Emit all seven routes (four document routes, then pr, then code, then r2p).
  const routes = listRoutes();

  if (normalizedPlatform === 'codex') {
    return routes.map((route) => generateCodexSkill(route, packageVersion, options));
  }

  const extension = normalizedPlatform === 'gemini' ? 'toml' : 'md';
  return routes.map((route) =>
    generatedFile(
      path.join('commands', `${route.routeName}.${extension}`),
      renderPlatformRoute(normalizedPlatform, route.routeName, { packageVersion }),
      {
        platform: normalizedPlatform,
        routeName: route.routeName,
        documentType: route.documentType
      }
    )
  );
}

function copySharedAssets(destinationDir, options = {}) {
  const documentType = options.documentType || 'COMMON';
  const destinationRoot = path.resolve(destinationDir);
  const copied = [];

  const relativePaths = options.all ? allSharedRelativePaths() : sharedRelativePaths(documentType);
  for (const relativePath of relativePaths) {
    const sourcePath = path.join(ROOT, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    let stat = null;
    let action = 'created';
    try {
      stat = fs.lstatSync(destinationPath);
      if (!stat.isFile()) {
        fail('ERR_SHARED_ASSET_TARGET_KIND', `refusing to copy shared asset over non-file target: ${destinationPath}`);
      }
      action = 'overwritten';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (typeof options.onBeforeWrite === 'function') {
      options.onBeforeWrite({ relativePath, sourcePath, destinationPath, action, stat });
    }
    atomicCopyFile(sourcePath, destinationPath);
    copied.push({
      relativePath,
      sourcePath,
      path: destinationPath,
      action
    });
  }

  return copied;
}

module.exports = {
  ROUTES,
  renderPlatformRoute,
  generatePlatformFiles,
  allSharedRelativePaths,
  copySharedAssets
};
