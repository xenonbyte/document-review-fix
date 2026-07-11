'use strict';

// PLAN-TASK-009 (Phase C): file-set (PR/CODE) persistent review lifecycle executes
// end-to-end. These tests drive start → context → record-review → record-triage over a
// real PR diff / CODE scope and assert the reviewer context-pack describes the file SET,
// the round-limit gate holds, and read-only file-set review never claims PASS.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const { runWorkflowCommand } = require('../lib/workflow');
const { formatManifestV2, parseManifestV2 } = require('../lib/workflow-state');
const { parseLedger } = require('../lib/ledger');
const { buildFileSetFinalValidationState } = require('../lib/workflow/file-set-finalize');
const { resolveFileSetStateMetadata } = require('../lib/workflow/helpers');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function makePrRepo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-life-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 3;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feature work']);
  return root;
}

function makeCodeRepoWithChunkedFile(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-chunk-fix-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'big.js'), Array.from({ length: 80 }, () => 'x').join('\n') + '\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function makePrRepoWithDeletedFile(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-delete-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'remove-me.js'), 'module.exports = "remove";\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.rmSync(path.join(root, 'src', 'remove-me.js'));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'feature deletes a file']);
  return root;
}

function makePrRepoWithDistFile(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-dist-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'module.exports = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  git(root, ['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'module.exports = 2;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feature updates dist']);
  return root;
}

function practicalArgs(extra, mode = 'review-and-fix') {
  return [
    ...extra,
    mode,
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ];
}

const REVIEW_FAIL = [
  'FAIL',
  'Findings:',
  '- id: R001',
  '  severity: high',
  '  location: src/a.js',
  '  issue: The change drops error handling.',
  '  why_it_matters: A failure path now throws unhandled.',
  '  suggested_fix: Restore the try/catch around the call.',
  '  confidence: confirmed',
  '  sensitive: false'
].join('\n');

const TRIAGE_ACCEPT = [
  'Triage:',
  '- reviewer_id: R001',
  '  issue_id: ISSUE-001',
  '  decision: accepted',
  '  severity: high',
  '  original_severity: high',
  '  rationale: The missing error handling blocks merge.',
  '  merged_into: none',
  '  deferred_owner: none',
  '  deferred_next_action: none',
  '  non_blocking: false'
].join('\n');

test('PR file-set review path runs context → record-review → record-triage to a fix decision', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);
  assert.equal(start.status, 'review');

  const context = await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(context.status, 'context');
  assert.equal(context.contextPackSkeleton.fileSet.routeKind, 'pr');
  assert.equal(context.contextPackSkeleton.fileSet.base, 'main');
  // The file set carries the PR diff member files, not a single document body.
  const memberPaths = context.contextPackSkeleton.fileSet.files.map((file) => file.path).sort();
  assert.deepEqual(memberPaths, ['src/a.js', 'src/b.js']);
  assert.equal(context.contextPackSkeleton.target, 'none');

  const review = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'triage');

  const triage = await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true);
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.currentPhase, 'fix');

  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'accepted');
});

test('CODE file-set context describes the scoped file set, never a single document body', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(start.ok, true);

  const context = await runWorkflowCommand('context', practicalArgs(['review-fix-code', 'scope=src']), { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(context.contextPackSkeleton.fileSet.routeKind, 'code');
  assert.deepEqual(context.contextPackSkeleton.fileSet.scopes, ['src']);
  assert.ok(context.contextPackSkeleton.fileSet.fileCount >= 2);
  assert.equal(context.contextPackSkeleton.documentType, 'none');
});

test('file-set state commands re-derive PR and CODE target keys from manifest identity fields', async (t) => {
  const prRoot = makePrRepo(t);
  const prStart = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: prRoot });
  const prManifest = parseManifestV2(fs.readFileSync(prStart.manifestPath, 'utf8'));
  fs.writeFileSync(prStart.manifestPath, formatManifestV2({ ...prManifest, base: 'tampered-base' }));
  assert.throws(
    () => resolveFileSetStateMetadata(prStart.targetStateDir),
    /derived pr target key/i
  );
  const prResult = await runWorkflowCommand('begin-fix', [prStart.targetStateDir, '--json'], { cwd: prRoot });
  assert.equal(prResult.status, 'blocked');
  assert.equal(prResult.blockingReason, 'state-validation-failed');

  const codeRoot = makePrRepo(t);
  const codeStart = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src']), { cwd: codeRoot });
  const codeManifest = parseManifestV2(fs.readFileSync(codeStart.manifestPath, 'utf8'));
  fs.writeFileSync(codeStart.manifestPath, formatManifestV2({
    ...codeManifest,
    normalizedScopes: ['tampered-scope']
  }));
  assert.throws(
    () => resolveFileSetStateMetadata(codeStart.targetStateDir),
    /derived code target key/i
  );
  const codeResult = await runWorkflowCommand('begin-fix', [codeStart.targetStateDir, '--json'], { cwd: codeRoot });
  assert.equal(codeResult.status, 'blocked');
  assert.equal(codeResult.blockingReason, 'state-validation-failed');
});

test('CODE file-set record-review blocks when scoped content changes after context', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true);

  await runWorkflowCommand('context', args, { cwd: root });
  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// reviewer-side mutation\n');

  const review = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });

  assert.equal(review.ok, false);
  assert.equal(review.status, 'blocked');
  assert.equal(review.blockingReason, 'reviewer-mutated-file');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'reports', 'reviewer-round-001.md')), false);
});

const FIX_REPORT_FILESET = [
  'Fixed:',
  '- ISSUE-001: Restored the error handling around the call.',
  '',
  'Files changed:',
  '- src/a.js',
  '',
  'Not fixed:',
  '- none',
  '',
  'Verification:',
  '- node --check src/a.js: passed',
  '',
  'Residual risk:',
  '- none identified'
].join('\n');

const DIFF_OK = 'DIFF-OK\nSummary: File-set edit addresses ISSUE-001.\n';
const REVIEW_PASS = 'PASS\nSummary: No blocking findings.\n';

function finalPass(filesChanged) {
  return [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    `Files changed: ${filesChanged}`,
    'Fixed issue IDs: ISSUE-001',
    'Verification performed: node --check src/a.js',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
}

function finalPassWithoutFixes() {
  return [
    'Final status: pass',
    'Assurance: practical',
    'Runtime platform: codex',
    'Mode: review-and-fix',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full file-set re-review',
    'Deferrals or blockers: none',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: none identified',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: approved after full re-review'
  ].join('\n');
}

function noStateReadOnlyFindings() {
  return [
    'Final status: read-only-findings',
    'Assurance: advisory',
    'Runtime platform: codex',
    'Mode: read-only',
    'Target: none',
    'Files changed: none',
    'Fixed issue IDs: none',
    'Verification performed: full file-set read-only review',
    'Deferrals or blockers: read-only findings',
    'Blocking reason: none',
    'Status reason: none',
    'Residual risk: unresolved read-only findings remain',
    'Redaction statement: no sensitive values persisted',
    'Coordinator agreement: none'
  ].join('\n');
}

async function reachFileSetFixStage(root, args) {
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));
  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  return start;
}

test('PR file-set review-and-fix reaches pass through the file-set fix loop', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true);

  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
  assert.ok(beginFix.monitoredFileCount >= 2);

  // The fixer edits a file IN the recorded file set.
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assert.deepEqual(endFix.verification, ['node --check src/a.js: passed']);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');

  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });
  assert.equal(diff.ok, true);
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'full-re-review');

  await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  const archivedManifestPath = path.join(final.archivedStatePath, path.relative(start.targetStateDir, start.manifestPath));
  assert.equal(parseManifestV2(fs.readFileSync(archivedManifestPath, 'utf8')).status, 'pass');

  const archivedLedgerPath = path.join(final.archivedStatePath, path.relative(start.targetStateDir, start.ledgerPath));
  const ledger = parseLedger(fs.readFileSync(archivedLedgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'fixed');
});

test('PR file-set finalize rejects a concrete Target in the final machine block', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  await runWorkflowCommand('context', [
    ...args,
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js').replace('Target: none', 'Target: src/a.js') });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.equal(final.errorCode, 'ERR_FINAL_TARGET_MISMATCH');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('PR file-set end-fix records the uncommitted worktree content fingerprint', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const before = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fileSetFingerprint;

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { return 42; };\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  const after = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fileSetFingerprint;
  assert.notEqual(after, before);
});

test('PR file-set cannot pass without a full re-review after the fix', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  // Skip the full re-review and try to pass directly: finalize must refuse.
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('PR file-set cannot pass from an initial PASS before the required full re-review', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  await runWorkflowCommand('context', args, { cwd: root });
  const initialPass = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(initialPass.ok, true, JSON.stringify(initialPass));
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'full-re-review');
  assert.equal(manifest.currentPhase, 'full-re-review');

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPassWithoutFixes() });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('PR file-set finalize pass revalidates the live file-set fingerprint', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });
  await runWorkflowCommand('context', [
    ...args,
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  fs.appendFileSync(path.join(root, 'src', 'b.js'), '\n// changed after full re-review\n');
  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, false);
  assert.equal(final.status, 'blocked');
  assert.equal(final.blockingReason, 'final-validation-failed');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'pass');
});

test('CODE file-set full re-review refreshes stale policy identity before final pass', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  const staleManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  staleManifest.fileSetFingerprint = '0'.repeat(64);
  staleManifest.exclusions = staleManifest.exclusions.filter((entry) => ![
    '.claude',
    '.codex',
    '.codegraph',
    '.gemini',
    '.req-to-plan'
  ].includes(entry));
  fs.writeFileSync(start.manifestPath, formatManifestV2(staleManifest));

  await runWorkflowCommand('context', [
    ...args,
    '--phase',
    'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const refreshedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.notEqual(refreshedManifest.fileSetFingerprint, '0'.repeat(64));
  assert.ok(refreshedManifest.exclusions.includes('.codegraph'));

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

test('PR file-set full re-review refreshes stale identity (incl head) before final pass', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  // Corrupt the stored PR identity: zero the fingerprint AND the head revision, so a pass can
  // only be reached if record-review re-anchors the full PR identity, not just the fingerprint.
  const staleManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  staleManifest.fileSetFingerprint = '0'.repeat(64);
  staleManifest.head = '0'.repeat(40);
  fs.writeFileSync(start.manifestPath, formatManifestV2(staleManifest));

  await runWorkflowCommand('context', [...args, '--phase', 'full-re-review'], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const refreshedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.notEqual(refreshedManifest.fileSetFingerprint, '0'.repeat(64));
  assert.notEqual(refreshedManifest.head, '0'.repeat(40));
  assert.match(refreshedManifest.head, /^[0-9a-f]{40}$/);

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
});

test('PR file-set end-fix accepts a fix report missing optional Verification', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 99;\n');

  const noVerification = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: noVerification });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assert.equal(Object.hasOwn(endFix, 'verification'), false);
  assert.doesNotMatch(fs.readFileSync(endFix.fixReportPath, 'utf8'), /"verification"/);
});

test('PR file-set end-fix blocks a fix that writes outside the recorded file set', async (t) => {
  const root = makePrRepo(t);
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  // Write a file NOT in the recorded set (src/a.js / src/b.js).
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'unrelated.js'), 'module.exports = 5;\n');

  const declaresInSet = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- node --check src/a.js: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: declaresInSet });
  // The unrelated.js untracked write makes the worktree fall outside the recorded set.
  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
});

test('PR file-set snapshot begin-fix supports deleted files in the PR file set', async (t) => {
  const root = makePrRepoWithDeletedFile(t);
  const args = practicalArgs(['review-fix-pr', 'base=main', 'guard=snapshot']);
  const start = await runWorkflowCommand('start', args, { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
});

test('PR file-set git begin-fix rejects dirty PR members before the first route-owned fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// local dirty edit before first fix\n');
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
});

test('PR file-set snapshot begin-fix rejects clean file-set commits after triage before first fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const reviewedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 22;\n');
  git(root, ['add', 'src/a.js']);
  git(root, ['commit', '-m', 'unreviewed follow-up']);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });

  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'unexpected-worktree-change');
  assert.equal(fs.existsSync(path.join(start.targetStateDir, 'file-set-baseline.json')), false);
  const blockedManifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(blockedManifest.fixAttemptCount, 0);
  assert.equal(blockedManifest.fileSetFingerprint, reviewedManifest.fileSetFingerprint);
});

test('PR file-set begin-fix allows diff members inside CODE-excluded directories', async (t) => {
  const root = makePrRepoWithDistFile(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });

  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  assert.equal(beginFix.status, 'begin-fix');
  assert.equal(typeof beginFix.fixGuardReportPath, 'string');
  assert.match(fs.readFileSync(beginFix.fixGuardReportPath, 'utf8'), /"dist\/app\.js"/);
});

test('CODE file-set abort-fix restores monitored files from persisted baseline bodies', async (t) => {
  const root = makePrRepo(t);
  const codeReviewFail = REVIEW_FAIL;
  const targetPath = path.join(root, 'src', 'a.js');
  if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o640);

  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']), { cwd: root });
  assert.equal(start.ok, true);
  assert.equal(start.guardMode, 'snapshot');

  await runWorkflowCommand('context', practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: codeReviewFail });
  await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  const persistedBaseline = JSON.parse(fs.readFileSync(path.join(start.targetStateDir, 'file-set-baseline.json'), 'utf8'));
  assert.equal(persistedBaseline.entries.every((entry) => !Object.hasOwn(entry, 'body')), true);
  assert.equal(persistedBaseline.entries.every((entry) => entry.missing || typeof entry.bodyPath === 'string'), true);
  if (process.platform !== 'win32') {
    assert.equal(persistedBaseline.entries.find((entry) => entry.path === 'src/a.js').mode, 0o640);
  }

  const before = fs.readFileSync(targetPath, 'utf8');
  const edited = 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n';
  fs.writeFileSync(targetPath, edited);
  if (process.platform !== 'win32') fs.chmodSync(targetPath, 0o755);

  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(aborted.status, 'checkpoint');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), before, 'abort must restore the monitored file body');
  if (process.platform !== 'win32') assert.equal(fs.statSync(targetPath).mode & 0o7777, 0o640);
});

test('CODE file-set snapshot end-fix reloads a persisted permission-only change', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are required');
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const targetPath = path.join(root, 'src', 'a.js');
  fs.chmodSync(targetPath, 0o640);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.chmodSync(targetPath, 0o755);
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });

  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assert.equal(endFix.currentPhase, 'diff-review');
});

test('CODE file-set abort-fix blocks rollback when the persisted baseline is missing', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const targetPath = path.join(root, 'src', 'a.js');
  const before = fs.readFileSync(targetPath, 'utf8');
  const edited = `${before}\n// partial fixer edit without readable baseline\n`;
  fs.writeFileSync(targetPath, edited);
  fs.rmSync(path.join(start.targetStateDir, 'file-set-baseline.json'));

  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.status, 'blocked');
  assert.equal(aborted.blockingReason, 'rollback-unavailable');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), edited, 'abort must not claim rollback when baseline is missing');
});

test('CODE file-set abort-fix blocks rollback when a persisted baseline body is corrupt', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const targetPath = path.join(root, 'src', 'a.js');
  const before = fs.readFileSync(targetPath, 'utf8');
  const edited = `${before}\n// partial fixer edit before corrupt rollback\n`;
  fs.writeFileSync(targetPath, edited);
  const baseline = JSON.parse(fs.readFileSync(path.join(start.targetStateDir, 'file-set-baseline.json'), 'utf8'));
  const targetEntry = baseline.entries.find((entry) => entry.path === 'src/a.js');
  assert.ok(targetEntry && targetEntry.bodyPath, 'baseline must persist a body path for src/a.js');
  fs.writeFileSync(path.join(start.targetStateDir, targetEntry.bodyPath), 'corrupt rollback body\n');

  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.status, 'blocked');
  assert.equal(aborted.blockingReason, 'rollback-unavailable');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), edited, 'abort must not restore a corrupt baseline body');
});

test('CODE file-set abort-fix restores an originally empty monitored file', async (t) => {
  const root = makePrRepo(t);
  fs.writeFileSync(path.join(root, 'src', 'empty.js'), '');
  git(root, ['add', 'src/empty.js']);
  git(root, ['commit', '-m', 'add empty source']);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const emptyPath = path.join(root, 'src', 'empty.js');
  fs.writeFileSync(emptyPath, 'module.exports = "filled";\n');
  const aborted = await runWorkflowCommand('abort-fix', [
    start.targetStateDir,
    '--status',
    'checkpoint',
    '--reason',
    'checkpoint-requested',
    '--json'
  ], { cwd: root });
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(aborted.status, 'checkpoint');
  assert.equal(fs.readFileSync(emptyPath, 'utf8'), '');
});

test('PR file-set DIFF-FAIL stops at the round limit instead of scheduling another fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });

  const diffFail = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix still misses the required behavior.',
    '  required_action: Rework the fix manually.'
  ].join('\n');
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: diffFail });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(diff.stopReason, 'round-limit');
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.equal(manifest.currentPhase, 'final');
  assert.equal(manifest.statusReason, 'round-limit');
  assert.equal(manifest.currentRound, 1);
  const ledger = parseLedger(fs.readFileSync(start.ledgerPath, 'utf8'));
  assert.equal(ledger.issues.find((issue) => issue.id === 'ISSUE-001').status, 'deferred');
});

test('CODE file-set snapshot end-fix blocks writes outside the recorded file set', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src', 'guard=snapshot']);

  const start = await runWorkflowCommand('start', args, { cwd: root });
  await runWorkflowCommand('context', args, { cwd: root });
  await runWorkflowCommand('record-review', [
    ...args,
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  await runWorkflowCommand('record-triage', [
    ...args,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(root, 'outside.js'), 'module.exports = "outside";\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'unexpected-worktree-change');
});

test('CODE file-set git end-fix blocks files created in scope after begin-fix', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  fs.writeFileSync(path.join(root, 'src', 'created-after-begin.js'), 'module.exports = "late";\n');

  const reportDeclaringLateFile = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '- src/created-after-begin.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- node --check src/a.js: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: reportDeclaringLateFile });

  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.blockingReason, 'fix-report-mismatch');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('CODE file-set git end-fix compares changes against the current begin-fix baseline', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const firstBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  const firstEnd = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(firstEnd.ok, true, JSON.stringify(firstEnd));

  const diffFail = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix still misses the required behavior.',
    '  required_action: Rework the fix.'
  ].join('\n');
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: diffFail });
  assert.equal(diff.ok, true, JSON.stringify(diff));

  const secondBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:05:00.000Z')
  });
  assert.equal(secondBegin.ok, true, JSON.stringify(secondBegin));

  const secondEnd = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(secondEnd.ok, false);
  assert.equal(secondEnd.status, 'blocked');
  assert.equal(secondEnd.blockingReason, 'fix-report-mismatch');
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('CODE file-set retry begin-fix recovers after a transient out-of-set end-fix block', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(beginFix.status, 'begin-fix');

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// fixed transient guard case\n');
  fs.writeFileSync(path.join(root, 'outside.js'), 'module.exports = "temporary";\n');
  const blocked = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockingReason, 'unexpected-worktree-change');

  fs.rmSync(path.join(root, 'outside.js'));
  const retry = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(retry.status, 'begin-fix');
  assert.equal(retry.nextAction, 'retry end-fix with a valid fix report');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.status, 'end-fix');
});

test('CODE file-set retry begin-fix recovers after a fix-report-mismatch end-fix block', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(beginFix.status, 'begin-fix');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fixAttemptCount, 1);

  // The report credits src/a.js but no edit was actually written, so the actual changed set
  // is empty and end-fix blocks as a (correctable) fix-report-mismatch rather than a guard breach.
  const blocked = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockingReason, 'fix-report-mismatch');

  // begin-fix retries the still-counted round and returns to fix WITHOUT burning a new fix
  // attempt; once the declared edit is actually applied, end-fix succeeds.
  const retry = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], { cwd: root });
  assert.equal(retry.status, 'begin-fix');
  assert.equal(retry.nextAction, 'retry end-fix with a valid fix report');
  assert.equal(
    parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fixAttemptCount,
    1,
    'a blocked-fix retry must not consume a new fix attempt'
  );

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// applied the declared fix on retry\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.status, 'end-fix');
});

test('CODE file-set later begin-fix rejects user edits to the prior-round allowed set', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const firstBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 42;\n');
  const firstEnd = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(firstEnd.ok, true, JSON.stringify(firstEnd));

  const diffFail = [
    'DIFF-FAIL',
    'Findings:',
    '- issue_id: ISSUE-001',
    '  problem: Fix still misses the required behavior.',
    '  required_action: Rework the fix.'
  ].join('\n');
  const diff = await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: diffFail });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'fix');

  fs.appendFileSync(path.join(root, 'src', 'a.js'), '\n// user edit before next begin-fix\n');
  const secondBegin = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:05:00.000Z')
  });
  assert.equal(secondBegin.ok, false);
  assert.equal(secondBegin.status, 'blocked');
  assert.equal(secondBegin.blockingReason, 'unexpected-worktree-change');
});

test('CODE file-set begin-fix returns corrupt-lock workflow JSON for invalid leases', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const lockDir = path.join(start.targetStateDir, 'LOCK');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lease.json'), '{not json');

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });

  assert.equal(beginFix.ok, false);
  assert.equal(beginFix.status, 'blocked');
  assert.equal(beginFix.blockingReason, 'corrupt-lock');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'blocked');
});

test('PR file-set concurrent begin-fix attempts preserve the active fix manifest', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-pr', 'base=main']);
  const start = await reachFileSetFixStage(root, args);
  const beginArgs = [start.targetStateDir, '--json'];
  const now = new Date('2026-06-03T00:00:00.000Z');

  const results = await Promise.all([
    runWorkflowCommand('begin-fix', beginArgs, { cwd: root, now }),
    runWorkflowCommand('begin-fix', beginArgs, { cwd: root, now })
  ]);

  assert.equal(results.every((result) => result.ok === true), true, JSON.stringify(results));
  assert.equal(results.every((result) => result.status === 'begin-fix'), true, JSON.stringify(results));
  assert.equal(new Set(results.map((result) => result.leaseId)).size, 1);
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'fix');
  assert.equal(manifest.blockingReason, 'none');
  assert.equal(manifest.fixAttemptCount, 1);
});

test('CODE file-set refresh-lock returns corrupt-lock workflow JSON for invalid leases', async (t) => {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  const lockDir = path.join(start.targetStateDir, 'LOCK');
  fs.writeFileSync(path.join(lockDir, 'lease.json'), '{not json');

  const refresh = await runWorkflowCommand('refresh-lock', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:01:00.000Z')
  });

  assert.equal(refresh.ok, false);
  assert.equal(refresh.status, 'blocked');
  assert.equal(refresh.blockingReason, 'corrupt-lock');
  assert.equal(refresh.errorCode, 'ERR_CORRUPT_LOCK');
  assert.equal(refresh.targetStateDir, start.targetStateDir);
  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'blocked');
  assert.equal(manifest.blockingReason, 'corrupt-lock');
});

test('no-state read-only CODE advisory review runs without auto-fix state and never claims pass', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('context', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.mode, 'read-only');
  assert.notEqual(result.status, 'pass');
  assert.equal(result.createdTargetState, false);
  assert.equal(result.targetStateDir, null);
  assert.equal(result.contextPackSkeleton.fileSet.routeKind, 'code');
  assert.ok(result.contextPackSkeleton.fileSet.fileCount >= 2);
  assert.equal(typeof result.reviewGuard, 'string');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
});

test('no-state read-only CODE practical review preserves practical assurance', async (t) => {
  const root = makePrRepo(t);
  const result = await runWorkflowCommand('context', [
    'review-fix-code',
    'scope=src',
    'read-only',
    '--no-state',
    '--assurance',
    'practical',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--json'
  ], { cwd: root });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'context');
  assert.equal(result.assurance, 'practical');
  assert.equal(result.assuranceNormalizedFrom, null);
  assert.equal(result.contextPackSkeleton.assurance, 'practical');
  assert.equal(typeof result.reviewGuard, 'string');
});

test('no-state PR advisory read-only records review, triage, and finalize without persistent state', async (t) => {
  const root = makePrRepo(t);
  const context = await runWorkflowCommand('context', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--json'
  ], { cwd: root });
  assert.equal(context.ok, true);
  assert.equal(typeof context.reviewGuard, 'string');

  const review = await runWorkflowCommand('record-review', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--review-guard',
    context.reviewGuard,
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  assert.equal(review.ok, true);
  assert.equal(review.status, 'recorded-review');
  assert.equal(typeof review.stateToken, 'string');

  const triage = await runWorkflowCommand('record-triage', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--phase',
    'initial-review',
    '--state-token',
    review.stateToken,
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true);
  assert.equal(triage.status, 'recorded-triage');

  const final = await runWorkflowCommand('finalize', [
    'review-fix-pr',
    'base=main',
    'read-only',
    '--no-state',
    '--runtime-platform',
    'codex',
    '--runtime-subagent-probe',
    'ready',
    '--runtime-stdin-handoff',
    'ready',
    '--state-token',
    triage.stateToken,
    '--final-response-stdin'
  ], { cwd: root, stdin: noStateReadOnlyFindings() });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'read-only-findings');
  assert.notEqual(final.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, '.drfx', 'targets')), false);
});

test('PR file-set round-limit gate stops with deferrals instead of a clean pass', async (t) => {
  const root = makePrRepo(t);
  // rounds=1 with one already-completed fix attempt forces the limit at the loop boundary.
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']), { cwd: root });
  assert.equal(start.ok, true);

  // Simulate a prior completed fix round so the round-limit gate bites on the next triage.
  const manifestPath = start.manifestPath;
  const original = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, original.replace('Fix attempt count: 0', 'Fix attempt count: 1'));

  await runWorkflowCommand('context', practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']), { cwd: root });
  await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']),
    '--phase',
    'initial-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_FAIL });
  const triage = await runWorkflowCommand('record-triage', [
    ...practicalArgs(['review-fix-pr', 'base=main', 'rounds=1']),
    '--triage-stdin'
  ], { cwd: root, stdin: TRIAGE_ACCEPT });
  assert.equal(triage.ok, true);
  assert.equal(triage.stopReason, 'round-limit');
  const manifest = parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.status, 'stopped-with-deferrals');
  assert.notEqual(manifest.status, 'pass');
});

test('PR file-set finalize archives the state dir on pass', async (t) => {
  const root = makePrRepo(t);
  const start = await reachFileSetFixStage(root, practicalArgs(['review-fix-pr', 'base=main']));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase', 'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase', 'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  const targetStateDir = start.targetStateDir;
  const final = await runWorkflowCommand('finalize', [
    targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(fs.existsSync(targetStateDir), false);
  assert.match(final.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(fs.existsSync(final.archivedStatePath), true);
  assert.equal(fs.existsSync(path.join(final.archivedStatePath, 'MANIFEST.md')), true);
});

test('PR file-set finalize archive failure reports repair action in result and summary', async (t) => {
  const root = makePrRepo(t);
  const start = await reachFileSetFixStage(root, practicalArgs(['review-fix-pr', 'base=main']));
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  assert.equal(endFix.ok, true, JSON.stringify(endFix));

  await runWorkflowCommand('record-diff-review', [
    start.targetStateDir,
    '--result-stdin',
    '--json'
  ], { cwd: root, stdin: DIFF_OK });

  await runWorkflowCommand('context', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase', 'full-re-review'
  ], { cwd: root });
  const fullReview = await runWorkflowCommand('record-review', [
    ...practicalArgs(['review-fix-pr', 'base=main']),
    '--phase', 'full-re-review',
    '--result-stdin'
  ], { cwd: root, stdin: REVIEW_PASS });
  assert.equal(fullReview.ok, true, JSON.stringify(fullReview));

  fs.writeFileSync(path.join(root, '.drfx', 'archived'), 'not a dir');

  const final = await runWorkflowCommand('finalize', [
    start.targetStateDir,
    '--final-response-stdin',
    '--json'
  ], { cwd: root, stdin: finalPass('src/a.js') });

  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.status, 'pass');
  assert.equal(final.archivedStatePath, undefined);
  assert.ok(final.archiveWarning, 'archive failure is surfaced as a warning');
  assert.match(final.nextAction, /delete or reset.*file-set state directory.*retry/i);
  assert.equal(fs.existsSync(start.targetStateDir), true);

  const summary = fs.readFileSync(path.join(start.targetStateDir, 'SUMMARY.md'), 'utf8');
  assert.match(summary, /Status: pass/);
  assert.match(summary, /Next action: delete or reset the leftover terminal file-set state directory, then retry/);
});

test('PR file-set resume archives a live passed state and starts a fresh review', async (t) => {
  const root = makePrRepo(t);
  // Start to get a real manifest with correct PR identity (base, head, merge-base, fingerprint).
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  const manifestPath = start.manifestPath;

  // Mutate the manifest status to 'pass' to simulate a leftover terminal state.
  const before = parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, formatManifestV2({ ...before, status: 'pass', currentPhase: 'final' }));

  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume']), { cwd: root });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'review');                  // fresh file-set start
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.notEqual(result.errorCode, 'ERR_FILE_SET_STALE_IDENTITY');
  // archived state dir is accessible at the archive path
  assert.equal(fs.existsSync(result.archivedStatePath), true);
  // fresh manifest recreated at the same target key path by start
  const freshManifest = parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(freshManifest.status, 'review');
  assert.equal(freshManifest.currentPhase, 'review');
});

test('CODE file-set resume preserves archivedStatePath when fresh start fails after archiving a live passed state', async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fs-no-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');

  const start = await runWorkflowCommand('start', practicalArgs([
    'review-fix-code',
    'scope=src',
    'guard=snapshot'
  ]), { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  const before = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  fs.writeFileSync(start.manifestPath, formatManifestV2({ ...before, status: 'pass', currentPhase: 'final' }));

  const result = await runWorkflowCommand('start', practicalArgs([
    'review-fix-code',
    'scope=src',
    'resume'
  ]), { cwd: root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.statusReason, 'git-guard-unavailable');
  assert.match(result.archivedStatePath, /\.drfx\/archived\/.+/);
  assert.equal(fs.existsSync(result.archivedStatePath), true);
  assert.equal(fs.existsSync(path.join(result.archivedStatePath, 'MANIFEST.md')), true);
  assert.equal(fs.existsSync(start.targetStateDir), false, 'old passed file-set state was moved before fresh start failed');
});

test('PR file-set resume archive failure blocks without fresh-starting', async (t) => {
  const root = makePrRepo(t);
  // Start to get a real manifest with correct PR identity.
  const start = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main']), { cwd: root });
  assert.equal(start.ok, true, JSON.stringify(start));

  const targetStateDir = start.targetStateDir;
  const manifestPath = start.manifestPath;

  // Mutate the manifest status to 'pass' to simulate a leftover terminal state.
  const before = parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, formatManifestV2({ ...before, status: 'pass', currentPhase: 'final' }));

  // Force archive failure: write a regular file where the archive dir would be created.
  fs.writeFileSync(path.join(root, '.drfx', 'archived'), 'not a dir');

  const result = await runWorkflowCommand('start', practicalArgs(['review-fix-pr', 'base=main', 'resume']), { cwd: root });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'state-validation-failed');
  assert.ok(result.archiveWarning, 'archive failure is surfaced as a warning');
  assert.equal(result.archivedStatePath, undefined);
  assert.notEqual(result.errorCode, 'ERR_FILE_SET_STALE_IDENTITY');
  // old passed state remains for operator repair
  assert.equal(fs.existsSync(targetStateDir), true);
  const manifest = parseManifestV2(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.status, 'pass');
});

// ---------------------------------------------------------------------------
// PLAN-TASK-006: Unit-review lifecycle module (lib/workflow/file-set-unit-review.js).
//
// These tests exercise the four composed functions directly against a real CODE
// project tree + a written project-review/units.json plan. They assert: a bounded
// per-unit reviewer context (only the unit's files + suggestedRefs), an oversize
// unit's metadata-only context + forced coverage blocker, recordUnitReview's
// summary/findings shapes, the cache-skip vs contract-edit forced re-review, resume
// from the first unverified unit, projectReviewFingerprint drift → stale/blocked, and
// unitsToReReview (changed ∪ suggestedRefs-hit ∪ extraReads-hit).
// ---------------------------------------------------------------------------

const {
  unitContext,
  recordUnitReview,
  nextUnit,
  unitsToReReview
} = require('../lib/workflow/file-set-unit-review');
const {
  assemblePartitionPlan,
  writeProjectReviewPlan
} = require('../lib/workflow/file-set-context');
const { resolveCodeInventory, streamingContentId } = require('../lib/target-context');

// Build a small CODE project root with a couple of importing JS files so the
// partition plan produces suggestedRefs, plus write a units.json plan under
// .drfx/targets/<key>/project-review/. Returns { root, targetStateDir, plan }.
async function makeUnitReviewProject(t, { oversize = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-unit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // a.js imports ./helper — helper.js becomes a suggestedRef of a.js's unit.
  fs.writeFileSync(path.join(root, 'src', 'helper.js'), 'module.exports = function helper() { return 1; };\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), "const helper = require('./helper');\nmodule.exports = helper;\n");
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 3;\n');
  if (oversize) {
    // A single file larger than the unit byte budget → its own oversize_file unit.
    fs.writeFileSync(path.join(root, 'src', 'big.js'), `module.exports = ${'/* pad */ '.repeat(120000)}1;\n`);
  }
  const targetStateDir = path.join(root, '.drfx', 'targets', 'whole-root');
  fs.mkdirSync(targetStateDir, { recursive: true });

  const { inventory, projectReviewFingerprint } = await resolveCodeInventory({ cwd: root, scopes: [] });
  // Small byte budget so a.js/helper.js/b.js partition into more than one unit, exercising
  // the multi-unit resume + bounded-context paths. Budget 70 keeps a.js (61B) a NORMAL unit
  // that resolves helper.js as a suggestedRef, while helper.js+b.js land in a second unit.
  const plan = assemblePartitionPlan({
    inventory,
    projectReviewFingerprint,
    projectRoot: root,
    unitByteBudget: 70
  });
  writeProjectReviewPlan(targetStateDir, plan);
  return { root, targetStateDir, plan };
}

function unitReviewPayload({ unitId, reviewed = true, coverageRisk = 'none', skippedLines = ['- none'], extraReads = [] }) {
  const lines = [
    `Unit: ${unitId}`,
    `Reviewed: ${reviewed}`,
    `Coverage risk: ${coverageRisk}`,
    'Skipped:',
    ...skippedLines,
    'Extra reads:'
  ];
  if (extraReads.length === 0) {
    lines.push('- none');
  } else {
    for (const r of extraReads) lines.push(`- path: ${r.path}  contentId: ${r.contentId}`);
  }
  lines.push('Contracts touched:', '- none');
  return lines.join('\n');
}

const REVIEWER_PASS = ['PASS', 'Summary: Unit reviewed clean.'].join('\n');

function unitById(plan, id) {
  return plan.units.find((u) => u.unit_id === id);
}

test('unitContext: a partitioned unit context contains exactly the unit files + suggestedRefs', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  // Find the unit that contains src/a.js — it should carry helper.js as a suggestedRef.
  const aUnit = plan.units.find((u) => u.files.some((f) => f.path === 'src/a.js'));
  assert.ok(aUnit, 'a.js unit exists');
  assert.deepEqual(aUnit.suggestedRefs.map((r) => r.path), ['src/helper.js']);

  const ctx = unitContext({ targetStateDir, projectRoot: root, unitId: aUnit.unit_id });
  assert.equal(ctx.ok, true);
  assert.equal(ctx.unitId, aUnit.unit_id);
  assert.equal(ctx.oversize, false);
  // Bounded: the context pack carries ONLY the unit's files, no other inventory file.
  const packFiles = ctx.contextPackSkeleton.fileSet.files.map((f) => f.path).sort();
  assert.deepEqual(packFiles, aUnit.files.map((f) => f.path).sort());
  // suggestedRefs are injected as read-only references and contain helper.js.
  const refPaths = ctx.contextPackSkeleton.references.map((r) => r.path);
  assert.ok(refPaths.includes('src/helper.js'), 'helper.js is a read-only reference');
  assert.ok(ctx.contextPackSkeleton.references.every((r) => r.readOnly === true));
  assert.equal(ctx.contextPackSkeleton.reviewMode, 'partitioned');
  assert.equal(ctx.contextPackSkeleton.unit_id, aUnit.unit_id);
  // No out-of-set leakage: src/b.js (a different unit) is not in this unit's pack.
  assert.ok(!packFiles.includes('src/b.js') || aUnit.files.some((f) => f.path === 'src/b.js'));
  // A per-unit context manifest is written under the target key.
  assert.ok(fs.existsSync(ctx.contextManifestPath));
});

test('unitContext: an oversize unit returns metadata-only context + forced coverage blocker, never a body', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t, { oversize: true });
  const oversizeUnit = plan.units.find((u) => u.oversize_file === true);
  assert.ok(oversizeUnit, 'oversize unit exists');

  const ctx = unitContext({ targetStateDir, projectRoot: root, unitId: oversizeUnit.unit_id });
  assert.equal(ctx.oversize, true);
  assert.equal(ctx.nextAction, 'record oversize coverage blocker');
  // Metadata only: NO context pack with file bodies — the unit's body is never loaded.
  assert.equal(ctx.contextPackSkeleton, undefined);
  assert.equal(ctx.contextManifestPath, undefined);
  // The unit metadata is surfaced so the caller can record the blocker.
  assert.equal(ctx.coverageRisk, 'high');
});

test('recordUnitReview: writes summaries/<id>.json + findings/<id>.json with the right shapes', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];
  const rec = await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: unit.unit_id,
    coverageReceipt: unitReviewPayload({ unitId: unit.unit_id }),
    reviewerFindings: REVIEWER_PASS
  });
  assert.equal(rec.ok, true);
  assert.equal(rec.reused, false);

  const summary = JSON.parse(fs.readFileSync(
    path.join(targetStateDir, 'project-review', 'summaries', `${unit.unit_id}.json`), 'utf8'));
  assert.equal(summary.reviewed, true);
  assert.equal(summary.coverage_risk, 'none');
  assert.match(summary.reviewCacheKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(summary.extraReads, []);
  assert.ok(Array.isArray(summary.skipped));
  assert.ok(Array.isArray(summary.contractsTouched));

  const findings = JSON.parse(fs.readFileSync(
    path.join(targetStateDir, 'project-review', 'findings', `${unit.unit_id}.json`), 'utf8'));
  assert.equal(findings.result, 'PASS');
});

test('recordUnitReview: rejects stale projectReviewFingerprint before writing summaries', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 999;\n');

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({ unitId: unit.unit_id }),
      reviewerFindings: REVIEWER_PASS
    }),
    (error) => error.code === 'ERR_STATE_VALIDATION_FAILED' &&
      /stale-fingerprint-mismatch/.test(String(error.message))
  );

  assert.equal(fs.existsSync(path.join(
    targetStateDir, 'project-review', 'summaries', `${unit.unit_id}.json`
  )), false);
  assert.equal(fs.existsSync(path.join(
    targetStateDir, 'project-review', 'findings', `${unit.unit_id}.json`
  )), false);
});

test('recordUnitReview: rejects reviewed false with coverage_risk none before persistence', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({
        unitId: unit.unit_id,
        reviewed: false,
        coverageRisk: 'none'
      }),
      reviewerFindings: REVIEWER_PASS
    }),
    (error) => error.code === 'ERR_UNIT_REVIEW_INCONSISTENT_RECEIPT' &&
      /coverage_risk:none requires Reviewed:true/.test(String(error.message))
  );

  assert.equal(fs.existsSync(path.join(
    targetStateDir, 'project-review', 'summaries', `${unit.unit_id}.json`
  )), false);
});

test('recordUnitReview: rejects a non-empty Skipped list with coverage_risk none before persistence', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({
        unitId: unit.unit_id,
        coverageRisk: 'none',
        skippedLines: ['- path: src/a.js  reason: context-limit']
      }),
      reviewerFindings: REVIEWER_PASS
    }),
    (error) => error.code === 'ERR_UNIT_REVIEW_SKIPPED_WITH_NONE' &&
      /coverage_risk:none requires Skipped:none/.test(String(error.message))
  );

  assert.equal(fs.existsSync(path.join(
    targetStateDir, 'project-review', 'summaries', `${unit.unit_id}.json`
  )), false);
});

test('recordUnitReview: rejects a coverage receipt for a different unit', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  assert.ok(plan.units.length >= 2, 'multi-unit plan');

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: plan.units[1].unit_id,
      coverageReceipt: unitReviewPayload({ unitId: plan.units[0].unit_id }),
      reviewerFindings: REVIEWER_PASS
    }),
    /does not match requested unit/
  );
});

test('recordUnitReview: rejects unsafe extraRead paths before persistence', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({
        unitId: unit.unit_id,
        extraReads: [{ path: '../outside.js', contentId: 'a'.repeat(64) }]
      }),
      reviewerFindings: REVIEWER_PASS
    }),
    /invalid Extra reads path/
  );

  assert.equal(fs.existsSync(path.join(
    targetStateDir, 'project-review', 'summaries', `${unit.unit_id}.json`
  )), false);
});

test('recordUnitReview: rejects malformed extraRead contentId before persistence', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({
        unitId: unit.unit_id,
        extraReads: [{ path: 'src/b.js', contentId: 'not-a-sha256' }]
      }),
      reviewerFindings: REVIEWER_PASS
    }),
    /invalid Extra reads contentId/
  );
});

test('recordUnitReview: rejects extraRead contentId mismatches before persistence', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const unit = plan.units[0];

  await assert.rejects(
    recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({
        unitId: unit.unit_id,
        extraReads: [{ path: 'src/b.js', contentId: '0'.repeat(64) }]
      }),
      reviewerFindings: REVIEWER_PASS
    }),
    (error) => error.code === 'ERR_UNIT_REVIEW_EXTRA_READ_STALE' &&
      /extraRead contentId/.test(String(error.message))
  );

  assert.equal(fs.existsSync(path.join(
    targetStateDir, 'project-review', 'summaries', `${unit.unit_id}.json`
  )), false);
});

test('recordUnitReview: an oversize unit writes the FIXED high-risk summary, never claims coverage', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t, { oversize: true });
  const oversizeUnit = plan.units.find((u) => u.oversize_file === true);
  const rec = await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: oversizeUnit.unit_id
  });
  assert.equal(rec.ok, true);
  const summary = JSON.parse(fs.readFileSync(
    path.join(targetStateDir, 'project-review', 'summaries', `${oversizeUnit.unit_id}.json`), 'utf8'));
  assert.equal(summary.reviewed, false);
  assert.equal(summary.coverage_risk, 'high');
  assert.equal(summary.skipped_reason, 'single-file-over-budget');
});

test('recordUnitReview cache skip: an unchanged unit reuses its prior summary; a contract edit forces re-review', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const aUnit = plan.units.find((u) => u.files.some((f) => f.path === 'src/a.js'));
  const helperRef = aUnit.suggestedRefs.find((r) => r.path === 'src/helper.js');
  assert.ok(helperRef, 'helper.js suggestedRef present');

  // First review records the summary.
  const first = await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: aUnit.unit_id,
    coverageReceipt: unitReviewPayload({ unitId: aUnit.unit_id }),
    reviewerFindings: REVIEWER_PASS
  });
  assert.equal(first.reused, false);
  const storedKey = first.reviewCacheKey;
  assert.match(storedKey, /^[0-9a-f]{64}$/);

  // Re-recording WITHOUT any change → cache skip (prior summary reused, no re-review).
  const again = await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: aUnit.unit_id,
    coverageReceipt: unitReviewPayload({ unitId: aUnit.unit_id }),
    reviewerFindings: REVIEWER_PASS
  });
  assert.equal(again.reused, true, 'unchanged unit reuses prior summary');
  assert.equal(again.reviewCacheKey, storedKey);

  // Edit the suggestedRef (a contract file) → its contentId changes → cache key changes
  // → forced re-review (no cache reuse).
  fs.writeFileSync(path.join(root, 'src', 'helper.js'),
    'module.exports = function helper() { return 2; };\n');
  // The plan's stored suggestedRefs still carry the OLD contentId, but the unit's
  // member_digest is unchanged; the forced re-review is driven by nextUnit/cache
  // re-validation seeing the changed content. Recompute via the public helper to assert
  // the contentId actually moved.
  const newHelperId = await streamingContentId(path.join(root, 'src', 'helper.js'));
  assert.notEqual(newHelperId, helperRef.contentId, 'editing the contract file changes its contentId');

  const resume = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(resume.status, 'blocked');
  assert.equal(resume.statusReason, 'stale-fingerprint-mismatch');
});

test('nextUnit: stale extraReads invalidate a stored summary even when the project fingerprint is stable', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const aUnit = plan.units.find((u) => u.files.some((f) => f.path === 'src/a.js'));
  const dependencyPath = path.join(root, 'node_modules', 'external-contract.js');
  fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
  fs.writeFileSync(dependencyPath, 'module.exports = 1;\n');
  const dependencyContentId = await streamingContentId(dependencyPath);

  await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: aUnit.unit_id,
    coverageReceipt: unitReviewPayload({
      unitId: aUnit.unit_id,
      extraReads: [{ path: 'node_modules/external-contract.js', contentId: dependencyContentId }]
    }),
    reviewerFindings: REVIEWER_PASS
  });

  fs.writeFileSync(dependencyPath, 'module.exports = 2;\n');
  const resume = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(resume.status, 'next-unit');
  assert.equal(resume.unitId, aUnit.unit_id);
});

test('nextUnit: missing extraReads invalidate a stored summary even when the project fingerprint is stable', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const aUnit = plan.units.find((u) => u.files.some((f) => f.path === 'src/a.js'));
  const dependencyPath = path.join(root, 'node_modules', 'deleted-contract.js');
  fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
  fs.writeFileSync(dependencyPath, 'module.exports = 1;\n');
  const dependencyContentId = await streamingContentId(dependencyPath);

  await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: aUnit.unit_id,
    coverageReceipt: unitReviewPayload({
      unitId: aUnit.unit_id,
      extraReads: [{ path: 'node_modules/deleted-contract.js', contentId: dependencyContentId }]
    }),
    reviewerFindings: REVIEWER_PASS
  });

  fs.rmSync(dependencyPath);
  const resume = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(resume.status, 'next-unit');
  assert.equal(resume.unitId, aUnit.unit_id);
});

test('nextUnit: resume continues from the first unit lacking a valid summary', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  assert.ok(plan.units.length >= 2, 'multi-unit plan');

  // Nothing reviewed yet → next is the first unit in order.
  const first = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(first.status, 'next-unit');
  assert.equal(first.unitId, plan.units[0].unit_id);

  // Record a summary for the first unit, then resume → next is the second unit.
  await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: plan.units[0].unit_id,
    coverageReceipt: unitReviewPayload({ unitId: plan.units[0].unit_id }),
    reviewerFindings: REVIEWER_PASS
  });
  const second = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(second.status, 'next-unit');
  assert.equal(second.unitId, plan.units[1].unit_id);
});

test('nextUnit: every unit reviewed → all-units-reviewed', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  for (const unit of plan.units) {
    await recordUnitReview({
      targetStateDir,
      projectRoot: root,
      unitId: unit.unit_id,
      coverageReceipt: unitReviewPayload({ unitId: unit.unit_id }),
      reviewerFindings: REVIEWER_PASS
    });
  }
  const done = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(done.status, 'all-units-reviewed');
});

test('nextUnit: projectReviewFingerprint DRIFT returns stale/blocked, never a silent continue', async (t) => {
  const { root, targetStateDir } = await makeUnitReviewProject(t);
  // Mutate the tree so the live projectReviewFingerprint no longer matches units.json.
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'module.exports = 999;\n');
  const result = await nextUnit(targetStateDir, undefined, { projectRoot: root });
  assert.equal(result.status, 'blocked');
  assert.equal(result.statusReason, 'stale-fingerprint-mismatch');
  assert.equal(result.ok, false);
});

test('unitsToReReview: changed ∪ suggestedRefs-hit ∪ extraReads-hit, deterministic order', async (t) => {
  const { root, targetStateDir, plan } = await makeUnitReviewProject(t);
  const aUnit = plan.units.find((u) => u.files.some((f) => f.path === 'src/a.js'));
  const helperUnit = plan.units.find((u) => u.files.some((f) => f.path === 'src/helper.js'));
  assert.ok(aUnit && helperUnit);

  // Record a summary for aUnit that carries an extraRead on src/b.js.
  const bContentId = await streamingContentId(path.join(root, 'src', 'b.js'));
  await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: aUnit.unit_id,
    coverageReceipt: unitReviewPayload({
      unitId: aUnit.unit_id,
      extraReads: [{ path: 'src/b.js', contentId: bContentId }]
    }),
    reviewerFindings: REVIEWER_PASS
  });

  // (a) Direct change: editing helper.js re-includes the helper unit AND aUnit
  //     (helper.js is a suggestedRef of aUnit).
  const byHelper = unitsToReReview(['src/helper.js'], plan.units, targetStateDir);
  assert.ok(byHelper.includes(helperUnit.unit_id), 'changed unit included');
  assert.ok(byHelper.includes(aUnit.unit_id), 'suggestedRefs-hit unit included');

  // (c) extraReads hit: editing src/b.js re-includes aUnit (its stored extraRead).
  const byExtra = unitsToReReview(['src/b.js'], plan.units, targetStateDir);
  assert.ok(byExtra.includes(aUnit.unit_id), 'extraReads-hit unit included');

  // Deterministic order: sorted unit ids, no duplicates.
  const sorted = [...byHelper].slice().sort();
  assert.deepEqual(byHelper, sorted);
  assert.equal(new Set(byHelper).size, byHelper.length);
});

// ---------------------------------------------------------------------------
// PLAN-TASK-011 / Task 4 fork: post-fix integration for a PARTITIONED CODE target.
//
// After end-fix on a partitioned target (project-review/units.json present), the Task 4
// fork routes to applyPartitionedIncrement, which re-resolves the inventory, refreshes
// stale contentIds/projectReviewFingerprint, invalidates affected units, and transitions
// to checkpoint/review (not diff-review). A non-partitioned CODE fix flow is unchanged
// (falls through to diff-review as before).
// ---------------------------------------------------------------------------

// Write a deterministic, hand-crafted partitioned units.json under a resolved CODE
// target state dir. src/a.js lives in unit-001; unit-002 carries src/a.js as a
// suggestedRef; unit-003 owns src/b.js. The plan only needs reviewMode:'partitioned'
// + a units array for readUnitsPlan/unitsToReReview.
function writePartitionPlanForCodeTarget(targetStateDir) {
  const planDir = path.join(targetStateDir, 'project-review');
  fs.mkdirSync(planDir, { recursive: true });
  const plan = {
    reviewMode: 'partitioned',
    unitByteBudget: 4096,
    units: [
      {
        unit_id: 'unit-001',
        files: [{ path: 'src/a.js', size: 1, ext: '.js', contentId: 'sha256:a', unit_id: 'unit-001' }],
        member_digest: 'digest-001',
        suggestedRefs: [],
        oversize_file: false
      },
      {
        unit_id: 'unit-002',
        files: [{ path: 'src/b.js', size: 1, ext: '.js', contentId: 'sha256:b', unit_id: 'unit-002' }],
        member_digest: 'digest-002',
        // src/a.js (the file the fix touches) is a contract reference of unit-002.
        suggestedRefs: [{ path: 'src/a.js', contentId: 'sha256:a' }],
        oversize_file: false
      }
    ],
    crosscuttingBackstops: [],
    projectReviewFingerprint: 'fp-test'
  };
  fs.writeFileSync(path.join(planDir, 'units.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

async function writeActiveChunkPartitionPlanForCodeTarget(root, targetStateDir) {
  const inventoryResult = await resolveCodeInventory({ cwd: root, scopes: ['src'] });
  const plan = assemblePartitionPlan({
    inventory: inventoryResult.inventory,
    projectReviewFingerprint: inventoryResult.projectReviewFingerprint,
    userExcludes: inventoryResult.userExcludes,
    projectRoot: root,
    unitByteBudget: 100
  });
  assert.ok(plan.units.some((unit) => unit.oversize_chunk === true), 'test fixture must contain chunk units');
  writeProjectReviewPlan(targetStateDir, plan);
  return plan;
}

async function reachCodeFixStageWithBeginFix(t, { writePlan = false } = {}) {
  const root = makePrRepo(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  let plan = null;
  if (writePlan) plan = writePartitionPlanForCodeTarget(start.targetStateDir);
  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));
  return { root, args, start, plan };
}

test('partitioned CODE end-fix with an INACTIVE plan falls through to diff-review (not fork)', async (t) => {
  const { root, start } = await reachCodeFixStageWithBeginFix(t, { writePlan: true });

  // writePartitionPlanForCodeTarget writes a plan with projectReviewFingerprint:'fp-test' which
  // does NOT match the manifest fileSetFingerprint set by start. readActivePartitionedPlan
  // returns null → fork does not fire → falls through to the non-partitioned diff-review path.
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });

  // Inactive (fingerprint-mismatched) plan → non-partitioned path → ok:true, diff-review.
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.reviewMode, undefined, 'inactive plan must not surface partitioned reviewMode');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('partitioned CODE end-fix with an INACTIVE plan ignores extraReads-hit (falls through to diff-review)', async (t) => {
  const { root, start } = await reachCodeFixStageWithBeginFix(t, { writePlan: true });
  // Record a summary for unit-002 whose extraReads hit src/a.js (the changed file).
  const summariesDir = path.join(start.targetStateDir, 'project-review', 'summaries');
  fs.mkdirSync(summariesDir, { recursive: true });
  fs.writeFileSync(path.join(summariesDir, 'unit-002.json'), `${JSON.stringify({
    reviewed: true,
    coverage_risk: 'none',
    reviewCacheKey: 'k',
    extraReads: [{ path: 'src/a.js', contentId: 'sha256:a' }]
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });

  // The plan is inactive (fingerprint mismatch) → fork returns null → non-partitioned diff-review path.
  // Before Task 4 the stale-freshness check blocked this. Now an inactive plan simply falls through.
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.reviewMode, undefined, 'inactive plan must not surface partitioned reviewMode');
  assert.equal(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('partitioned CODE end-fix re-splits a changed oversize chunk file', async (t) => {
  const root = makeCodeRepoWithChunkedFile(t);
  const args = practicalArgs(['review-fix-code', 'scope=src']);
  const start = await reachFileSetFixStage(root, args);
  const oldPlan = await writeActiveChunkPartitionPlanForCodeTarget(root, start.targetStateDir);
  const manifestBeforeFix = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  manifestBeforeFix.fileSetFingerprint = oldPlan.projectReviewFingerprint;
  fs.writeFileSync(start.manifestPath, formatManifestV2(manifestBeforeFix));
  const oldChunkIds = oldPlan.units
    .filter((unit) => unit.oversize_chunk === true && unit.sourcePath === 'src/big.js')
    .map((unit) => unit.unit_id);

  const beginFix = await runWorkflowCommand('begin-fix', [start.targetStateDir, '--json'], {
    cwd: root,
    now: new Date('2026-06-03T00:00:00.000Z')
  });
  assert.equal(beginFix.ok, true, JSON.stringify(beginFix));

  fs.writeFileSync(path.join(root, 'src', 'big.js'), Array.from({ length: 90 }, () => 'y').join('\n') + '\n');
  const fixReport = [
    'Fixed:',
    '- ISSUE-001: Updated the chunked implementation.',
    '',
    'Files changed:',
    '- src/big.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- node --check src/big.js: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');

  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: fixReport });

  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  assert.equal(endFix.reviewMode, 'partitioned');
  for (const unitId of oldChunkIds) {
    assert.ok(endFix.invalidatedUnitIds.includes(unitId), `old chunk ${unitId} must be invalidated`);
  }

  const manifest = parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'checkpoint');
  assert.equal(manifest.currentPhase, 'review');

  const refreshedPlan = JSON.parse(fs.readFileSync(path.join(start.targetStateDir, 'project-review', 'units.json'), 'utf8'));
  assert.equal(manifest.fileSetFingerprint, refreshedPlan.projectReviewFingerprint);
  const refreshedChunks = refreshedPlan.units.filter((unit) => unit.oversize_chunk === true && unit.sourcePath === 'src/big.js');
  assert.ok(refreshedChunks.length > 0, 'changed chunked source must remain represented as chunks');
  assert.ok(refreshedChunks.every((unit) => unit.sourceContentId !== oldPlan.units.find((old) => old.sourcePath === 'src/big.js').sourceContentId));
  for (const unit of refreshedChunks) {
    assert.ok(endFix.invalidatedUnitIds.includes(unit.unit_id), `refreshed chunk ${unit.unit_id} must be invalidated`);
  }
});

test('partitioned CODE end-fix still blocks a fix that writes outside the recorded file set', async (t) => {
  const { root, start } = await reachCodeFixStageWithBeginFix(t, { writePlan: true });

  // Declare + write a file NOT in the resolved file set (src/a.js / src/b.js).
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'src', 'unrelated.js'), 'module.exports = 5;\n');
  const declaresOutside = [
    'Fixed:',
    '- ISSUE-001: Restored the error handling.',
    '',
    'Files changed:',
    '- src/a.js',
    '- src/unrelated.js',
    '',
    'Not fixed:',
    '- none',
    '',
    'Verification:',
    '- node --check src/a.js: passed',
    '',
    'Residual risk:',
    '- none identified'
  ].join('\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: declaresOutside });

  // The in-set guard is unchanged: an outside-set fix is still blocked, no affected units surfaced.
  assert.equal(endFix.ok, false);
  assert.equal(endFix.status, 'blocked');
  assert.equal(endFix.affectedUnits, undefined);
  assert.notEqual(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).status, 'diff-review');
});

test('partitioned CODE begin-fix counting is unchanged: fixAttemptCount increments and the cap still holds', async (t) => {
  const { root, start } = await reachCodeFixStageWithBeginFix(t, { writePlan: true });
  // begin-fix recorded the first attempt — counting is independent of partitioning.
  assert.equal(Number(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fixAttemptCount), 1);

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });
  // The plan written by writePartitionPlanForCodeTarget has a mismatched fingerprint (inactive).
  // readActivePartitionedPlan returns null → fork does not fire → non-partitioned diff-review.
  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  // end-fix never burns fix attempts (counting lives in begin-fix only); fixAttemptCount stays at 1.
  assert.equal(Number(parseManifestV2(fs.readFileSync(start.manifestPath, 'utf8')).fixAttemptCount), 1);
});

test('non-partitioned CODE end-fix is byte-identical: no affected units, unchanged nextAction', async (t) => {
  const { root, start } = await reachCodeFixStageWithBeginFix(t, { writePlan: false });

  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = function safe() { try { return 2; } catch { return 0; } };\n');
  const endFix = await runWorkflowCommand('end-fix', [
    start.targetStateDir,
    '--fix-report-stdin',
    '--json'
  ], { cwd: root, stdin: FIX_REPORT_FILESET });

  assert.equal(endFix.ok, true, JSON.stringify(endFix));
  assert.equal(endFix.status, 'end-fix');
  // No project-review plan ⇒ today's behavior: no affected-unit surface, the original nextAction.
  assert.equal(endFix.affectedUnits, undefined);
  assert.equal(endFix.reReviewScope, undefined);
  assert.equal(endFix.nextAction, 'run record-diff-review');
});

// ---------------------------------------------------------------------------
// Task 6: partitioned fix rounds skip the diff-review requirement.
//
// buildFileSetFinalValidationState must return requiredDiffReviewComplete===true
// for a partitioned active target with a fix round, because the aggregate
// full-re-review PASS is the coverage proof (requiredFullReReviewComplete gates
// PASS instead). Non-partitioned fix rounds are unchanged: they still require a
// DIFF-OK diff-review report.
// ---------------------------------------------------------------------------

// Build a minimal in-memory metadata fixture for buildFileSetFinalValidationState.
// All report files are written to a real temp dir so readManifestReport can read them.
function makeFinalizeFxture(t, { withActivePlan }) {
  const tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-finalize-t6-')));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // reports/ must exist so validateTargetStateOwnedPath resolves correctly.
  const reportsDir = path.join(tmpDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const FINGERPRINT = 'fp-task6-match';
  const ROUND = 1;

  // Write a full-re-review PASS report (what recordAggregatePassAsFullReview produces).
  const reviewerReportName = 'full-review-round-001.md';
  const reviewerReportJson = JSON.stringify({
    normalized: { result: 'PASS', summary: 'All units PASS.', findings: [], warnings: [] },
    phase: 'full-re-review',
    producer: 'reviewer-subagent',
    round: ROUND
  }, null, 2);
  fs.writeFileSync(
    path.join(reportsDir, reviewerReportName),
    `# Reviewer Report\n\nRound: ${ROUND}\nPhase: full-re-review\nProducer: reviewer-subagent\nResult: PASS\n\n\`\`\`json\n${reviewerReportJson}\n\`\`\`\n`
  );

  // Write a fix report so hasFixRound is true (round matches currentRound).
  const fixReportName = 'fix-round-001.md';
  const fixReportJson = JSON.stringify({
    round: ROUND,
    normalized: { issueIds: [], filesChanged: [], verification: 'node --check: passed' }
  }, null, 2);
  fs.writeFileSync(
    path.join(reportsDir, fixReportName),
    `# Fix Report\n\nRound: ${ROUND}\n\n\`\`\`json\n${fixReportJson}\n\`\`\`\n`
  );

  if (withActivePlan) {
    // Write an ACTIVE partitioned units.json: projectReviewFingerprint must equal
    // manifest.fileSetFingerprint for readActivePartitionedPlan to return non-null.
    const planDir = path.join(tmpDir, 'project-review');
    fs.mkdirSync(planDir, { recursive: true });
    const plan = {
      reviewMode: 'partitioned',
      unitByteBudget: 4096,
      units: [
        {
          unit_id: 'unit-001',
          files: [{ path: 'src/a.js', size: 1, ext: '.js', contentId: 'sha256:a', unit_id: 'unit-001' }],
          member_digest: 'digest-001',
          suggestedRefs: [],
          oversize_file: false
        }
      ],
      crosscuttingBackstops: [],
      projectReviewFingerprint: FINGERPRINT
    };
    fs.writeFileSync(path.join(planDir, 'units.json'), `${JSON.stringify(plan, null, 2)}\n`);
  }

  const manifest = {
    currentRound: String(ROUND),
    fileSetFingerprint: FINGERPRINT,
    mode: 'review-and-fix',
    assurance: 'practical',
    runtimePlatform: 'claude',
    strictness: 'normal',
    lastFixReportPath: `reports/${fixReportName}`,
    lastReviewerReportPath: `reports/${reviewerReportName}`,
    lastDiffReviewReportPath: 'none'
  };

  const metadata = {
    targetStateDir: tmpDir,
    ledgerPath: path.join(tmpDir, 'ISSUES.md'), // does not exist → readLedgerIfPresent returns { issues: [] }
    routeKind: 'code',
    manifest
  };

  return metadata;
}

test('partitioned fix round finalizes without a diff-review report', (t) => {
  // Fixture A: active partitioned plan (fingerprint matches), fix report present,
  // full-re-review PASS report at currentRound. No DIFF-OK diff-review report.
  // Expected: requiredDiffReviewComplete===true (plan presence satisfies the requirement)
  //           requiredFullReReviewComplete===true (full-re-review PASS at round 1).
  const metadata = makeFinalizeFxture(t, { withActivePlan: true });
  const state = buildFileSetFinalValidationState(metadata);
  assert.equal(state.requiredDiffReviewComplete, true,
    'partitioned active plan must satisfy diff-review without a DIFF-OK report');
  assert.equal(state.requiredFullReReviewComplete, true,
    'full-re-review PASS at currentRound must satisfy requiredFullReReviewComplete');
});

test('non-partitioned fix round still requires DIFF-OK (no regression)', (t) => {
  // Fixture B: NO partitioned plan, fix report present, full-re-review PASS present,
  // but NO diff-review report. Non-partitioned path must still require DIFF-OK.
  // Expected: requiredDiffReviewComplete===false (unchanged behaviour).
  const metadata = makeFinalizeFxture(t, { withActivePlan: false });
  const state = buildFileSetFinalValidationState(metadata);
  assert.equal(state.requiredDiffReviewComplete, false,
    'non-partitioned fix round without DIFF-OK must yield requiredDiffReviewComplete===false');
});

// ---------------------------------------------------------------------------
// PLAN-TASK-015: oversize_chunk units take the NORMAL bounded-review path
//
// Pins that a chunk unit (oversize_chunk:true) is routed through the normal
// review path in both unitContext and recordUnitReview, while the legacy
// oversize_file:true unit keeps its forced-high coverage-blocker behaviour.
// ---------------------------------------------------------------------------

// Build a project with a file large enough to produce oversize_chunk units when
// partitioned with a budget that is smaller than the file but large enough per
// chunk.  Returns { root, targetStateDir, plan, chunkUnit } where chunkUnit is
// the first chunk unit in the plan.
async function makeChunkUnitReviewProject(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-chunk15-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // A file with 1 200 short lines so each individual line fits the budget
  // (~20 KB) but the whole file (~50 KB) exceeds it by 2-3x → three chunks.
  const lines = [];
  for (let i = 0; i < 1200; i++) lines.push(`const x${i} = ${i}; // padding comment here`);
  fs.writeFileSync(path.join(root, 'src', 'big.js'), lines.join('\n') + '\n');

  const targetStateDir = path.join(root, '.drfx', 'targets', 'whole-root');
  fs.mkdirSync(targetStateDir, { recursive: true });

  const { inventory, projectReviewFingerprint } = await resolveCodeInventory({ cwd: root, scopes: [] });
  const bigSize = inventory.find((r) => r.path === 'src/big.js').size;
  // Budget ≈ 40 % of the file so the file is over budget, but each of the ~800-
  // line chunks fits comfortably.
  const unitByteBudget = Math.floor(bigSize * 0.4);

  const plan = assemblePartitionPlan({ inventory, projectReviewFingerprint, projectRoot: root, unitByteBudget });
  writeProjectReviewPlan(targetStateDir, plan);

  const chunkUnit = plan.units.find((u) => u.oversize_chunk === true);
  assert.ok(chunkUnit, 'makeChunkUnitReviewProject: expected at least one chunk unit');
  return { root, targetStateDir, plan, chunkUnit };
}

// Task 15 – Test 1: unitContext for an oversize_chunk unit returns oversize:false
// (the NORMAL bounded-review branch), not the forced-high oversize_file branch.
test('TASK-015: unitContext for oversize_chunk unit returns oversize:false (normal branch)', async (t) => {
  const { root, targetStateDir, chunkUnit } = await makeChunkUnitReviewProject(t);

  const result = unitContext({ targetStateDir, projectRoot: root, unitId: chunkUnit.unit_id });

  assert.equal(result.ok, true, JSON.stringify(result));
  // KEY assertion: chunk unit takes the NORMAL path, not the forced-high oversize_file branch.
  assert.equal(result.oversize, false, 'oversize_chunk unit must NOT be routed to the oversize_file forced-high branch');
  assert.ok(result.contextPackSkeleton, 'chunk unit must surface a bounded context pack');
  assert.equal(result.contextPackSkeleton.reviewMode, 'partitioned');
  assert.equal(result.contextPackSkeleton.unit_id, chunkUnit.unit_id);

  // The member carries chunk range metadata (no body).
  const member = result.contextPackSkeleton.fileSet.files[0];
  assert.ok(member.chunk, 'chunk member must carry chunk metadata');
  assert.equal(member.chunk.index, chunkUnit.chunkIndex, 'chunk.index copied from unit level');
  assert.equal(member.chunk.count, chunkUnit.chunkCount, 'chunk.count copied from unit level');
  assert.equal(Number.isNaN(member.chunk.index), false, 'chunk.index must not be NaN');
  assert.equal(Number.isNaN(member.chunk.count), false, 'chunk.count must not be NaN');

  // A per-unit context manifest is written (no body persisted).
  assert.ok(result.contextManifestPath, 'context manifest path must be returned');
  const manifest = fs.readFileSync(result.contextManifestPath, 'utf8');
  assert.equal(manifest.includes('sliceText'), false, 'no sliceText may be persisted in the chunk unit manifest');
});

// Task 15 – Test 2: recordUnitReview for an oversize_chunk unit with a clean receipt
// writes coverage_risk:'none' honestly and returns oversize:false — NOT forced high.
test('TASK-015: recordUnitReview for oversize_chunk unit with clean receipt writes honest coverage_risk:none', async (t) => {
  const { root, targetStateDir, chunkUnit } = await makeChunkUnitReviewProject(t);

  const rec = await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: chunkUnit.unit_id,
    coverageReceipt: unitReviewPayload({ unitId: chunkUnit.unit_id, reviewed: true, coverageRisk: 'none' }),
    reviewerFindings: REVIEWER_PASS
  });

  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.reused, false);
  // KEY assertion: chunk unit is NOT forced to the oversize_file high-risk path.
  assert.equal(rec.oversize, false, 'oversize_chunk unit must return oversize:false from recordUnitReview');
  assert.equal(rec.coverageRisk, 'none', 'oversize_chunk unit with clean receipt must record honest coverage_risk:none');

  // The persisted summary must carry the honest receipt values.
  const summaryPath = path.join(targetStateDir, 'project-review', 'summaries', `${chunkUnit.unit_id}.json`);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.reviewed, true, 'summary.reviewed must be true');
  assert.equal(summary.coverage_risk, 'none', 'summary.coverage_risk must be none (not forced high)');
  assert.ok(!('skipped_reason' in summary), 'chunk unit summary must not carry skipped_reason (that is the oversize_file field)');
});

// Task 15 – Test 3 (regression): legacy oversize_file:true unit keeps forced-high
// behaviour in both unitContext and recordUnitReview.
test('TASK-015 regression: oversize_file:true unit is still forced high in unitContext and recordUnitReview', async (t) => {
  // big.js content: exceeds budget but each line is long enough that
  // computeOversizeChunks returns null → falls back to oversize_file:true.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-ovf15-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  // A single very long line (> any reasonable budget) so splitOversizeFile returns null.
  fs.writeFileSync(path.join(root, 'src', 'big.js'), `module.exports = ${'/* pad */ '.repeat(120000)}1;\n`);

  const targetStateDir = path.join(root, '.drfx', 'targets', 'whole-root');
  fs.mkdirSync(targetStateDir, { recursive: true });

  const { inventory, projectReviewFingerprint } = await resolveCodeInventory({ cwd: root, scopes: [] });
  // Tiny budget so big.js is over budget; splitOversizeFile returns null because the
  // single-line file cannot satisfy the per-chunk budget → oversize_file:true.
  const plan = assemblePartitionPlan({ inventory, projectReviewFingerprint, projectRoot: root, unitByteBudget: 70 });
  writeProjectReviewPlan(targetStateDir, plan);

  const oversizeUnit = plan.units.find((u) => u.oversize_file === true);
  assert.ok(oversizeUnit, 'expected an oversize_file:true unit in the regression fixture');

  // unitContext: must return oversize:true and the forced-high metadata.
  const ctx = unitContext({ targetStateDir, projectRoot: root, unitId: oversizeUnit.unit_id });
  assert.equal(ctx.oversize, true, 'oversize_file:true must return oversize:true from unitContext');
  assert.equal(ctx.nextAction, 'record oversize coverage blocker');
  assert.equal(ctx.coverageRisk, 'high');
  assert.equal(ctx.contextPackSkeleton, undefined, 'oversize_file unit must produce no context pack');

  // recordUnitReview: must force reviewed:false / coverage_risk:'high' and return oversize:true.
  const rec = await recordUnitReview({
    targetStateDir,
    projectRoot: root,
    unitId: oversizeUnit.unit_id
    // No coverageReceipt / reviewerFindings — oversize path ignores them.
  });
  assert.equal(rec.ok, true, JSON.stringify(rec));
  assert.equal(rec.oversize, true, 'oversize_file:true must return oversize:true from recordUnitReview');
  assert.equal(rec.coverageRisk, 'high', 'oversize_file:true must be forced to coverageRisk:high');

  const summaryPath = path.join(targetStateDir, 'project-review', 'summaries', `${oversizeUnit.unit_id}.json`);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.reviewed, false, 'oversize_file summary must have reviewed:false');
  assert.equal(summary.coverage_risk, 'high', 'oversize_file summary must have coverage_risk:high');
  assert.equal(summary.skipped_reason, 'single-file-over-budget');
});
