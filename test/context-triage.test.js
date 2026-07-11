'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildContextPack } = require('../lib/context-pack');
const {
  applyTriageDecisions,
  formatLedger,
  parseLedger
} = require('../lib/ledger');
const { acquireLock } = require('../lib/lock');
const { computeFingerprint, deriveR2pTargetKey, deriveTargetKey } = require('../lib/target-state');
const { runWorkflowCommand } = require('../lib/workflow');
const {
  enrichTriageDecisions,
  resolveFileSetStateMetadata,
  resolveStateCommandMetadata,
  validateTriageReviewerIds
} = require('../lib/workflow/helpers');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

function makeManifest(overrides = {}) {
  return {
    manifestSchema: 2,
    target: 'docs/spec.md',
    normalizedTarget: 'docs/spec.md',
    documentType: 'SPEC',
    strictness: 'normal',
    mode: 'review-and-fix',
    targetKey: 'spec-md-aaaaaaaaaaaa',
    ledgerPath: '.drfx/targets/spec-md-aaaaaaaaaaaa/ISSUES.md',
    status: 'review',
    currentPhase: 'review',
    currentRound: 1,
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
    initialContentSha256: 'a'.repeat(64),
    lastKnownContentSha256: 'a'.repeat(64),
    lastReviewedContentSha256: 'none',
    lastPassedContentSha256: 'none',
    lastModifiedAt: '2026-05-21T00:00:00.000Z',
    fileSize: 10,
    references: [],
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides
  };
}

function makePersistentFixture(t, { manifestOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-context-triage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'spec.md');
  const reference = path.join(root, 'docs', 'ref.md');
  fs.writeFileSync(target, '# Target\n\nTarget body sentinel must stay out of manifests.\n');
  fs.writeFileSync(reference, '# Reference\n\nReference body sentinel must stay out of manifests.\n');

  const metadata = deriveTargetKey(root, target);
  const targetDir = path.join(root, '.drfx', 'targets', metadata.targetKey);
  const manifestPath = path.join(targetDir, 'MANIFEST.md');
  const ledgerPath = path.join(targetDir, 'ISSUES.md');
  const fingerprint = computeFingerprint(target);
  const manifest = makeManifest({
    target,
    normalizedTarget: metadata.normalizedTarget,
    targetKey: metadata.targetKey,
    ledgerPath: path.relative(root, ledgerPath).split(path.sep).join('/'),
    initialContentSha256: fingerprint.sha256,
    lastKnownContentSha256: fingerprint.sha256,
    lastModifiedAt: new Date(0).toISOString(),
    fileSize: fingerprint.size,
    references: ['docs/ref.md'],
    ...manifestOverrides
  });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(manifest));

  return { root, target, reference, targetDir, manifestPath, ledgerPath };
}

function workflowArgs({ root, target, reference, phase = 'initial-review' }) {
  return [
    'review-fix-spec',
    `root=${root}`,
    `target=${target}`,
    `ref=${reference}`,
    'review-and-fix',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    phase,
    '--json'
  ];
}

function reviewerFailPayload() {
  return [
    'FAIL',
    'Findings:',
    '- id: R001',
    '  severity: high',
    '  location: docs/spec.md:3',
    '  issue: Missing deterministic triage persistence',
    '  why_it_matters: repeated runs could assign unstable IDs',
    '  suggested_fix: Persist a normalized ledger update',
    '  confidence: confirmed',
    '  sensitive: false'
  ].join('\n');
}

function triageAcceptedPayload(reviewerId = 'R001') {
  return [
    'Triage:',
    `- reviewer_id: ${reviewerId}`,
    '  issue_id: ISSUE-001',
    '  decision: accepted',
    '  severity: high',
    '  original_severity: high',
    '  rationale: none',
    '  merged_into: none',
    '  deferred_owner: none',
    '  deferred_next_action: none',
    '  non_blocking: false'
  ].join('\n');
}

function triageLowNonBlockingPayload() {
  return [
    'Triage:',
    '- reviewer_id: R001',
    '  issue_id: ISSUE-001',
    '  decision: accepted',
    '  severity: low',
    '  original_severity: low',
    '  rationale: Accepted but non-blocking',
    '  merged_into: none',
    '  deferred_owner: none',
    '  deferred_next_action: none',
    '  non_blocking: true'
  ].join('\n');
}

async function recordFailingReview(fixture) {
  await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });
  return runWorkflowCommand('record-review', [
    ...workflowArgs(fixture),
    '--result-stdin'
  ], {
    cwd: fixture.root,
    stdin: reviewerFailPayload()
  });
}

test('context pack includes merged rule set and deterministic rules source list', () => {
  const pack = buildContextPack({
    target: 'docs/spec.md',
    references: [{ path: 'docs/ref.md', readOnly: true }],
    documentType: 'SPEC',
    strictness: 'normal',
    mode: 'read-only',
    assurance: 'advisory',
    runtimePlatform: 'manual',
    phase: 'initial-review',
    round: 1,
    mergedRules: {
      text: '### hard\nWorkflow hard constraints',
      sources: ['hard', 'built-in-SPEC', 'user-COMMON', 'project-SPEC']
    },
    acceptedNonBlockingLowIssueIds: [],
    requiredOutputSchema: 'reviewer-pass-fail',
    reviewerGuardBaseline: { target: { sha256: 'a'.repeat(64), size: 1, mtimeMs: 1 }, references: [] }
  });

  assert.equal(pack.contentPolicy, 'read-in-memory-only');
  assert.deepEqual(pack.rulesSourceList.map((entry) => entry.category), [
    'package built-in',
    'package built-in',
    'user-global',
    'project-local'
  ]);
  assert.equal(pack.acceptedNonBlockingLowIssueIds, 'none');
  assert.doesNotMatch(JSON.stringify(pack), /Target body/);
});

test('triage maps accepted reopened merged downgraded rejected deferred decisions', () => {
  const ledger = {
    issues: [
      { id: 'ISSUE-001', severity: 'medium', status: 'fixed', location: 'A', summary: 'Old', resolution: 'Fixed' }
    ]
  };
  const next = applyTriageDecisions(ledger, [
    { reviewer_id: 'R001', decision: 'accepted', severity: 'high', location: 'B', summary: 'New', rationale: 'Valid' },
    { reviewer_id: 'R002', decision: 'reopened', issue_id: 'ISSUE-001', severity: 'medium', rationale: 'Regression' },
    { reviewer_id: 'R003', decision: 'merged', issue_id: 'ISSUE-003', severity: 'low', merged_into: 'ISSUE-001', rationale: 'Duplicate' },
    { reviewer_id: 'R004', decision: 'downgraded', issue_id: 'ISSUE-004', severity: 'low', original_severity: 'medium', rationale: 'Low impact' },
    { reviewer_id: 'R005', decision: 'rejected', issue_id: 'ISSUE-005', severity: 'low', rationale: 'Not applicable' },
    { reviewer_id: 'R006', decision: 'deferred', issue_id: 'ISSUE-006', severity: 'medium', rationale: 'Needs owner', deferred_owner: 'user', deferred_next_action: 'Decide scope' }
  ]);

  assert.equal(next.issues.find((issue) => issue.id === 'ISSUE-001').status, 'reopened');
  assert.equal(next.issues.some((issue) => issue.status === 'downgraded'), false);
  assert.equal(next.issues.find((issue) => issue.status === 'merged').resolution.includes('Merged into ISSUE-001'), true);
  assert.deepEqual(next.issues.map((issue) => issue.id), [
    'ISSUE-001',
    'ISSUE-002',
    'ISSUE-003',
    'ISSUE-004',
    'ISSUE-005',
    'ISSUE-006'
  ]);
});

test('triage records non-blocking low accepted issue ids only for low severity', () => {
  const next = applyTriageDecisions({ issues: [] }, [
    {
      reviewer_id: 'R001',
      issue_id: 'ISSUE-001',
      decision: 'accepted',
      severity: 'low',
      location: 'A',
      summary: 'Low issue',
      rationale: 'Accepted but not blocking',
      non_blocking: true
    }
  ]);

  assert.deepEqual(next.acceptedNonBlockingLowIssueIds, ['ISSUE-001']);
  assert.match(next.issues[0].resolution, /Accepted as non-blocking low/i);
  assert.throws(
    () => applyTriageDecisions({ issues: [] }, [
      {
        reviewer_id: 'R001',
        issue_id: 'ISSUE-001',
        decision: 'accepted',
        severity: 'medium',
        location: 'A',
        summary: 'Medium issue',
        rationale: 'Cannot be non-blocking',
        non_blocking: true
      }
    ]),
    /non-blocking|low/i
  );
});

test('triage requires unique one-to-one coverage of every reviewer finding', () => {
  const reviewerReport = {
    normalized: {
      findings: [
        { id: 'R001', severity: 'high', location: 'A', issue: 'First', suggested_fix: 'Fix first' },
        { id: 'R002', severity: 'medium', location: 'B', issue: 'Second', suggested_fix: 'Fix second' }
      ]
    }
  };

  assert.throws(
    () => validateTriageReviewerIds({ decisions: [{
      reviewer_id: 'R001',
      decision: 'accepted',
      severity: 'high',
      original_severity: 'high'
    }] }, reviewerReport),
    /missing.*R002|cover.*R002/i
  );
  assert.throws(
    () => validateTriageReviewerIds({
      decisions: [
        { reviewer_id: 'R001', decision: 'accepted', severity: 'high', original_severity: 'high' },
        { reviewer_id: 'R001', decision: 'accepted', severity: 'high', original_severity: 'high' }
      ]
    }, reviewerReport),
    /duplicate.*R001/i
  );
});

test('triage severity stays bound to the reviewer finding unless explicitly downgraded', () => {
  const reviewerReport = {
    normalized: {
      findings: [
        {
          id: 'R001',
          severity: 'high',
          location: 'A',
          issue: 'Blocking finding',
          suggested_fix: 'Fix it'
        }
      ]
    }
  };

  assert.throws(
    () => enrichTriageDecisions({ decisions: [{
      reviewer_id: 'R001',
      decision: 'accepted',
      severity: 'low',
      original_severity: 'high',
      non_blocking: true
    }] }, reviewerReport),
    /severity.*reviewer|downgraded/i
  );
  assert.throws(
    () => enrichTriageDecisions({ decisions: [{
      reviewer_id: 'R001',
      decision: 'downgraded',
      severity: 'low',
      original_severity: 'medium'
    }] }, reviewerReport),
    /original_severity.*high|reviewer severity/i
  );
  assert.throws(
    () => enrichTriageDecisions({ decisions: [{
      reviewer_id: 'R001',
      decision: 'downgraded',
      severity: 'high',
      original_severity: 'high'
    }] }, reviewerReport),
    /strictly lower|lower severity/i
  );

  const [decision] = enrichTriageDecisions({ decisions: [{
    reviewer_id: 'R001',
    decision: 'downgraded',
    severity: 'medium',
    original_severity: 'high',
    rationale: 'Impact is bounded'
  }] }, reviewerReport);
  assert.equal(decision.severity, 'medium');
  assert.equal(decision.original_severity, 'high');
});

test('state command metadata re-derives the document key from the resolved target identity', (t) => {
  const fixture = makePersistentFixture(t);
  const redirected = path.join(fixture.root, 'docs', 'redirected.md');
  fs.copyFileSync(fixture.target, redirected);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...manifest,
    target: redirected,
    normalizedTarget: 'docs/redirected.md'
  }));

  assert.throws(
    () => resolveStateCommandMetadata(fixture.targetDir),
    /derived target key|target identity|normalized target/i
  );
});

test('file-set state metadata re-derives the R2P key from workId', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-r2p-state-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalWorkId = 'WF-20260711-original';
  const targetKey = deriveR2pTargetKey({ projectRoot: root, workId: originalWorkId }).targetKey;
  const targetDir = path.join(root, '.drfx', 'targets', targetKey);
  const manifestPath = path.join(targetDir, 'MANIFEST.md');
  const ledgerPath = path.join(targetDir, 'ISSUES.md');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(makeManifest({
    targetContextKind: 'r2p',
    target: 'none',
    normalizedTarget: 'none',
    documentType: 'none',
    targetKey,
    ledgerPath: path.relative(root, ledgerPath).split(path.sep).join('/'),
    status: 'fix',
    currentPhase: 'fix',
    workId: 'WF-20260711-redirected',
    runMdSha256: 'a'.repeat(64),
    reviewSetFingerprint: 'b'.repeat(64)
  })));

  assert.throws(
    () => resolveFileSetStateMetadata(targetDir),
    /derived r2p target key/i
  );
});

test('persistent workflow context writes reviewer manifest without target body', async (t) => {
  const fixture = makePersistentFixture(t);
  const result = await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.contextManifestPath, path.join(result.targetStateDir, 'context', 'current-reviewer-context-manifest.md'));
  const text = fs.readFileSync(result.contextManifestPath, 'utf8');
  assert.match(text, /"contentPolicy": "read-in-memory-only"/);
  assert.match(text, /Workflow hard constraints/);
  assert.match(text, /"requiredOutputSchema": "reviewer-pass-fail"/);
  assert.doesNotMatch(text, /Target body sentinel|Reference body sentinel/);
});

test('persistent workflow context blocks when context directory is an external symlink', async (t) => {
  const fixture = makePersistentFixture(t);
  const outsideContext = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-outside-context-'));
  t.after(() => fs.rmSync(outsideContext, { recursive: true, force: true }));
  fs.symlinkSync(outsideContext, path.join(fixture.targetDir, 'context'), 'dir');

  const result = await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(fs.existsSync(path.join(outsideContext, 'current-reviewer-context-manifest.md')), false);
});

test('persistent record-review blocks when reviewer guard fingerprints change', async (t) => {
  const fixture = makePersistentFixture(t);
  await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });
  fs.appendFileSync(fixture.target, '\nReviewer mutation attempt.\n');

  const result = await runWorkflowCommand('record-review', [
    ...workflowArgs(fixture),
    '--result-stdin'
  ], {
    cwd: fixture.root,
    stdin: reviewerFailPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'reviewer-mutated-file');
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md')), false);
});

test('persistent record-review blocks when reports directory is an external symlink', async (t) => {
  const fixture = makePersistentFixture(t);
  await runWorkflowCommand('context', workflowArgs(fixture), { cwd: fixture.root });
  const outsideReports = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-outside-reports-'));
  t.after(() => fs.rmSync(outsideReports, { recursive: true, force: true }));
  fs.symlinkSync(outsideReports, path.join(fixture.targetDir, 'reports'), 'dir');

  const result = await runWorkflowCommand('record-review', [
    ...workflowArgs(fixture),
    '--result-stdin'
  ], {
    cwd: fixture.root,
    stdin: reviewerFailPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(fs.existsSync(path.join(outsideReports, 'reviewer-round-001.md')), false);
});

test('persistent record-review stores producer metadata and record-triage updates ledger', async (t) => {
  const fixture = makePersistentFixture(t);
  const review = await recordFailingReview(fixture);
  assert.equal(review.ok, true);
  assert.equal(review.status, 'recorded-review');
  const reviewerReport = fs.readFileSync(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md'), 'utf8');
  assert.match(reviewerReport, /Producer: reviewer-subagent/);
  assert.doesNotMatch(reviewerReport, /^FAIL$/m);

  const triage = await runWorkflowCommand('record-triage', [
    ...workflowArgs(fixture),
    '--triage-stdin'
  ], {
    cwd: fixture.root,
    stdin: triageAcceptedPayload()
  });
  assert.equal(triage.ok, true);
  assert.equal(triage.status, 'recorded-triage');
  assert.deepEqual(parseLedger(fs.readFileSync(fixture.ledgerPath, 'utf8')).issues, [
    {
      id: 'ISSUE-001',
      severity: 'high',
      status: 'accepted',
      location: 'docs/spec.md:3',
      summary: 'Missing deterministic triage persistence',
      resolution: 'Persist a normalized ledger update'
    }
  ]);
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'triage-round-001.md')), true);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');
  assert.equal(manifest.lastReviewerReportPath, 'reports/reviewer-round-001.md');
  assert.equal(manifest.lastTriageReportPath, 'reports/triage-round-001.md');
});

test('persistent record-triage blocks when target changes after failed review', async (t) => {
  const fixture = makePersistentFixture(t);
  const review = await recordFailingReview(fixture);
  assert.equal(review.ok, true);

  fs.appendFileSync(fixture.target, '\nChanged after review.\n');
  const result = await runWorkflowCommand('record-triage', [
    ...workflowArgs(fixture),
    '--triage-stdin'
  ], {
    cwd: fixture.root,
    stdin: triageAcceptedPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'reviewer-mutated-file');
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'triage-round-001.md')), false);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.lastTriageReportPath, 'none');
});

test('persistent record-triage blocks when reference changes after failed review', async (t) => {
  const fixture = makePersistentFixture(t);
  const review = await recordFailingReview(fixture);
  assert.equal(review.ok, true);

  fs.appendFileSync(fixture.reference, '\nChanged after review.\n');
  const result = await runWorkflowCommand('record-triage', [
    ...workflowArgs(fixture),
    '--triage-stdin'
  ], {
    cwd: fixture.root,
    stdin: triageAcceptedPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'reference-mutated-file');
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'triage-round-001.md')), false);
});

test('persistent record-triage blocks absolute manifest ledger path before writing outside target state', async (t) => {
  const fixture = makePersistentFixture(t);
  const review = await recordFailingReview(fixture);
  assert.equal(review.ok, true);
  const outsideLedger = path.join(fixture.root, 'outside-ISSUES.md');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...manifest,
    ledgerPath: outsideLedger
  }));

  const result = await runWorkflowCommand('record-triage', [
    ...workflowArgs(fixture),
    '--triage-stdin'
  ], {
    cwd: fixture.root,
    stdin: triageAcceptedPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(fs.existsSync(outsideLedger), false);
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'triage-round-001.md')), false);
});

test('persistent record-triage blocks escaping manifest reviewer report path before ledger writes', async (t) => {
  const fixture = makePersistentFixture(t);
  const review = await recordFailingReview(fixture);
  assert.equal(review.ok, true);
  const outsideReport = path.join(fixture.root, 'outside-reviewer-report.md');
  fs.copyFileSync(path.join(fixture.targetDir, 'reports', 'reviewer-round-001.md'), outsideReport);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...manifest,
    lastReviewerReportPath: path.relative(fixture.targetDir, outsideReport).split(path.sep).join('/')
  }));

  const result = await runWorkflowCommand('record-triage', [
    ...workflowArgs(fixture),
    '--triage-stdin'
  ], {
    cwd: fixture.root,
    stdin: triageAcceptedPayload()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'reports', 'triage-round-001.md')), false);
});

test('persistent record-triage rejects reviewer ids absent from latest normalized report', async (t) => {
  const fixture = makePersistentFixture(t);
  await recordFailingReview(fixture);

  await assert.rejects(
    () => runWorkflowCommand('record-triage', [
      ...workflowArgs(fixture),
      '--triage-stdin'
    ], {
      cwd: fixture.root,
      stdin: triageAcceptedPayload('R999')
    }),
    /reviewer_id|R999/i
  );
  assert.equal(fs.existsSync(fixture.ledgerPath), false);
});

test('persistent fix context rejects when no accepted or reopened issues exist', async (t) => {
  const fixture = makePersistentFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });

  await assert.rejects(
    () => runWorkflowCommand('context', workflowArgs({ ...fixture, phase: 'fix' }), { cwd: fixture.root }),
    /accepted|reopened|fix/i
  );
});

test('persistent fix context includes lock and target-only skeleton fields', async (t) => {
  const fixture = makePersistentFixture(t, {
    manifestOverrides: { status: 'fix', currentPhase: 'fix' }
  });
  const metadata = deriveTargetKey(fixture.root, fixture.target);
  fs.writeFileSync(fixture.ledgerPath, formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'docs/spec.md:3',
        summary: 'Missing deterministic triage persistence',
        resolution: 'Persist a normalized ledger update'
      }
    ]
  }));
  const lease = acquireLock({
    projectRoot: fixture.root,
    targetKey: metadata.targetKey,
    targetPath: fixture.target,
    ownerId: 'owner-a',
    mode: 'review-and-fix',
    strictness: 'normal',
    now: new Date('2026-05-21T00:00:00.000Z')
  });

  const result = await runWorkflowCommand('context', workflowArgs({ ...fixture, phase: 'fix' }), { cwd: fixture.root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.contextManifestPath, path.join(result.targetStateDir, 'context', 'current-fixer-context-manifest.md'));
  const contextText = fs.readFileSync(result.contextManifestPath, 'utf8');
  const context = JSON.parse(contextText.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(context.requiredOutputSchema, 'fix-report');
  assert.deepEqual(context.fixerGuard.issueIds, ['ISSUE-001']);
  assert.equal(context.fixerGuard.activeLock.ownerId, 'owner-a');
  assert.equal(context.fixerGuard.activeLock.leaseId, lease.leaseId);
  assert.equal(context.fixerGuard.latestFixGuardReportPath, 'none');
  assert.deepEqual(context.fixerGuard.expectedChangedFileSet, ['docs/spec.md']);
  assert.deepEqual(context.fixerGuard.safeLocationAnchors, ['docs/spec.md:3']);
  assert.match(context.fixerGuard.targetOnlyWriteRule, /target only/i);
  assert.match(context.fixerGuard.referenceReadOnlyRule, /read-only/i);
});

test('review-and-fix triage cannot launder a high finding into non-blocking low', async (t) => {
  const fixture = makePersistentFixture(t);
  await recordFailingReview(fixture);

  await assert.rejects(
    () => runWorkflowCommand('record-triage', [
      ...workflowArgs(fixture),
      '--triage-stdin'
    ], {
      cwd: fixture.root,
      stdin: triageLowNonBlockingPayload()
    }),
    /severity.*reviewer|downgraded/i
  );
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'triage');
  assert.equal(manifest.currentPhase, 'triage');
});

test('buildContextPack omits changedSinceLastReview by default and includes it when provided', () => {
  const base = buildContextPack({ target: 'docs/spec.md', documentType: 'SPEC', phase: 'full-re-review' });
  assert.equal(base.changedSinceLastReview, null);

  const withHint = buildContextPack({
    target: 'docs/spec.md',
    documentType: 'SPEC',
    phase: 'full-re-review',
    changedSinceLastReview: { fixedIssueIds: ['ISSUE-001'], sections: ['Requirements'] }
  });
  assert.deepEqual(withHint.changedSinceLastReview, { fixedIssueIds: ['ISSUE-001'], sections: ['Requirements'] });
});

test('runPersistentContext populates changedSinceLastReview from latest fix report only', async (t) => {
  // Build a fixture with two ledger issues fixed across two fix rounds, but only the
  // LATEST fix report references the second issue.  The context command must surface
  // only the latest fix report's issue ID, not the older one.
  const fixture = makePersistentFixture(t);

  // Write a two-issue ledger (both previously fixed by separate rounds).
  fs.mkdirSync(path.dirname(fixture.ledgerPath), { recursive: true });
  fs.writeFileSync(fixture.ledgerPath, formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:3',
        summary: 'Old issue fixed in round 1',
        resolution: 'Fixed: round 1 fix'
      },
      {
        id: 'ISSUE-002',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:Section B',
        summary: 'New issue fixed in round 2',
        resolution: 'Fixed: round 2 fix'
      }
    ]
  }));

  // Write a "round 1" fix report that only fixed ISSUE-001.
  const reportsDir = path.join(fixture.targetDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const round1FixReport = {
    round: 1,
    normalized: {
      fixed: [{ issue_id: 'ISSUE-001', summary: 'round 1 fix' }],
      filesChanged: ['docs/spec.md'],
      notFixed: [],
      residualRisk: 'none'
    }
  };
  const round1ReportPath = path.join(reportsDir, 'fix-round-001.md');
  fs.writeFileSync(round1ReportPath, [
    '# Fix Report',
    '',
    'Round: 1',
    '',
    '```json',
    JSON.stringify(round1FixReport, null, 2),
    '```',
    ''
  ].join('\n'));

  // Write a "round 2" fix report (the latest) that only fixed ISSUE-002.
  const round2FixReport = {
    round: 2,
    normalized: {
      fixed: [{ issue_id: 'ISSUE-002', summary: 'round 2 fix' }],
      filesChanged: ['docs/spec.md'],
      notFixed: [],
      residualRisk: 'none'
    }
  };
  const round2ReportPath = path.join(reportsDir, 'fix-round-002.md');
  fs.writeFileSync(round2ReportPath, [
    '# Fix Report',
    '',
    'Round: 2',
    '',
    '```json',
    JSON.stringify(round2FixReport, null, 2),
    '```',
    ''
  ].join('\n'));

  // Update the manifest: lastKnownContentSha256 differs from initialContentSha256
  // (indicating the file was changed by a fix), and lastFixReportPath points to the
  // latest (round 2) fix report only.
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  const alteredSha = 'b'.repeat(64);
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...manifest,
    status: 'full-re-review',
    currentPhase: 'full-re-review',
    initialContentSha256: manifest.initialContentSha256,
    lastKnownContentSha256: alteredSha,
    lastFixReportPath: 'reports/fix-round-002.md'
  }));

  const result = await runWorkflowCommand('context', workflowArgs({ ...fixture, phase: 'full-re-review' }), { cwd: fixture.root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');

  const hint = result.contextPackSkeleton.changedSinceLastReview;
  assert.ok(hint !== null, 'changedSinceLastReview should be populated');
  assert.deepEqual(hint.fixedIssueIds, ['ISSUE-002'], 'should include only the latest fix report issue');
  assert.ok(!hint.fixedIssueIds.includes('ISSUE-001'), 'must not include older fixed issue');
  assert.ok(Array.isArray(hint.sections), 'sections should be an array');
  assert.ok(hint.sections.some((s) => /Section B/i.test(s)), 'sections should include location of ISSUE-002');
});
