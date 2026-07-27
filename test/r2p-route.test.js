'use strict';

// Contract suite for the workId-based review-fix-r2p route. It:
// 1. covers the gate 1-10 / redaction / drift cases explicitly;
// 2. provides a fake req-to-plan CLI harness that emits documented R2P_JSON payloads;
// 3. runs under `node --test test/r2p-route.test.js`.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getRouteDescriptor } = require('../lib/routes');
const { formatManifestV2, parseManifestV2, requiredManifestV2Keys } = require('../lib/workflow-state');
const { runWorkflowCommand, parseWorkflowArgs } = require('../lib/workflow');
const {
  resolveR2pCommands,
  probeJsonContract,
  readRunStatus,
  mapRepairMode,
  buildRepairPlan,
  statusMatchesCommandKind,
  driftGuard,
  runRepairCommand,
  writeReceipt
} = require('../lib/workflow/r2p-repair');
const { resolveRouteTargetMetadata } = require('../lib/workflow/target-resolution');
const { computeFileSetFingerprint } = require('../lib/target-context');

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#repair',
  '  issue: The plan depends on an upstream decision that is not owned by the current stage.',
  '  why_it_matters: The run cannot truthfully PASS until r2p regenerates the staged artifacts.',
  '  suggested_fix: Route the finding back to the owning stage through the r2p lifecycle.',
  '  confidence: confirmed',
  '  sensitive: false'
].join('\n');

const REVIEW_FAIL_WITH_OWNER_STAGE = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#repair',
  '  issue: The plan depends on an upstream design decision that is not yet settled.',
  '  why_it_matters: The run cannot truthfully PASS until r2p regenerates the staged artifacts.',
  '  suggested_fix: Reopen design so r2p can regenerate the downstream artifacts.',
  '  confidence: confirmed',
  '  sensitive: false',
  '  owner_stage: design',
  '  reason: Reopen design so r2p can regenerate the downstream artifacts.'
].join('\n');

const REVIEW_FAIL_WITH_SPEC_OWNER_STAGE = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#repair',
  '  issue: The plan depends on an upstream spec decision that is not yet settled.',
  '  why_it_matters: The run cannot truthfully PASS until r2p regenerates the staged artifacts.',
  '  suggested_fix: Rework the spec so r2p can regenerate the downstream artifacts.',
  '  confidence: confirmed',
  '  sensitive: false',
  '  owner_stage: spec',
  '  reason: Rework the spec so r2p can regenerate the downstream artifacts.'
].join('\n');

const REVIEW_FAIL_HIGH_DESIGN_LOW_REQUIREMENT = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: 07-plan.md#design',
  '  issue: The plan depends on an upstream design decision that is not yet settled.',
  '  why_it_matters: The run cannot truthfully PASS until r2p regenerates design-owned artifacts.',
  '  suggested_fix: Reopen design so r2p can regenerate the downstream artifacts.',
  '  confidence: confirmed',
  '  sensitive: false',
  '  owner_stage: design',
  '  reason: Reopen design for the high severity issue.',
  '- id: R002',
  '  severity: low',
  '  location: 07-plan.md#brief',
  '  issue: A minor requirement-brief clarification is accepted but does not block the repair loop.',
  '  why_it_matters: It should be tracked without changing the r2p repair stage.',
  '  suggested_fix: Clarify the requirement brief later.',
  '  confidence: confirmed',
  '  sensitive: false',
  '  owner_stage: requirement_brief',
  '  reason: Low severity issue must not drive r2p repair.'
].join('\n');

const TRIAGE_ACCEPT = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The finding is real and should drive an r2p repair command.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

const TRIAGE_ACCEPT_REASON_AND_REQUIRED_ACTION = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The finding is real and should drive an r2p repair command.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false',
  '  owner_stage: design',
  '  reason: Reopen design from triage reason, not the gap action.',
  '  required_action: Open a design gap route; this must not become the reopen reason.'
].join('\n');

const TRIAGE_ACCEPT_SECOND = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-002',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The repeated upstream gap remains real after the first repair.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

const TRIAGE_ACCEPT_MULTI = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The requirement brief gap is real and should route upstream.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false',
  '- reviewer_id: R002',
  '  issue_id: ISSUE-002',
  '  decision: accepted',
  '  severity: medium',
  '  original_severity: medium',
  '  rationale: The design-stage gap is also real and should aggregate into the same repair plan.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

const TRIAGE_ACCEPT_HIGH_AND_LOW_BLOCKING_FALSE = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The high design-stage finding is real and should drive repair.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false',
  '- reviewer_id: R002',
  '  issue_id: ISSUE-002',
  '  decision: accepted',
  '  severity: low',
  '  original_severity: low',
  '  rationale: The low requirement finding is accepted for tracking only.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

const REVIEW_PASS = 'PASS\nSummary: No blocking findings after r2p regeneration.\n';

const FINAL_PASS = [
  'Final status: pass',
  'Assurance: practical',
  'Runtime platform: codex',
  'Mode: review-and-fix',
  'Target: none',
  'Files changed: none',
  'Fixed issue IDs: none',
  'Verification performed: full re-review after r2p regeneration',
  'Deferrals or blockers: none',
  'Blocking reason: none',
  'Status reason: none',
  'Residual risk: none identified',
  'Redaction statement: no sensitive values persisted',
  'Coordinator agreement: approved after full re-review'
].join('\n');

const R2P_ARTIFACTS = [
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
];

function makeSandbox(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-route-')));
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-route-home-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { root, homeDir };
}

function makeRun(root, workId, options = {}) {
  const {
    underArchive = false,
    runMd = '# Requirement Run\n',
    artifactNames = R2P_ARTIFACTS
  } = options;
  const parent = underArchive
    ? path.join(root, '.req-to-plan', 'archive')
    : path.join(root, '.req-to-plan');
  const runDir = path.join(parent, workId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.md'), runMd);
  for (const artifact of artifactNames) {
    fs.writeFileSync(path.join(runDir, artifact), `# ${artifact}\ncontent for ${artifact}\n`);
  }
  return runDir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function installFakeR2pCli(root, scripts = {}) {
  const binDir = path.join(root, 'fake-r2p-bin');
  const logDir = path.join(root, 'fake-r2p-logs');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const defaults = {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-status.log')}"`,
      'if [ "${R2P_JSON:-}" != "1" ]; then',
      '  printf "status without json\\n"',
      '  exit 0',
      'fi',
      `workspace=${JSON.stringify(path.join(root, '.req-to-plan'))}`,
      'emitted=0',
      'for run_dir in "$workspace"/WF-*; do',
      '  [ -d "$run_dir" ] || continue',
      '  work_id=${run_dir##*/}',
      '  printf \'{"work_id":"%s","status":"closed_at_plan_checkpoint","current_stage":"plan","open_routes_detail":[]}\\n\' "$work_id"',
      '  emitted=1',
      'done',
      'if [ "$emitted" -eq 0 ]; then',
      '  printf "%s\\n" "[]"',
      'fi'
    ].join('\n'),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-reopen.log')}"`,
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-demo-r1' })}'`
    ].join('\n'),
    'r2p-gap-open': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-gap-open.log')}"`,
      `printf "%s\\n" '${JSON.stringify({
        route_id: 'ROUTE-001',
        staled_stages: ['design', 'spec', 'plan']
      })}'`
    ].join('\n'),
    'r2p-continue': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(logDir, 'r2p-continue.log')}"`,
      'printf "%s\\n" "{\\"ok\\":true}"'
    ].join('\n')
  };

  for (const command of ['r2p-status', 'r2p-reopen', 'r2p-gap-open', 'r2p-continue']) {
    writeExecutable(path.join(binDir, command), scripts[command] || defaults[command]);
  }

  return { binDir, logDir };
}

function statusScript(payload, options = {}) {
  const lines = ['#!/bin/sh', 'set -eu'];
  if (options.stderr) {
    lines.push(`printf "%s\\n" '${options.stderr}' 1>&2`);
  }
  lines.push(`printf "%s\\n" '${JSON.stringify(payload)}'`);
  return lines.join('\n');
}

function captureRunFingerprints(runDir) {
  const runMdSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(runDir, 'run.md'), 'utf8'))
    .digest('hex');
  return {
    runMdSha256,
    fileSetFingerprint: computeFileSetFingerprint(R2P_ARTIFACTS.map((artifact) => ({
      path: artifact,
      status: 'modified',
      contentId: crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(runDir, artifact), 'utf8'))
        .digest('hex')
    })))
  };
}

function runtimeArgs(routeTokens, overrides = {}) {
  const {
    assurance = 'practical',
    runtimePlatform = 'codex',
    subagent = 'ready',
    stdin = 'ready'
  } = overrides;
  return [
    ...routeTokens,
    '--assurance',
    assurance,
    '--runtime-platform',
    runtimePlatform,
    '--runtime-subagent-probe',
    subagent,
    '--runtime-stdin-handoff',
    stdin,
    '--json'
  ];
}

function workflowInvocation(workId, extraTokens = [], overrides = {}) {
  return runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix',
    ...extraTokens
  ], {
    runtimePlatform: overrides.runtimePlatform
  });
}

async function startFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'start',
    workflowInvocation(workId, extraTokens, overrides),
    {
      cwd: root,
      homeDir,
      env: overrides.env
    }
  );
}

async function contextFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'context',
    workflowInvocation(workId, extraTokens, overrides),
    {
      cwd: root,
      homeDir,
      env: overrides.env
    }
  );
}

async function recordReviewFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId, extraTokens, overrides),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: overrides.stdin || REVIEW_FAIL_WITH_OWNER_STAGE,
      env: overrides.env
    }
  );
}

async function recordReviewPassFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId, extraTokens, overrides),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_PASS,
      env: overrides.env
    }
  );
}

async function recordTriageFor(root, homeDir, workId, extraTokens = [], overrides = {}) {
  return runWorkflowCommand(
    'record-triage',
    [
      ...workflowInvocation(workId, extraTokens, overrides),
      '--triage-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: overrides.stdin || TRIAGE_ACCEPT,
      env: overrides.env
    }
  );
}

async function reachAcceptedRepairState(root, homeDir, workId, extraTokens = [], overrides = {}) {
  const start = await startFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(start.ok, true, JSON.stringify(start));

  const context = await contextFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(context.ok, true, JSON.stringify(context));

  const review = await recordReviewFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(review.ok, true, JSON.stringify(review));

  const triage = await recordTriageFor(root, homeDir, workId, extraTokens, overrides);
  assert.equal(triage.ok, true, JSON.stringify(triage));

  return { start, context, review, triage };
}

async function recordRepairPlanFor(root, homeDir, targetStateDir, overrides = {}) {
  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env: overrides.env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));
  return repairPlan;
}

test('descriptor fields expose r2p repair policy and no defaultGuard', () => {
  const descriptor = getRouteDescriptor('review-fix-r2p');
  assert.equal(descriptor.routeName, 'review-fix-r2p');
  assert.equal(descriptor.artifactWritePolicy, 'forbidden');
  assert.equal(descriptor.repairPolicy, 'r2p-lifecycle');
  assert.deepEqual(descriptor.repairCommands, ['r2p-reopen', 'r2p-gap-open']);
  assert.equal('defaultGuard' in descriptor, false);
});

test('gate1 invocation accept/reject incl. archive-bypass and flag-injection', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate1';
  makeRun(root, workId);

  const accepted = parseWorkflowArgs('start', workflowInvocation(workId));
  assert.equal(accepted.invocation.routeKind, 'r2p');
  assert.equal(accepted.invocation.workId, workId);

  const shorthand = parseWorkflowArgs('start', runtimeArgs([
    'review-fix-r2p',
    workId,
    'review-and-fix'
  ]));
  assert.equal(shorthand.invocation.workId, workId);

  for (const tokens of [
    ['review-fix-r2p', `target=.req-to-plan/${workId}`, 'review-and-fix'],
    ['review-fix-r2p', `.req-to-plan/${workId}`, 'review-and-fix'],
    ['review-fix-r2p', '07-plan.md', 'review-and-fix'],
    ['review-fix-r2p', `workId=archive/${workId}`, 'review-and-fix'],
    ['review-fix-r2p', `workId=../${workId}`, 'review-and-fix'],
    ['review-fix-r2p', 'workId=--from=WF-evil', 'review-and-fix'],
    ['review-fix-r2p', `workId=${workId}`, `workId=${workId}-dup`, 'review-and-fix'],
    ['review-fix-r2p', workId, `${workId}-dup`, 'review-and-fix'],
    ['review-fix-r2p', `workId=${workId}`, 'read-only', 'review-and-fix'],
    ['review-fix-r2p', `workId=${workId}`, 'resume', 'reset'],
    ['review-fix-r2p', `workId=${workId}`, 'rounds=2']
  ]) {
    const blocked = await runWorkflowCommand('start', runtimeArgs(tokens), { cwd: root, homeDir });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockingReason, 'invalid-r2p-invocation');
    assert.equal(
      blocked.nextAction,
      'rerun explicitly as $review-fix-r2p workId=<WF-...> on Codex or /review-fix-r2p workId=<WF-...> on other platforms'
    );
  }

  const missingRoot = path.join(root, 'missing-project-root');
  const missingRootWithoutCommands = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    `root=${missingRoot}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), { cwd: root, homeDir, env: { ...process.env, PATH: '' } });
  assert.equal(missingRootWithoutCommands.ok, false);
  assert.equal(missingRootWithoutCommands.status, 'blocked');
  assert.equal(missingRootWithoutCommands.blockingReason, 'r2p-command-unavailable');
  assert.match(missingRootWithoutCommands.nextAction, /install req-2-plan/);

  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const missingRootStart = await runWorkflowCommand('start', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    `root=${missingRoot}`,
    'review-and-fix'
  ]), { cwd: root, homeDir, env });
  assert.equal(missingRootStart.ok, false);
  assert.equal(missingRootStart.status, 'blocked');
  assert.equal(missingRootStart.blockingReason, 'invalid-project-root');
  assert.equal(missingRootStart.nextAction, 'rerun with root=<project-root> that exists as a real directory');
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);

  const missingRootPreflight = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    `root=${missingRoot}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), { cwd: root, homeDir, env });
  assert.equal(missingRootPreflight.ok, false);
  assert.equal(missingRootPreflight.status, 'blocked');
  assert.equal(missingRootPreflight.blockingReason, 'invalid-project-root');
  assert.equal(missingRootPreflight.nextAction, 'rerun with root=<project-root> that exists as a real directory');

  const symlinkRoot = path.join(root, 'project-root-symlink');
  fs.symlinkSync(root, symlinkRoot, 'dir');
  const symlinkRootPreflight = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    `root=${symlinkRoot}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), { cwd: root, homeDir, env });
  assert.equal(symlinkRootPreflight.ok, false);
  assert.equal(symlinkRootPreflight.status, 'blocked');
  assert.equal(symlinkRootPreflight.blockingReason, 'invalid-project-root');
  assert.equal(symlinkRootPreflight.nextAction, 'rerun with root=<project-root> that exists as a real directory');
});

test('gate2 command-env + R2P_JSON probe', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate2';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      'printf "not-json\\n"'
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const blocked = await startFor(root, homeDir, workId, [], { env });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockingReason, 'r2p-json-contract-unavailable');
  assert.match(blocked.nextAction, /R2P_JSON=1 emits valid JSON/);
  assert.doesNotMatch(blocked.nextAction, /install req-2-plan/);

  const explicitPreflight = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(explicitPreflight.ok, false);
  assert.equal(explicitPreflight.blockingReason, 'r2p-json-contract-unavailable');
  assert.match(explicitPreflight.nextAction, /R2P_JSON=1 emits valid JSON/);
  assert.doesNotMatch(explicitPreflight.nextAction, /install req-2-plan/);

  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan'
  }));
  const missingContract = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missingContract.ok, false);
  assert.equal(missingContract.blockingReason, 'r2p-json-contract-unavailable');
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);

  fs.rmSync(path.join(fake.binDir, 'r2p-gap-open'));
  const missing = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missing.ok, false);
  assert.equal(missing.blockingReason, 'r2p-command-unavailable');

  const missingExplicitPreflight = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(missingExplicitPreflight.ok, false);
  assert.equal(missingExplicitPreflight.blockingReason, 'r2p-command-unavailable');
});

test('gate2 preflight blocks when r2p-status omits requested workId', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate2-status-missing';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript([{
      work_id: 'WF-20260627-sibling',
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }])
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const preflight = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: root,
    homeDir,
    env
  });

  assert.equal(preflight.ok, false, JSON.stringify(preflight));
  assert.equal(preflight.status, 'blocked');
  assert.equal(preflight.blockingReason, 'r2p-run-not-found');
  assert.equal(preflight.errorCode, 'ERR_R2P_STATUS_NOT_FOUND');
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});

test('gate2 record-review blocks when r2p-status omits requested workId after context', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-record-review-status-missing';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));

  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript([{
    work_id: 'WF-20260627-sibling',
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }]));

  const review = await recordReviewPassFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, false, JSON.stringify(review));
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'r2p-run-not-found');
  assert.equal(review.errorCode, 'ERR_R2P_STATUS_NOT_FOUND');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'reports', 'reviewer-round-001.md')), false);
});

test('gate2 record-triage blocks when r2p-status omits requested workId after review', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-record-triage-status-missing';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true, JSON.stringify(review));

  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript([{
    work_id: 'WF-20260627-sibling',
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }]));

  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, false, JSON.stringify(triage));
  assert.equal(triage.status, 'blocked');
  assert.equal(triage.blockingReason, 'r2p-run-not-found');
  assert.equal(triage.errorCode, 'ERR_R2P_STATUS_NOT_FOUND');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'reports', 'triage-round-001.md')), false);
});

test('gate2 treats missing work_id as status JSON contract failure before artifacts', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate2-status-contract';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const contract = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(contract.ok, false, JSON.stringify(contract));
  assert.equal(contract.status, 'blocked');
  assert.equal(contract.blockingReason, 'r2p-json-contract-unavailable');
  assert.equal(contract.errorCode, 'ERR_R2P_JSON_CONTRACT_UNAVAILABLE');

  fs.rmSync(path.join(runDir, '06-spec.md'));
  const missingArtifactWithBrokenContract = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missingArtifactWithBrokenContract.ok, false, JSON.stringify(missingArtifactWithBrokenContract));
  assert.equal(missingArtifactWithBrokenContract.blockingReason, 'r2p-json-contract-unavailable');
  assert.notEqual(missingArtifactWithBrokenContract.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(fs.existsSync(path.join(root, '.drfx')), false);
});

test('gate2 root override drives r2p-status JSON probe cwd', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate2-root';
  makeRun(root, workId);
  const probeCwdLog = path.join(root, 'probe-cwd.log');
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      'current="$(pwd)"',
      `printf "%s\\n" "$current" >> "${probeCwdLog}"`,
      `if [ "$current" != "${root}" ]; then`,
      '  printf "not-json\\n"',
      '  exit 0',
      'fi',
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'closed_at_plan_checkpoint',
        current_stage: 'plan',
        open_routes_detail: []
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const preflight = await runWorkflowCommand('preflight', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    `root=${root}`,
    'review-and-fix'
  ], {
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: homeDir,
    homeDir,
    env
  });

  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  assert.equal(preflight.status, 'write-eligible');
  assert.deepEqual(fs.readFileSync(probeCwdLog, 'utf8').trim().split('\n'), [root]);
});

test('gate3 workspace preflight', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate3';
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const missingWorkspace = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missingWorkspace.ok, false);
  assert.equal(missingWorkspace.blockingReason, 'r2p-workspace-not-found');

  fs.mkdirSync(path.join(root, '.req-to-plan'), { recursive: true });
  const missingRunPreflight = await runWorkflowCommand(
    'preflight',
    runtimeArgs([
      'review-fix-r2p',
      `workId=${workId}`,
      'review-and-fix'
    ], {
      subagent: 'not-required',
      stdin: 'not-required'
    }),
    {
      cwd: root,
      homeDir,
      env
    }
  );
  assert.equal(missingRunPreflight.ok, false, JSON.stringify(missingRunPreflight));
  assert.equal(missingRunPreflight.blockingReason, 'r2p-run-not-found');
  assert.equal(missingRunPreflight.errorCode, 'ERR_R2P_WORK_ID_MISSING');
  fs.rmSync(path.join(root, '.req-to-plan'), { recursive: true, force: true });

  makeRun(root, workId, { underArchive: true });
  const archiveOnly = await startFor(root, homeDir, workId, [], { env });
  assert.equal(archiveOnly.ok, false);
  assert.equal(archiveOnly.blockingReason, 'r2p-run-archived');

  fs.rmSync(path.join(root, '.req-to-plan'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'real-workspace'), { recursive: true });
  fs.symlinkSync(path.join(root, 'real-workspace'), path.join(root, '.req-to-plan'));
  const symlinkWorkspace = await startFor(root, homeDir, workId, [], { env });
  assert.equal(symlinkWorkspace.ok, false);
  assert.equal(symlinkWorkspace.blockingReason, 'unsafe-r2p-workspace');

  fs.rmSync(path.join(root, '.req-to-plan'), { recursive: true, force: true });
  makeRun(root, workId, { underArchive: true });
  makeRun(root, workId);
  const conflict = await startFor(root, homeDir, workId, [], { env });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.blockingReason, 'r2p-work-id-conflict');
});

test('gate4 artifact preflight', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate4';
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const runDir = makeRun(root, workId);

  fs.rmSync(path.join(runDir, '06-spec.md'));
  const missingArtifact = await startFor(root, homeDir, workId, [], { env });
  assert.equal(missingArtifact.ok, false);
  assert.equal(missingArtifact.blockingReason, 'r2p-artifact-missing-or-unsafe');

  fs.writeFileSync(path.join(runDir, '06-spec.md'), '# 06-spec.md\nrestored\n');
  fs.rmSync(path.join(runDir, 'run.md'));
  fs.symlinkSync(path.join(runDir, '07-plan.md'), path.join(runDir, 'run.md'));
  const symlinkArtifact = await startFor(root, homeDir, workId, [], { env });
  assert.equal(symlinkArtifact.ok, false);
  assert.equal(symlinkArtifact.blockingReason, 'r2p-artifact-missing-or-unsafe');
});

test('gate4 stable target key stays content-independent for the same workId', async (t) => {
  const { root } = makeSandbox(t);
  const workId = 'WF-20260627-stable-key';
  const otherWorkId = 'WF-20260627-stable-key-r1';
  const runDir = makeRun(root, workId);
  makeRun(root, otherWorkId);

  const parsed = parseWorkflowArgs('start', workflowInvocation(workId));
  const first = resolveRouteTargetMetadata(parsed, { cwd: root, rootCwd: root });
  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\nregenerated content\n');
  const second = resolveRouteTargetMetadata(parsed, { cwd: root, rootCwd: root });

  assert.equal(first.targetKey, second.targetKey);

  const otherParsed = parseWorkflowArgs('start', workflowInvocation(otherWorkId));
  const other = resolveRouteTargetMetadata(otherParsed, { cwd: root, rootCwd: root });
  assert.notEqual(first.targetKey, other.targetKey);
});

test('gate4 manifest round-trips r2p workId review-set fields without retired editable-set keys', () => {
  const manifest = {
    manifestSchema: 2,
    targetContextKind: 'r2p',
    target: 'none',
    normalizedTarget: 'none',
    documentType: 'none',
    strictness: 'normal',
    mode: 'review-and-fix',
    guardMode: 'git',
    targetKey: 'r2p-aaaaaaaaaaaa',
    ledgerPath: 'none',
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
    fixAttemptCount: 0,
    assurance: 'practical',
    runtimePlatform: 'codex',
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimeSubagentProbe: 'ready',
    runtimeSubagentProbeEvidence: 'route-asserted-ready',
    runtimeFingerprintGuard: 'not-run',
    runtimeStdinHandoff: 'ready',
    runtimeStdinHandoffEvidence: 'route-asserted-ready',
    runtimeDowngradeReason: 'none',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'none',
    lastTriageReportPath: 'none',
    lastFixReportPath: 'none',
    lastDiffReviewReportPath: 'none',
    workId: 'WF-20260627-manifest',
    runMdSha256: 'a'.repeat(64),
    reviewSetFingerprint: 'b'.repeat(64),
    lastModifiedAt: '2026-06-28T00:00:00.000Z',
    references: [],
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z'
  };

  const text = formatManifestV2(manifest);
  assert.match(text, /Work id: WF-20260627-manifest/);
  assert.match(text, /Review set fingerprint: b{64}/);
  assert.doesNotMatch(text, /^Requirement dir:/m);
  assert.doesNotMatch(text, /^File set fingerprint:/m);

  const parsed = parseManifestV2(text);
  assert.equal(parsed.workId, manifest.workId);
  assert.equal(parsed.runMdSha256, manifest.runMdSha256);
  assert.equal(parsed.reviewSetFingerprint, manifest.reviewSetFingerprint);
  assert.ok(requiredManifestV2Keys('r2p').includes('workId'));
  assert.ok(requiredManifestV2Keys('r2p').includes('reviewSetFingerprint'));
  assert.ok(!requiredManifestV2Keys('r2p').includes('requirementDir'));
  assert.ok(!requiredManifestV2Keys('r2p').includes('fileSetFingerprint'));
  assert.equal(formatManifestV2(parsed), text);
});

test('gate5 no-direct-write both directions (drfx fails; r2p-authored change allowed)', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-reopen.log')}"`,
      `printf "%s\\n" "r2p-side-effect" >> "${path.join(runDir, '07-plan.md')}"`,
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-gate5-r1' })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));

  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true);
  assert.equal(context.contextPackSkeleton.runLocation, `.req-to-plan/${workId}`);
  assert.deepEqual(context.contextPackSkeleton.reviewFiles, [
    '03-requirement-brief.md',
    '04-risk-discovery.md',
    '05-design.md',
    '06-spec.md',
    '07-plan.md'
  ]);
  assert.equal(context.contextPackSkeleton.editableFiles.length, 0);
  assert.equal(context.contextPackSkeleton.directArtifactWrites, 'forbidden');
  assert.equal(context.contextPackSkeleton.repairMode.command_kind, 'r2p-reopen');

  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true);
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true);

  const beginFix = await runWorkflowCommand('begin-fix', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.blockingReason, 'r2p-direct-artifact-write-forbidden');

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));

  const originalPlan = fs.readFileSync(path.join(runDir, '07-plan.md'), 'utf8');
  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\ndrifted after triage\n');
  const driftedApply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(driftedApply.ok, false, JSON.stringify(driftedApply));
  assert.equal(driftedApply.blockingReason, 'r2p-drift-detected');
  fs.writeFileSync(path.join(runDir, '07-plan.md'), originalPlan);
});

test('gate5 apply-r2p-repair blocks missing or unsafe artifacts before r2p command', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-artifact-drift';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  fs.rmSync(path.join(runDir, '06-spec.md'));
  const missing = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(missing.ok, false, JSON.stringify(missing));
  assert.equal(missing.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), false);

  const restoredSpec = path.join(runDir, '06-spec-real.md');
  fs.writeFileSync(restoredSpec, '# 06-spec.md\ncontent for 06-spec.md\n');
  fs.symlinkSync(restoredSpec, path.join(runDir, '06-spec.md'));
  const unsafe = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(unsafe.ok, false, JSON.stringify(unsafe));
  assert.equal(unsafe.blockingReason, 'r2p-artifact-missing-or-unsafe');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), false);
});

test('gate5 apply-r2p-repair reserves receipt before mutating r2p command', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-receipt-reserve';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-reopen.log')}"`,
      `printf "%s\\n" "r2p-side-effect" >> "${path.join(runDir, '07-plan.md')}"`,
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-gate5-receipt-reserve-r1' })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { start, triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  const roundsDir = path.join(start.targetStateDir, 'rounds');
  const unsafeReceiptDir = path.join(root, 'unsafe-receipts');
  fs.rmSync(roundsDir, { recursive: true, force: true });
  fs.mkdirSync(unsafeReceiptDir, { recursive: true });
  fs.symlinkSync(unsafeReceiptDir, roundsDir);

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'state-validation-failed');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(runDir, '07-plan.md'), 'utf8'), /r2p-side-effect/);

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'state-validation-failed');
});

test('gate5 apply-r2p-repair records failed r2p command in reserved receipt', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-receipt-failure';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-reopen.log')}"`,
      'printf "%s\\n" "failed stdout before exit"',
      'printf "%s\\n" "failed stderr before exit" 1>&2',
      'exit 7'
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { start, triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'r2p-command-failed');
  assert.equal(typeof apply.receiptPath, 'string');

  const receipt = fs.readFileSync(apply.receiptPath, 'utf8');
  assert.match(receipt, /- Status: blocked/);
  assert.match(receipt, /- Blocking reason: r2p-command-failed/);
  assert.match(receipt, /Command: r2p-reopen/);
  assert.match(receipt, /Exit code: 7/);
  assert.match(receipt, /Stdout: failed stdout before exit/);
  assert.match(receipt, /Stderr: failed stderr before exit/);
  assert.doesNotMatch(receipt, /receipt reserved before mutating r2p command/);

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.blockingReason, 'r2p-command-failed');

  writeExecutable(path.join(fake.binDir, 'r2p-reopen'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-reopen.log')}"`,
    `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-gate5-receipt-failure-r1' })}'`
  ].join('\n'));
  const retry = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.status, 'checkpoint');
  assert.equal(retry.newWorkId, 'WF-20260627-gate5-receipt-failure-r1');
  assert.match(retry.nextAction, /r2p-continue/);

  const sameRoundFinal = await runWorkflowCommand('finalize', [triage.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.equal(sameRoundFinal.statusReason, 'r2p-repair-applied');
  assert.equal(sameRoundFinal.nextAction, retry.nextAction);
  assert.doesNotMatch(sameRoundFinal.nextAction, /repair the r2p command failure/);

  const reopenedLog = fs.readFileSync(path.join(fake.logDir, 'r2p-reopen.log'), 'utf8').trim().split('\n');
  assert.equal(reopenedLog.length, 2);
});

test('gate5 r2p-authored change after apply-r2p-repair is allowed', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-apply';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-reopen.log')}"`,
      `printf "%s\\n" "r2p-side-effect" >> "${path.join(runDir, '07-plan.md')}"`,
      `printf "%s\\n" '${JSON.stringify({ new_work_id: 'WF-20260627-gate5-apply-r1' })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });
  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.match(fs.readFileSync(path.join(runDir, '07-plan.md'), 'utf8'), /r2p-side-effect/);
});

test('gate5 retry apply-r2p-repair does not rerun fixed ledger issues', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-no-duplicate-apply';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  const firstApply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(firstApply.ok, true, JSON.stringify(firstApply));

  const reopenLogPath = path.join(fake.logDir, 'r2p-reopen.log');
  const firstLog = fs.readFileSync(reopenLogPath, 'utf8');
  assert.equal(firstLog.trim().split('\n').length, 1);

  const retry = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(retry.ok, false, JSON.stringify(retry));
  assert.equal(retry.blockingReason, 'state-validation-failed');
  assert.equal(retry.errorCode, 'ERR_R2P_REPAIR_PHASE_REQUIRED');
  assert.equal(fs.readFileSync(reopenLogPath, 'utf8'), firstLog);
});

test('gate5 run.md refreshed before review becomes apply-r2p-repair baseline', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-runmd-refresh';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  fs.appendFileSync(path.join(runDir, 'run.md'), '\nr2p refreshed run metadata before review\n');

  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true, JSON.stringify(triage));
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  const manifestBeforeApply = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(
    manifestBeforeApply.runMdSha256,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(runDir, 'run.md'))).digest('hex')
  );

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
});

test('gate5 status drift after recorded repair plan blocks before r2p command', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-unsupported';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { start, triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'unknown_terminal_state',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'r2p-drift-detected');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), false);

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.blockingReason, 'none');
});

test('gate5 apply-r2p-repair rejects live command drift from recorded plan', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-command-drift';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  const repairPlan = await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });
  assert.equal(repairPlan.repairPlan.command_kind, 'r2p-reopen');

  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'active_stage_draft',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'r2p-drift-detected');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), false);
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-gap-open.log')), false);
});

test('gate5 r2p-gap-open live status guard rejects next_stage', () => {
  assert.equal(statusMatchesCommandKind('r2p-gap-open', 'active_stage_draft'), true);
  assert.equal(statusMatchesCommandKind('r2p-gap-open', 'next_stage'), false);
  assert.equal(statusMatchesCommandKind('r2p-gap-open', 'closed_at_plan_checkpoint'), false);
});

test('gate5 apply-r2p-repair rejects accepted finding drift from recorded plan', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate5-finding-drift';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  const ledgerPath = path.join(triage.targetStateDir, 'ISSUES.md');
  fs.writeFileSync(
    ledgerPath,
    fs.readFileSync(ledgerPath, 'utf8').replace('| ISSUE-001 | high | accepted |', '| ISSUE-001 | high | fixed |')
  );

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'r2p-drift-detected');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), false);
});

test('gate6 repair exec argv shell:false; capture new_work_id/route_id; checkpoint, no PASS', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate6-reopen';
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(root, 'fake-r2p-logs', 'r2p-status.log')}"`,
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'closed_at_plan_checkpoint',
        current_stage: 'plan',
        open_routes_detail: []
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  makeRun(root, workId);
  const paths = resolveR2pCommands({ env, homeDir });
  await probeJsonContract(paths, { cwd: root, env, homeDir });
  const reopenStatus = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const reopenFindings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', reason: 'Need upstream design repair.' }
  ];
  const reopenMode = mapRepairMode(reopenStatus, reopenStatus.currentStage, reopenFindings);
  const reopenPlan = buildRepairPlan(reopenFindings, reopenMode, reopenStatus.currentStage, { workId });
  assert.equal(reopenPlan.command_kind, 'r2p-reopen');

  const apply = await runRepairCommand(paths, reopenPlan, { cwd: root, env, homeDir });
  assert.equal(apply.status, 'checkpoint');
  assert.equal(apply.statusReason, 'r2p-repair-applied');
  assert.equal(apply.newWorkId, 'WF-20260627-demo-r1');
  assert.match(apply.nextAction, /r2p-continue/);

  const reopenLog = fs.readFileSync(path.join(fake.logDir, 'r2p-reopen.log'), 'utf8');
  assert.match(reopenLog, /r2p-reopen/);
  assert.match(reopenLog, /R2P_JSON=1/);
  assert.match(reopenLog, new RegExp(`--from ${workId}`));

  const gapWorkId = 'WF-20260627-gate6-gap-open';
  makeRun(root, gapWorkId);
  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" "$0|$*|R2P_JSON=\${R2P_JSON:-}" >> "${path.join(fake.logDir, 'r2p-status.log')}"`,
      `printf "%s\\n" '${JSON.stringify([{
        work_id: gapWorkId,
        status: 'active_stage_draft',
        current_stage: 'plan',
        open_routes_detail: []
    }])}'`
  ].join('\n'));
  const gapStatus = await readRunStatus(paths, gapWorkId, { cwd: root, env, homeDir });
  const gapFindings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', required_action: 'Clarify design constraints.' }
  ];
  const gapMode = mapRepairMode(gapStatus, gapStatus.currentStage, gapFindings);
  const gapPlan = buildRepairPlan(gapFindings, gapMode, gapStatus.currentStage, { workId: gapWorkId });
  assert.equal(gapPlan.command_kind, 'r2p-gap-open');

  const gapApply = await runRepairCommand(paths, gapPlan, { cwd: root, env, homeDir });
  assert.equal(gapApply.status, 'checkpoint');
  assert.equal(gapApply.statusReason, 'r2p-repair-applied');
  assert.equal(gapApply.routeId, 'ROUTE-001');
  assert.match(gapApply.nextAction, new RegExp(`review-fix-r2p workId=${gapWorkId}`));
  assert.match(gapApply.nextAction, /\bresume\b/);
  assert.match(gapApply.nextAction, /r2p-continue/);

  const gapOpenLog = fs.readFileSync(path.join(fake.logDir, 'r2p-gap-open.log'), 'utf8');
  assert.match(gapOpenLog, /r2p-gap-open/);
  assert.match(gapOpenLog, /R2P_JSON=1/);
  assert.match(gapOpenLog, new RegExp(`--work-id ${gapWorkId}`));
  assert.match(gapOpenLog, /--confirm/);
});

test('r2p apply, receipt fallback, and finalize fallback preserve persisted runtime invocation syntax', async (t) => {
  for (const runtimePlatform of ['codex', 'claude-code']) {
    const { root, homeDir } = makeSandbox(t);
    const workId = `WF-20260627-explicit-${runtimePlatform}`;
    makeRun(root, workId);
    const fake = installFakeR2pCli(root, {
      'r2p-status': statusScript({
        work_id: workId,
        status: 'closed_at_plan_checkpoint',
        current_stage: 'plan',
        open_routes_detail: []
      })
    });
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
    const routeInvocation = runtimePlatform === 'codex'
      ? '$review-fix-r2p'
      : '/review-fix-r2p';
    const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], {
      env,
      runtimePlatform
    });
    const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
    assert.equal(manifest.runtimePlatform, runtimePlatform);

    const fallbackReceipt = writeReceipt({
      projectRoot: root,
      targetKey: start.targetKey,
      round: 1,
      kind: 'r2p-repair-fallback',
      status: 'checkpoint',
      statusReason: 'none',
      command: 'r2p-reopen',
      argv: [],
      exitCode: 0,
      stdout: 'none',
      stderr: '',
      workId,
      issueIds: [],
      runtimePlatform
    });
    assert.ok(
      fs.readFileSync(fallbackReceipt.receiptPath, 'utf8')
        .includes(`run r2p-continue and rerun ${routeInvocation}`)
    );

    await recordRepairPlanFor(root, homeDir, start.targetStateDir, { env });
    const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
      cwd: root,
      homeDir,
      env
    });
    assert.equal(apply.ok, true, JSON.stringify(apply));
    assert.ok(apply.nextAction.includes(`then rerun ${routeInvocation} workId=`));
    assert.equal(apply.nextAction.includes('then rerun review-fix-r2p'), false);
    assert.ok(
      fs.readFileSync(apply.receiptPath, 'utf8')
        .includes(`then rerun ${routeInvocation} workId=`)
    );

    fs.rmSync(apply.receiptPath);
    const sameRoundFinal = await runWorkflowCommand(
      'finalize',
      [start.targetStateDir, '--final-response-stdin', '--json'],
      {
        cwd: root,
        homeDir,
        stdin: FINAL_PASS,
        env
      }
    );
    assert.equal(sameRoundFinal.statusReason, 'r2p-repair-applied');
    assert.ok(sameRoundFinal.nextAction.includes(`then rerun ${routeInvocation}`));
    assert.equal(sameRoundFinal.nextAction.includes('then rerun review-fix-r2p'), false);
  }
});

test('gate7 rerun-PASS only after clean re-review', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7';
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  makeRun(root, workId);

  const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));

  const maliciousFinalizeBody = [
    '# Round 001 R2p-repair Receipt',
    '',
    '- Round: 1',
    '- Kind: r2p-repair',
    '- Status: checkpoint',
    `- Target: workId=${workId}`,
    '',
    '## Summary',
    `New work ID: ${apply.newWorkId || workId}`,
    '',
    '## Next Action',
    'run MALICIOUS finalize next action',
    ''
  ].join('\n');
  const maliciousFinalizeTarget = path.join(root, 'malicious-finalize-receipt.md');
  fs.writeFileSync(maliciousFinalizeTarget, maliciousFinalizeBody);
  fs.symlinkSync(
    maliciousFinalizeTarget,
    path.join(start.targetStateDir, 'rounds', '001-aaa-malicious.md')
  );

  const sameRoundFinal = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.notEqual(sameRoundFinal.status, 'pass');
  assert.equal(sameRoundFinal.statusReason, 'r2p-repair-applied');
  assert.notEqual(sameRoundFinal.nextAction, 'run MALICIOUS finalize next action');
  assert.notEqual(sameRoundFinal.nextAction, 'run apply-r2p-repair');
  assert.equal(sameRoundFinal.nextAction, apply.nextAction);

  const rerunWorkId = apply.newWorkId || workId;
  assert.ok(apply.receiptId, 'expected apply-r2p-repair to expose a stable receipt id');
  const rogueTargetDir = path.join(root, '.drfx', 'targets', 'rogue-target');
  const rogueRoundsDir = path.join(rogueTargetDir, 'rounds');
  fs.mkdirSync(rogueRoundsDir, { recursive: true });
  const maliciousLinkBody = [
    '# Round 001 R2p-repair Receipt',
    '',
    '- Round: 1',
    '- Kind: r2p-repair',
    '- Status: checkpoint',
    '- Target: workId=WF-malicious-prior',
    '',
    '## Summary',
    `New work ID: ${rerunWorkId}`,
    '',
    '## Next Action',
    'run MALICIOUS reopen linkage',
    ''
  ].join('\n');
  const maliciousLinkTarget = path.join(root, 'malicious-link-receipt.md');
  fs.writeFileSync(maliciousLinkTarget, maliciousLinkBody);
  fs.symlinkSync(maliciousLinkTarget, path.join(rogueRoundsDir, '001-r2p-repair.md'));
  makeRun(root, rerunWorkId);
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: rerunWorkId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const rerunStart = await startFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunStart.ok, true, JSON.stringify(rerunStart));
  if (rerunWorkId !== workId) {
    assert.equal(rerunStart.priorWorkId, workId);
    assert.equal(rerunStart.priorReceiptId, apply.receiptId);
    assert.equal(fs.existsSync(rerunStart.linkageReceiptPath), true);
  }

  const rerunContext = await contextFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunContext.ok, true, JSON.stringify(rerunContext));

  const rerunReview = await recordReviewPassFor(root, homeDir, rerunWorkId, [], { env });
  assert.equal(rerunReview.ok, true, JSON.stringify(rerunReview));

  const rerunFinal = await runWorkflowCommand('finalize', [rerunStart.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.equal(rerunFinal.ok, true, JSON.stringify(rerunFinal));
  assert.equal(rerunFinal.status, 'pass');
});

test('gate7 resume keeps same-workId r2p repair receipts across regenerated artifacts', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7-gap-open';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'active_stage_draft',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_FAIL_WITH_OWNER_STAGE,
      env
    }
  );
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true, JSON.stringify(triage));
  await recordRepairPlanFor(root, homeDir, start.targetStateDir, { env });
  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.match(
    fs.readFileSync(path.join(start.targetStateDir, 'ISSUES.md'), 'utf8'),
    /\| ISSUE-001 \| high \| fixed \|/
  );
  const receiptDir = path.join(start.targetStateDir, 'rounds');
  const beforeResumeReceipts = fs.readdirSync(receiptDir).filter((entry) => /r2p-repair/.test(entry));
  assert.ok(beforeResumeReceipts.length > 0);

  fs.appendFileSync(path.join(root, '.req-to-plan', workId, '07-plan.md'), '\nregenerated by r2p\n');
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const resumed = await startFor(root, homeDir, workId, ['resume'], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.statusReason, 'r2p-repair-applied');
  assert.equal(resumed.targetStateDir, start.targetStateDir);
  const afterResumeReceipts = fs.readdirSync(receiptDir).filter((entry) => /r2p-repair/.test(entry));
  assert.deepEqual(afterResumeReceipts, beforeResumeReceipts);

  const refreshedContext = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(refreshedContext.ok, true, JSON.stringify(refreshedContext));
  const cleanReview = await recordReviewPassFor(root, homeDir, workId, [], { env });
  assert.equal(cleanReview.ok, true, JSON.stringify(cleanReview));
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

test('same-workId r2p repair counts against rounds limit after resume', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-r2p-round-limit';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'active_stage_draft',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const { start } = await reachAcceptedRepairState(root, homeDir, workId, ['rounds=1'], { env });
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).roundLimit, '1');
  await recordRepairPlanFor(root, homeDir, start.targetStateDir, { env });
  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.routeId, 'ROUTE-001');
  assert.match(apply.nextAction, /\bresume\b/);
  assert.match(apply.nextAction, /\brounds=1\b/);

  const afterApply = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(Number(afterApply.fixAttemptCount), 1);
  assert.equal(afterApply.status, 'checkpoint');

  fs.appendFileSync(path.join(root, '.req-to-plan', workId, '07-plan.md'), '\nregenerated by r2p\n');
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const resumed = await startFor(root, homeDir, workId, ['resume', 'rounds=1'], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const refreshedContext = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(refreshedContext.ok, true, JSON.stringify(refreshedContext));
  const secondReview = await recordReviewFor(root, homeDir, workId, [], {
    env,
    stdin: REVIEW_FAIL_WITH_OWNER_STAGE
  });
  assert.equal(secondReview.ok, true, JSON.stringify(secondReview));
  const secondTriage = await recordTriageFor(root, homeDir, workId, [], {
    env,
    stdin: TRIAGE_ACCEPT_SECOND
  });
  assert.equal(secondTriage.ok, true, JSON.stringify(secondTriage));

  const afterSecondTriage = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(Number(afterSecondTriage.fixAttemptCount), 1);
  assert.equal(afterSecondTriage.status, 'stopped-with-deferrals');
  assert.equal(afterSecondTriage.statusReason, 'round-limit');

  const reopenLogPath = path.join(fake.logDir, 'r2p-reopen.log');
  const gapLogPath = path.join(fake.logDir, 'r2p-gap-open.log');
  const beforeReopenLog = fs.existsSync(reopenLogPath) ? fs.readFileSync(reopenLogPath, 'utf8') : null;
  const beforeGapLog = fs.existsSync(gapLogPath) ? fs.readFileSync(gapLogPath, 'utf8') : null;
  const stoppedApply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(stoppedApply.ok, false, JSON.stringify(stoppedApply));
  assert.equal(stoppedApply.blockingReason, 'state-validation-failed');
  assert.equal(stoppedApply.errorCode, 'ERR_R2P_REPAIR_PHASE_REQUIRED');
  assert.match(stoppedApply.message, /Status: fix and Current phase: fix/);
  assert.equal(fs.existsSync(reopenLogPath) ? fs.readFileSync(reopenLogPath, 'utf8') : null, beforeReopenLog);
  assert.equal(fs.existsSync(gapLogPath) ? fs.readFileSync(gapLogPath, 'utf8') : null, beforeGapLog);

  const afterStoppedApply = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(afterStoppedApply.status, 'stopped-with-deferrals');
  assert.equal(afterStoppedApply.statusReason, 'round-limit');
});

test('r2p resume at fix phase points to the repair plan, never begin-fix', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-resume-fix-phase';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  // Triage accepting a blocking finding leaves r2p at Status: fix / phase: fix.
  const { start } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  const atFix = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(atFix.status, 'fix');
  assert.equal(atFix.currentPhase, 'fix');

  // begin-fix is forbidden for r2p, so resume must route to the lifecycle repair.
  const resumed = await startFor(root, homeDir, workId, ['resume'], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'fix');
  assert.match(resumed.nextAction, /record-r2p-repair-plan/);
  assert.doesNotMatch(resumed.nextAction, /begin-fix/);
});

test('r2p resume refuses changed roundLimit identity', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-r2p-round-limit-identity';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));

  const resumed = await startFor(root, homeDir, workId, ['resume', 'rounds=1'], { env });
  assert.equal(resumed.ok, false, JSON.stringify(resumed));
  assert.equal(resumed.blockingReason, 'state-validation-failed');
  assert.equal(resumed.errorCode, 'ERR_FILE_SET_STALE_IDENTITY');
  assert.deepEqual(resumed.staleIdentityFields, ['roundLimit']);
});

test('gate7 resume refreshes when only run.md drifted after r2p repair', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7-runmd-only';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'active_stage_draft',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_FAIL_WITH_OWNER_STAGE,
      env
    }
  );
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true, JSON.stringify(triage));
  await recordRepairPlanFor(root, homeDir, start.targetStateDir, { env });
  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));

  const manifestBeforeResume = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  const reviewSetBeforeResume = manifestBeforeResume.reviewSetFingerprint;

  fs.appendFileSync(path.join(root, '.req-to-plan', workId, 'run.md'), '\nregenerated run metadata\n');
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const resumed = await startFor(root, homeDir, workId, ['resume'], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.statusReason, 'r2p-repair-applied');

  const manifestAfterResume = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifestAfterResume.reviewSetFingerprint, reviewSetBeforeResume);
  assert.equal(
    manifestAfterResume.runMdSha256,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, '.req-to-plan', workId, 'run.md'))).digest('hex')
  );
});

test('gate7 Gemini remains advisory-only and never enters persistent PASS flow', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate7-gemini';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root);
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await runWorkflowCommand('start', runtimeArgs([
    'review-fix-r2p',
    `workId=${workId}`,
    'review-and-fix'
  ], {
    assurance: 'advisory',
    runtimePlatform: 'gemini',
    subagent: 'not-required',
    stdin: 'not-required'
  }), {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(start.status, 'unsupported');
  assert.equal(start.targetStateDir, undefined);
});

test('gate8 status-contract parses multiple owner stages; missing contract blocks', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate8';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'checkpoint_review',
        current_stage: 'plan',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'clarify design' },
          { route_id: 'ROUTE-002', owner_stage: 'spec', required_action: 'tighten spec' }
        ]
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  assert.deepEqual(status.openRouteOwnerStages, ['design', 'spec']);
  // With routes already open, r2p refuses gap-open; the contract still parses the
  // owner stages, but the repair maps to the existing-route blocker, not a command.
  const mode = mapRepairMode(status, status.currentStage, [
    { issue_id: 'ISSUE-001', owner_stage: 'design', required_action: 'Clarify design.' }
  ]);
  assert.equal(mode.kind, 'blocked');
  assert.equal(mode.blockingReason, 'r2p-existing-route-open');

  writeExecutable(path.join(fake.binDir, 'r2p-status'), '#!/bin/sh\nset -eu\nprintf "oops\\n"\n');
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      current_stage: 'plan',
      open_routes_detail: []
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'bogus',
      open_routes_detail: []
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan'
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan',
      open_routes_detail: {}
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan',
      open_routes_detail: [
        { route_id: 'ROUTE-003', owner_stage: 'bogus', required_action: 'bad owner stage' }
      ]
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([{
      work_id: workId,
      status: 'checkpoint_review',
      current_stage: 'plan',
      open_routes_detail: [
        { route_id: 'ROUTE-004', required_action: 'missing owner stage' }
      ]
    }])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );

  writeExecutable(path.join(fake.binDir, 'r2p-status'), [
    '#!/bin/sh',
    'set -eu',
    `printf "%s\\n" '${JSON.stringify([])}'`
  ].join('\n'));
  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-run-not-found'
  );
});

test('gate8 readRunStatus fails closed when a workId appears more than once', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate8-dup';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript([
      { work_id: workId, status: 'closed_at_plan_checkpoint', current_stage: 'plan', open_routes_detail: [] },
      { work_id: workId, status: 'executing', current_stage: 'closed', open_routes_detail: [] }
    ])
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });

  await assert.rejects(
    () => readRunStatus(paths, workId, { cwd: root, env, homeDir }),
    (error) => error && error.blockingReason === 'r2p-json-contract-unavailable'
  );
});

// Real `r2p-status --all` prints one pretty-printed JSON object PER run, back to
// back (NOT a single array), and a closed/executing run reports
// current_stage:"closed" (r2p Stage.CLOSED). Verified against the installed
// @xenonbyte/req-2-plan v0.7.3. This fake reproduces that exact shape.
function concatenatedStatusScript(payloads) {
  const body = payloads.map((payload) => JSON.stringify(payload, null, 2)).join('\n');
  return ['#!/bin/sh', 'set -eu', `cat <<'R2P_EOF'\n${body}\nR2P_EOF`].join('\n');
}

test('gate8 readRunStatus parses concatenated multi-run --all with a closed current_stage', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-multi-closed';
  const fake = installFakeR2pCli(root, {
    'r2p-status': concatenatedStatusScript([
      { work_id: 'WF-20260627-sibling', status: 'archived', current_stage: 'closed', open_routes_detail: [] },
      { work_id: workId, status: 'closed_at_plan_checkpoint', current_stage: 'closed', open_routes_detail: [] }
    ])
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });

  // Before the fix: JSON.parse of concatenated objects threw, and ensureContractStage
  // rejected "closed" -> r2p-json-contract-unavailable. Now both parse cleanly.
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  assert.equal(status.status, 'closed_at_plan_checkpoint');
  assert.equal(status.currentStage, 'closed');

  const mode = mapRepairMode(status, status.currentStage, [{ owner_stage: 'design', issue_id: 'ISSUE-001' }]);
  assert.equal(mode.kind, 'command');
  assert.equal(mode.command_kind, 'r2p-reopen');
});

test('gate6 closed_at_plan_checkpoint run (current_stage=closed) reopens end to end', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-closed-stage-reopen';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': concatenatedStatusScript([
      { work_id: workId, status: 'closed_at_plan_checkpoint', current_stage: 'closed', open_routes_detail: [] }
    ])
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const { triage } = await reachAcceptedRepairState(root, homeDir, workId, [], { env });
  await recordRepairPlanFor(root, homeDir, triage.targetStateDir, { env });

  const apply = await runWorkflowCommand('apply-r2p-repair', [triage.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, true, JSON.stringify(apply));
  assert.equal(apply.status, 'checkpoint');
  assert.equal(apply.statusReason, 'r2p-repair-applied');
  assert.ok(apply.newWorkId, 'reopen must capture new_work_id even when current_stage is "closed"');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-reopen.log')), true);
});

test('gate9 current-stage checkpoint', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate9';
  const roundTokens = ['rounds=2'];
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify({
        work_id: workId,
        status: 'open',
        current_stage: 'spec',
        open_routes_detail: [
          { route_id: 'ROUTE-001', owner_stage: 'spec', required_action: 'tighten spec wording' }
        ]
      })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(start.ok, true);
  const context = await contextFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId, roundTokens),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_FAIL_WITH_SPEC_OWNER_STAGE,
      env
    }
  );
  assert.equal(review.ok, true);
  const triage = await recordTriageFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(triage.ok, true);

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true);
  assert.equal(repairPlan.status, 'checkpoint');
  assert.equal(repairPlan.statusReason, 'r2p-current-stage-repair-required');
  assert.match(repairPlan.nextAction, new RegExp(`workId=${workId}`));
  assert.match(repairPlan.nextAction, /\brounds=2\b/);
  assert.match(repairPlan.nextAction, /\bresume\b/);

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'checkpoint');
  assert.equal(manifest.currentPhase, 'final');
  assert.equal(manifest.statusReason, 'r2p-current-stage-repair-required');

  fs.appendFileSync(path.join(root, '.req-to-plan', workId, 'run.md'), '\ncurrent-stage repair metadata\n');
  fs.appendFileSync(path.join(root, '.req-to-plan', workId, '06-spec.md'), '\ncurrent-stage repair output\n');
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const resumed = await startFor(root, homeDir, workId, ['resume', ...roundTokens], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.statusReason, 'r2p-current-stage-repair-required');
  assert.equal(resumed.targetStateDir, start.targetStateDir);

  const refreshed = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(refreshed.status, 'review');
  assert.equal(refreshed.currentPhase, 'review');
  assert.equal(refreshed.statusReason, 'r2p-current-stage-repair-required');
  assert.notEqual(refreshed.runMdSha256, manifest.runMdSha256);
  assert.notEqual(refreshed.reviewSetFingerprint, manifest.reviewSetFingerprint);
  assert.match(
    fs.readFileSync(path.join(start.targetStateDir, 'ISSUES.md'), 'utf8'),
    /\| ISSUE-001 \| high \| fixed \|/
  );

  const refreshedContext = await contextFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(refreshedContext.ok, true, JSON.stringify(refreshedContext));
  const cleanReview = await recordReviewPassFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(cleanReview.ok, true, JSON.stringify(cleanReview));
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

test('gate9 resume marks only high/medium blocking issues fixed, low stays accepted', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate9-low';
  const roundTokens = ['rounds=2'];
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'open',
      current_stage: 'design',
      open_routes_detail: [
        { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'reopen design' }
      ]
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await recordReviewFor(root, homeDir, workId, roundTokens, {
    env,
    stdin: REVIEW_FAIL_HIGH_DESIGN_LOW_REQUIREMENT
  });
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, roundTokens, {
    env,
    stdin: TRIAGE_ACCEPT_HIGH_AND_LOW_BLOCKING_FALSE
  });
  assert.equal(triage.ok, true, JSON.stringify(triage));

  // Only the high design finding drives the current-stage checkpoint; the low
  // requirement-brief finding is tracked but never enters the repair plan.
  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));
  assert.equal(repairPlan.status, 'checkpoint');
  assert.equal(repairPlan.statusReason, 'r2p-current-stage-repair-required');

  fs.appendFileSync(path.join(root, '.req-to-plan', workId, 'run.md'), '\ncurrent-stage repair metadata\n');
  fs.appendFileSync(path.join(root, '.req-to-plan', workId, '05-design.md'), '\ncurrent-stage repair output\n');
  writeExecutable(path.join(fake.binDir, 'r2p-status'), statusScript({
    work_id: workId,
    status: 'closed_at_plan_checkpoint',
    current_stage: 'plan',
    open_routes_detail: []
  }));

  const resumed = await startFor(root, homeDir, workId, ['resume', ...roundTokens], { env });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.status, 'review');
  assert.equal(resumed.statusReason, 'r2p-current-stage-repair-required');

  const ledgerText = fs.readFileSync(path.join(start.targetStateDir, 'ISSUES.md'), 'utf8');
  assert.match(ledgerText, /\| ISSUE-001 \| high \| fixed \|/);
  assert.match(ledgerText, /\| ISSUE-002 \| low \| accepted \|/);

  // A leftover accepted low issue does not block PASS (high/medium-only gate).
  const refreshedContext = await contextFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(refreshedContext.ok, true, JSON.stringify(refreshedContext));
  const cleanReview = await recordReviewPassFor(root, homeDir, workId, roundTokens, { env });
  assert.equal(cleanReview.ok, true, JSON.stringify(cleanReview));
  const final = await runWorkflowCommand('finalize', [start.targetStateDir, '--final-response-stdin', '--json'], {
    cwd: root,
    homeDir,
    stdin: FINAL_PASS,
    env
  });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

test('gate10 earliest-stage aggregation + r2p-repair-plan-ambiguous', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate10';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': [
      '#!/bin/sh',
      'set -eu',
      `printf "%s\\n" '${JSON.stringify([{
        work_id: workId,
        status: 'open',
        current_stage: 'plan',
        open_routes_detail: []
      }])}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'requirement_brief', required_action: 'Clarify scope.' },
    { issue_id: 'ISSUE-002', owner_stage: 'design', required_action: 'Tighten architecture.' }
  ];
  const mode = mapRepairMode(status, status.currentStage, findings);
  const aggregated = buildRepairPlan(findings, mode, status.currentStage, { workId });
  assert.equal(aggregated.owner_stage, 'requirement_brief');
  assert.deepEqual(aggregated.issue_ids, ['ISSUE-001', 'ISSUE-002']);

  assert.throws(
    () => buildRepairPlan(
      [{ issue_id: 'ISSUE-001', owner_stage: 'unknown-stage', required_action: 'broken' }],
      mode,
      status.currentStage,
      { workId }
    ),
    (error) => error && error.blockingReason === 'r2p-repair-plan-ambiguous'
  );
});

test('gate10 open run with an existing open route blocks gap-open (one route per run)', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate10-existing-route';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript([{
      work_id: workId,
      status: 'active_stage_draft',
      current_stage: 'plan',
      open_routes_detail: [
        { route_id: 'ROUTE-001', owner_stage: 'design', required_action: 'resolve the open design route' }
      ]
    }])
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', required_action: 'Reopen design.' }
  ];

  // Real r2p refuses gap-open while another route is open; map to a clean blocked
  // result instead of emitting a command r2p would reject as a command failure.
  const mode = mapRepairMode(status, status.currentStage, findings);
  assert.equal(mode.kind, 'blocked');
  assert.equal(mode.blockingReason, 'r2p-existing-route-open');
  assert.match(mode.nextAction, /r2p-continue|r2p-gap-resolve/);

  // End to end: record-r2p-repair-plan surfaces the blocker; no r2p-gap-open is invoked.
  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await recordReviewFor(root, homeDir, workId, [], { env });
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true, JSON.stringify(triage));

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, false, JSON.stringify(repairPlan));
  assert.equal(repairPlan.blockingReason, 'r2p-existing-route-open');
  assert.match(repairPlan.nextAction, /r2p-continue|r2p-gap-resolve/);

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'r2p-repair-plan-ambiguous');
  assert.equal(fs.existsSync(path.join(fake.logDir, 'r2p-gap-open.log')), false);

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.blockingReason, 'none');
});

test('gate10 persistent repair-plan path preserves owner stage and reason from accepted r2p findings', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate10-persistent-owner-stage';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));

  const review = await runWorkflowCommand(
    'record-review',
    [
      ...workflowInvocation(workId),
      '--phase',
      'initial-review',
      '--result-stdin'
    ],
    {
      cwd: root,
      homeDir,
      stdin: REVIEW_FAIL_WITH_OWNER_STAGE,
      env
    }
  );
  assert.equal(review.ok, true, JSON.stringify(review));

  const triage = await recordTriageFor(root, homeDir, workId, [], {
    env,
    stdin: TRIAGE_ACCEPT_REASON_AND_REQUIRED_ACTION
  });
  assert.equal(triage.ok, true, JSON.stringify(triage));

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));
  assert.equal(repairPlan.repairPlan.command_kind, 'r2p-reopen');
  assert.equal(repairPlan.repairPlan.owner_stage, 'design');
  assert.equal(repairPlan.repairPlan.reason, 'Reopen design from triage reason, not the gap action.');
  assert.notEqual(repairPlan.repairPlan.reason, 'Open a design gap route; this must not become the reopen reason.');
});

test('gate10 persistent repair-plan includes only high/medium blocking r2p findings', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate10-blocking-only';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await recordReviewFor(root, homeDir, workId, [], {
    env,
    stdin: REVIEW_FAIL_HIGH_DESIGN_LOW_REQUIREMENT
  });
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, [], {
    env,
    stdin: TRIAGE_ACCEPT_HIGH_AND_LOW_BLOCKING_FALSE
  });
  assert.equal(triage.ok, true, JSON.stringify(triage));
  assert.equal(triage.status, 'recorded-triage');

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, true, JSON.stringify(repairPlan));
  assert.equal(repairPlan.repairPlan.command_kind, 'r2p-reopen');
  assert.equal(repairPlan.repairPlan.owner_stage, 'design');
  assert.deepEqual(repairPlan.repairPlan.issue_ids, ['ISSUE-001']);
  assert.equal(repairPlan.repairPlan.reason, 'Reopen design for the high severity issue.');

  const ledgerText = fs.readFileSync(path.join(start.targetStateDir, 'ISSUES.md'), 'utf8');
  assert.match(ledgerText, /\| ISSUE-001 \| high \| accepted \|/);
  assert.match(ledgerText, /\| ISSUE-002 \| low \| accepted \|/);
});

test('gate10 persistent repair-plan blocks accepted findings without owner_stage', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-gate10-missing-owner-stage';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };

  const start = await startFor(root, homeDir, workId, [], { env });
  assert.equal(start.ok, true, JSON.stringify(start));
  const context = await contextFor(root, homeDir, workId, [], { env });
  assert.equal(context.ok, true, JSON.stringify(context));
  const review = await recordReviewFor(root, homeDir, workId, [], { env, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true, JSON.stringify(review));
  const triage = await recordTriageFor(root, homeDir, workId, [], { env });
  assert.equal(triage.ok, true, JSON.stringify(triage));

  const repairPlan = await runWorkflowCommand('record-r2p-repair-plan', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(repairPlan.ok, false, JSON.stringify(repairPlan));
  assert.equal(repairPlan.blockingReason, 'r2p-repair-plan-ambiguous');

  const apply = await runWorkflowCommand('apply-r2p-repair', [start.targetStateDir, '--json'], {
    cwd: root,
    homeDir,
    env
  });
  assert.equal(apply.ok, false, JSON.stringify(apply));
  assert.equal(apply.blockingReason, 'r2p-repair-plan-ambiguous');
});

test('redaction receipt omits raw reason/secrets', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-redaction';
  makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    }),
    'r2p-reopen': [
      '#!/bin/sh',
      'set -eu',
      'printf "%s\\n" "SECRET_TOKEN=sk-live-redaction raw required_action=multi word stderr instruction reason=multi word stderr reason" 1>&2',
      `printf "%s\\n" '${JSON.stringify({
        new_work_id: 'WF-20260627-redaction-r1',
        reason: 'multi word stdout reason from reviewer context',
        required_action: 'multi word stdout action from reviewer context'
      })}'`
    ].join('\n')
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', reason: 'reason=super-secret-password' }
  ];
  const mode = mapRepairMode(status, status.currentStage, findings);
  const plan = buildRepairPlan(findings, mode, status.currentStage, { workId });
  const apply = await runRepairCommand(paths, plan, { cwd: root, env, homeDir });
  const receiptPath = path.join(root, 'r2p-repair-receipt.md');
  const receipt = writeReceipt({ ...apply, receiptPath }).receiptText;
  assert.doesNotMatch(receipt, /SECRET_TOKEN|sk-live|password/i);
  assert.doesNotMatch(receipt, /multi word stdout reason/i);
  assert.doesNotMatch(receipt, /multi word stdout action/i);
  assert.doesNotMatch(receipt, /multi word stderr instruction/i);
  assert.doesNotMatch(receipt, /multi word stderr reason/i);
  assert.doesNotMatch(receipt, /raw required_action/i);
  assert.equal(fs.existsSync(receiptPath), true);
});

test('drift guard blocks instead of executing', async (t) => {
  const { root, homeDir } = makeSandbox(t);
  const workId = 'WF-20260627-drift';
  const runDir = makeRun(root, workId);
  const fake = installFakeR2pCli(root, {
    'r2p-status': statusScript({
      work_id: workId,
      status: 'closed_at_plan_checkpoint',
      current_stage: 'plan',
      open_routes_detail: []
    })
  });
  const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}` };
  const paths = resolveR2pCommands({ env, homeDir });
  const status = await readRunStatus(paths, workId, { cwd: root, env, homeDir });
  const findings = [
    { issue_id: 'ISSUE-001', owner_stage: 'design', reason: 'Need upstream design repair.' }
  ];
  const mode = mapRepairMode(status, status.currentStage, findings);
  const repairPlan = buildRepairPlan(findings, mode, status.currentStage, { workId });
  const fingerprint = captureRunFingerprints(runDir);

  fs.appendFileSync(path.join(runDir, '07-plan.md'), '\ndrifted after review\n');
  const apply = await driftGuard({
    cwd: root,
    env,
    homeDir,
    workId,
    runDir,
    archiveRunDir: path.join(root, '.req-to-plan', 'archive', workId),
    command_kind: repairPlan.command_kind,
    runMdSha256: fingerprint.runMdSha256,
    fileSetFingerprint: fingerprint.fileSetFingerprint
  });
  assert.equal(apply.ok, false);
  assert.equal(apply.blockingReason, 'r2p-drift-detected');
});
