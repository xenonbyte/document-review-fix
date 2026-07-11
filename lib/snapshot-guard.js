'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  computeFingerprint,
  validateTargetStateOwnedPath
} = require('./target-state');
const { atomicWriteFile, atomicCopyFile } = require('./atomic-write');

const INFRASTRUCTURE_DIRECTORIES = new Set([
  '.git',
  '.claude',
  '.codex',
  '.codegraph',
  '.gemini',
  '.opencode',
  '.req-to-plan',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.cache',
  'dist',
  'build',
  'coverage'
]);

// VCS and package-manager internals that the file-set snapshot guard prunes from its whole-tree
// walk. These are large and/or volatile (git index/pack churn, package caches rewritten by any
// tool run) and are never a legitimate part of a reviewed code file set, so walking them at
// begin-fix + end-fix only adds cost and spurious `unexpected-worktree-change` blocks. A file-set
// member that does live under one of these stays tracked through the monitored-entries list; the
// tree walk only detects OUT-OF-SET changes. Build outputs (dist/build/coverage) are deliberately
// NOT pruned here: committed outputs and sneaky out-of-set writes there are review-relevant, so
// the file-set guard keeps monitoring them even though the single-target guard prunes them.
const FILE_SET_PRUNED_DIRECTORIES = new Set([
  '.git',
  '.claude',
  '.codex',
  '.codegraph',
  '.gemini',
  '.opencode',
  '.req-to-plan',
  'node_modules',
  '.pnpm-store',
  '.yarn',
  '.cache'
]);

const FILE_SET_PRUNED_DIRECTORY_PATHS = new Set([
  '.config/opencode'
]);

function guardError(blockingReason, message, metadata = {}) {
  const error = new Error(`${blockingReason}: ${message}`);
  error.code = blockingReason === 'rollback-unavailable'
    ? 'ERR_ROLLBACK_UNAVAILABLE'
    : 'ERR_TARGET_ONLY_GUARD_UNAVAILABLE';
  error.status = 'blocked';
  error.reason = blockingReason;
  error.blockingReason = blockingReason;
  Object.assign(error, metadata);
  return error;
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativeToProject(projectRoot, filePath) {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return toPosix(relative);
}

function pathSha256(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');
}

function redactedEntry(filePath, kind) {
  return {
    pathSha256: pathSha256(filePath),
    statusCode: 'snapshot',
    kind
  };
}

function assertInsideProject(projectRoot, filePath, label, blockingReason) {
  const relative = relativeToProject(projectRoot, filePath);
  if (!relative) throw guardError(blockingReason, `${label} must be inside project root`);
  return relative;
}

function assertMissingTargetParentChain({ projectRoot, targetPath, blockingReason }) {
  const root = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(targetPath);
  const normalizedTarget = assertInsideProject(root, absoluteTarget, 'target', blockingReason);
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(root);
  } catch (error) {
    throw guardError(blockingReason, 'project root identity is unavailable', { cause: error });
  }

  const relativeParts = path.relative(root, absoluteTarget).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts.slice(0, -1)) {
    current = path.join(current, part);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw guardError(blockingReason, 'target parent is unavailable', { cause: error });
    }
    if (stats.isSymbolicLink()) throw guardError(blockingReason, 'target parent must not be a symlink');
    if (!stats.isDirectory()) throw guardError(blockingReason, 'target parent must be a directory');
    let parentRealPath;
    try {
      parentRealPath = fs.realpathSync.native(current);
    } catch (error) {
      throw guardError(blockingReason, 'target parent identity is unavailable', { cause: error });
    }
    const realRelative = path.relative(rootRealPath, parentRealPath);
    if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) {
      throw guardError(blockingReason, 'target parent realpath must stay inside project root');
    }
  }
  return normalizedTarget;
}

function assertSafeMissingFileParentChain({ projectRoot, filePath, label, blockingReason }) {
  const root = path.resolve(projectRoot);
  const absoluteFile = path.resolve(filePath);
  const projectRelative = assertInsideProject(root, absoluteFile, label, blockingReason);
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(root);
  } catch (error) {
    throw guardError(blockingReason, 'project root identity is unavailable', { cause: error });
  }

  const relativeParts = path.relative(root, absoluteFile).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts.slice(0, -1)) {
    current = path.join(current, part);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw guardError(blockingReason, `${label} parent is unavailable`, { cause: error });
    }
    if (stats.isSymbolicLink()) throw guardError(blockingReason, `${label} parent must not be a symlink`);
    if (!stats.isDirectory()) throw guardError(blockingReason, `${label} parent must be a directory`);
    let parentRealPath;
    try {
      parentRealPath = fs.realpathSync.native(current);
    } catch (error) {
      throw guardError(blockingReason, `${label} parent identity is unavailable`, { cause: error });
    }
    const realRelative = path.relative(rootRealPath, parentRealPath);
    if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) {
      throw guardError(blockingReason, `${label} parent realpath must stay inside project root`);
    }
  }
  return projectRelative;
}

function assertTargetIdentity({ projectRoot, targetPath, expectedNormalizedTarget, blockingReason, allowMissing = false }) {
  const root = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(targetPath);
  const normalizedTarget = assertInsideProject(root, absoluteTarget, 'target', blockingReason);
  const expected = expectedNormalizedTarget ? toPosix(expectedNormalizedTarget) : normalizedTarget;
  if (normalizedTarget !== expected) {
    throw guardError(blockingReason, 'target identity does not match manifest target');
  }

  let linkStats;
  try {
    linkStats = fs.lstatSync(absoluteTarget);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') {
      return assertMissingTargetParentChain({ projectRoot: root, targetPath: absoluteTarget, blockingReason });
    }
    throw guardError(blockingReason, 'target is missing or unreadable', { cause: error });
  }
  if (linkStats.isSymbolicLink()) throw guardError(blockingReason, 'target must not be a symlink');
  if (!linkStats.isFile()) throw guardError(blockingReason, 'target must be a regular file');

  let rootRealPath;
  let targetRealPath;
  try {
    rootRealPath = fs.realpathSync.native(root);
    targetRealPath = fs.realpathSync.native(absoluteTarget);
  } catch (error) {
    throw guardError(blockingReason, 'target identity is unavailable', { cause: error });
  }
  const realRelative = path.relative(rootRealPath, targetRealPath);
  if (realRelative === '' || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw guardError(blockingReason, 'target realpath must stay inside project root');
  }
  if (toPosix(realRelative) !== expected) {
    throw guardError(blockingReason, 'target identity does not match manifest target');
  }
  return normalizedTarget;
}

function assertRegularNonSymlink(filePath, label, blockingReason) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    throw guardError(blockingReason, `${label} is missing or unreadable`, { cause: error });
  }
  if (stats.isSymbolicLink()) throw guardError(blockingReason, `${label} must not be a symlink`);
  if (!stats.isFile()) throw guardError(blockingReason, `${label} must be a regular file`);
}

function snapshotRelativePath(round) {
  return path.posix.join('snapshots', `round-${String(Number(round || 1)).padStart(3, '0')}`, 'target.body');
}

function snapshotPathFromAnchor(targetStateDir, round, rollbackAnchor = {}) {
  const relativePath = rollbackAnchor.snapshotPath || snapshotRelativePath(round);
  let absolutePath;
  try {
    absolutePath = validateTargetStateOwnedPath({
      targetStateDir,
      relativePath,
      allowedDirectories: ['snapshots'],
      label: 'snapshot path'
    });
  } catch (error) {
    throw guardError(
      'rollback-unavailable',
      error && error.message ? error.message : 'snapshot path is invalid',
      { cause: error }
    );
  }
  return {
    relativePath: toPosix(path.relative(path.resolve(targetStateDir), absolutePath)),
    absolutePath
  };
}

function checkSnapshotRollbackAnchor({ projectRoot, targetPath, expectedNormalizedTarget = null }) {
  const normalizedTarget = assertTargetIdentity({
    projectRoot,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable'
  });
  return {
    status: 'passed',
    guardMode: 'snapshot',
    normalizedTarget
  };
}

function captureSnapshot({
  projectRoot,
  targetPath,
  targetStateDir,
  round = 1,
  expectedNormalizedTarget = null
}) {
  const anchor = checkSnapshotRollbackAnchor({ projectRoot, targetPath, expectedNormalizedTarget });
  const { relativePath, absolutePath } = snapshotPathFromAnchor(targetStateDir, round);
  atomicCopyFile(targetPath, absolutePath);
  const fingerprint = computeFingerprint(targetPath);
  const mode = fs.lstatSync(targetPath).mode & 0o7777;
  return {
    ...anchor,
    snapshotPath: relativePath,
    targetFingerprint: {
      sha256: fingerprint.sha256,
      size: fingerprint.size,
      mode
    }
  };
}

function monitorRoleLabel(role) {
  if (role === 'target') return 'target';
  if (role === 'reference') return 'reference';
  return 'monitored file';
}

function symlinkOpaqueRecord({ projectRoot, filePath }) {
  const projectRelative = relativeToProject(projectRoot, filePath);
  if (!projectRelative) {
    throw guardError('target-only-guard-unavailable', 'monitored symlink must be inside project root');
  }
  let lstat;
  let linkTarget;
  try {
    lstat = fs.lstatSync(filePath);
    linkTarget = fs.readlinkSync(filePath);
  } catch (error) {
    throw guardError('target-only-guard-unavailable', 'monitored symlink is unreadable', { cause: error });
  }
  return {
    path: projectRelative,
    pathSha256: pathSha256(filePath),
    role: 'opaque-symlink',
    linkTargetSha256: crypto.createHash('sha256').update(linkTarget).digest('hex'),
    mode: lstat.mode
  };
}

function monitorPathRecord({ projectRoot, filePath, normalizedTarget, role }) {
  const label = monitorRoleLabel(role);
  assertRegularNonSymlink(filePath, label, 'target-only-guard-unavailable');
  const projectRelative = relativeToProject(projectRoot, filePath);
  if (!projectRelative) {
    throw guardError('target-only-guard-unavailable', `${label} must be inside project root`);
  }
  const fingerprint = computeFingerprint(filePath);
  const mode = fs.lstatSync(filePath).mode & 0o7777;
  return {
    path: projectRelative,
    pathSha256: pathSha256(filePath),
    role: projectRelative === normalizedTarget ? 'target' : role,
    sha256: fingerprint.sha256,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    mode
  };
}

function uniqueByPath(records) {
  const byPath = new Map();
  // opaque-symlink is a forward-looking slot; symlink references are rejected earlier by
  // assertRegularNonSymlink, so an opaque entry never collides with a reference/target at
  // the same path today.
  const priority = { neighbor: 0, 'opaque-symlink': 1, reference: 2, target: 3 };
  for (const record of records) {
    const previous = byPath.get(record.path);
    if (!previous || (priority[record.role] || 0) >= (priority[previous.role] || 0)) { // last writer wins for equal-priority duplicate paths
      byPath.set(record.path, record);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function collectMonitorRecords({
  projectRoot,
  targetPath,
  allowedStateDir,
  expectedNormalizedTarget = null,
  referencePaths = []
}) {
  const normalizedTarget = assertTargetIdentity({
    projectRoot,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'target-only-guard-unavailable'
  });
  const records = [];
  const excludedDirectories = [];
  const monitorRoot = path.resolve(projectRoot);
  const stateDir = allowedStateDir ? path.resolve(allowedStateDir) : null;

  const monitoredPaths = [path.resolve(targetPath), ...(referencePaths || []).map((referencePath) =>
    path.isAbsolute(referencePath) ? referencePath : path.resolve(projectRoot, referencePath))];
  // target already validated above by assertTargetIdentity; only references need checking here
  for (const monitoredPath of monitoredPaths.slice(1)) {
    let lstat;
    try {
      lstat = fs.lstatSync(monitoredPath);
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'reference is unreadable', { cause: error });
    }
    if (lstat.isSymbolicLink()) {
      throw guardError('target-only-guard-unavailable', 'reference must not be a symlink');
    }
  }
  function containsMonitoredPath(directoryPath) {
    return monitoredPaths.some((monitored) => isInsideOrEqual(monitored, directoryPath));
  }

  function collectDirectory(directoryPath) {
    let entries;
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'monitored project directory is unreadable', { cause: error });
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (stateDir && isInsideOrEqual(entryPath, stateDir)) continue;
      if (entry.isSymbolicLink()) {
        let resolved;
        try {
          resolved = fs.statSync(entryPath);
        } catch {
          // Deliberate: a broken symlink can't be classified as dir-vs-file, so it is treated
          // leniently as an opaque monitored entry (it will still block via
          // unexpected-worktree-change if its readlink text or mode changes).
          resolved = null;
        }
        if (resolved && resolved.isDirectory()) {
          throw guardError('target-only-guard-unavailable', 'monitored directory symlink is not supported');
        }
        records.push(symlinkOpaqueRecord({ projectRoot, filePath: entryPath }));
        continue;
      }
      if (entry.isDirectory()) {
        if (INFRASTRUCTURE_DIRECTORIES.has(entry.name) && !containsMonitoredPath(entryPath)) {
          excludedDirectories.push(toPosix(path.relative(monitorRoot, entryPath)));
          continue;
        }
        collectDirectory(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const role = path.resolve(entryPath) === path.resolve(targetPath) ? 'target' : 'neighbor';
      records.push(monitorPathRecord({ projectRoot, filePath: entryPath, normalizedTarget, role }));
    }
  }
  collectDirectory(monitorRoot);

  for (const referencePath of referencePaths || []) {
    const absoluteReference = path.isAbsolute(referencePath)
      ? referencePath
      : path.resolve(projectRoot, referencePath);
    records.push(monitorPathRecord({
      projectRoot,
      filePath: absoluteReference,
      normalizedTarget,
      role: 'reference'
    }));
  }
  return { normalizedTarget, records: uniqueByPath(records), excludedDirectories: excludedDirectories.sort() };
}

function checkSnapshotTargetOnly({
  projectRoot,
  targetPath,
  allowedStateDir,
  expectedNormalizedTarget = null,
  referencePaths = []
}) {
  try {
    const { records, excludedDirectories } = collectMonitorRecords({
      projectRoot,
      targetPath,
      allowedStateDir,
      expectedNormalizedTarget,
      referencePaths
    });
    return {
      status: 'passed',
      guardMode: 'snapshot',
      monitorScope: excludedDirectories.length > 0
        ? 'project-tree-files-and-references-excluding-infrastructure'
        : 'project-tree-files-and-references',
      excludedDirectories,
      entries: records
    };
  } catch (error) {
    if (error && error.blockingReason) throw error;
    return {
      status: 'blocked',
      blockingReason: 'target-only-guard-unavailable',
      entries: [],
      message: error && error.message ? error.message : String(error)
    };
  }
}

function fingerprintChanged(left, right) {
  return !left || !right ||
    left.sha256 !== right.sha256 ||
    left.size !== right.size ||
    (typeof left.mode === 'number' && typeof right.mode === 'number' && left.mode !== right.mode);
}

function monitorEntryChanged(previous, current) {
  if (!previous || !current) return true;
  if (current.role === 'opaque-symlink' || previous.role === 'opaque-symlink') {
    return previous.role !== current.role ||
      previous.linkTargetSha256 !== current.linkTargetSha256 ||
      previous.mode !== current.mode;
  }
  return fingerprintChanged(previous, current);
}

function stringSetChanged(left = [], right = []) {
  if (left.length !== right.length) return true;
  const values = new Set(left);
  return right.some((value) => !values.has(value));
}

function changedStringSetMember(left = [], right = []) {
  const leftValues = new Set(left);
  const rightValues = new Set(right);
  return right.find((value) => !leftValues.has(value)) ||
    left.find((value) => !rightValues.has(value)) ||
    'infrastructure';
}

function hasPrunedDirectoryPath(entryPath) {
  const segments = String(entryPath || '').split('/').filter(Boolean);
  for (const segment of segments) {
    if (FILE_SET_PRUNED_DIRECTORIES.has(segment)) return true;
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (FILE_SET_PRUNED_DIRECTORY_PATHS.has(`${segments[index]}/${segments[index + 1]}`)) return true;
  }
  return false;
}

function isPrunedDirectoryPath(relativePath) {
  return hasPrunedDirectoryPath(relativePath);
}

function inspectActualChangedFilesSnapshot({
  projectRoot,
  targetPath,
  allowedStateDir,
  expectedNormalizedTarget = null,
  targetOnlyGuard
}) {
  try {
    if (!targetOnlyGuard || targetOnlyGuard.status !== 'passed' || !Array.isArray(targetOnlyGuard.entries)) {
      return { status: 'blocked', blockingReason: 'target-only-guard-unavailable', entries: [] };
    }
    const referencePaths = targetOnlyGuard.entries
      .filter((entry) => entry.role === 'reference')
      .map((entry) => entry.path);
    const { normalizedTarget, records, excludedDirectories } = collectMonitorRecords({
      projectRoot,
      targetPath,
      allowedStateDir,
      expectedNormalizedTarget,
      referencePaths
    });
    const previousExcludedDirectories = Array.isArray(targetOnlyGuard.excludedDirectories)
      ? targetOnlyGuard.excludedDirectories
      : [];
    if (stringSetChanged(previousExcludedDirectories, excludedDirectories)) {
      return {
        status: 'blocked',
        blockingReason: 'unexpected-worktree-change',
        entries: [
          redactedEntry(
            path.join(projectRoot, changedStringSetMember(previousExcludedDirectories, excludedDirectories)),
            'monitor-scope-changed'
          )
        ]
      };
    }
    const before = new Map(targetOnlyGuard.entries.map((entry) => [entry.path, entry]));
    const after = new Map(records.map((entry) => [entry.path, entry]));
    const blockedEntries = [];
    let targetChanged = false;

    for (const [entryPath, current] of after) {
      const previous = before.get(entryPath);
      if (current.path === normalizedTarget) {
        targetChanged = fingerprintChanged(previous, current);
        continue;
      }
      if (!previous) blockedEntries.push(redactedEntry(entryPath, 'created'));
      else if (monitorEntryChanged(previous, current)) blockedEntries.push(redactedEntry(entryPath, 'modified'));
    }
    for (const [entryPath, previous] of before) {
      if (previous.path === normalizedTarget) continue;
      if (!after.has(entryPath)) blockedEntries.push(redactedEntry(entryPath, 'deleted'));
    }
    if (!after.has(normalizedTarget)) blockedEntries.push(redactedEntry(normalizedTarget, 'deleted'));

    if (blockedEntries.length > 0) {
      return {
        status: 'blocked',
        blockingReason: 'unexpected-worktree-change',
        entries: blockedEntries
      };
    }
    return {
      status: 'passed',
      changedFiles: targetChanged ? [normalizedTarget] : [],
      allowedStateEntryCount: 0
    };
  } catch (error) {
    if (error && error.blockingReason === 'target-only-guard-unavailable') {
      return {
        status: 'blocked',
        blockingReason: 'target-only-guard-unavailable',
        entries: [],
        message: error.message
      };
    }
    return {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: [],
      message: error && error.message ? error.message : String(error)
    };
  }
}

function restoreSnapshot({
  projectRoot,
  targetPath,
  targetStateDir,
  round = 1,
  expectedNormalizedTarget = null,
  rollbackAnchor = {}
}) {
  const normalizedTarget = assertTargetIdentity({
    projectRoot,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable',
    allowMissing: true
  });
  const { relativePath, absolutePath } = snapshotPathFromAnchor(targetStateDir, round, rollbackAnchor);
  if (!fs.existsSync(absolutePath)) {
    return {
      status: 'missing',
      guardMode: 'snapshot',
      normalizedTarget,
      snapshotPath: relativePath
    };
  }
  assertRegularNonSymlink(absolutePath, 'snapshot', 'rollback-unavailable');
  const absoluteTarget = path.resolve(targetPath);
  atomicCopyFile(absolutePath, absoluteTarget);
  if (rollbackAnchor.targetFingerprint && typeof rollbackAnchor.targetFingerprint.mode === 'number') {
    fs.chmodSync(absoluteTarget, rollbackAnchor.targetFingerprint.mode);
  }
  fs.rmSync(absolutePath, { force: true });
  return {
    status: 'passed',
    guardMode: 'snapshot',
    normalizedTarget,
    snapshotPath: relativePath
  };
}

// --- File-set snapshot guard primitives (PLAN-TASK-006) ---
//
// These capture/validate/restore fingerprint baselines for an EXPLICIT SET of monitored
// files (the primary target PLUS recorded necessary dependency files), rather than a single
// target. They are ADDITIVE: captureSnapshot/restoreSnapshot/checkSnapshotTargetOnly/
// inspectActualChangedFilesSnapshot above are unchanged. PLAN-TASK-009 wires these into the
// live fixer boundary; TASK-006 only provides + unit-tests the primitives in isolation.
//
// Unlike the single-target snapshot which copies the target body into a
// snapshots/round-NNN/target.body file, these baselines carry an in-memory restorable body
// per entry so a SET of files can be captured/restored without minting per-file on-disk
// snapshot slots. Restore writes ONLY to monitored files and never touches unmonitored
// paths.

// Accepts plain string paths or { path, reason, issueId } dependency records; returns the
// absolute path + the raw entry. Path/symlink/outside-root safety is enforced per file by
// fileSetEntryRecord.
function monitoredFileSpec(entry) {
  const raw = typeof entry === 'string' ? entry : (entry && entry.path);
  if (typeof raw !== 'string' || raw === '') {
    throw guardError('target-only-guard-unavailable', 'monitored file entry must be a non-empty path');
  }
  return raw;
}

function monitoredFileAllowsMissing(entry) {
  return Boolean(entry && typeof entry === 'object' && (entry.status === 'deleted' || entry.allowMissingBaseline === true));
}

function normalizedMonitoredFile({ projectRoot, rawPath, blockingReason = 'target-only-guard-unavailable' }) {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
  const projectRelative = relativeToProject(root, absolute);
  if (!projectRelative) {
    throw guardError(blockingReason, 'monitored file must be inside project root');
  }
  if (projectRelative.includes('\0')) {
    throw guardError(blockingReason, 'monitored file path must not contain null bytes');
  }
  return { root, absolute, projectRelative };
}

// Fingerprints one monitored file with full path safety (reuses assertRegularNonSymlink +
// relativeToProject). Captures the body so restore can roll it back. Throws
// target-only-guard-unavailable on any unsafe/missing/symlink/outside-root file.
function fileSetEntryRecord({ projectRoot, rawPath, withBody, allowMissing = false }) {
  const { root, absolute, projectRelative } = normalizedMonitoredFile({ projectRoot, rawPath });
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') {
      assertSafeMissingFileParentChain({
        projectRoot: root,
        filePath: absolute,
        label: 'monitored file',
        blockingReason: 'target-only-guard-unavailable'
      });
      return {
        path: projectRelative,
        pathSha256: pathSha256(absolute),
        missing: true
      };
    }
    throw guardError('target-only-guard-unavailable', 'monitored file is missing or unreadable', { cause: error });
  }
  if (stats.isSymbolicLink()) throw guardError('target-only-guard-unavailable', 'monitored file must not be a symlink');
  if (!stats.isFile()) throw guardError('target-only-guard-unavailable', 'monitored file must be a regular file');
  const fingerprint = computeFingerprint(absolute);
  const record = {
    path: projectRelative,
    pathSha256: pathSha256(absolute),
    sha256: fingerprint.sha256,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    mode: stats.mode & 0o7777
  };
  if (withBody) {
    try {
      record.body = fs.readFileSync(absolute);
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'monitored file body is unreadable', { cause: error });
    }
  }
  return record;
}

function blockedSnapshotResult(blockingReason, error) {
  return {
    status: 'blocked',
    blockingReason,
    entries: [],
    message: error && error.message ? error.message : String(error)
  };
}

function fileSetTreeRecord({ projectRoot, filePath }) {
  assertRegularNonSymlink(filePath, 'project file', 'target-only-guard-unavailable');
  const projectRelative = relativeToProject(projectRoot, filePath);
  if (!projectRelative) {
    throw guardError('target-only-guard-unavailable', 'project file must be inside project root');
  }
  const fingerprint = computeFingerprint(filePath);
  const mode = fs.lstatSync(filePath).mode & 0o7777;
  return {
    path: projectRelative,
    pathSha256: pathSha256(filePath),
    role: 'project-file',
    sha256: fingerprint.sha256,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    mode
  };
}

// Fingerprint the project tree (minus the active state dir and FILE_SET_PRUNED_DIRECTORIES) so
// the file-set snapshot guard can detect out-of-set write/create/delete, including writes under
// build-output directories such as dist/build/coverage. Design notes:
//   - Whole-tree cost: this walk runs at begin-fix (capture) AND end-fix (validate), and the
//     captured tree is persisted in the baseline. That O(tree)x2-per-round cost is the price of
//     detecting unrelated fixer writes under guard=snapshot; a cheaper monitored-only check is
//     exactly the escape this guard closes.
//   - Exclusion set: the active workflow state dir plus FILE_SET_PRUNED_DIRECTORIES (VCS/package
//     internals) are skipped. Build outputs (dist/build/coverage) stay monitored because sneaky
//     out-of-set writes there are review-relevant. A pruned dir that appears/disappears between
//     capture and validate still blocks via the `excludedDirectories` monitor-scope-changed check.
// forceIncludeDirs lets a route opt a specific directory back INTO the tree walk even when
// it (or an ancestor) is normally pruned. r2p uses this so the whole requirement directory
// under the globally-pruned `.req-to-plan` is fingerprinted: a fixer write to run.md or any
// sibling 03–07 doc OUTSIDE the monitored set is then caught as an out-of-set tree change
// under guard=snapshot, the same way git status catches it under guard=git. PR/CODE pass no
// force-include dirs, so the walk (and the `.req-to-plan` prune) is byte-identical for them.
function shouldForceIncludeDirectory(relativePath, forceIncludeRelatives) {
  if (!forceIncludeRelatives || forceIncludeRelatives.length === 0) return false;
  return forceIncludeRelatives.some(
    (target) => target === relativePath || isInsideOrEqualPosix(relativePath, target) || isInsideOrEqualPosix(target, relativePath)
  );
}

function forceIncludeRelativesFor(projectRoot, forceIncludeDirs) {
  const root = path.resolve(projectRoot);
  return (Array.isArray(forceIncludeDirs) ? forceIncludeDirs : [])
    .map((dir) => toPosix(path.relative(root, path.isAbsolute(dir) ? dir : path.resolve(root, dir))))
    .filter((relative) => relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function isForceIncludedPath(relativePath, forceIncludeRelatives) {
  return forceIncludeRelatives.some((target) => isInsideOrEqualPosix(relativePath, target));
}

function isInsideOrEqualPosix(candidate, ancestor) {
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

function collectFileSetTreeRecords({ projectRoot, allowedStateDir = null, forceIncludeDirs = [] }) {
  const root = path.resolve(projectRoot);
  const stateDir = allowedStateDir ? path.resolve(allowedStateDir) : null;
  const forceIncludeRelatives = forceIncludeRelativesFor(root, forceIncludeDirs);
  const records = [];
  const excludedDirectories = [];

  function collectDirectory(directoryPath) {
    let entries;
    try {
      entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw guardError('target-only-guard-unavailable', 'monitored project directory is unreadable', { cause: error });
    }

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (stateDir && isInsideOrEqual(entryPath, stateDir)) continue;
      if (entry.isSymbolicLink()) {
        let resolved;
        try {
          resolved = fs.statSync(entryPath);
        } catch {
          resolved = null;
        }
        if (resolved && resolved.isDirectory()) {
          throw guardError('target-only-guard-unavailable', 'monitored directory symlink is not supported');
        }
        records.push(symlinkOpaqueRecord({ projectRoot: root, filePath: entryPath }));
        continue;
      }
      if (entry.isDirectory()) {
        const entryRelative = toPosix(path.relative(root, entryPath));
        if (isPrunedDirectoryPath(entryRelative) && !shouldForceIncludeDirectory(entryRelative, forceIncludeRelatives)) {
          excludedDirectories.push(entryRelative);
          continue;
        }
        collectDirectory(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      records.push(fileSetTreeRecord({ projectRoot: root, filePath: entryPath }));
    }
  }

  collectDirectory(root);
  return { records: uniqueByPath(records), excludedDirectories: excludedDirectories.sort() };
}

function fileSetEntryChanged(previous, current) {
  if (!previous || !current) return true;
  if (previous.missing || current.missing) return Boolean(previous.missing) !== Boolean(current.missing);
  return fingerprintChanged(previous, current);
}

function hasPrunedPathSegment(entryPath) {
  return hasPrunedDirectoryPath(entryPath);
}

function removedStringSetMembers(previous, current) {
  const currentSet = new Set(current || []);
  return (previous || []).filter((entry) => !currentSet.has(entry));
}

// Capture a fingerprint + restorable body baseline for a SET of monitored files.
// Missing monitored files block unless the file-set entry explicitly allows an absent
// baseline (for example a PR-deleted file). Symlink / outside-root files always block.
function captureFileSetBaseline({ projectRoot, monitoredFiles = [], allowedStateDir = null, forceIncludeDirs = [] }) {
  try {
    const entries = [];
    const seen = new Set();
    for (const entry of monitoredFiles) {
      const rawPath = monitoredFileSpec(entry);
      const record = fileSetEntryRecord({
        projectRoot,
        rawPath,
        withBody: true,
        allowMissing: monitoredFileAllowsMissing(entry)
      });
      if (seen.has(record.path)) continue;
      seen.add(record.path);
      entries.push(record);
    }
    const tree = collectFileSetTreeRecords({ projectRoot, allowedStateDir, forceIncludeDirs });
    return {
      status: 'passed',
      guardMode: 'snapshot',
      entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
      treeEntries: tree.records,
      excludedDirectories: tree.excludedDirectories
    };
  } catch (error) {
    if (error && error.blockingReason) return blockedSnapshotResult(error.blockingReason, error);
    return blockedSnapshotResult('target-only-guard-unavailable', error);
  }
}

// Validate the current state of the monitored set against a captured baseline. Returns the
// monitored files whose content fingerprint changed (mtime-only touches are ignored, same
// as the single-target guard). Missing monitored files are reported as changed inside the
// recorded set; symlink/unsafe monitored files still block.
function validateFileSetBaseline({ projectRoot, monitoredFiles = [], baseline, allowedStateDir = null, forceIncludeDirs = [] }) {
  if (!baseline || baseline.status !== 'passed' || !Array.isArray(baseline.entries)) {
    return { status: 'blocked', blockingReason: 'target-only-guard-unavailable', entries: [] };
  }
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const currentMonitored = new Map();
  const allowed = new Set();
  const changedFiles = [];
  const blockedEntries = [];
  try {
    for (const entry of monitoredFiles) {
      const rawPath = monitoredFileSpec(entry);
      const normalized = normalizedMonitoredFile({ projectRoot, rawPath });
      allowed.add(normalized.projectRelative);
      let current;
      try {
        current = fileSetEntryRecord({ projectRoot, rawPath, withBody: false, allowMissing: true });
      } catch (error) {
        throw error;
      }
      currentMonitored.set(current.path, current);
      const previous = before.get(current.path);
      if (!previous) {
        // Newly monitored file with no recorded baseline must be established first.
        blockedEntries.push(redactedEntry(path.resolve(projectRoot, current.path), 'unbaselined'));
        continue;
      }
      if (fileSetEntryChanged(previous, current)) changedFiles.push(current.path);
    }
    for (const previous of before.values()) {
      if (hasPrunedPathSegment(previous.path)) continue;
      if (!currentMonitored.has(previous.path)) {
        blockedEntries.push(redactedEntry(path.resolve(projectRoot, previous.path), 'unmonitored'));
      }
    }

    if (Array.isArray(baseline.treeEntries)) {
      const tree = collectFileSetTreeRecords({ projectRoot, allowedStateDir, forceIncludeDirs });
      const forceIncludeRelatives = forceIncludeRelativesFor(projectRoot, forceIncludeDirs);
      const previousExcludedDirectories = Array.isArray(baseline.excludedDirectories)
        ? baseline.excludedDirectories
        : [];
      // Only the DISAPPEARANCE of a previously-excluded directory blocks: a pruned dir that
      // vanishes (e.g. deleting .git) could hide tree changes, so it stays a scope breach. A
      // pruned dir that newly APPEARS is tolerated — it can only carry fresh infra/build noise
      // that never existed in the baseline tree, and content moved OUT of the monitored set is
      // still caught by the `deleted` check below (its original path disappears from the tree).
      // This also lets a dir that becomes pruned mid-round (a drfx upgrade that grows the pruned
      // set) settle without stranding the guard, paired with the hasPrunedPathSegment skips.
      const removedExcludedDirectories = removedStringSetMembers(previousExcludedDirectories, tree.excludedDirectories);
      if (removedExcludedDirectories.length > 0) {
        blockedEntries.push(redactedEntry(
          path.join(projectRoot, removedExcludedDirectories[0]),
          'monitor-scope-changed'
        ));
      }
      const beforeTree = new Map(baseline.treeEntries.map((entry) => [entry.path, entry]));
      const afterTree = new Map(tree.records.map((entry) => [entry.path, entry]));
      for (const [entryPath, current] of afterTree) {
        if (allowed.has(entryPath)) continue;
        const previous = beforeTree.get(entryPath);
        if (!previous) blockedEntries.push(redactedEntry(path.resolve(projectRoot, entryPath), 'created'));
        else if (monitorEntryChanged(previous, current)) {
          blockedEntries.push(redactedEntry(path.resolve(projectRoot, entryPath), 'modified'));
        }
      }
      for (const [entryPath] of beforeTree) {
        if (hasPrunedPathSegment(entryPath) && !isForceIncludedPath(entryPath, forceIncludeRelatives)) continue;
        if (allowed.has(entryPath)) continue;
        if (!afterTree.has(entryPath)) blockedEntries.push(redactedEntry(path.resolve(projectRoot, entryPath), 'deleted'));
      }
    }
  } catch (error) {
    return blockedSnapshotResult('target-only-guard-unavailable', error);
  }
  if (blockedEntries.length > 0) {
    return { status: 'blocked', blockingReason: 'unexpected-worktree-change', entries: blockedEntries };
  }
  return { status: 'passed', changedFiles: changedFiles.sort() };
}

// Restore the captured baseline body for the monitored set. Writes ONLY to monitored files;
// unmonitored paths are never touched. A monitored entry without a restorable body (or an
// unsafe/symlinked path) blocks as rollback-unavailable (never a silent partial restore).
function restoreFileSetBaseline({ projectRoot, monitoredFiles = [], baseline }) {
  if (!baseline || baseline.status !== 'passed' || !Array.isArray(baseline.entries)) {
    return { status: 'blocked', blockingReason: 'rollback-unavailable', entries: [] };
  }
  const root = path.resolve(projectRoot);
  const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const targets = [];
  try {
    for (const entry of monitoredFiles) {
      const rawPath = monitoredFileSpec(entry);
      const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
      const projectRelative = relativeToProject(root, absolute);
      if (!projectRelative) {
        throw guardError('rollback-unavailable', 'monitored file must be inside project root');
      }
      const record = byPath.get(projectRelative);
      if (!record) {
        throw guardError('rollback-unavailable', 'monitored file baseline body is unavailable');
      }
      if (record.missing) {
        assertSafeMissingFileParentChain({
          projectRoot: root,
          filePath: absolute,
          label: 'monitored file',
          blockingReason: 'rollback-unavailable'
        });
        let stats;
        try {
          stats = fs.lstatSync(absolute);
        } catch (error) {
          if (error && error.code === 'ENOENT') {
            targets.push({ absolute, projectRelative, action: 'delete' });
            continue;
          }
          throw guardError('rollback-unavailable', 'monitored file is unreadable', { cause: error });
        }
        if (stats.isDirectory() || (!stats.isFile() && !stats.isSymbolicLink())) {
          throw guardError('rollback-unavailable', 'monitored file must be a regular file, symlink, or absent');
        }
        targets.push({ absolute, projectRelative, action: 'delete' });
        continue;
      }
      if (!record.body) {
        throw guardError('rollback-unavailable', 'monitored file baseline body is unavailable');
      }
      assertSafeMissingFileParentChain({
        projectRoot: root,
        filePath: absolute,
        label: 'monitored file',
        blockingReason: 'rollback-unavailable'
      });
      // Reject restoring through a symlink: the destination must be a regular file (or
      // absent), never a symlink that could redirect the write outside the project.
      let stats;
      try {
        stats = fs.lstatSync(absolute);
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) {
          throw guardError('rollback-unavailable', 'monitored file is unreadable', { cause: error });
        }
        stats = null;
      }
      if (stats && stats.isSymbolicLink()) {
        throw guardError('rollback-unavailable', 'monitored file must not be a symlink');
      }
      if (stats && !stats.isFile()) {
        throw guardError('rollback-unavailable', 'monitored file must be a regular file');
      }
      targets.push({
        absolute,
        projectRelative,
        action: 'write',
        body: record.body,
        mode: typeof record.mode === 'number' ? record.mode : null
      });
    }
  } catch (error) {
    if (error && error.blockingReason) return blockedSnapshotResult(error.blockingReason, error);
    return blockedSnapshotResult('rollback-unavailable', error);
  }

  const restoredFiles = [];
  try {
    for (const { absolute, projectRelative, action, body, mode } of targets) {
      if (action === 'delete') fs.rmSync(absolute, { force: true });
      else {
        atomicWriteFile(absolute, body);
        if (mode !== null) fs.chmodSync(absolute, mode);
      }
      restoredFiles.push(projectRelative);
    }
  } catch (error) {
    // A write/rename failure (disk full, vanished parent dir, etc.) must surface as a
    // blocked rollback, never an uncaught throw that bypasses the guard contract.
    return blockedSnapshotResult('rollback-unavailable', error);
  }
  return {
    status: 'passed',
    guardMode: 'snapshot',
    restoredFiles: restoredFiles.sort()
  };
}

module.exports = {
  checkSnapshotRollbackAnchor,
  captureSnapshot,
  restoreSnapshot,
  checkSnapshotTargetOnly,
  inspectActualChangedFilesSnapshot,
  captureFileSetBaseline,
  validateFileSetBaseline,
  restoreFileSetBaseline
};
