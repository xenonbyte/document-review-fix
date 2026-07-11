'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureSnapshot,
  checkSnapshotRollbackAnchor,
  checkSnapshotTargetOnly,
  inspectActualChangedFilesSnapshot,
  restoreSnapshot,
  captureFileSetBaseline,
  validateFileSetBaseline,
  restoreFileSetBaseline
} = require('../lib/snapshot-guard');

const { formatFixGuardReport } = require('../lib/fix-guard');

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  const sibling = path.join(root, 'docs', 'sibling.md');
  const nested = path.join(root, 'docs', 'nested', 'nested.md');
  const other = path.join(root, 'other', 'file.md');
  const reference = path.join(root, 'refs.md');
  fs.writeFileSync(target, '# Target\n\nOriginal.\n');
  fs.writeFileSync(sibling, '# Sibling\n');
  fs.writeFileSync(nested, '# Nested\n');
  fs.writeFileSync(other, '# Other\n');
  fs.writeFileSync(reference, '# Reference\n');
  const targetStateDir = path.join(root, '.drfx', 'targets', 'target-md-aaaaaaaaaaaa');
  return { root, target, sibling, nested, other, reference, targetStateDir };
}

test('snapshot rollback anchor rejects missing and symlink targets', (t) => {
  const fixture = makeWorkspace(t);
  fs.rmSync(fixture.target);
  assert.throws(
    () => checkSnapshotRollbackAnchor({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );

  fs.writeFileSync(fixture.target, '# Restored\n');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-outside-')), 'target.md');
  t.after(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
  fs.writeFileSync(outside, '# Outside\n');
  fs.rmSync(fixture.target);
  fs.symlinkSync(outside, fixture.target);
  assert.throws(
    () => checkSnapshotRollbackAnchor({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'rollback-unavailable'
  );
});

test('snapshot target-only guard monitors project tree files and explicit refs', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [fixture.reference]
  });
  assert.equal(baseline.status, 'passed');
  assert.equal(baseline.monitorScope, 'project-tree-files-and-references');
  assert.ok(baseline.entries.some((entry) => entry.path === 'docs/nested/nested.md'));
  assert.ok(baseline.entries.some((entry) => entry.path === 'other/file.md'));

  fs.appendFileSync(fixture.target, '\nFixed.\n');
  let actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.changedFiles, ['docs/target.md']);

  fs.appendFileSync(fixture.sibling, '\nIn scope.\n');
  actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard blocks reference changes as unexpected worktree changes', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [fixture.reference]
  });
  fs.appendFileSync(fixture.reference, '\nChanged ref.\n');

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard blocks nested non-target changes', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  fs.appendFileSync(fixture.nested, '\nNested non-target change.\n');

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard blocks non-target changes outside target directory', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  fs.appendFileSync(fixture.target, '\nTarget change.\n');
  fs.appendFileSync(fixture.other, '\nOther project file change.\n');

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'blocked');
  assert.equal(actual.blockingReason, 'unexpected-worktree-change');
  assert.equal(actual.changedFiles, undefined);
});

test('snapshot target-only guard blocks an out-of-set permission-only change', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are required');
  const fixture = makeWorkspace(t);
  fs.chmodSync(fixture.sibling, 0o755);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });

  fs.chmodSync(fixture.sibling, 0o4755);
  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('snapshot capture rejects symlinked snapshot parent directory', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-outside-round-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, 'real-round'), { recursive: true });
  fs.mkdirSync(path.join(fixture.targetStateDir, 'snapshots'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'real-round'), path.join(fixture.targetStateDir, 'snapshots', 'round-001'));

  assert.throws(
    () => captureSnapshot({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      targetStateDir: fixture.targetStateDir,
      round: 1,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error && error.blockingReason === 'rollback-unavailable'
  );
});

test('snapshot capture and restore round target body without touching non-target files', (t) => {
  const fixture = makeWorkspace(t);
  const snapshotPath = path.join(fixture.targetStateDir, 'snapshots', 'round-002', 'target.body');
  const snapshot = captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 2,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(snapshot.status, 'passed');
  assert.equal(fs.existsSync(snapshotPath), true);

  fs.writeFileSync(fixture.target, '# Target\n\nChanged.\n');
  fs.writeFileSync(fixture.sibling, '# Sibling changed outside restore.\n');
  const restored = restoreSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 2,
    expectedNormalizedTarget: 'docs/target.md',
    rollbackAnchor: snapshot
  });

  assert.equal(restored.status, 'passed');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), '# Target\n\nOriginal.\n');
  assert.equal(fs.readFileSync(fixture.sibling, 'utf8'), '# Sibling changed outside restore.\n');
  assert.equal(fs.existsSync(snapshotPath), false);
});

test('snapshot restore returns the target to its captured permission mode', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are required');
  const fixture = makeWorkspace(t);
  fs.chmodSync(fixture.target, 0o4640);
  const snapshot = captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 2,
    expectedNormalizedTarget: 'docs/target.md'
  });

  fs.chmodSync(fixture.target, 0o755);
  const restored = restoreSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 2,
    expectedNormalizedTarget: 'docs/target.md',
    rollbackAnchor: snapshot
  });

  assert.equal(restored.status, 'passed');
  assert.equal(fs.statSync(fixture.target).mode & 0o7777, 0o4640);
});

test('snapshot restore returns missing when snapshot body is absent', (t) => {
  const fixture = makeWorkspace(t);
  fs.writeFileSync(fixture.target, '# Target\n\nChanged.\n');

  const restored = restoreSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 3,
    expectedNormalizedTarget: 'docs/target.md'
  });

  assert.equal(restored.status, 'missing');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), '# Target\n\nChanged.\n');
});

test('snapshot capture leaves no .tmp file in the snapshot directory', (t) => {
  const fixture = makeWorkspace(t);
  captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 4,
    expectedNormalizedTarget: 'docs/target.md'
  });
  const snapshotDir = path.join(fixture.targetStateDir, 'snapshots', 'round-004');
  const residual = fs.readdirSync(snapshotDir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(residual, []);
});

test('snapshot target-only guard rejects references outside the project root', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-extref-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalReference = path.join(outside, 'external-ref.md');
  fs.writeFileSync(externalReference, '# External\n');

  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md',
      referencePaths: [externalReference]
    }),
    (error) => {
      assert.equal(error.blockingReason, 'target-only-guard-unavailable');
      assert.equal(error.message.includes(outside), false);
      assert.equal(error.message.includes(externalReference), false);
      return true;
    }
  );
});

test('snapshot guard ignores mtime-only touches when content is unchanged', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(baseline.status, 'passed');

  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(fixture.target, future, future);
  fs.utimesSync(fixture.sibling, future, future);

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });

  assert.equal(actual.status, 'passed');
  assert.deepEqual(actual.changedFiles, []);
});

test('snapshot restore rejects symlinked snapshot parent directory', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-outside-restore-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const realRound = path.join(outside, 'real-round');
  fs.mkdirSync(realRound, { recursive: true });
  fs.writeFileSync(path.join(realRound, 'target.body'), '# Outside body\n');
  fs.mkdirSync(path.join(fixture.targetStateDir, 'snapshots'), { recursive: true });
  fs.symlinkSync(realRound, path.join(fixture.targetStateDir, 'snapshots', 'round-001'));

  assert.throws(
    () => restoreSnapshot({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      targetStateDir: fixture.targetStateDir,
      round: 1,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error && error.blockingReason === 'rollback-unavailable'
  );
});

test('snapshot target-only guard excludes infrastructure directories and records the scoped monitor set', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });

  assert.equal(guard.status, 'passed');
  assert.equal(guard.monitorScope, 'project-tree-files-and-references-excluding-infrastructure');
  assert.ok(guard.excludedDirectories.includes('node_modules'));
  assert.equal(guard.entries.some((e) => e.path.startsWith('node_modules/')), false);
});

test('snapshot target-only guard keeps the plain scope when no infrastructure dir is present', (t) => {
  const fixture = makeWorkspace(t);
  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(guard.monitorScope, 'project-tree-files-and-references');
  assert.deepEqual(guard.excludedDirectories, []);
});

test('snapshot target-only guard records an unrelated file symlink as opaque without following it', (t) => {
  const fixture = makeWorkspace(t);
  const realFile = path.join(fixture.root, 'docs', 'real.md');
  fs.writeFileSync(realFile, '# Real\n');
  fs.symlinkSync(realFile, path.join(fixture.root, 'docs', 'link.md'));

  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  const link = guard.entries.find((e) => e.path === 'docs/link.md');
  assert.equal(link.role, 'opaque-symlink');
  assert.ok(link.linkTargetSha256);
});

test('snapshot target-only guard rejects a directory symlink instead of treating it as opaque', (t) => {
  const fixture = makeWorkspace(t);
  fs.symlinkSync(path.join(fixture.root, 'other'), path.join(fixture.root, 'docs', 'otherlink'));
  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('snapshot target-only guard rejects a symlink target', (t) => {
  const fixture = makeWorkspace(t);
  const outside = path.join(fixture.root, 'outside-target.md');
  fs.writeFileSync(outside, '# Outside\n');
  fs.rmSync(fixture.target);
  fs.symlinkSync(outside, fixture.target);

  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md'
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('snapshot target-only guard rejects a symlink reference', (t) => {
  const fixture = makeWorkspace(t);
  const realReference = path.join(fixture.root, 'real-ref.md');
  fs.writeFileSync(realReference, '# Real ref\n');
  fs.rmSync(fixture.reference);
  fs.symlinkSync(realReference, fixture.reference);

  assert.throws(
    () => checkSnapshotTargetOnly({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      allowedStateDir: fixture.targetStateDir,
      expectedNormalizedTarget: 'docs/target.md',
      referencePaths: [fixture.reference]
    }),
    (error) => error.blockingReason === 'target-only-guard-unavailable'
  );
});

test('snapshot inspection blocks when an opaque symlink is retargeted', (t) => {
  const fixture = makeWorkspace(t);
  const realA = path.join(fixture.root, 'docs', 'a.md');
  const realB = path.join(fixture.root, 'docs', 'b.md');
  fs.writeFileSync(realA, '# A\n');
  fs.writeFileSync(realB, '# B\n');
  const link = path.join(fixture.root, 'docs', 'link.md');
  fs.symlinkSync(realA, link);

  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  fs.rmSync(link);
  fs.symlinkSync(realB, link);

  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('snapshot target-only guard does not exclude a target that lives under an infrastructure dir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-infra-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist', 'docs'), { recursive: true });
  const target = path.join(root, 'dist', 'docs', 'target.md');
  fs.writeFileSync(target, '# Target\n');
  const stateDir = path.join(root, '.drfx', 'targets', 'x');

  const guard = checkSnapshotTargetOnly({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir,
    expectedNormalizedTarget: 'dist/docs/target.md'
  });

  assert.equal(guard.status, 'passed');
  assert.equal(guard.entries.some((e) => e.path === 'dist/docs/target.md'), true);
  assert.equal(guard.excludedDirectories.includes('dist'), false);
});

test('snapshot target-only guard does not exclude a reference that lives under an infrastructure dir', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-ref-infra-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'refs'), { recursive: true });
  const target = path.join(root, 'docs', 'target.md');
  const reference = path.join(root, 'dist', 'refs', 'reference.md');
  fs.writeFileSync(target, '# Target\n');
  fs.writeFileSync(reference, '# Reference\n');
  const stateDir = path.join(root, '.drfx', 'targets', 'x');

  const guard = checkSnapshotTargetOnly({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir,
    expectedNormalizedTarget: 'docs/target.md',
    referencePaths: [reference]
  });

  assert.equal(guard.status, 'passed');
  assert.equal(guard.entries.some((e) => e.path === 'dist/refs/reference.md'), true);
  assert.equal(guard.entries.find((e) => e.path === 'dist/refs/reference.md').role, 'reference');
  assert.equal(guard.excludedDirectories.includes('dist'), false);

  const actual = inspectActualChangedFilesSnapshot({
    projectRoot: root,
    targetPath: target,
    allowedStateDir: stateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: guard
  });
  assert.equal(actual.status, 'passed');
});

test('snapshot restore rejects missing target when parent was replaced by symlink', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-snapshot-parent-symlink-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const snapshot = captureSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    targetStateDir: fixture.targetStateDir,
    round: 5,
    expectedNormalizedTarget: 'docs/target.md'
  });

  fs.rmSync(path.join(fixture.root, 'docs'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(fixture.root, 'docs'));

  assert.throws(
    () => restoreSnapshot({
      projectRoot: fixture.root,
      targetPath: fixture.target,
      targetStateDir: fixture.targetStateDir,
      round: 5,
      expectedNormalizedTarget: 'docs/target.md',
      rollbackAnchor: snapshot
    }),
    (error) => {
      assert.equal(error.blockingReason, 'rollback-unavailable');
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(outside, 'target.md')), false);
});

test('snapshot target-only guard records a broken symlink as opaque and passes', (t) => {
  const fixture = makeWorkspace(t);
  // Create a symlink pointing at a non-existent path (broken symlink)
  const brokenLink = path.join(fixture.root, 'docs', 'broken-link.md');
  fs.symlinkSync(path.join(fixture.root, 'docs', 'nonexistent.md'), brokenLink);

  const guard = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });

  assert.equal(guard.status, 'passed');
  const entry = guard.entries.find((e) => e.path === 'docs/broken-link.md');
  assert.ok(entry, 'broken symlink entry should appear in entries');
  assert.equal(entry.role, 'opaque-symlink');
  assert.ok(entry.linkTargetSha256, 'broken symlink entry should have a linkTargetSha256');
});

test('snapshot inspection blocks when an opaque symlink is deleted', (t) => {
  const fixture = makeWorkspace(t);
  const realFile = path.join(fixture.root, 'docs', 'real.md');
  fs.writeFileSync(realFile, '# Real\n');
  const link = path.join(fixture.root, 'docs', 'link.md');
  fs.symlinkSync(realFile, link);

  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(baseline.status, 'passed');
  assert.ok(baseline.entries.some((e) => e.path === 'docs/link.md' && e.role === 'opaque-symlink'));

  fs.rmSync(link);

  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('snapshot inspection blocks when a new opaque symlink is created after baseline', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(baseline.status, 'passed');

  const realFile = path.join(fixture.root, 'docs', 'real.md');
  fs.writeFileSync(realFile, '# Real\n');
  const newLink = path.join(fixture.root, 'docs', 'new-link.md');
  fs.symlinkSync(realFile, newLink);

  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('snapshot inspection blocks when a new infrastructure directory appears after baseline', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.equal(baseline.monitorScope, 'project-tree-files-and-references');

  fs.mkdirSync(path.join(fixture.root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');

  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('snapshot inspection blocks when an excluded infrastructure directory disappears', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  const baseline = checkSnapshotTargetOnly({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md'
  });
  assert.deepEqual(baseline.excludedDirectories, ['node_modules']);

  fs.rmSync(path.join(fixture.root, 'node_modules'), { recursive: true, force: true });

  const result = inspectActualChangedFilesSnapshot({
    projectRoot: fixture.root,
    targetPath: fixture.target,
    allowedStateDir: fixture.targetStateDir,
    expectedNormalizedTarget: 'docs/target.md',
    targetOnlyGuard: baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

// --- File-set snapshot guard (PLAN-TASK-006) ---
// These helpers capture/validate/restore fingerprint baselines for a SET of monitored
// files (not a single target). They accept recorded dependency records { path, reason,
// issueId } alongside plain string paths.

test('file-set snapshot baseline fingerprints each monitored file', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', { path: 'docs/sibling.md', reason: 'dep', issueId: 'I-1' }]
  });
  assert.equal(baseline.status, 'passed');
  const paths = baseline.entries.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ['docs/sibling.md', 'docs/target.md']);
  for (const entry of baseline.entries) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof entry.size, 'number');
  }
});

test('file-set snapshot baseline blocks a missing monitored file', (t) => {
  const fixture = makeWorkspace(t);
  const result = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/does-not-exist.md']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'target-only-guard-unavailable');
});

test('file-set snapshot baseline rejects a symlinked monitored file', (t) => {
  const fixture = makeWorkspace(t);
  const real = path.join(fixture.root, 'docs', 'real.md');
  fs.writeFileSync(real, '# Real\n');
  fs.rmSync(fixture.sibling);
  fs.symlinkSync(real, fixture.sibling);
  const result = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'target-only-guard-unavailable');
});

test('file-set snapshot baseline rejects a monitored file outside the project root', (t) => {
  const fixture = makeWorkspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-fileset-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const externalFile = path.join(outside, 'ext.md');
  fs.writeFileSync(externalFile, '# Ext\n');
  const result = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', externalFile]
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'target-only-guard-unavailable');
  assert.equal((result.message || '').includes(outside), false);
});

test('file-set snapshot validate passes when monitored files match the baseline', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md'],
    baseline
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, []);
});

test('file-set snapshot validate reports which monitored files changed', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  fs.appendFileSync(fixture.target, '\nFixed.\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md'],
    baseline
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/target.md']);
});

test('file-set snapshot validate prunes .git and package-manager churn from the tree walk', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(fixture.root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md']
  });
  assert.equal(baseline.status, 'passed');
  // VCS/package internals churn between begin-fix and end-fix whenever any tool runs (a git
  // command updating .git/index, a package manager touching node_modules). The file-set guard
  // prunes these, so such churn must NOT trip an unexpected-worktree-change block.
  fs.writeFileSync(path.join(fixture.root, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
  fs.writeFileSync(path.join(fixture.root, '.git', 'index'), 'binary-index\n');
  fs.writeFileSync(path.join(fixture.root, 'node_modules', 'pkg', 'extra.js'), 'module.exports = 2;\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.changedFiles, []);
});

test('file-set snapshot validate prunes opencode config churn from the tree walk', (t) => {
  const fixture = makeWorkspace(t);
  const opencodeDir = path.join(fixture.root, '.config', 'opencode', 'command');
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.writeFileSync(path.join(opencodeDir, 'review-fix-code.md'), 'old command\n');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md']
  });
  assert.equal(baseline.status, 'passed');
  assert.deepEqual(baseline.excludedDirectories, ['.config/opencode']);

  fs.writeFileSync(path.join(opencodeDir, 'review-fix-code.md'), 'new command\n');
  fs.writeFileSync(path.join(opencodeDir, 'generated.json'), '{}\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.changedFiles, []);
});

test('file-set snapshot validate ignores legacy monitored entries under pruned directories', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, '.codegraph', 'codegraph.db'), 'old-index\n');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', '.codegraph/codegraph.db']
  });
  assert.equal(baseline.status, 'passed');

  fs.writeFileSync(path.join(fixture.root, '.codegraph', 'codegraph.db'), 'new-index\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });

  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.changedFiles, []);
});

test('file-set snapshot validate still blocks an out-of-set write under a build-output directory', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'dist', 'out.js'), 'console.log(1);\n');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md']
  });
  assert.equal(baseline.status, 'passed');
  // dist/build/coverage stay monitored: a sneaky write there is review-relevant and must block.
  fs.writeFileSync(path.join(fixture.root, 'dist', 'out.js'), 'console.log(2);\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('file-set snapshot validate reports when a monitored file goes missing', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  fs.rmSync(fixture.sibling);
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md'],
    baseline
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/sibling.md']);
});

test('file-set snapshot validate blocks a write outside the monitored file set', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md']
  });
  fs.appendFileSync(fixture.target, '\nAllowed change.\n');
  fs.appendFileSync(fixture.other, '\nOutside file-set change.\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('file-set snapshot validate blocks writes under existing infrastructure directories', (t) => {
  const fixture = makeWorkspace(t);
  fs.mkdirSync(path.join(fixture.root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(fixture.root, 'dist', 'app.js'), 'module.exports = 1;\n');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md']
  });
  fs.appendFileSync(fixture.target, '\nAllowed change.\n');
  fs.writeFileSync(path.join(fixture.root, 'dist', 'extra.js'), 'module.exports = 2;\n');

  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
});

test('file-set snapshot validate blocks deletions under force-included pruned directories', (t) => {
  const fixture = makeWorkspace(t);
  const wfDir = path.join(fixture.root, '.req-to-plan', 'WF-force-delete');
  fs.mkdirSync(wfDir, { recursive: true });
  const monitored = path.join(wfDir, '07-plan.md');
  const sibling = path.join(wfDir, '06-spec.md');
  fs.writeFileSync(monitored, '# Plan\n');
  fs.writeFileSync(sibling, '# Spec\n');

  const monitoredRelative = path.relative(fixture.root, monitored).split(path.sep).join('/');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: [monitoredRelative],
    forceIncludeDirs: [wfDir]
  });
  assert.equal(baseline.status, 'passed');
  assert.ok(baseline.treeEntries.some((entry) => entry.path.endsWith('/06-spec.md')));

  fs.rmSync(sibling);

  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: [monitoredRelative],
    baseline,
    forceIncludeDirs: [wfDir]
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'unexpected-worktree-change');
  assert.equal(result.entries[0].kind, 'deleted');
});

test('file-set snapshot baseline supports deleted PR members as missing monitored files', (t) => {
  const fixture = makeWorkspace(t);
  const deletedPath = path.join(fixture.root, 'docs', 'deleted.js');
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', { path: 'docs/deleted.js', status: 'deleted' }]
  });
  assert.equal(baseline.status, 'passed');
  assert.equal(baseline.entries.find((entry) => entry.path === 'docs/deleted.js').missing, true);

  fs.writeFileSync(deletedPath, 'module.exports = 1;\n');
  const result = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', { path: 'docs/deleted.js', status: 'deleted' }],
    baseline
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.changedFiles, ['docs/deleted.js']);

  const restored = restoreFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', { path: 'docs/deleted.js', status: 'deleted' }],
    baseline
  });
  assert.equal(restored.status, 'passed');
  assert.equal(fs.existsSync(deletedPath), false);
});

test('file-set snapshot restore limits writes to monitored files only', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  fs.writeFileSync(fixture.target, '# Target\n\nMutated.\n');
  fs.writeFileSync(fixture.sibling, '# Sibling mutated.\n');
  // An UNMONITORED file is also dirty; restore must NOT touch it.
  fs.writeFileSync(fixture.other, '# Other mutated and must survive.\n');

  const result = restoreFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md'],
    baseline
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.restoredFiles, ['docs/sibling.md', 'docs/target.md']);
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), '# Target\n\nOriginal.\n');
  assert.equal(fs.readFileSync(fixture.sibling, 'utf8'), '# Sibling\n');
  // Unmonitored file preserved.
  assert.equal(fs.readFileSync(fixture.other, 'utf8'), '# Other mutated and must survive.\n');
});

test('file-set snapshot baseline detects and restores a monitored permission-only change', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission bits are required');
  const fixture = makeWorkspace(t);
  fs.chmodSync(fixture.target, 0o4640);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md']
  });
  fs.chmodSync(fixture.target, 0o755);

  const validation = validateFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(validation.status, 'passed');
  assert.deepEqual(validation.changedFiles, ['docs/target.md']);

  const restored = restoreFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md'],
    baseline
  });
  assert.equal(restored.status, 'passed');
  assert.equal(fs.statSync(fixture.target).mode & 0o7777, 0o4640);
});

test('file-set snapshot restore recreates a monitored file whose parent dir was removed', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  // A fixer deleted both monitored files AND their parent directory; restore must
  // recreate the directory and the files rather than throwing an uncaught ENOENT.
  fs.rmSync(path.dirname(fixture.target), { recursive: true, force: true });

  const result = restoreFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md'],
    baseline
  });
  assert.equal(result.status, 'passed');
  assert.equal(fs.readFileSync(fixture.target, 'utf8'), '# Target\n\nOriginal.\n');
  assert.equal(fs.readFileSync(fixture.sibling, 'utf8'), '# Sibling\n');
});

test('file-set snapshot restore blocks (no silent pass) when a snapshot body is unavailable', (t) => {
  const fixture = makeWorkspace(t);
  const baseline = captureFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md']
  });
  // Corrupt the baseline so the recorded body cannot be located.
  const corrupt = { ...baseline, entries: baseline.entries.map((entry) => ({ ...entry, body: null })) };
  const result = restoreFileSetBaseline({
    projectRoot: fixture.root,
    monitoredFiles: ['docs/target.md', 'docs/sibling.md'],
    baseline: corrupt
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockingReason, 'rollback-unavailable');
});

test('fix guard report persists monitorScope and excludedDirectories', () => {
  const report = formatFixGuardReport({
    round: 1,
    normalizedTarget: 'docs/target.md',
    targetFingerprint: { sha256: 'x', size: 1 },
    referenceFingerprints: [],
    rollbackAnchor: { status: 'passed', guardMode: 'snapshot' },
    targetOnlyGuard: {
      status: 'passed',
      guardMode: 'snapshot',
      monitorScope: 'project-tree-files-and-references-excluding-infrastructure',
      excludedDirectories: ['node_modules'],
      entries: []
    },
    lock: null
  });
  const json = JSON.parse(report.split('```json')[1].split('```')[0]);
  assert.equal(json.targetOnlyGuard.monitorScope, 'project-tree-files-and-references-excluding-infrastructure');
  assert.deepEqual(json.targetOnlyGuard.excludedDirectories, ['node_modules']);
});
