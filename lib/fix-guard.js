'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Read-only git plumbing allowlist. runGit refuses to spawn any git subcommand
// outside this set, so a future edit cannot accidentally introduce
// fetch/push/remote/branch/ref mutations. Mirrors lib/target-context.js.
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'rev-parse',
  'ls-files',
  'status'
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

function assertInsideProject(projectRoot, filePath, label) {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw guardError('rollback-unavailable', `${label} must be inside project root`);
  }
  return toPosix(relative);
}

function assertTargetIdentity({ projectRoot, targetPath, expectedNormalizedTarget, blockingReason }) {
  const root = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(targetPath);
  let linkStats;
  try {
    linkStats = fs.lstatSync(absoluteTarget);
  } catch (error) {
    throw guardError(blockingReason, 'target is missing or unreadable', { cause: error });
  }
  if (linkStats.isSymbolicLink()) {
    throw guardError(blockingReason, 'target must not be a symlink');
  }
  if (!linkStats.isFile()) {
    throw guardError(blockingReason, 'target must be a regular file');
  }

  const normalizedTarget = assertInsideProject(root, absoluteTarget, 'target');
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
  const realNormalizedTarget = toPosix(realRelative);
  const expected = expectedNormalizedTarget ? toPosix(expectedNormalizedTarget) : normalizedTarget;
  if (realNormalizedTarget !== expected || normalizedTarget !== expected) {
    throw guardError(blockingReason, 'target identity does not match manifest target');
  }

  return normalizedTarget;
}

function runGit(projectRoot, args, blockingReason) {
  const subcommand = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw guardError(blockingReason, `refusing to run non-read-only git subcommand: ${subcommand}`);
  }
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw guardError(blockingReason, `git ${args.join(' ')} failed`, { cause: error });
  }
}

function parseGitPath(rawPath) {
  const text = String(rawPath || '');
  if (!text) throw new Error('empty path');
  if (path.isAbsolute(text) || text.split('/').includes('..') || text.includes('\0')) {
    throw new Error(`unsafe path: ${rawPath}`);
  }
  return text;
}

function entryKind(statusCode) {
  if (statusCode === '??') return 'untracked';
  if (statusCode.includes('R')) return 'renamed';
  if (statusCode.includes('C')) return 'copied';
  if (statusCode.includes('D')) return 'deleted';
  if (statusCode[0] && statusCode[0] !== ' ') return 'staged';
  if (statusCode[1] && statusCode[1] !== ' ') return 'dirty';
  return 'modified';
}

function parsePorcelainStatus(output) {
  const text = String(output || '');
  if (text === '') return [];
  if (!text.endsWith('\0')) throw new Error('unparseable git status output: missing NUL terminator');
  const records = text.split('\0');
  records.pop();
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`unparseable git status record: ${record}`);
    }
    const statusCode = record.slice(0, 2);
    const firstPath = parseGitPath(record.slice(3));
    let paths;
    if (statusCode.includes('R') || statusCode.includes('C')) {
      if (index + 1 >= records.length) {
        throw new Error(`unparseable rename/copy git status record: ${record}`);
      }
      const sourcePath = parseGitPath(records[index + 1]);
      index += 1;
      // In porcelain v1 -z, rename/copy records emit destination first and source second.
      // Preserve the historical parser API order (source, destination) for callers.
      paths = [
        sourcePath,
        firstPath
      ];
    } else {
      paths = [firstPath];
    }
    entries.push({
      statusCode,
      kind: entryKind(statusCode),
      paths
    });
  }
  return entries;
}

function readPorcelainStatus(projectRoot) {
  const output = runGit(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'target-only-guard-unavailable');
  try {
    return parsePorcelainStatus(output);
  } catch (error) {
    throw guardError('target-only-guard-unavailable', error.message, { cause: error });
  }
}

function readGitTopLevel(projectRoot) {
  const output = runGit(projectRoot, ['rev-parse', '--show-toplevel'], 'target-only-guard-unavailable').trim();
  if (!output) throw guardError('target-only-guard-unavailable', 'git top-level is unavailable');
  return path.resolve(output);
}

function gitStatusPathToProjectPath({ repoRoot, projectRoot, rawPath }) {
  const absolutePath = path.resolve(repoRoot, ...toPosix(rawPath).split('/'));
  return toPosix(path.relative(projectRoot, absolutePath));
}

function pathSha256(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex');
}

function redactEntry(entry, relativePath) {
  return {
    pathSha256: pathSha256(relativePath),
    statusCode: entry.statusCode,
    kind: entry.kind
  };
}

function isInsideOrEqual(relativePath, parentRelativePath) {
  return relativePath === parentRelativePath || relativePath.startsWith(`${parentRelativePath}/`);
}

function inspectStatusEntries({
  projectRoot,
  targetPath,
  allowedStateDir,
  allowTarget,
  expectedNormalizedTarget,
  targetIdentityBlockingReason = 'target-only-guard-unavailable'
}) {
  const root = path.resolve(projectRoot);
  const normalizedTarget = assertTargetIdentity({
    projectRoot: root,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: targetIdentityBlockingReason
  });
  const stateRelative = allowedStateDir
    ? toPosix(path.relative(root, path.resolve(allowedStateDir)))
    : null;
  if (stateRelative && (stateRelative.startsWith('..') || path.isAbsolute(stateRelative))) {
    throw guardError('target-only-guard-unavailable', 'allowed state directory must be inside project root');
  }

  const entries = readPorcelainStatus(root);
  const nonTargetEntries = [];
  const changedTargets = new Set();
  let allowedStateEntryCount = 0;

  for (const entry of entries) {
    let entryTouchesTarget = false;
    let entryIsAllowedState = false;
    for (const rawPath of entry.paths) {
      const relativePath = rawPath.split(path.sep).join('/');
      if (relativePath === normalizedTarget) {
        entryTouchesTarget = true;
      } else if (stateRelative && isInsideOrEqual(relativePath, stateRelative)) {
        entryIsAllowedState = true;
      } else {
        nonTargetEntries.push(redactEntry(entry, relativePath));
      }
    }

    if (entryTouchesTarget) {
      changedTargets.add(normalizedTarget);
      if (!allowTarget) {
        nonTargetEntries.push(redactEntry(entry, normalizedTarget));
      }
    } else if (entryIsAllowedState) {
      allowedStateEntryCount += 1;
    }
  }

  if (nonTargetEntries.length > 0) {
    return {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: nonTargetEntries
    };
  }

  return {
    status: 'passed',
    changedFiles: [...changedTargets].sort(),
    allowedStateEntryCount
  };
}

function checkGitRollbackAnchor({
  projectRoot,
  targetPath,
  expectedNormalizedTarget = null,
  priorFix = false
}) {
  const root = path.resolve(projectRoot);
  runGit(root, ['rev-parse', '--is-inside-work-tree'], 'rollback-unavailable');
  const head = runGit(root, ['rev-parse', '--verify', 'HEAD'], 'rollback-unavailable').trim();
  const normalizedTarget = assertTargetIdentity({
    projectRoot: root,
    targetPath,
    expectedNormalizedTarget,
    blockingReason: 'rollback-unavailable'
  });
  runGit(root, ['ls-files', '--error-unmatch', '--', normalizedTarget], 'rollback-unavailable');

  // Subsequent fix: the target's WORKTREE may be legitimately dirty with our own prior
  // output (assertPreFixFingerprint already proved current == lastKnown), so relax the
  // worktree-clean requirement. A STAGED (index) target change is NOT validated upstream,
  // so keep rejecting it — only the worktree-clean rule is relaxed, not index-clean.
  if (priorFix) {
    let stagedEntries;
    try {
      stagedEntries = parsePorcelainStatus(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'rollback-unavailable'));
    } catch (error) {
      if (error && error.blockingReason) throw error;
      throw guardError('rollback-unavailable', error.message, { cause: error });
    }
    const stagedTarget = stagedEntries.filter(
      (entry) => entry.paths.includes(normalizedTarget) && entry.statusCode[0] !== ' '
    );
    if (stagedTarget.length > 0) {
      throw guardError('rollback-unavailable', 'target must not have staged index changes before a subsequent fix', {
        entries: stagedTarget.map((entry) => ({
          statusCode: entry.statusCode,
          kind: entry.kind
        }))
      });
    }
    return { status: 'passed', head, normalizedTarget, priorFix: true };
  }

  let entries;
  try {
    entries = parsePorcelainStatus(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'rollback-unavailable'));
  } catch (error) {
    if (error && error.blockingReason) throw error;
    throw guardError('rollback-unavailable', error.message, { cause: error });
  }

  const targetEntries = entries.filter((entry) => entry.paths.includes(normalizedTarget));
  if (targetEntries.length > 0) {
    throw guardError('rollback-unavailable', 'target must be tracked, index-clean, and worktree-clean', {
      entries: targetEntries.map((entry) => ({
        statusCode: entry.statusCode,
        kind: entry.kind
      }))
    });
  }

  return {
    status: 'passed',
    head,
    normalizedTarget
  };
}

function blockedGuardResult(blockingReason, error) {
  return {
    status: 'blocked',
    blockingReason,
    entries: [],
    message: error && error.message ? error.message : String(error)
  };
}

function checkTargetOnlyWorktree({ projectRoot, targetPath, allowedStateDir, expectedNormalizedTarget = null }) {
  try {
    return inspectStatusEntries({
      projectRoot,
      targetPath,
      allowedStateDir,
      allowTarget: false,
      expectedNormalizedTarget
    });
  } catch (error) {
    if (error && error.blockingReason === 'rollback-unavailable') throw error;
    if (error && error.blockingReason === 'target-only-guard-unavailable') throw error;
    return blockedGuardResult('target-only-guard-unavailable', error);
  }
}

function inspectActualChangedFiles({ projectRoot, targetPath, allowedStateDir, expectedNormalizedTarget = null }) {
  try {
    return inspectStatusEntries({
      projectRoot,
      targetPath,
      allowedStateDir,
      allowTarget: true,
      expectedNormalizedTarget,
      targetIdentityBlockingReason: 'unexpected-worktree-change'
    });
  } catch (error) {
    if (error && error.blockingReason === 'unexpected-worktree-change') {
      return blockedGuardResult('unexpected-worktree-change', error);
    }
    return blockedGuardResult('target-only-guard-unavailable', error);
  }
}

// --- File-set guard primitives (PLAN-TASK-006) ---
//
// These extend the single-target git guard to an EXPLICIT allowed/monitored SET of files
// (the primary target PLUS recorded necessary dependency files). They are ADDITIVE: the
// single-target wrappers above are unchanged. PLAN-TASK-009 wires these into the live
// fixer boundary; TASK-006 only provides + unit-tests the primitives.

// Accepts plain string paths or { path, reason, issueId } dependency records and returns
// project-relative POSIX paths. Rejects absolute/.. /unsafe paths (same safety as the
// single-target path checks). Throws a target-only-guard-unavailable guardError on unsafe
// input so callers never proceed with an unvalidated allowed set.
function normalizeAllowedFileSet(allowedFiles) {
  const normalized = new Set();
  for (const entry of allowedFiles || []) {
    const raw = typeof entry === 'string' ? entry : (entry && entry.path);
    if (typeof raw !== 'string' || raw === '') {
      throw guardError('target-only-guard-unavailable', 'allowed file entry must be a non-empty path');
    }
    if (raw.includes('\0')) {
      throw guardError('target-only-guard-unavailable', 'allowed file path must not contain null bytes');
    }
    const posix = toPosix(raw);
    if (path.posix.isAbsolute(posix) || path.isAbsolute(raw) || posix.split('/').includes('..') || posix.startsWith('/')) {
      throw guardError('target-only-guard-unavailable', 'allowed file path must be a safe project-relative path');
    }
    normalized.add(posix);
  }
  return normalized;
}

function normalizeChangedFileEntry(rawEntry) {
  if (typeof rawEntry === 'string') {
    return {
      relativePath: toPosix(rawEntry),
      statusCode: null,
      kind: null
    };
  }
  const rawPath = rawEntry && (rawEntry.relativePath || rawEntry.path);
  return {
    relativePath: toPosix(rawPath),
    statusCode: rawEntry && rawEntry.statusCode ? rawEntry.statusCode : null,
    kind: rawEntry && rawEntry.kind ? rawEntry.kind : null
  };
}

function hasIndexChange(entry) {
  if (!entry || typeof entry.statusCode !== 'string' || entry.statusCode.length < 2) return false;
  if (entry.statusCode === '??') return false;
  return entry.statusCode[0] !== ' ';
}

// PURE classifier core: decides ok/blocked from caller-supplied changed paths against an
// allowed set. Callers must explicitly decide whether dirty in-set files are trusted
// prior-round route writes (`allowAllowedFileChanges`) or first-round local dirt.
// Unit-testable in isolation. The SECURITY-relevant caller is
// checkFileSetWorktree, which feeds it REAL git status — never trust injected changedPaths
// for the live safety decision. When status records are supplied, allowed files and
// allowed state entries with staged/index changes are blocked; only unstaged worktree
// changes can be treated as prior-round route-owned dirt.
function classifyFileSetChanges({
  changedPaths = [],
  allowedSet = [],
  allowedStateRelative = null,
  allowAllowedFileChanges = true
}) {
  const allowed = allowedSet instanceof Set ? allowedSet : new Set((allowedSet || []).map((value) => toPosix(value)));
  const stateRelative = allowedStateRelative ? toPosix(allowedStateRelative) : null;
  const offending = [];
  const offendingEntriesByPath = new Map();
  const changed = new Set();
  let allowedStateEntryCount = 0;
  function addOffending(relativePath, entry) {
    offending.push(relativePath);
    if (!offendingEntriesByPath.has(relativePath)) {
      offendingEntriesByPath.set(relativePath, {
        relativePath,
        statusCode: entry.statusCode || 'worktree',
        kind: entry.kind || 'changed'
      });
    }
  }
  for (const rawEntry of changedPaths) {
    const entry = normalizeChangedFileEntry(rawEntry);
    const relativePath = entry.relativePath;
    if (allowed.has(relativePath)) {
      if (allowAllowedFileChanges) {
        if (hasIndexChange(entry)) {
          addOffending(relativePath, entry);
        } else {
          changed.add(relativePath);
        }
      } else {
        addOffending(relativePath, entry);
      }
    } else if (stateRelative && isInsideOrEqual(relativePath, stateRelative)) {
      if (hasIndexChange(entry)) {
        addOffending(relativePath, entry);
      } else {
        allowedStateEntryCount += 1;
      }
    } else {
      addOffending(relativePath, entry);
    }
  }
  if (offending.length > 0) {
    const sortedOffending = [...new Set(offending)].sort();
    return {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      offending: sortedOffending,
      offendingEntries: sortedOffending.map((relativePath) => offendingEntriesByPath.get(relativePath)),
      changedFiles: [...changed].sort(),
      allowedStateEntryCount
    };
  }
  return {
    status: 'ok',
    offending: [],
    changedFiles: [...changed].sort(),
    allowedStateEntryCount
  };
}

// WRAPPER: reads the ACTUAL worktree via `git status --porcelain` (reuses
// parsePorcelainStatus), then classifies against the allowed set. A change to any file IN
// the allowed/route-owned set is allowed only when the caller has confirmed prior-round
// route ownership; any untrusted or out-of-set change blocks (unexpected-worktree-change).
// git failure => blocked with the guard-unavailable reason, NEVER a silent pass.
function checkFileSetWorktree({
  projectRoot,
  allowedFiles,
  allowedStateDir = null,
  allowAllowedFileChanges = true
}) {
  let root;
  try {
    root = fs.realpathSync.native(path.resolve(projectRoot));
  } catch (error) {
    return blockedGuardResult('target-only-guard-unavailable', error);
  }
  const allowed = normalizeAllowedFileSet(allowedFiles);
  let stateRelative = null;
  if (allowedStateDir) {
    const stateAbsolute = fs.existsSync(allowedStateDir)
      ? fs.realpathSync.native(path.resolve(allowedStateDir))
      : path.resolve(allowedStateDir);
    stateRelative = toPosix(path.relative(root, stateAbsolute));
    if (stateRelative === '' || stateRelative.startsWith('..') || path.isAbsolute(stateRelative)) {
      throw guardError('target-only-guard-unavailable', 'allowed state directory must be inside project root');
    }
  }

  let entries;
  let repoRoot;
  try {
    repoRoot = readGitTopLevel(root);
    entries = readPorcelainStatus(repoRoot);
  } catch (error) {
    if (error && error.blockingReason) {
      return blockedGuardResult(error.blockingReason, error);
    }
    return blockedGuardResult('target-only-guard-unavailable', error);
  }

  const changedPaths = [];
  try {
    for (const entry of entries) {
      for (const rawPath of entry.paths) {
        changedPaths.push({
          relativePath: gitStatusPathToProjectPath({ repoRoot, projectRoot: root, rawPath }),
          statusCode: entry.statusCode,
          kind: entry.kind
        });
      }
    }
  } catch (error) {
    return blockedGuardResult('target-only-guard-unavailable', error);
  }

  const classified = classifyFileSetChanges({
    changedPaths,
    allowedSet: allowed,
    allowedStateRelative: stateRelative,
    allowAllowedFileChanges
  });
  if (classified.status === 'blocked') {
    return {
      status: 'blocked',
      blockingReason: 'unexpected-worktree-change',
      entries: classified.offendingEntries.map((entry) => redactEntry(entry, entry.relativePath))
    };
  }
  return {
    status: 'passed',
    changedFiles: classified.changedFiles,
    allowedStateEntryCount: classified.allowedStateEntryCount
  };
}

function formatFixGuardReport({
  round,
  normalizedTarget,
  targetFingerprint,
  referenceFingerprints,
  rollbackAnchor,
  targetOnlyGuard,
  lock,
  status = 'passed',
  blockingReason = 'none'
}) {
  const report = {
    round,
    normalizedTarget,
    targetFingerprint,
    referenceFingerprints: referenceFingerprints || [],
    rollbackAnchor,
    targetOnlyGuard,
    lock,
    status,
    blockingReason
  };
  return [
    '# Fix Guard Report',
    '',
    `Round: ${round}`,
    `Status: ${status}`,
    `Blocking reason: ${blockingReason}`,
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    ''
  ].join('\n');
}

module.exports = {
  checkGitRollbackAnchor,
  checkTargetOnlyWorktree,
  inspectActualChangedFiles,
  formatFixGuardReport,
  parsePorcelainStatus,
  classifyFileSetChanges,
  checkFileSetWorktree,
  runGit
};
