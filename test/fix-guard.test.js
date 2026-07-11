'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const test = require('node:test');
const {
  checkGitRollbackAnchor,
  checkTargetOnlyWorktree,
  inspectActualChangedFiles,
  formatFixGuardReport,
  parsePorcelainStatus,
  classifyFileSetChanges,
  checkFileSetWorktree,
  runGit
} = require('../lib/fix-guard');
const { formatLedger, parseLedger } = require('../lib/ledger');
const { readLease } = require('../lib/lock');
const { computeFingerprint, deriveTargetKey } = require('../lib/target-state');
const { runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');

function git(root, args) {
  execSync(`git ${args}`, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  });
}

function isolateGitFixture(root) {
  const excludesFile = path.join(root, '.git', 'drfx-empty-excludes');
  fs.writeFileSync(excludesFile, '');
  git(root, `config core.excludesFile ${JSON.stringify(excludesFile)}`);
}

function makeGitRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');
  git(root, 'init');
  isolateGitFixture(root);
  git(root, 'add docs/target.md');
  git(root, 'commit -m init');
  return { root, target };
}

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
    status: 'fix',
    currentPhase: 'fix',
    currentRound: 1,
    assurance: 'practical',
    runtimePlatform: 'codex',
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimeSubagentProbe: 'ready',
    runtimeSubagentProbeEvidence: 'route-asserted-ready',
    runtimeFingerprintGuard: 'passed',
    runtimeStdinHandoff: 'ready',
    runtimeStdinHandoffEvidence: 'route-asserted-ready',
    runtimeDowngradeReason: 'none',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: 'none',
    lastReviewerReportPath: 'reports/reviewer-round-001.md',
    lastTriageReportPath: 'reports/triage-round-001.md',
    lastFixReportPath: 'none',
    lastDiffReviewReportPath: 'none',
    initialContentSha256: 'a'.repeat(64),
    lastKnownContentSha256: 'a'.repeat(64),
    lastReviewedContentSha256: 'a'.repeat(64),
    lastPassedContentSha256: 'none',
    lastModifiedAt: '2026-05-21T00:00:00.000Z',
    fileSize: 10,
    references: [],
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    ...overrides
  };
}

function makeWorkflowFixture(t, { manifestOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'spec.md');
  fs.writeFileSync(target, '# Spec\n\nOriginal.\n');
  git(root, 'init');
  git(root, 'add docs/spec.md');
  git(root, 'commit -m init');

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
    lastReviewedContentSha256: fingerprint.sha256,
    lastModifiedAt: new Date(0).toISOString(),
    fileSize: fingerprint.size,
    ...manifestOverrides
  });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(manifest));
  fs.writeFileSync(ledgerPath, formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Pending fix'
      }
    ]
  }));

  return { root, target, targetDir, manifestPath, ledgerPath, metadata };
}

function validFixReport(targetPath = 'docs/spec.md') {
  return [
    'Fixed:',
    '- ISSUE-001: Updated the required section.',
    '',
    'Files changed:',
    `- ${targetPath}`,
    '',
    'Not fixed:',
    '- none',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
}

function fixReportForIssue(issueId) {
  return [
    'Fixed:',
    `- ${issueId}: Updated the required section.`,
    '',
    'Files changed:',
    '- docs/spec.md',
    '',
    'Not fixed:',
    '- none',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
}

async function beginFix(fixture) {
  return runWorkflowCommand('begin-fix', [fixture.targetDir, '--json'], {
    cwd: fixture.root,
    now: new Date('2026-05-21T00:00:00.000Z')
  });
}

function receiptFiles(fixture) {
  const roundsDir = path.join(fixture.targetDir, 'rounds');
  if (!fs.existsSync(roundsDir)) return [];
  return fs.readdirSync(roundsDir).sort();
}

test('git rollback anchor passes for clean tracked target', (t) => {
  const { root, target } = makeGitRepo(t);
  const result = checkGitRollbackAnchor({ projectRoot: root, targetPath: target });
  assert.equal(result.status, 'passed');
});

test('git rollback anchor blocks dirty target as rollback-unavailable', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.appendFileSync(target, '\nDirty\n');
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: target }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );
});

test('git rollback anchor blocks tracked symlink target as rollback-unavailable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-guard-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-external-target-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const externalTarget = path.join(externalDir, 'target.md');
  const target = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(externalTarget, '# External target\n');
  fs.symlinkSync(externalTarget, target);
  git(root, 'init');
  git(root, 'add docs/target.md');
  git(root, 'commit -m init');

  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: target }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );
});

for (const subcommand of ['fetch', 'push', 'remote', 'branch', 'checkout', 'reset', 'commit']) {
  test(`runGit refuses non-read-only git subcommand: ${subcommand}`, () => {
    assert.throws(
      () => runGit(os.tmpdir(), [subcommand, '--anything'], 'rollback-unavailable'),
      (error) =>
        error.blockingReason === 'rollback-unavailable' &&
        error.code === 'ERR_ROLLBACK_UNAVAILABLE' &&
        new RegExp(`non-read-only git subcommand: ${subcommand}`).test(error.message)
    );
  });
}

test('runGit propagates the caller blocking reason for a rejected subcommand', () => {
  assert.throws(
    () => runGit(os.tmpdir(), ['push'], 'target-only-guard-unavailable'),
    (error) =>
      error.blockingReason === 'target-only-guard-unavailable' &&
      error.code === 'ERR_TARGET_ONLY_GUARD_UNAVAILABLE'
  );
});

test('runGit allows whitelisted read-only subcommands to run', (t) => {
  const { root } = makeGitRepo(t);
  assert.equal(
    runGit(root, ['rev-parse', '--is-inside-work-tree'], 'rollback-unavailable').trim(),
    'true'
  );
  // ls-files and status are also on the allowlist and must not be rejected by the guard.
  assert.doesNotThrow(() => runGit(root, ['ls-files'], 'rollback-unavailable'));
  assert.doesNotThrow(() =>
    runGit(root, ['status', '--porcelain=v1', '--untracked-files=all'], 'rollback-unavailable')
  );
});

test('target-only worktree blocks non-target dirty entry with redacted metadata', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.writeFileSync(path.join(root, 'other.md'), '# Other\n');
  const result = checkTargetOnlyWorktree({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: path.join(root, '.drfx', 'targets', 'target-md-aaaaaaaaaaaa')
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.match(result.entries[0].pathSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result.entries[0], 'path'), false);
  assert.equal(Object.hasOwn(result.entries[0], 'fileSize'), false);
});

test('target-only worktree allows current target-state files', (t) => {
  const { root, target } = makeGitRepo(t);
  const stateDir = path.join(root, '.drfx', 'targets', 'target-md-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'reports', 'fix-guard-round-001.md'), '# Guard\n');
  const result = checkTargetOnlyWorktree({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.allowedStateEntryCount, 1);
});

test('actual changed-file inspection allows only target and current state', (t) => {
  const { root, target } = makeGitRepo(t);
  const stateDir = path.join(root, '.drfx', 'targets', 'target-md-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.appendFileSync(target, '\nFixed\n');
  fs.writeFileSync(path.join(stateDir, 'reports', 'fix-round-001.md'), '# Fix\n');
  const result = inspectActualChangedFiles({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/target.md']);
});

test('fix guard report is machine-parseable without non-target paths', (t) => {
  const { root, target } = makeGitRepo(t);
  const text = formatFixGuardReport({
    round: 1,
    normalizedTarget: 'docs/target.md',
    targetFingerprint: computeFingerprint(target),
    referenceFingerprints: [],
    rollbackAnchor: { status: 'passed', head: 'abc123' },
    targetOnlyGuard: {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: [{ pathSha256: 'f'.repeat(64), statusCode: '??', kind: 'untracked' }]
    },
    lock: { ownerId: 'owner-a', leaseId: 'lease-a', expiresAt: '2026-05-21T00:15:00.000Z' },
    status: 'blocked',
    blockingReason: 'unexpected-worktree-change'
  });
  assert.match(text, /```json/);
  assert.doesNotMatch(text, /other\.md/);
  assert.doesNotMatch(text, /# Target/);
});

test('workflow begin-fix returns persisted lock metadata and guard report path', async (t) => {
  const fixture = makeWorkflowFixture(t);
  const result = await beginFix(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'begin-fix');
  assert.equal(typeof result.lockOwnerId, 'string');
  assert.equal(typeof result.leaseId, 'string');
  assert.equal(typeof result.leaseExpiresAt, 'string');
  assert.equal(result.refreshAfterSeconds, 60);
  assert.equal(result.fixGuardReportPath, path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md'));
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }).leaseId, result.leaseId);
});

test('workflow begin-fix writes rollback-unavailable guard blocker report', async (t) => {
  const fixture = makeWorkflowFixture(t);
  fs.appendFileSync(fixture.target, '\nDirty before fix.\n');

  const result = await beginFix(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  const reportPath = path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md');
  assert.equal(fs.existsSync(reportPath), true);
  const reportText = fs.readFileSync(reportPath, 'utf8');
  assert.match(reportText, /Blocking reason: rollback-unavailable/);
  assert.match(reportText, /"status": "blocked"/);
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});

test('workflow begin-fix maps deleted target to rollback-unavailable guard blocker report', async (t) => {
  const fixture = makeWorkflowFixture(t);
  fs.rmSync(fixture.target);

  const result = await beginFix(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  const reportPath = path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md');
  assert.equal(fs.existsSync(reportPath), true);
  assert.match(fs.readFileSync(reportPath, 'utf8'), /Blocking reason: rollback-unavailable/);
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});

test('workflow begin-fix rejects clean tracked symlink target as rollback-unavailable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-workflow-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-external-target-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const externalTarget = path.join(externalDir, 'spec.md');
  const target = path.join(root, 'docs', 'spec.md');
  fs.writeFileSync(externalTarget, '# Spec\n\nOriginal.\n');
  fs.symlinkSync(externalTarget, target);
  git(root, 'init');
  git(root, 'add docs/spec.md');
  git(root, 'commit -m init');

  const targetKey = 'spec-md-aaaaaaaaaaaa';
  const targetDir = path.join(root, '.drfx', 'targets', targetKey);
  const manifestPath = path.join(targetDir, 'MANIFEST.md');
  const ledgerPath = path.join(targetDir, 'ISSUES.md');
  const fingerprint = computeFingerprint(target);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(manifestPath, formatManifestV2(makeManifest({
    target,
    normalizedTarget: 'docs/spec.md',
    targetKey,
    ledgerPath: path.relative(root, ledgerPath).split(path.sep).join('/'),
    initialContentSha256: fingerprint.sha256,
    lastKnownContentSha256: fingerprint.sha256,
    lastReviewedContentSha256: fingerprint.sha256,
    fileSize: fingerprint.size
  })));
  fs.writeFileSync(ledgerPath, formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Pending fix'
      }
    ]
  }));

  const result = await runWorkflowCommand('begin-fix', [targetDir, '--json'], {
    cwd: root,
    now: new Date('2026-05-21T00:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
  assert.equal(fs.existsSync(path.join(targetDir, 'reports', 'fix-guard-round-001.md')), true);
  assert.equal(readLease({ projectRoot: root, targetKey }), null);
});

test('workflow begin-fix writes target-only guard blocker report with redacted entries', async (t) => {
  const fixture = makeWorkflowFixture(t);
  fs.writeFileSync(path.join(fixture.root, 'other.md'), '# Other\n');

  const result = await beginFix(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  const reportPath = path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md');
  assert.equal(fs.existsSync(reportPath), true);
  const reportText = fs.readFileSync(reportPath, 'utf8');
  assert.match(reportText, /Blocking reason: unexpected-worktree-change/);
  assert.match(reportText, /"pathSha256": "[a-f0-9]{64}"/);
  assert.doesNotMatch(reportText, /other\.md/);
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});

test('workflow refresh-lock reads persisted owner and lease identity', async (t) => {
  const fixture = makeWorkflowFixture(t);
  const begin = await beginFix(fixture);
  const result = await runWorkflowCommand('refresh-lock', [fixture.targetDir, '--json'], {
    cwd: fixture.root,
    now: new Date('2026-05-21T00:01:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'refresh-lock');
  assert.equal(result.lockOwnerId, begin.lockOwnerId);
  assert.equal(result.leaseId, begin.leaseId);
  assert.notEqual(result.leaseExpiresAt, begin.leaseExpiresAt);
});

test('workflow end-fix detects fix-report-mismatch and releases the lock', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport('docs/other.md')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'fix-report-mismatch');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});

test('workflow end-fix blocks unknown fixed issue id with receipt and lock release', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-999.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: fixReportForIssue('ISSUE-999')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'fix-report-mismatch');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  assert.deepEqual(receiptFiles(fixture), ['001-fix-blocked.md']);
});

test('workflow end-fix blocks unparseable fix report with receipt and lock release', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: [
      'Fixed:',
      '- ISSUE-001: Updated the required section.'
    ].join('\n')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'fix-report-mismatch');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  assert.deepEqual(receiptFiles(fixture), ['001-fix-blocked.md']);
});

test('workflow end-fix blocks not-accepted fixed issue id with receipt and lock release', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.writeFileSync(fixture.ledgerPath, formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'docs/spec.md:3',
        summary: 'Original issue',
        resolution: 'Already fixed'
      }
    ]
  }));
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001 again.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'fix-report-mismatch');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  assert.deepEqual(receiptFiles(fixture), ['001-fix-blocked.md']);
});

test('workflow end-fix maps missing persisted guard baseline to target-only-guard-unavailable', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.rmSync(path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md'));
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'target-only-guard-unavailable');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  assert.deepEqual(receiptFiles(fixture), ['001-fix-blocked.md']);
});

test('workflow end-fix maps corrupt persisted guard baseline to target-only-guard-unavailable', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.writeFileSync(path.join(fixture.targetDir, 'reports', 'fix-guard-round-001.md'), '# Fix Guard Report\n\nnot json\n');
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'target-only-guard-unavailable');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  assert.deepEqual(receiptFiles(fixture), ['001-fix-blocked.md']);
});

test('workflow end-fix maps deleted external reference to reference-mutated-file and releases lock', async (t) => {
  const fixture = makeWorkflowFixture(t);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-external-ref-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const reference = path.join(externalDir, 'ref.md');
  fs.writeFileSync(reference, '# External reference\n');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  fs.writeFileSync(fixture.manifestPath, formatManifestV2({
    ...manifest,
    references: [reference]
  }));
  await beginFix(fixture);
  fs.rmSync(reference);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'reference-mutated-file');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  assert.deepEqual(receiptFiles(fixture), ['001-fix-blocked.md']);
});

test('workflow end-fix blocks target replaced by external symlink and releases lock', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-external-target-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const externalTarget = path.join(externalDir, 'spec.md');
  fs.writeFileSync(externalTarget, '# External target\n');
  fs.rmSync(fixture.target);
  fs.symlinkSync(externalTarget, fixture.target);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001 outside the repo.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.notEqual(manifest.status, 'diff-review');
  assert.match(fs.readFileSync(externalTarget, 'utf8'), /Fixed ISSUE-001 outside the repo/);
});

test('workflow end-fix maps release failure to lock-release-failed', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');
  fs.writeFileSync(path.join(fixture.targetDir, 'LOCK', 'unexpected.tmp'), 'keep\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'lock-release-failed');
  assert.equal(result.originalBlockingReason, 'none');
  assert.equal(fs.existsSync(path.join(fixture.targetDir, 'LOCK', 'unexpected.tmp')), true);
});

test('workflow end-fix maps required receipt write failure to state-validation-failed', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');
  fs.writeFileSync(path.join(fixture.targetDir, 'rounds'), 'not a directory\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport('docs/other.md')
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.equal(result.statusReason, 'none');
});

test('workflow end-fix writes normalized report, marks issues fixed, updates manifest, and releases lock', async (t) => {
  const fixture = makeWorkflowFixture(t);
  await beginFix(fixture);
  fs.appendFileSync(fixture.target, '\nFixed ISSUE-001.\n');

  const result = await runWorkflowCommand('end-fix', [fixture.targetDir, '--fix-report-stdin', '--json'], {
    cwd: fixture.root,
    stdin: validFixReport()
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'end-fix');
  assert.equal(result.fixReportPath, path.join(fixture.targetDir, 'reports', 'fix-round-001.md'));
  assert.equal(parseLedger(fs.readFileSync(fixture.ledgerPath, 'utf8')).issues[0].status, 'fixed');
  const manifest = parseManifestV2(fs.readFileSync(fixture.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'diff-review');
  assert.equal(manifest.currentPhase, 'diff-review');
  assert.equal(manifest.lastFixReportPath, 'reports/fix-round-001.md');
  assert.equal(readLease({ projectRoot: fixture.root, targetKey: fixture.metadata.targetKey }), null);
});

test('porcelain status parser classifies copied target entries', () => {
  assert.deepEqual(parsePorcelainStatus('C  docs/target.md\0docs/source.md\0'), [
    {
      statusCode: 'C ',
      kind: 'copied',
      paths: ['docs/source.md', 'docs/target.md']
    }
  ]);
});

test('porcelain status parser rejects unparseable target-only guard output', () => {
  assert.throws(
    () => parsePorcelainStatus('not-a-porcelain-line\0'),
    /unparseable git status record/i
  );
});

test('porcelain status parser preserves Unicode and newline paths from NUL records', () => {
  assert.deepEqual(parsePorcelainStatus(' M é.js\0?? line\nbreak.js\0'), [
    { statusCode: ' M', kind: 'dirty', paths: ['é.js'] },
    { statusCode: '??', kind: 'untracked', paths: ['line\nbreak.js'] }
  ]);
});

test('target-only git guard parses a Unicode path with core.quotePath enabled', (t) => {
  const { root, target } = makeGitRepo(t);
  const unicodePath = path.join(root, 'é.js');
  fs.writeFileSync(unicodePath, 'module.exports = 1;\n');
  git(root, 'add .');
  git(root, 'commit -m unicode');
  git(root, 'config core.quotePath true');
  fs.appendFileSync(unicodePath, '// changed\n');

  const result = checkTargetOnlyWorktree({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: null
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('target-only worktree maps unavailable git status to target-only-guard-unavailable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-target-only-unavailable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');

  assert.throws(
    () => checkTargetOnlyWorktree({
      projectRoot: root,
      targetPath: target,
      allowedStateDir: null
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('checkGitRollbackAnchor: priorFix accepts a tracked dirty target', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.writeFileSync(target, '# Target\n\nEdited by the previous fix.\n');

  // Default (first fix): a dirty target is still rejected.
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: target }),
    /rollback-unavailable/
  );

  // Subsequent fix: a dirty tracked target is accepted.
  const anchor = checkGitRollbackAnchor({ projectRoot: root, targetPath: target, priorFix: true });
  assert.equal(anchor.status, 'passed');
  assert.equal(anchor.priorFix, true);
});

test('checkGitRollbackAnchor: priorFix still requires a tracked target', (t) => {
  const { root } = makeGitRepo(t);
  const untracked = path.join(root, 'docs', 'untracked.md');
  fs.writeFileSync(untracked, '# Untracked\n');
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: untracked, priorFix: true }),
    /rollback-unavailable/
  );
});

test('checkGitRollbackAnchor: priorFix rejects a staged target change', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.writeFileSync(target, '# Target\n\nStaged change.\n');
  git(root, 'add docs/target.md');
  // A subsequent fix may carry a dirty WORKTREE target, but a staged (index) target
  // change is not validated upstream and must still be rejected.
  assert.throws(
    () => checkGitRollbackAnchor({ projectRoot: root, targetPath: target, priorFix: true }),
    /rollback-unavailable/
  );
});

// --- File-set git guard (PLAN-TASK-006) ---
// classifyFileSetChanges is the PURE core: caller-supplied paths only, no git read.

test('classifyFileSetChanges passes a clean baseline with no changes', () => {
  const result = classifyFileSetChanges({ changedPaths: [], allowedSet: ['lib/a.js'] });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.offending, []);
  assert.deepEqual(result.changedFiles, []);
});

test('classifyFileSetChanges allows route-owned prior-round changes only', () => {
  const result = classifyFileSetChanges({
    changedPaths: ['lib/a.js'],
    allowedSet: ['lib/a.js', 'lib/b.js']
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.offending, []);
  assert.deepEqual(result.changedFiles, ['lib/a.js']);
});

test('classifyFileSetChanges blocks dirty allowed files when prior-round allowance is disabled', () => {
  const result = classifyFileSetChanges({
    changedPaths: ['lib/a.js'],
    allowedSet: ['lib/a.js', 'lib/b.js'],
    allowAllowedFileChanges: false
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.deepEqual(result.offending, ['lib/a.js']);
});

test('classifyFileSetChanges blocks staged allowed files even during later rounds', () => {
  const result = classifyFileSetChanges({
    changedPaths: [{ relativePath: 'lib/a.js', statusCode: 'M ', kind: 'staged' }],
    allowedSet: ['lib/a.js', 'lib/b.js']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.deepEqual(result.offending, ['lib/a.js']);
  assert.deepEqual(result.offendingEntries, [
    { relativePath: 'lib/a.js', statusCode: 'M ', kind: 'staged' }
  ]);
});

test('classifyFileSetChanges blocks a change outside the allowed set', () => {
  const result = classifyFileSetChanges({
    changedPaths: ['lib/a.js', 'README.md'],
    allowedSet: ['lib/a.js']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.deepEqual(result.offending, ['README.md']);
});

test('classifyFileSetChanges allows files inside the allowed state directory', () => {
  const result = classifyFileSetChanges({
    changedPaths: ['lib/a.js', '.drfx/targets/x/reports/r.md'],
    allowedSet: ['lib/a.js'],
    allowedStateRelative: '.drfx/targets/x'
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.changedFiles, ['lib/a.js']);
});

// checkFileSetWorktree is the WRAPPER: it reads REAL git status, not injected paths.

test('file-set git guard allows route-owned prior-round changes only', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.writeFileSync(path.join(root, 'docs', 'dep.md'), '# Dep\n');
  git(root, 'add docs/dep.md');
  git(root, 'commit -m dep');
  // Both target and a recorded dependency file changed; both are in the allowed set.
  fs.appendFileSync(target, '\nRoute-owned target change.\n');
  fs.appendFileSync(path.join(root, 'docs', 'dep.md'), '\nNecessary dependency change.\n');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md', { path: 'docs/dep.md', reason: 'necessary dependency', issueId: 'ISSUE-001' }]
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/dep.md', 'docs/target.md']);
});

test('file-set git guard rejects staged allowed files in later fix rounds', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.appendFileSync(target, '\nRoute-owned target change staged by mistake.\n');
  git(root, 'add docs/target.md');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md'],
    allowAllowedFileChanges: true
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.equal(result.entries.length, 1);
  assert.match(result.entries[0].pathSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.entries[0].statusCode, 'M ');
  assert.equal(result.entries[0].kind, 'staged');
  assert.equal(Object.hasOwn(result.entries[0], 'path'), false);
});

test('file-set git guard rejects partially staged allowed files in later fix rounds', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.appendFileSync(target, '\nFirst target change.\n');
  git(root, 'add docs/target.md');
  fs.appendFileSync(target, '\nSecond unstaged target change.\n');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md'],
    allowAllowedFileChanges: true
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.equal(result.entries[0].statusCode, 'MM');
  assert.equal(result.entries[0].kind, 'staged');
});

test('file-set git guard blocks unrelated local changes', (t) => {
  const { root, target } = makeGitRepo(t);
  fs.appendFileSync(target, '\nRoute-owned target change.\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Unrelated\n');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  // Offending entries are redacted (sha256 only), never raw paths.
  assert.match(result.entries[0].pathSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result.entries[0], 'path'), false);
});

test('file-set git guard blocks a file outside the allowed set even when target is allowed', (t) => {
  const { root } = makeGitRepo(t);
  fs.writeFileSync(path.join(root, 'docs', 'dep.md'), '# Dep\n');
  git(root, 'add docs/dep.md');
  git(root, 'commit -m dep');
  fs.appendFileSync(path.join(root, 'docs', 'dep.md'), '\nDep changed but not recorded.\n');

  // dep.md is NOT in the allowed set -> blocked.
  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('file-set git guard allows files inside the allowed state directory', (t) => {
  const { root, target } = makeGitRepo(t);
  const stateDir = path.join(root, '.drfx', 'targets', 'target-md-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'reports', 'fix-guard-round-001.md'), '# Guard\n');
  fs.appendFileSync(target, '\nRoute-owned change.\n');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md'],
    allowedStateDir: stateDir
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/target.md']);
  assert.equal(result.allowedStateEntryCount, 1);
});

test('file-set git guard normalizes repo-root status paths for CODE sub-roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fix-guard-subroot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init');
  isolateGitFixture(root);
  const codeRoot = path.join(root, 'lib');
  fs.mkdirSync(codeRoot, { recursive: true });
  fs.writeFileSync(path.join(codeRoot, 'a.js'), 'module.exports = 1;\n');
  git(root, 'add lib/a.js');
  git(root, 'commit -m init');

  const stateDir = path.join(codeRoot, '.drfx', 'targets', 'code-aaaaaaaaaaaa');
  fs.mkdirSync(path.join(stateDir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'reports', 'fix-guard-round-001.md'), '# Guard\n');
  fs.writeFileSync(path.join(codeRoot, 'a.js'), 'module.exports = 2;\n');

  const result = checkFileSetWorktree({
    projectRoot: codeRoot,
    allowedFiles: ['a.js'],
    allowedStateDir: stateDir
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['a.js']);
  assert.equal(result.allowedStateEntryCount, 1);
});

test('file-set git guard reads REAL worktree state and ignores a misleading allowed set', (t) => {
  const { root, target } = makeGitRepo(t);
  // The worktree actually changes an UNRELATED file. Even if the caller (wrongly) lists
  // it as not-changed, the guard must still read git and block it.
  fs.writeFileSync(path.join(root, 'secret.md'), '# Secret unrelated change\n');
  fs.appendFileSync(target, '\nTarget change.\n');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('file-set git guard blocks (never silently passes) when git is unavailable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fileset-nogit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'target.md'), '# Target\n');

  const result = checkFileSetWorktree({
    projectRoot: root,
    allowedFiles: ['docs/target.md']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'target-only-guard-unavailable');
});

test('file-set git guard rejects unsafe allowed paths', (t) => {
  const { root } = makeGitRepo(t);
  assert.throws(
    () => checkFileSetWorktree({
      projectRoot: root,
      allowedFiles: ['../escape.md']
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
  assert.throws(
    () => checkFileSetWorktree({
      projectRoot: root,
      allowedFiles: ['/absolute/path.md']
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});
