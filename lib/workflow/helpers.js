'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildContextPack, buildFileSetContextPack, writeContextManifest } = require('../context-pack');
const {
  checkGitRollbackAnchor,
  checkTargetOnlyWorktree,
  inspectActualChangedFiles,
  formatFixGuardReport
} = require('../fix-guard');
const {
  captureSnapshot,
  checkSnapshotRollbackAnchor,
  checkSnapshotTargetOnly,
  inspectActualChangedFilesSnapshot,
  restoreSnapshot
} = require('../snapshot-guard');
// Raw (non-normalizing) atomic write for binary baseline bodies. State/text writes
// use workflow-state's atomicWriteFile, which redacts and line-normalizes first.
const { atomicWriteFile: atomicWriteFileRaw } = require('../atomic-write');
const {
  validateFinalResponse,
  validateResumeState
} = require('../final-response');
const {
  applyTriageDecisions,
  enrichTriageDecisions,
  formatLedger,
  parseLedger,
  validateTriageReviewerIds
} = require('../ledger');
const {
  acquireLock,
  refreshLock,
  assertPreFixFingerprint,
  deriveFileSetStateKey,
  releaseLock,
  readLease,
  readPersistedLeaseForTarget,
  validateDocumentStateIdentity
} = require('../lock');
const { writeRoundReceipt } = require('../receipts');
const { loadCustomRuleFiles, mergeRules, loadRouteRuleContext } = require('../rulebook');
const {
  resolveTargetContext,
  resolveCodeTarget,
  describeCodeBlock,
  computeFileSetFingerprint,
  hasCodeExcludedDirectory,
  buildPrIdentity,
  buildCodeIdentity,
  comparePrIdentity,
  compareCodeIdentity,
  resolveR2pWorkIdTarget
} = require('../target-context');
const {
  captureFileSetBaseline,
  validateFileSetBaseline,
  restoreFileSetBaseline
} = require('../snapshot-guard');
const {
  checkFileSetWorktree
} = require('../fix-guard');
const {
  computeFingerprint,
  deriveTargetKey,
  deriveR2pTargetKey,
  normalizeReferences,
  readManifestAny,
  resolveProjectRoot,
  validateLedgerPath,
  validateTargetStateOwnedPath
} = require('../target-state');
const {
  createPreflightToken,
  createReviewGuard,
  nextStateToken,
  validateReviewGuard,
  validateStateToken
} = require('../no-state');
const {
  isFileSetRoute,
  resolveR2pProjectRoot,
  resolveRouteTargetMetadata
} = require('./target-resolution');
const { parseReviewerResult } = require('../reviewer-report');
const {
  parseDiffReview,
  parseFixReport,
  parseFinalResponseBlock,
  parseTriageResult,
  readSemanticPayload
} = require('../semantic-parsers');
const {
  atomicWriteFile,
  BLOCKING_REASONS,
  STATUS_REASONS,
  formatSummary,
  formatManifestV2
} = require('../workflow-state');
const { canonicalFingerprint, stableJson } = require('./serialization');

const NO_STATE_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RESERVED_STATE_PATH_BASENAMES = new Set(['MANIFEST.md', 'CONTINUITY.md', 'SUMMARY.md']);
const FILE_SET_BASELINE_BASENAME = 'file-set-baseline.json';
const FILE_SET_BASELINE_BODIES_DIR = 'file-set-baseline-bodies';

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function protectedDependencyRelativePath(projectRoot, entry) {
  const raw = entry && entry.path;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('protected dependency path must be a non-empty path');
  if (raw.includes('\0')) throw new Error('protected dependency path must not contain null bytes');
  if (path.win32.isAbsolute(raw)) throw new Error(`protected dependency path must be project-relative: ${raw}`);
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`protected dependency path must be inside project root: ${raw}`);
  }
  return relative.split(path.sep).join('/');
}

function protectedDependencyFingerprint(projectRoot, relativePath) {
  const absolute = path.resolve(projectRoot, relativePath);
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'missing', sha256: 'none', size: 0 };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(absolute);
    return { kind: 'symlink', sha256: sha256Buffer(Buffer.from(linkTarget)), size: Buffer.byteLength(linkTarget) };
  }
  if (!stats.isFile()) return { kind: stats.isDirectory() ? 'directory' : 'other', sha256: 'none', size: stats.size };
  return { kind: 'file', sha256: sha256Buffer(fs.readFileSync(absolute)), size: stats.size };
}

function fileSetReviewFingerprintSummary(projectRoot, fileSetFingerprint, liveFileSet) {
  const files = Array.isArray(liveFileSet.files) ? liveFileSet.files : [];
  const summary = { normalizedPath: 'none', sha256: fileSetFingerprint, size: files.length, mtimeMs: 0 };
  const protectedDependencies = (Array.isArray(liveFileSet.protectedDependencies) ? liveFileSet.protectedDependencies : [])
    .map((entry) => {
      const relativePath = protectedDependencyRelativePath(projectRoot, entry);
      return {
        path: relativePath,
        readOnly: entry && entry.readOnly !== false,
        contentId: String((entry && entry.sha256) || (entry && entry.contentId) || 'none'),
        ...protectedDependencyFingerprint(projectRoot, relativePath)
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (protectedDependencies.length === 0) return summary;
  const dependencyInput = protectedDependencies.map(({ path: dependencyPath, readOnly, contentId, kind, sha256, size }) => ({
    path: dependencyPath,
    readOnly,
    contentId,
    kind,
    sha256,
    size
  }));
  summary.sha256 = sha256Buffer(Buffer.from(stableJson({ fileSetFingerprint, protectedDependencies: dependencyInput })));
  summary.size += protectedDependencies.length;
  return summary;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function failStateValidation(message) {
  fail('ERR_STATE_VALIDATION_FAILED', `state-validation-failed: ${message}`);
}

function descriptorPlatformFor(runtimePlatform) {
  if (runtimePlatform === 'claude-code') return 'claude';
  return runtimePlatform;
}

function resolveTargetMetadata(parsed, options) {
  // Route-kind aware (shared with index.js): document ⇒ single-file deriveTargetKey;
  // PR/CODE ⇒ file-set identity. Never deriveTargetKey on an undefined single-file target.
  return resolveRouteTargetMetadata(parsed, options);
}

function resolveNoStateMetadata(parsed, options) {
  const projectRoot = resolveProjectRoot({
    explicitRoot: parsed.invocation.root,
    targetPath: parsed.invocation.target,
    cwd: options.cwd || process.cwd(),
    persistentStateRequired: false
  });
  if (!projectRoot) fail('ERR_EXPLICIT_ROOT_REQUIRED', 'Unable to resolve project root for no-state workflow');
  const targetMetadata = deriveTargetKey(projectRoot, parsed.invocation.target);
  const referenceRecords = normalizeReferences({
    projectRoot,
    references: parsed.invocation.refs,
    targetPath: parsed.invocation.target
  });
  const references = referenceRecords.map((reference) => {
    if (reference.external) return reference.realPath;
    return path.relative(projectRoot, reference.realPath).split(path.sep).join('/');
  });
  const referenceFingerprints = referenceRecords.map((reference, index) => canonicalFingerprint(
    computeFingerprint(reference.realPath),
    references[index]
  ));
  return {
    projectRoot,
    targetKey: targetMetadata.targetKey,
    normalizedTarget: targetMetadata.normalizedTarget,
    references,
    targetFingerprint: canonicalFingerprint(computeFingerprint(parsed.invocation.target)),
    referenceFingerprints
  };
}

function workflowBase(parsed, options = {}) {
  const targetMetadata = resolveTargetMetadata(parsed, options);
  const fileSet = isFileSetRoute(parsed);
  const descriptorPlatform = parsed.assurance === 'strict-verified' && parsed.proofRunId
    ? descriptorPlatformFor(parsed.runtimePlatform)
    : 'none';
  const assuranceProof = descriptorPlatform === 'none'
    ? 'none'
    : `capability-descriptor:${descriptorPlatform}:${parsed.proofRunId}`;
  return {
    ok: true,
    status: 'started',
    entrySkill: parsed.entrySkill,
    routeKind: targetMetadata.routeKind,
    documentType: fileSet ? 'none' : parsed.invocation.documentType,
    target: fileSet ? null : parsed.invocation.target,
    base: fileSet ? (targetMetadata.base || null) : null,
    scopes: fileSet ? (targetMetadata.scopes || null) : null,
    targetKey: targetMetadata.targetKey,
    requestedMode: parsed.invocation.requestedMode,
    mode: parsed.invocation.mode,
    guardMode: parsed.invocation.guardMode || 'git',
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: parsed.invocation.modeNormalizedFrom,
    strictness: parsed.invocation.strictness,
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform,
    assuranceProof,
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: parsed.runtimeCheck,
    blockingReason: parsed.blockingReason || 'none',
    statusReason: parsed.statusReason || 'none'
  };
}

function fallbackWorkflowBase(parsed) {
  const descriptorPlatform = parsed.assurance === 'strict-verified' && parsed.proofRunId
    ? descriptorPlatformFor(parsed.runtimePlatform)
    : 'none';
  const assuranceProof = descriptorPlatform === 'none'
    ? 'none'
    : `capability-descriptor:${descriptorPlatform}:${parsed.proofRunId}`;
  return {
    ok: true,
    status: 'started',
    entrySkill: parsed.entrySkill,
    documentType: parsed.invocation.documentType,
    target: parsed.invocation.target,
    targetKey: null,
    requestedMode: parsed.invocation.requestedMode,
    mode: parsed.invocation.mode,
    guardMode: parsed.invocation.guardMode || 'git',
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: parsed.invocation.modeNormalizedFrom,
    strictness: parsed.invocation.strictness,
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform,
    assuranceProof,
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: parsed.runtimeCheck,
    blockingReason: parsed.blockingReason || 'none',
    statusReason: parsed.statusReason || 'none'
  };
}

function preflightBase(parsed, options = {}) {
  try {
    return { base: workflowBase(parsed, options), error: null };
  } catch (error) {
    return { base: fallbackWorkflowBase(parsed), error };
  }
}

function withReadOnlyMode(result) {
  if (result.mode === 'read-only') return result;
  return {
    ...result,
    mode: 'read-only',
    modeNormalizedFrom: result.mode
  };
}

function noStateBase(parsed, metadata, overrides = {}) {
  const mode = overrides.mode || parsed.invocation.mode;
  return {
    ok: true,
    status: overrides.status || 'started',
    entrySkill: parsed.entrySkill,
    documentType: parsed.invocation.documentType,
    target: parsed.invocation.target,
    targetKey: metadata.targetKey,
    targetStateDir: null,
    manifestPath: null,
    ledgerPath: null,
    contextManifestPath: null,
    round: overrides.round || 1,
    requestedMode: parsed.invocation.requestedMode,
    mode,
    guardMode: parsed.invocation.guardMode || 'git',
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: mode === parsed.invocation.mode ? parsed.invocation.modeNormalizedFrom : parsed.invocation.mode,
    strictness: parsed.invocation.strictness,
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: overrides.runtimeCheck || parsed.runtimeCheck,
    blockingReason: overrides.blockingReason || parsed.blockingReason || 'none',
    statusReason: overrides.statusReason || parsed.statusReason || 'none',
    nextAction: Object.hasOwn(overrides, 'nextAction') ? overrides.nextAction : null
  };
}

function noStateValidationFailure(parsed, metadata, {
  errorCode = 'final-validation-failed',
  message,
  blockingReason = 'final-validation-failed',
  statusReason = 'none',
  nextAction = null
} = {}) {
  return {
    ...noStateBase(parsed, metadata, {
      status: 'blocked',
      blockingReason,
      statusReason,
      nextAction
    }),
    ok: false,
    errorCode,
    message
  };
}

function noStateTokenTooLarge(parsed, metadata, error) {
  return noStateValidationFailure(parsed, metadata, {
    errorCode: 'state-token-too-large',
    message: error && error.message ? error.message : 'state-token-too-large',
    blockingReason: 'state-token-too-large',
    statusReason: 'none',
    nextAction: 'rerun with ledger= or review-and-fix persistent state'
  });
}

function noStateOutputOrTooLarge(parsed, metadata, createOutput) {
  try {
    return createOutput();
  } catch (error) {
    if (error && error.code === 'ERR_STATE_TOKEN_TOO_LARGE') {
      return noStateTokenTooLarge(parsed, metadata, error);
    }
    throw error;
  }
}

function readWorkflowPayload({ parsed, metadata, valueFlag, stdinFlag, label, options }) {
  const fromStdin = Boolean(parsed.payloadFlags[stdinFlag]);
  const fromFile = parsed.payloadFlags[valueFlag] || null;
  if (fromStdin === Boolean(fromFile)) {
    fail('ERR_SEMANTIC_HANDOFF', `exactly one ${label} stdin or safe file input is required`);
  }
  if (fromStdin) {
    if (parsed.runtimeCheck.stdinHandoff.status !== 'ready') {
      fail('ERR_SEMANTIC_HANDOFF', `${label} stdin handoff requires ready runtime stdin`);
    }
    return readSemanticPayload({ content: options.stdin || '' });
  }
  return readSemanticPayload({ filePath: fromFile, projectRoot: metadata.projectRoot });
}

function metadataExpectedGuard(parsed, metadata) {
  return {
    phase: parsed.phase || 'initial-review',
    round: 1,
    normalizedTarget: metadata.normalizedTarget,
    references: metadata.references,
    targetFingerprint: metadata.targetFingerprint,
    referenceFingerprints: metadata.referenceFingerprints,
    strictness: parsed.invocation.strictness,
    mode: parsed.invocation.mode,
    assurance: parsed.assurance,
    runtimePlatform: parsed.runtimePlatform
  };
}

function loadMergedRules({ projectRoot, documentType, strictness = 'normal', homeDir = null } = {}) {
  const userHome = homeDir || process.env.HOME || null;
  const loaded = loadCustomRuleFiles({ projectRoot, documentType, strictness, homeDir: userHome });
  return {
    ...mergeRules({ documentType, user: loaded.user, project: loaded.project }),
    warnings: loaded.warnings
  };
}

function assertReadableWritableTarget(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    const guard = new Error('target must be readable and writable for automatic fixes');
    guard.blockingReason = 'rollback-unavailable';
    guard.cause = error;
    throw guard;
  }
}

function targetStateDirectory(projectRoot, targetKey) {
  return path.join(projectRoot, '.drfx', 'targets', targetKey);
}

function resolvePersistentMetadata(parsed, options) {
  const projectRoot = resolveProjectRoot({
    explicitRoot: parsed.invocation.root,
    targetPath: parsed.invocation.target,
    cwd: options.cwd || process.cwd(),
    persistentStateRequired: true
  });
  const targetMetadata = deriveTargetKey(projectRoot, parsed.invocation.target);
  const targetStateDir = targetStateDirectory(projectRoot, targetMetadata.targetKey);
  const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
  const manifest = readManifestAny(manifestPath);
  return {
    projectRoot,
    targetKey: targetMetadata.targetKey,
    normalizedTarget: targetMetadata.normalizedTarget,
    targetPath: path.resolve(projectRoot, targetMetadata.normalizedTarget),
    targetStateDir,
    manifestPath,
    manifest
  };
}

function resolveFileSetPersistentMetadata(parsed, options = {}) {
  if (parsed.invocation && parsed.invocation.routeKind === 'r2p') {
    const projectRoot = resolveR2pProjectRoot(parsed, options);
    const targetKey = deriveR2pTargetKey({ projectRoot, workId: parsed.invocation.workId }).targetKey;
    const targetStateDir = targetStateDirectory(projectRoot, targetKey);
    const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
    return {
      projectRoot, routeKind: 'r2p', targetKey, normalizedTarget: null, targetPath: null,
      targetStateDir, manifestPath, manifest: readManifestAny(manifestPath)
    };
  }
  const targetMetadata = resolveRouteTargetMetadata(parsed, options);
  const projectRoot = targetMetadata.projectRoot;
  const targetKey = targetMetadata.targetKey;
  const targetStateDir = targetStateDirectory(projectRoot, targetKey);
  const manifestPath = path.join(targetStateDir, 'MANIFEST.md');
  const manifest = readManifestAny(manifestPath);
  return {
    projectRoot,
    routeKind: targetMetadata.routeKind,
    targetKey,
    normalizedTarget: null,
    targetPath: null,
    targetStateDir,
    manifestPath,
    manifest
  };
}

function failStartStateValidation(base, {
  targetStateDir,
  manifestPath,
  message,
  nextAction = 'repair target state path before starting workflow'
}) {
  return {
    ...base,
    ok: false,
    status: 'blocked',
    targetStateDir,
    manifestPath,
    ledgerPath: null,
    round: null,
    currentPhase: 'review',
    errorCode: 'ERR_STATE_VALIDATION_FAILED',
    message: `state-validation-failed: ${message}`,
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction
  };
}

function assertExistingStateDirectorySafe(directoryPath, label) {
  let stats;
  try {
    stats = fs.lstatSync(directoryPath);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) failStateValidation(`${label} must not be a symlink`);
  if (!stats.isDirectory()) failStateValidation(`${label} must be a directory`);
}

function assertExistingStateFileSafe(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) failStateValidation(`${label} must not be a symlink`);
  if (stats.isDirectory()) failStateValidation(`${label} must be a file`);
}

function validatePersistentStartStatePaths({ projectRoot, targetStateDir, manifestPath, ledgerPath }) {
  const stateRoot = path.join(projectRoot, '.drfx');
  const targetsRoot = path.join(stateRoot, 'targets');
  const relativeTargetDir = path.relative(targetsRoot, targetStateDir);
  if (relativeTargetDir === '' || relativeTargetDir.startsWith('..') || path.isAbsolute(relativeTargetDir)) {
    failStateValidation('target state directory escapes project state targets directory');
  }

  assertExistingStateDirectorySafe(stateRoot, 'Project state directory');
  assertExistingStateDirectorySafe(targetsRoot, 'Targets state directory');
  assertExistingStateDirectorySafe(targetStateDir, 'Target state directory');
  assertExistingStateFileSafe(manifestPath, 'Manifest path');
  assertExistingStateFileSafe(ledgerPath, 'Ledger path');
}

function manifestReferenceInput(parsed, manifest, projectRoot) {
  const references = parsed.invocation.refs.length > 0 ? parsed.invocation.refs : (manifest.references || []);
  return references.map((reference) => (
    path.isAbsolute(reference) ? reference : path.resolve(projectRoot, reference)
  ));
}

function referenceRecordsFor(parsed, metadata) {
  return normalizeReferences({
    projectRoot: metadata.projectRoot,
    references: manifestReferenceInput(parsed, metadata.manifest, metadata.projectRoot),
    targetPath: parsed.invocation.target
  });
}

function normalizedReferencePath(reference, projectRoot) {
  if (reference.external) return reference.realPath;
  return path.relative(projectRoot, reference.realPath).split(path.sep).join('/');
}

function guardBaselineFor(parsed, metadata) {
  const referenceRecords = referenceRecordsFor(parsed, metadata);
  const references = referenceRecords.map((reference) => normalizedReferencePath(reference, metadata.projectRoot));
  const referenceFingerprints = referenceRecords.map((reference, index) => canonicalFingerprint(
    computeFingerprint(reference.realPath),
    references[index]
  ));
  return {
    references: references.map((referencePath) => ({ path: referencePath, readOnly: true })),
    reviewerGuardBaseline: {
      target: canonicalFingerprint(computeFingerprint(parsed.invocation.target)),
      references: referenceFingerprints
    }
  };
}

function stateRelativePath(targetStateDir, filePath) {
  return path.relative(targetStateDir, filePath).split(path.sep).join('/');
}

function fileSetBaselinePath(metadata) {
  return path.join(metadata.targetStateDir, FILE_SET_BASELINE_BASENAME);
}

function fileSetBaselineBodiesDir(metadata) {
  return path.join(metadata.targetStateDir, FILE_SET_BASELINE_BODIES_DIR);
}

function resetFileSetBaselineBodiesDir(metadata) {
  const directory = fileSetBaselineBodiesDir(metadata);
  let stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if (!(error && error.code === 'ENOENT')) throw error;
  }
  if (stats && stats.isSymbolicLink()) {
    failStateValidation('file-set baseline body directory must not be a symlink');
  }
  if (stats && !stats.isDirectory()) {
    failStateValidation('file-set baseline body path must be a directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function fileSetBaselineBodyPath(metadata, entry) {
  const pathHash = String(entry && entry.pathSha256 ? entry.pathSha256 : '');
  if (!/^[0-9a-f]{64}$/.test(pathHash)) {
    failStateValidation('file-set baseline body path hash is invalid');
  }
  return path.join(fileSetBaselineBodiesDir(metadata), `${pathHash}.body`);
}

function persistedFileSetBaselineBodyPath(metadata, storedPath) {
  const text = String(storedPath || '');
  if (!text || text.includes('\0') || path.isAbsolute(text) || path.win32.isAbsolute(text)) {
    failStateValidation('file-set baseline body path must be a relative target-state path');
  }
  const parts = text.split(/[\\/]+/);
  if (
    parts.length !== 2 ||
    parts[0] !== FILE_SET_BASELINE_BODIES_DIR ||
    !/^[0-9a-f]{64}\.body$/.test(parts[1])
  ) {
    failStateValidation('file-set baseline body path is outside the baseline body directory');
  }
  const absolute = path.resolve(metadata.targetStateDir, ...parts);
  const relative = path.relative(metadata.targetStateDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    failStateValidation('file-set baseline body path escapes target state');
  }
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    failStateValidation('file-set baseline body file is unavailable');
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    failStateValidation('file-set baseline body path must be a regular file');
  }
  return absolute;
}

function readFileSetBaselineBody(metadata, entry) {
  const expectedPath = stateRelativePath(metadata.targetStateDir, fileSetBaselineBodyPath(metadata, entry));
  if (entry.bodyPath !== expectedPath) {
    failStateValidation('file-set baseline body path does not match the monitored file path hash');
  }
  const body = fs.readFileSync(persistedFileSetBaselineBodyPath(metadata, entry.bodyPath));
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  if (sha256 !== entry.sha256 || body.length !== entry.size) {
    failStateValidation('file-set baseline body fingerprint does not match baseline metadata');
  }
  return body;
}

// Persist metadata in JSON and raw bodies in target-local body files. The JSON stays
// reviewable while abort-fix can still restore the exact monitored file content.
function persistFileSetBaseline(metadata, baseline) {
  resetFileSetBaselineBodiesDir(metadata);
  const serializable = {
    status: baseline.status,
    guardMode: baseline.guardMode,
    entries: baseline.entries.map((entry) => {
      const record = {
        path: entry.path,
        pathSha256: entry.pathSha256,
        missing: entry.missing === true,
        sha256: entry.sha256,
        size: entry.size,
        mtimeMs: entry.mtimeMs
      };
      if (!record.missing) {
        if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
          failStateValidation('file-set baseline mode is invalid for a present monitored file');
        }
        record.mode = entry.mode;
        if (!Buffer.isBuffer(entry.body)) {
          failStateValidation('file-set baseline body is unavailable for a present monitored file');
        }
        const bodyPath = fileSetBaselineBodyPath(metadata, entry);
        atomicWriteFileRaw(bodyPath, entry.body);
        record.bodyPath = stateRelativePath(metadata.targetStateDir, bodyPath);
      }
      return record;
    }),
    treeEntries: Array.isArray(baseline.treeEntries) ? baseline.treeEntries : [],
    excludedDirectories: Array.isArray(baseline.excludedDirectories) ? baseline.excludedDirectories : []
  };
  atomicWriteFile(fileSetBaselinePath(metadata), JSON.stringify(serializable));
}

function readPersistedFileSetBaseline(metadata) {
  const file = fileSetBaselinePath(metadata);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.status !== 'passed' || !Array.isArray(parsed.entries)) return null;
  try {
    return {
      status: 'passed',
      guardMode: parsed.guardMode || 'snapshot',
      entries: parsed.entries.map((entry) => {
        const missing = entry.missing === true;
        // Baselines persisted before mode tracking omit the field entirely; tolerate that
        // and skip the downstream chmod. A present-but-invalid mode is still corruption.
        const hasMode = !missing && entry.mode !== undefined && entry.mode !== null;
        if (hasMode && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777)) {
          failStateValidation('persisted file-set baseline mode is invalid');
        }
        return {
          path: entry.path,
          pathSha256: entry.pathSha256,
          missing,
          sha256: entry.sha256,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          ...(hasMode ? { mode: entry.mode } : {}),
          ...(missing || !entry.bodyPath ? {} : { body: readFileSetBaselineBody(metadata, entry) })
        };
      }),
      treeEntries: Array.isArray(parsed.treeEntries) ? parsed.treeEntries : [],
      excludedDirectories: Array.isArray(parsed.excludedDirectories) ? parsed.excludedDirectories : []
    };
  } catch {
    return null;
  }
}

function manifestPathParts(storedPath, label) {
  const text = String(storedPath || '');
  if (!text) failStateValidation(`${label} is missing`);
  if (text.includes('\0')) failStateValidation(`${label} must not contain null bytes`);
  if (path.isAbsolute(text) || path.win32.isAbsolute(text)) {
    failStateValidation(`${label} must be a relative target-state path`);
  }
  const parts = text.split(/[\\/]+/);
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    failStateValidation(`${label} must not contain empty, current, or parent path segments`);
  }
  if (parts.some((part) => RESERVED_STATE_PATH_BASENAMES.has(part))) {
    failStateValidation(`${label} must not target reserved state files`);
  }
  return parts;
}

function statePathFromManifest(projectRoot, targetStateDir, targetKey, storedPath, fallbackName) {
  const ledgerPath = (!storedPath || storedPath === 'none')
    ? path.join(targetStateDir, fallbackName)
    : path.resolve(projectRoot, ...manifestPathParts(storedPath, 'Ledger path'));
  try {
    return validateLedgerPath({ projectRoot, targetKey, ledgerPath });
  } catch (error) {
    failStateValidation(`Ledger path: ${error && error.message ? error.message : String(error)}`);
  }
}

function targetStatePathFromManifest(targetStateDir, storedPath, fallbackName, options = {}) {
  const relativePath = (!storedPath || storedPath === 'none') ? fallbackName : storedPath;
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath,
    allowedDirectories: options.allowedDirectories || ['reports', 'context', 'rounds'],
    label: options.label || 'Manifest path'
  });
}

function readLedgerIfPresent(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { issues: [] };
  return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
}

function acceptedNonBlockingLowIssueIdsFromLedger(ledger) {
  return (ledger.issues || [])
    .filter((issue) => (
      issue.status === 'accepted' &&
      issue.severity === 'low' &&
      /Accepted as non-blocking low/i.test(issue.resolution || '')
    ))
    .map((issue) => issue.id)
    .sort();
}

function fixableIssuesFromLedger(ledger) {
  return (ledger.issues || [])
    .filter((issue) => ['accepted', 'reopened'].includes(issue.status));
}

function activeLockContext(projectRoot, targetKey) {
  const lease = readLease({ projectRoot, targetKey });
  if (!lease) return { status: 'none' };
  return {
    status: 'active',
    ownerId: lease.ownerId,
    leaseId: lease.leaseId || 'none',
    expiresAt: lease.expiresAt,
    updatedAt: lease.updatedAt,
    mode: lease.mode,
    strictness: lease.strictness
  };
}

function latestFixGuardReportPath(targetStateDir, round) {
  const reportsDir = path.join(targetStateDir, 'reports');
  if (!fs.existsSync(reportsDir)) return 'none';
  const roundPrefix = `fix-guard-round-${padRound(round)}`;
  const matches = fs.readdirSync(reportsDir)
    .filter((name) => name.startsWith(roundPrefix) && name.endsWith('.md'))
    .sort();
  if (matches.length === 0) return 'none';
  return path.posix.join('reports', matches[matches.length - 1]);
}

function buildFixerGuard({ projectRoot, metadata, ledger, round }) {
  const fixableIssues = fixableIssuesFromLedger(ledger);
  if (fixableIssues.length === 0) {
    fail('ERR_FIX_CONTEXT_NO_ACCEPTED_ISSUES', 'fix context requires accepted or reopened issue IDs');
  }
  return {
    activeLock: activeLockContext(projectRoot, metadata.targetKey),
    expectedChangedFileSet: [metadata.normalizedTarget],
    issueIds: fixableIssues.map((issue) => issue.id),
    latestFixGuardReportPath: latestFixGuardReportPath(metadata.targetStateDir, round),
    referenceReadOnlyRule: 'Reference documents are read-only.',
    safeLocationAnchors: fixableIssues.map((issue) => issue.location).filter(Boolean),
    targetOnlyWriteRule: `Write target only: ${metadata.normalizedTarget}`
  };
}

// PLAN-TASK-009 (Phase C): file-set fixers may write only the resolved PR/CODE
// file-set members under review. Each entry is normalized to a safe in-root POSIX
// project-relative path. Anything outside the root or unsafe is REJECTED loudly
// (never silently dropped) so the Task-6 guard can never be handed an unvalidated
// allowed set.
function normalizeFileSetEntry(projectRoot, entry, { allowExcludedDirectories = false } = {}) {
  const raw = typeof entry === 'string' ? entry : (entry && entry.path);
  if (typeof raw !== 'string' || raw.trim() === '') {
    failStateValidation('file-set entry must be a non-empty path');
  }
  if (raw.includes('\0')) failStateValidation('file-set path must not contain null bytes');
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
  const relative = path.relative(path.resolve(projectRoot), absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    failStateValidation(`file-set path must be inside project root: ${raw}`);
  }
  const posix = relative.split(path.sep).join('/');
  if (!allowExcludedDirectories && hasCodeExcludedDirectory(posix)) {
    failStateValidation(`file-set path must not be in an excluded directory: ${posix}`);
  }
  const record = { path: posix };
  if (entry && typeof entry === 'object') {
    if (entry.reason) record.reason = String(entry.reason);
    if (entry.issueId) record.issueId = String(entry.issueId);
    if (entry.status) record.status = String(entry.status);
  }
  return record;
}

function fileSetMemberEntries(liveFileSet) {
  return (liveFileSet && Array.isArray(liveFileSet.files) ? liveFileSet.files : [])
    .filter((file) => {
      const value = typeof file === 'string' ? file : (file && file.path);
      return typeof value === 'string' && value !== '';
    });
}

// Build the guarded file-set member list, deduped and sorted. Live PR diff members may be
// inside directories CODE scope traversal normally excludes. The result is the fixer's
// expectedChangedFileSet and the monitored set the Task-6 file-set guard covers BEFORE any
// write.
function resolvedFileSetMemberSet({ projectRoot, liveFileSet }) {
  const byPath = new Map();
  for (const member of fileSetMemberEntries(liveFileSet)) {
    const record = normalizeFileSetEntry(projectRoot, member, { allowExcludedDirectories: true });
    if (!byPath.has(record.path)) byPath.set(record.path, record);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The fixer write rule is route-kind-specific. PR/CODE write only their resolved
// PR/CODE file set; r2p is the in-place backward-fix route whose writable set is EXACTLY
// the 03–07 docs (07-plan plus the owning upstream doc) — never run.md, never any path
// outside 03–07. The boundary itself is still enforced by the file-set guard (run.md is
// not a member); this string is the reviewer-facing wording.
function fileSetWriteRuleFor(liveFileSet) {
  if (liveFileSet && liveFileSet.routeKind === 'r2p') {
    return 'Write only the 03–07 requirement docs in the resolved set (07-plan plus the owning upstream doc); never run.md or any path outside 03–07.';
  }
  return 'Write only files in the resolved PR/CODE file set.';
}

// File-set fixer guard: pins expectedChangedFileSet to the resolved PR/CODE file-set
// members, not a single normalizedTarget. This is the allowed write boundary handed to
// the Task-6 file-set guard.
function buildFileSetFixerGuard({ metadata, ledger, liveFileSet, round }) {
  const fixableIssues = fixableIssuesFromLedger(ledger);
  if (fixableIssues.length === 0) {
    fail('ERR_FIX_CONTEXT_NO_ACCEPTED_ISSUES', 'fix context requires accepted or reopened issue IDs');
  }
  const memberSet = resolvedFileSetMemberSet({
    projectRoot: metadata.projectRoot,
    liveFileSet
  });
  return {
    activeLock: activeLockContext(metadata.projectRoot, metadata.targetKey),
    expectedChangedFileSet: memberSet.map((entry) => entry.path),
    resolvedFileSetMembers: memberSet,
    issueIds: fixableIssues.map((issue) => issue.id),
    latestFixGuardReportPath: latestFixGuardReportPath(metadata.targetStateDir, round),
    fileSetWriteRule: fileSetWriteRuleFor(liveFileSet),
    safeLocationAnchors: fixableIssues.map((issue) => issue.location).filter(Boolean)
  };
}

function contextPhase(parsed, manifest) {
  if (parsed.phase) return parsed.phase;
  if (manifest.status === 'full-re-review') return 'full-re-review';
  if (manifest.status === 'fix') return 'fix';
  return 'initial-review';
}

function requiredSchemaForPhase(phase) {
  if (phase === 'fix') return 'fix-report';
  return 'reviewer-pass-fail';
}

function readContextManifest(contextManifestPath) {
  const text = fs.readFileSync(contextManifestPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) fail('ERR_CONTEXT_MANIFEST', 'context manifest missing json block');
  return JSON.parse(match[1]);
}

function contextManifestPathFor(targetStateDir, phase) {
  const fileName = phase === 'fix'
    ? 'current-fixer-context-manifest.md'
    : 'current-reviewer-context-manifest.md';
  return targetStatePathFromManifest(targetStateDir, path.posix.join('context', fileName), null, {
    allowedDirectories: ['context'],
    label: 'Context manifest path'
  });
}

function updatePersistentManifest(metadata, updates) {
  const next = {
    ...metadata.manifest,
    ...updates,
    updatedAt: new Date().toISOString()
  };
  atomicWriteFile(metadata.manifestPath, formatManifestV2(next));
  metadata.manifest = next;
  return next;
}

function padRound(round) {
  return String(Number(round || 1)).padStart(3, '0');
}

function nextReportPath(targetStateDir, baseName) {
  const relativeBasePath = path.posix.join('reports', `${baseName}.md`);
  const basePath = validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: relativeBasePath,
    allowedDirectories: ['reports'],
    label: 'Report path'
  });
  if (!fs.existsSync(basePath)) return basePath;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const attemptPath = validateTargetStateOwnedPath({
      targetStateDir,
      relativePath: path.posix.join('reports', `${baseName}-attempt-${padRound(attempt)}.md`),
      allowedDirectories: ['reports'],
      label: 'Report path'
    });
    if (!fs.existsSync(attemptPath)) return attemptPath;
  }
  fail('ERR_REPORT_ATTEMPTS_EXHAUSTED', `too many report attempts for ${baseName}`);
}

function reportJsonBlock(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeReviewerReport({ reportPath, phase, round, producer, reviewerResult }) {
  const report = {
    normalized: reviewerResult,
    phase,
    producer,
    round
  };
  const lines = [
    '# Reviewer Report',
    '',
    `Round: ${round}`,
    `Phase: ${phase}`,
    `Producer: ${producer}`,
    `Result: ${reviewerResult.result}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return report;
}

function readReviewerReport(reportPath) {
  const text = fs.readFileSync(reportPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) fail('ERR_REVIEWER_REPORT', 'reviewer report missing normalized json block');
  return JSON.parse(match[1]);
}

function writeTriageReport({ reportPath, phase, round, triage, ledger }) {
  const report = {
    ledgerIssueIds: (ledger.issues || []).map((issue) => issue.id),
    normalized: triage,
    phase,
    round
  };
  const lines = [
    '# Triage Report',
    '',
    `Round: ${round}`,
    `Phase: ${phase}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return report;
}

function producerForAssurance(assurance) {
  return assurance === 'advisory' ? 'coordinator-advisory' : 'reviewer-subagent';
}

function compareGuardBaseline(contextPack, actualBaseline) {
  const expected = contextPack.reviewerGuardBaseline || {};
  if (stableJson(expected.target) !== stableJson(actualBaseline.reviewerGuardBaseline.target)) {
    return 'reviewer-mutated-file';
  }
  if (stableJson(expected.references || []) !== stableJson(actualBaseline.reviewerGuardBaseline.references)) {
    return 'reference-mutated-file';
  }
  return null;
}

// roundLimit is a MAXIMUM-only gate (PLAN-TASK-005): it can only cause an EARLIER
// terminal stop, never extend the loop. `roundsCompleted` is the count of repair
// rounds already attempted (fixAttemptCount) — NOT currentRound, which does not
// advance per repair cycle. When the next fix cycle would push past the limit we
// stop with deferrals (a NON-PASS terminal status), never a clean pass.
function roundLimitReached({ roundLimit, roundsCompleted }) {
  if (roundLimit === null || roundLimit === undefined || roundLimit === 'none') return false;
  const limit = Number(roundLimit);
  if (!Number.isInteger(limit) || limit < 1) return false;
  return Number(roundsCompleted || 0) >= limit;
}

function triageOutcome({ decisions, mode, strictness, roundLimit = 'none', roundsCompleted = 0 }) {
  const highMediumDeferred = decisions.some((decision) => (
    decision.decision === 'deferred' && ['high', 'medium'].includes(decision.severity)
  ));
  if (highMediumDeferred) {
    return {
      status: 'stopped-with-deferrals',
      currentPhase: 'final',
      statusReason: 'deferred-findings'
    };
  }

  const blocking = decisions.filter((decision) => (
    decision.non_blocking !== true &&
    ['accepted', 'reopened', 'downgraded'].includes(decision.decision) &&
    ['high', 'medium'].includes(decision.severity)
  ));
  if (mode === 'read-only') {
    return blocking.length > 0
      ? { status: 'read-only-findings', currentPhase: 'final', statusReason: 'read-only-blocking-findings' }
      : { status: 'read-only-clean', currentPhase: 'final', statusReason: 'none' };
  }
  if (blocking.length > 0) {
    // This is the loop boundary where another fix cycle WOULD begin. Enforce the
    // round limit as a maximum here, AFTER the full re-review's blocking findings
    // are known and BEFORE the next fix cycle is scheduled.
    if (roundLimitReached({ roundLimit, roundsCompleted })) {
      return {
        status: 'stopped-with-deferrals',
        currentPhase: 'final',
        statusReason: 'round-limit'
      };
    }
    return { status: 'fix', currentPhase: 'fix', statusReason: 'none' };
  }
  if (
    strictness === 'strict' &&
    decisions.some((decision) => decision.non_blocking === true && decision.severity === 'low')
  ) {
    return { status: 'full-re-review', currentPhase: 'full-re-review', statusReason: 'none' };
  }
  return { status: 'full-re-review', currentPhase: 'full-re-review', statusReason: 'none' };
}

function noStateStaleTokenFailure(parsed, metadata, blockingReason) {
  return noStateValidationFailure(parsed, metadata, {
    errorCode: blockingReason,
    message: `${blockingReason}: state token fingerprint mismatch`,
    blockingReason
  });
}

function validateNoStateTokenFingerprints(parsed, metadata, token) {
  if (token.tokenKind === 'preflight-terminal') return null;
  if (stableJson(token.targetFingerprint) !== stableJson(metadata.targetFingerprint)) {
    return noStateStaleTokenFailure(parsed, metadata, 'reviewer-mutated-file');
  }
  if (stableJson(token.referenceFingerprints) !== stableJson(metadata.referenceFingerprints)) {
    return noStateStaleTokenFailure(parsed, metadata, 'reference-mutated-file');
  }
  return null;
}

function blockingFindingsFromReviewerResult(result) {
  if (result.result !== 'FAIL') return [];
  return result.findings.filter((finding) => ['high', 'medium'].includes(finding.severity));
}

function blockingFindingsFromTriage(decisions) {
  return decisions.filter((decision) => (
    decision.non_blocking === false &&
    ['accepted', 'reopened', 'merged', 'downgraded', 'deferred'].includes(decision.decision)
  ));
}

function tokenHasBlockingFindings(token) {
  const normalized = token.normalized || {};
  if (Array.isArray(normalized.blockingFindings)) return normalized.blockingFindings.length > 0;
  if (Array.isArray(normalized.decisions)) return blockingFindingsFromTriage(normalized.decisions).length > 0;
  if (Array.isArray(normalized.findings)) {
    return normalized.findings.some((finding) => ['high', 'medium'].includes(finding.severity));
  }
  return (
    token.eligibleTerminalStatuses.includes('read-only-findings') &&
    !token.eligibleTerminalStatuses.includes('read-only-clean')
  );
}

function parsedForPersistentMetadata(parsed, metadata) {
  if (metadata && metadata.routeKind === 'r2p' && metadata.manifest && metadata.manifest.workId) {
    return {
      ...parsed,
      invocation: {
        ...parsed.invocation,
        root: null,
        workId: metadata.manifest.workId
      }
    };
  }
  return parsed;
}

function workflowBaseForPersistentMetadata(parsed, metadata) {
  return workflowBase(parsedForPersistentMetadata(parsed, metadata), { cwd: metadata.projectRoot });
}

function persistentBase(parsed, metadata, overrides = {}) {
  const ledgerPath = Object.hasOwn(overrides, 'ledgerPath')
    ? overrides.ledgerPath
    : statePathFromManifest(
      metadata.projectRoot,
      metadata.targetStateDir,
      metadata.targetKey,
      metadata.manifest.ledgerPath,
      'ISSUES.md'
    );
  return {
    ...workflowBaseForPersistentMetadata(parsed, metadata),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    ledgerPath,
    round: Number(metadata.manifest.currentRound || 1),
    ...overrides
  };
}

function blockPersistentReviewerMutation(parsed, metadata, blockingReason) {
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    runtimeFingerprintGuard: 'passed'
  });
  return persistentBase(parsed, metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction: 'rerun context after restoring target and references'
  });
}

function blockPersistentStateValidation(parsed, metadata, error) {
  return {
    ...workflowBaseForPersistentMetadata(parsed, metadata),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    ledgerPath: null,
    round: Number(metadata.manifest.currentRound || 1),
    ok: false,
    status: 'blocked',
    errorCode: error && error.code ? error.code : 'ERR_STATE_VALIDATION_FAILED',
    message: error && error.message ? error.message : String(error),
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    nextAction: 'repair manifest paths under the target state directory'
  };
}

function isStateValidationError(error) {
  return error && error.code === 'ERR_STATE_VALIDATION_FAILED';
}

function projectRootFromTargetStateDir(targetStateDir) {
  const absolute = path.resolve(targetStateDir);
  return path.dirname(path.dirname(path.dirname(absolute)));
}

function resolveTargetFromStateManifest(projectRoot, manifest) {
  if (manifest.target && path.isAbsolute(manifest.target)) return manifest.target;
  if (manifest.normalizedTarget && manifest.normalizedTarget !== 'none') {
    return path.resolve(projectRoot, manifest.normalizedTarget);
  }
  return path.resolve(projectRoot, manifest.target);
}

function resolveStateCommandMetadata(targetStateDir) {
  const absoluteTargetStateDir = path.resolve(targetStateDir);
  const projectRoot = projectRootFromTargetStateDir(absoluteTargetStateDir);
  const manifestPath = path.join(absoluteTargetStateDir, 'MANIFEST.md');
  let manifest;
  try {
    manifest = readManifestAny(manifestPath);
  } catch (error) {
    const wrapped = new Error(`state-validation-failed: unable to read target state manifest: ${error.message}`);
    wrapped.code = 'ERR_STATE_VALIDATION_FAILED';
    throw wrapped;
  }
  // PLAN-TASK-009 (Phase B): the state-dir fix/diff/finalize commands operate on a single
  // target file (sha256/size, target-only worktree guard). A file-set manifest (pr/code)
  // has no single-file target, so refuse cleanly here rather than resolving a bogus
  // `path.resolve(projectRoot, 'none')` target. Maps to a blocked result via callers'
  // stateValidationResult — never a crash, never a false PASS.
  if (manifest.targetContextKind && manifest.targetContextKind !== 'document') {
    failStateValidation(`${manifest.targetContextKind} file-set lifecycle is not supported by single-file state commands`);
  }
  const targetKey = manifest.targetKey || path.basename(absoluteTargetStateDir);
  if (targetKey !== path.basename(absoluteTargetStateDir)) {
    failStateValidation('target state directory does not match manifest Target key');
  }
  const targetPath = resolveTargetFromStateManifest(projectRoot, manifest);
  validateDocumentStateIdentity({ projectRoot, targetPath, manifest, targetKey });
  const ledgerPath = statePathFromManifest(
    projectRoot,
    absoluteTargetStateDir,
    targetKey,
    manifest.ledgerPath,
    'ISSUES.md'
  );
  return {
    projectRoot,
    targetKey,
    normalizedTarget: manifest.normalizedTarget,
    targetPath,
    targetStateDir: absoluteTargetStateDir,
    manifestPath,
    ledgerPath,
    manifest
  };
}

// PLAN-TASK-009 (Phase C): file-set analog of resolveStateCommandMetadata for the
// state-dir-based PR/CODE commands (begin-fix, refresh-lock, end-fix, abort-fix,
// record-diff-review, finalize). It reads the schema-2 file-set manifest and resolves the
// project root from the state directory layout (.drfx/targets/<key>). There is
// no single-file target: normalizedTarget/targetPath stay null, and the live monitored set
// is resolved separately from the manifest base/scope identity by the fix lifecycle.
function resolveFileSetStateMetadata(targetStateDir) {
  const absoluteTargetStateDir = path.resolve(targetStateDir);
  const projectRoot = projectRootFromTargetStateDir(absoluteTargetStateDir);
  const manifestPath = path.join(absoluteTargetStateDir, 'MANIFEST.md');
  let manifest;
  try {
    manifest = readManifestAny(manifestPath);
  } catch (error) {
    const wrapped = new Error(`state-validation-failed: unable to read target state manifest: ${error.message}`);
    wrapped.code = 'ERR_STATE_VALIDATION_FAILED';
    throw wrapped;
  }
  if (!manifest.targetContextKind || manifest.targetContextKind === 'document') {
    failStateValidation('document manifest is not supported by file-set state commands');
  }
  const targetKey = manifest.targetKey || path.basename(absoluteTargetStateDir);
  if (targetKey !== path.basename(absoluteTargetStateDir)) {
    failStateValidation('target state directory does not match manifest Target key');
  }
  const derivedTargetKey = deriveFileSetStateKey({ projectRoot, manifest });
  if (derivedTargetKey !== targetKey) {
    failStateValidation(`derived ${manifest.targetContextKind} target key does not match manifest Target key`);
  }
  const ledgerPath = statePathFromManifest(
    projectRoot,
    absoluteTargetStateDir,
    targetKey,
    manifest.ledgerPath,
    'ISSUES.md'
  );
  return {
    projectRoot,
    routeKind: manifest.targetContextKind,
    targetKey,
    normalizedTarget: null,
    targetPath: null,
    targetStateDir: absoluteTargetStateDir,
    manifestPath,
    ledgerPath,
    manifest
  };
}

function stateCommandBase(metadata, overrides = {}) {
  return {
    ok: true,
    status: overrides.status || metadata.manifest.status,
    target: metadata.targetPath,
    targetStateDir: metadata.targetStateDir,
    targetKey: metadata.targetKey,
    manifestPath: metadata.manifestPath,
    ledgerPath: metadata.ledgerPath,
    round: Number(metadata.manifest.currentRound || 1),
    currentPhase: overrides.currentPhase || metadata.manifest.currentPhase,
    documentType: metadata.manifest.documentType,
    strictness: metadata.manifest.strictness,
    requestedMode: metadata.manifest.mode,
    mode: metadata.manifest.mode,
    guardMode: metadata.manifest.guardMode || 'git',
    modeSource: 'manifest',
    modeNormalizedFrom: null,
    requestedAssurance: metadata.manifest.assurance,
    assuranceSource: 'manifest',
    assuranceNormalizedFrom: null,
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    descriptorPlatform: metadata.manifest.descriptorPlatform,
    assuranceProof: metadata.manifest.assuranceProof,
    runtimeCheck: {
      platform: metadata.manifest.runtimePlatform,
      subagentProbe: {
        status: metadata.manifest.runtimeSubagentProbe,
        evidence: metadata.manifest.runtimeSubagentProbeEvidence
      },
      stdinHandoff: {
        status: metadata.manifest.runtimeStdinHandoff,
        evidence: metadata.manifest.runtimeStdinHandoffEvidence
      },
      fingerprintGuard: { status: metadata.manifest.runtimeFingerprintGuard },
      downgradeReason: metadata.manifest.runtimeDowngradeReason
    },
    blockingReason: overrides.blockingReason || metadata.manifest.blockingReason || 'none',
    statusReason: overrides.statusReason || metadata.manifest.statusReason || 'none',
    nextAction: Object.hasOwn(overrides, 'nextAction') ? overrides.nextAction : null,
    ...overrides
  };
}

function stateValidationResult(targetStateDir, error) {
  const manifestPath = path.join(path.resolve(targetStateDir), 'MANIFEST.md');
  return {
    ok: false,
    status: 'blocked',
    targetStateDir: path.resolve(targetStateDir),
    manifestPath,
    ledgerPath: null,
    round: null,
    documentType: 'none',
    strictness: 'none',
    requestedMode: null,
    mode: null,
    modeSource: null,
    modeNormalizedFrom: null,
    requestedAssurance: null,
    assuranceSource: null,
    assuranceNormalizedFrom: null,
    assurance: null,
    runtimePlatform: null,
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_STATE_VALIDATION_FAILED',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair target state before continuing fix'
  };
}

function assertFixEligible(metadata) {
  if (metadata.manifest.mode !== 'review-and-fix') {
    failStateValidation('begin-fix requires Mode: review-and-fix');
  }
  if (metadata.manifest.assurance === 'advisory') {
    failStateValidation('begin-fix rejects Assurance: advisory');
  }
  if (metadata.manifest.status !== 'fix' || metadata.manifest.currentPhase !== 'fix') {
    failStateValidation('begin-fix requires Status: fix and Current phase: fix');
  }
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixableIssues = fixableIssuesFromLedger(ledger);
  if (fixableIssues.length === 0) {
    failStateValidation('begin-fix requires accepted or reopened issue IDs');
  }
  return { ledger, fixableIssues };
}

function referenceFingerprintsForManifest(metadata) {
  return (metadata.manifest.references || []).map((referencePath) => {
    const absolute = path.isAbsolute(referencePath)
      ? referencePath
      : path.resolve(metadata.projectRoot, referencePath);
    return canonicalFingerprint(computeFingerprint(absolute), toPosixPath(referencePath));
  });
}

function toPosixPath(filePath) {
  return String(filePath).split(path.sep).join('/');
}

function readJsonReportBlock(reportPath, label) {
  const text = fs.readFileSync(reportPath, 'utf8');
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) failStateValidation(`${label} missing normalized json block`);
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    failStateValidation(`${label} contains invalid json`);
  }
}

function latestReportPathByPrefix(targetStateDir, prefix) {
  const reportsDir = path.join(targetStateDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const matches = fs.readdirSync(reportsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.md'))
    .sort();
  if (matches.length === 0) return null;
  return path.join(reportsDir, matches[matches.length - 1]);
}

function readLatestFixGuardReport(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  let reportPath = null;
  if (metadata.manifest.currentReportPath && metadata.manifest.currentReportPath !== 'none') {
    reportPath = targetStatePathFromManifest(metadata.targetStateDir, metadata.manifest.currentReportPath, null, {
      allowedDirectories: ['reports'],
      label: 'Current report path'
    });
  }
  if (!reportPath || !fs.existsSync(reportPath)) {
    reportPath = latestReportPathByPrefix(metadata.targetStateDir, `fix-guard-round-${padRound(round)}`);
  }
  if (!reportPath) failStateValidation('fix guard report is missing');
  return { reportPath, report: readJsonReportBlock(reportPath, 'Fix guard report') };
}

function readLatestFixGuardBaseline(metadata) {
  try {
    const baseline = readLatestFixGuardReport(metadata);
    const report = baseline.report || {};
    if (report.status !== 'passed') failStateValidation('fix guard baseline must be passed');
    if (report.blockingReason !== 'none') failStateValidation('fix guard baseline must have Blocking reason: none');
    if (!report.rollbackAnchor || report.rollbackAnchor.status !== 'passed') {
      failStateValidation('fix guard baseline missing passed rollback anchor');
    }
    if (!report.targetOnlyGuard || report.targetOnlyGuard.status !== 'passed') {
      failStateValidation('fix guard baseline missing passed target-only guard');
    }
    if (report.normalizedTarget !== metadata.normalizedTarget) {
      failStateValidation('fix guard baseline target mismatch');
    }
    return { ok: true, ...baseline };
  } catch (error) {
    return { ok: false, error };
  }
}

function assertReferencesUnchanged(metadata, guardReport) {
  const expected = guardReport.referenceFingerprints || [];
  let actual;
  try {
    actual = referenceFingerprintsForManifest(metadata);
  } catch {
    return 'reference-mutated-file';
  }
  if (stableJson(expected) !== stableJson(actual)) {
    return 'reference-mutated-file';
  }
  return null;
}

function safeTargetFingerprint(metadata) {
  try {
    return canonicalFingerprint(computeFingerprint(metadata.targetPath));
  } catch {
    return null;
  }
}

function safeReferenceFingerprints(metadata) {
  try {
    return referenceFingerprintsForManifest(metadata);
  } catch {
    return [];
  }
}

function writeBeginFixGuardReport(metadata, {
  lease,
  rollbackAnchor,
  targetOnlyGuard,
  status,
  blockingReason
}) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `fix-guard-round-${padRound(round)}`);
  atomicWriteFile(reportPath, formatFixGuardReport({
    round,
    normalizedTarget: metadata.normalizedTarget,
    targetFingerprint: safeTargetFingerprint(metadata),
    referenceFingerprints: safeReferenceFingerprints(metadata),
    rollbackAnchor,
    targetOnlyGuard,
    lock: lease ? {
      ownerId: lease.ownerId,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt
    } : null,
    status,
    blockingReason
  }));
  return reportPath;
}

function readFixReportPayload(parsed, metadata, options) {
  const fromStdin = Boolean(parsed.payloadFlags.fixReportStdin);
  const fromFile = parsed.payloadFlags.fixReport || null;
  if (fromStdin === Boolean(fromFile)) {
    fail('ERR_SEMANTIC_HANDOFF', 'exactly one fix report stdin or safe file input is required');
  }
  if (fromStdin) return readSemanticPayload({ content: options.stdin || '' });
  return readSemanticPayload({ filePath: fromFile, projectRoot: metadata.projectRoot });
}

function validateFixedIssueIds(fixReport, ledger) {
  const issues = new Map((ledger.issues || []).map((issue) => [issue.id, issue]));
  for (const fixed of fixReport.fixed || []) {
    const issue = issues.get(fixed.issue_id);
    if (!issue) failStateValidation(`fixed issue id does not exist: ${fixed.issue_id}`);
    if (!['accepted', 'reopened'].includes(issue.status)) {
      failStateValidation(`fixed issue must be accepted or reopened: ${fixed.issue_id}`);
    }
  }
}

function validateDeclaredFilesChanged(fixReport, normalizedTarget) {
  if (
    !Array.isArray(fixReport.filesChanged) ||
    fixReport.filesChanged.length !== 1 ||
    fixReport.filesChanged[0] !== normalizedTarget
  ) {
    return 'fix-report-mismatch';
  }
  return null;
}

function updateFixedIssues(ledger, fixReport) {
  const summaries = new Map((fixReport.fixed || []).map((fixed) => [fixed.issue_id, fixed.summary]));
  return {
    issues: (ledger.issues || []).map((issue) => {
      if (!summaries.has(issue.id)) return issue;
      return {
        ...issue,
        status: 'fixed',
        resolution: `Fixed: ${summaries.get(issue.id)}`
      };
    })
  };
}

function writeNormalizedFixReport({ metadata, fixReport }) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `fix-round-${padRound(round)}`);
  const normalized = { ...fixReport };
  if (normalized.verification === null || normalized.verification === undefined) {
    delete normalized.verification;
  }
  const report = {
    round,
    normalized
  };
  const lines = [
    '# Fix Report',
    '',
    `Round: ${round}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return reportPath;
}

function writeFixReceipt(metadata, {
  kind = 'fix-blocked',
  status,
  issueIds = [],
  filesChanged = 'none',
  verification = 'none',
  blockingReason = 'none',
  statusReason = 'none',
  summary = 'none',
  nextAction = 'none'
}) {
  return writeRoundReceipt({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    round: Number(metadata.manifest.currentRound || 1),
    kind,
    status,
    target: metadata.normalizedTarget,
    issueIds,
    filesChanged,
    verification,
    blockingReason,
    statusReason,
    summary,
    nextAction
  });
}

function readStateCommandPayload({ metadata, parsed, valueFlag, stdinFlag, label, options, aliasValueFlag = null, aliasStdinFlag = null }) {
  const fromStdin = Boolean(parsed.payloadFlags[stdinFlag]);
  const fromFile = parsed.payloadFlags[valueFlag] || null;
  const fromAliasStdin = aliasStdinFlag ? Boolean(parsed.payloadFlags[aliasStdinFlag]) : false;
  const fromAliasFile = aliasValueFlag ? parsed.payloadFlags[aliasValueFlag] || null : null;
  const sourceCount = [
    fromStdin,
    Boolean(fromFile),
    fromAliasStdin,
    Boolean(fromAliasFile)
  ].filter(Boolean).length;
  if (sourceCount !== 1) {
    fail('ERR_SEMANTIC_HANDOFF', `exactly one ${label} stdin or safe file input is required`);
  }
  if (fromStdin || fromAliasStdin) return readSemanticPayload({ content: options.stdin || '' });
  return readSemanticPayload({ filePath: fromFile || fromAliasFile, projectRoot: metadata.projectRoot });
}

function writeWorkflowSummary(metadata, nextAction = 'none') {
  const ledgerPath = metadata.ledgerPath || statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
  const ledger = readLedgerIfPresent(ledgerPath);
  const roundsDir = path.join(metadata.targetStateDir, 'rounds');
  const receipts = fs.existsSync(roundsDir)
    ? fs.readdirSync(roundsDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => path.posix.join('rounds', name))
    : [];
  atomicWriteFile(path.join(metadata.targetStateDir, 'SUMMARY.md'), formatSummary({
    manifest: metadata.manifest,
    ledger,
    receipts,
    nextAction
  }));
}

function writeFinalReceipt(metadata, finalResponse, {
  kind = null,
  nextAction = 'none'
} = {}) {
  return writeRoundReceipt({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    round: Number(metadata.manifest.currentRound || 1),
    kind: kind || `final-${finalResponse.finalStatus}`,
    status: finalResponse.finalStatus,
    target: metadata.normalizedTarget,
    issueIds: finalResponse.fixedIssueIds === 'none'
      ? []
      : String(finalResponse.fixedIssueIds).split(',').map((item) => item.trim()),
    filesChanged: finalResponse.filesChanged || 'none',
    verification: finalResponse.verificationPerformed || 'none',
    blockingReason: finalResponse.blockingReason || 'none',
    statusReason: finalResponse.statusReason || 'none',
    summary: finalResponse.deferralsOrBlockers || 'none',
    nextAction
  });
}

function finalizationRequiresReceipt(status) {
  return [
    'blocked',
    'checkpoint',
    'stopped-with-deferrals',
    'stopped-no-progress',
    'read-only-findings',
    'read-only-clean',
    'unsupported',
    'externally-changed',
    'possible-target-replacement'
  ].includes(status);
}

function readManifestReport(metadata, storedPath, label) {
  if (!storedPath || storedPath === 'none') return null;
  const reportPath = targetStatePathFromManifest(metadata.targetStateDir, storedPath, null, {
    allowedDirectories: ['reports'],
    label
  });
  if (!fs.existsSync(reportPath)) failStateValidation(`${label} is missing`);
  return { reportPath, report: readJsonReportBlock(reportPath, label) };
}

function readRequiredResumeLedger(metadata) {
  const ledgerPath = metadata.ledgerPath || statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
  metadata.ledgerPath = ledgerPath;
  if (!fs.existsSync(ledgerPath)) {
    failStateValidation('resume requires ISSUES.md ledger');
  }
  try {
    return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    failStateValidation(`resume ledger is invalid: ${error && error.message ? error.message : String(error)}`);
  }
}

function readResumeReferencedReports(metadata) {
  const reportFields = [
    ['currentReportPath', 'Current report path'],
    ['lastReviewerReportPath', 'Last reviewer report path'],
    ['lastTriageReportPath', 'Last triage report path'],
    ['lastFixReportPath', 'Last fix report path'],
    ['lastDiffReviewReportPath', 'Last diff review report path']
  ];
  const reports = {};
  for (const [field, label] of reportFields) {
    if (!metadata.manifest[field] || metadata.manifest[field] === 'none') continue;
    reports[field] = readManifestReport(metadata, metadata.manifest[field], label);
  }
  return reports;
}

function readResumeReceiptsIfNeeded(metadata) {
  if (!resumeRequiresReceipt(metadata.manifest.status)) return [];
  const roundsDir = path.join(metadata.targetStateDir, 'rounds');
  if (!fs.existsSync(roundsDir)) return [];
  return fs.readdirSync(roundsDir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const receiptPath = targetStatePathFromManifest(
        metadata.targetStateDir,
        path.posix.join('rounds', name),
        null,
        { allowedDirectories: ['rounds'], label: 'Round receipt path' }
      );
      const text = fs.readFileSync(receiptPath, 'utf8');
      if (text.includes('\0')) failStateValidation('round receipt contains invalid null bytes');
      return { receiptPath, text };
    });
}

function readResumeDeterministicInputs(metadata) {
  return {
    ledger: readRequiredResumeLedger(metadata),
    reports: readResumeReferencedReports(metadata),
    receipts: readResumeReceiptsIfNeeded(metadata)
  };
}

function reportResult(report) {
  return report && report.normalized && report.normalized.result;
}

function reportIssueIds(report) {
  const normalized = report && report.normalized ? report.normalized : {};
  if (Array.isArray(normalized.fixed)) return normalized.fixed.map((item) => item.issue_id).sort();
  return [];
}

function unresolvedBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => (
      ['accepted', 'reopened'].includes(issue.status) &&
      ['high', 'medium'].includes(issue.severity)
    ))
    .map((issue) => issue.id)
    .sort();
}

function deferredBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => issue.status === 'deferred' && ['high', 'medium'].includes(issue.severity))
    .map((issue) => issue.id)
    .sort();
}

function includedLowIdsFromCurrentContext(metadata) {
  const contextPath = path.join(metadata.targetStateDir, 'context', 'current-reviewer-context-manifest.md');
  if (!fs.existsSync(contextPath)) return [];
  try {
    const context = readContextManifest(contextPath);
    const ids = context.acceptedNonBlockingLowIssueIds;
    if (ids === 'none') return [];
    return Array.isArray(ids) ? ids.slice().sort() : [];
  } catch {
    return [];
  }
}

function allIncluded(needles, haystack) {
  const values = new Set(haystack || []);
  return (needles || []).every((needle) => values.has(needle));
}

function latestFullReviewComplete({ latestReviewer, hasFixRound, round }) {
  if (!latestReviewer) return false;
  const report = latestReviewer.report || {};
  if (Number(report.round || 1) !== Number(round || 1)) return false;
  if (hasFixRound && report.phase !== 'full-re-review') return false;
  const normalized = report.normalized || {};
  return normalized.result === 'PASS';
}

function triageSuppressesReviewerFinding(decision) {
  if (!decision || !decision.reviewer_id) return false;
  if (decision.non_blocking === true) return true;
  if (['rejected', 'merged'].includes(decision.decision)) return true;
  if (decision.decision === 'deferred') return !['high', 'medium'].includes(decision.severity);
  if (['accepted', 'reopened', 'downgraded'].includes(decision.decision)) {
    return !['high', 'medium'].includes(decision.severity);
  }
  return false;
}

function triageSuppressedReviewerIds(latestTriage) {
  const report = latestTriage && latestTriage.report ? latestTriage.report : {};
  const normalized = report.normalized || {};
  const decisions = Array.isArray(normalized.decisions) ? normalized.decisions : [];
  return new Set(decisions
    .filter(triageSuppressesReviewerFinding)
    .map((decision) => decision.reviewer_id)
    .filter(Boolean));
}

function reviewerBlockingIssueIds(latestReviewer, latestTriage = null) {
  const report = latestReviewer && latestReviewer.report ? latestReviewer.report : {};
  const normalized = report.normalized || {};
  if (normalized.result !== 'FAIL' || !Array.isArray(normalized.findings)) return [];
  const suppressedReviewerIds = triageSuppressedReviewerIds(latestTriage);
  return normalized.findings
    .filter((finding) => ['high', 'medium'].includes(finding.severity))
    .filter((finding) => !suppressedReviewerIds.has(finding.id || finding.issue_id))
    .map((finding) => finding.id || finding.issue_id)
    .filter(Boolean)
    .sort();
}

function buildFinalValidationState(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixReport = readManifestReport(metadata, metadata.manifest.lastFixReportPath, 'Last fix report path');
  const diffReport = readManifestReport(metadata, metadata.manifest.lastDiffReviewReportPath, 'Last diff review report path');
  const latestReviewer = readManifestReport(metadata, metadata.manifest.lastReviewerReportPath, 'Last reviewer report path');
  const latestTriage = metadata.manifest.mode === 'read-only'
    ? readManifestReport(metadata, metadata.manifest.lastTriageReportPath, 'Last triage report path')
    : null;
  const hasFixRound = Boolean(fixReport);
  const fixRoundCurrent = !hasFixRound || Number(fixReport.report.round || 1) === round;
  const acceptedLowIds = acceptedNonBlockingLowIssueIdsFromLedger(ledger);
  const includedLowIds = includedLowIdsFromCurrentContext(metadata);
  const changedFiles = hasFixRound ? metadata.normalizedTarget : 'none';
  const unresolvedIds = unresolvedBlockingIssues(ledger);
  const deferredIds = deferredBlockingIssues(ledger);
  const readOnlyBlockingIds = [...new Set([
    ...unresolvedIds,
    ...deferredIds,
    ...reviewerBlockingIssueIds(latestReviewer, latestTriage)
  ])].sort();
  return {
    persistent: true,
    target: metadata.normalizedTarget,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    strictness: metadata.manifest.strictness,
    filesChanged: changedFiles,
    fixedIssueIds: hasFixRound ? reportIssueIds(fixReport.report) : [],
    unresolvedBlockingIssues: unresolvedIds,
    readOnlyBlockingIssueIds: readOnlyBlockingIds,
    readOnlyFindingsIssueIds: unresolvedIds,
    deferredBlockingIssueIds: deferredIds,
    acceptedNonBlockingLowIssueIds: acceptedLowIds,
    requiredDiffReviewComplete: !hasFixRound ? true : Boolean(
      fixRoundCurrent &&
      diffReport &&
      Number(diffReport.report.round || 1) === round &&
      reportResult(diffReport.report) === 'DIFF-OK'
    ),
    requiredFullReReviewComplete: Boolean(
      fixRoundCurrent && latestFullReviewComplete({ latestReviewer, hasFixRound, round })
    ),
    strictAcceptedLowIncludedInLatestFullReview: allIncluded(acceptedLowIds, includedLowIds)
  };
}

function receiptFailureResult(metadata, error) {
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason: 'state-validation-failed',
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_RECEIPT_WRITE_FAILED',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair target state receipt directory'
  });
}

function activeLeaseOrBlock(metadata) {
  return readPersistedLeaseForTarget({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    targetPath: metadata.targetPath
  });
}

function releasePersistedLease(metadata) {
  const lease = activeLeaseOrBlock(metadata);
  return releaseLock({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    ownerId: lease.ownerId
  });
}

function lockReleaseFailureResult(metadata, error, originalBlockingReason) {
  try {
    writeFixReceipt(metadata, {
      kind: 'lock-release-failed',
      status: 'blocked',
      blockingReason: 'lock-release-failed',
      summary: `Original blocking reason: ${originalBlockingReason || 'none'}`,
      nextAction: 'release or repair the target lock before continuing'
    });
  } catch (receiptError) {
    return receiptFailureResult(metadata, receiptError);
  }
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason: 'lock-release-failed',
    statusReason: 'none'
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason: 'lock-release-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_LOCK_RELEASE_FAILED',
    message: error && error.message ? error.message : String(error),
    originalBlockingReason: originalBlockingReason || 'none',
    nextAction: 'release or repair the target lock before continuing'
  });
}

function endFixBlocked(metadata, blockingReason, {
  issueIds = [],
  filesChanged = 'none',
  summary = 'none',
  nextAction = 'repair fix output and rerun end-fix',
  manifestUpdates = {}
} = {}) {
  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      issueIds,
      filesChanged,
      blockingReason,
      summary,
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }
  try {
    releasePersistedLease(metadata);
  } catch (error) {
    return lockReleaseFailureResult(metadata, error, blockingReason);
  }
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none', ...manifestUpdates
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction
  });
}

function beginFixBlocked(metadata, lease, {
  blockingReason,
  rollbackAnchor,
  targetOnlyGuard,
  summary,
  nextAction,
  errorCode = null,
  message = null
}) {
  let reportPath = null;
  try {
    reportPath = writeBeginFixGuardReport(metadata, {
      lease,
      rollbackAnchor,
      targetOnlyGuard,
      status: 'blocked',
      blockingReason
    });
  } catch (error) {
    if (lease) {
      try {
        releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
      } catch {
        // Preserve the report write failure as the blocker because no valid guard report was persisted.
      }
    }
    return receiptFailureResult(metadata, error);
  }

  try {
    writeFixReceipt(metadata, {
      status: 'blocked',
      blockingReason,
      summary,
      nextAction
    });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }

  if (lease) {
    try {
      releaseLock({ projectRoot: metadata.projectRoot, targetKey: metadata.targetKey, ownerId: lease.ownerId });
    } catch (error) {
      return lockReleaseFailureResult(metadata, error, blockingReason);
    }
  }

  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    currentReportPath: relativeReportPath
  });
  return stateCommandBase(metadata, {
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    errorCode,
    message,
    fixGuardReportPath: reportPath,
    nextAction
  });
}

function writeDiffReviewReport({ metadata, diffReview }) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `diff-review-round-${padRound(round)}`);
  const report = {
    round,
    normalized: diffReview
  };
  const lines = [
    '# Diff Review Report',
    '',
    `Round: ${round}`,
    `Result: ${diffReview.result}`,
    '',
    '```json',
    reportJsonBlock(report).trimEnd(),
    '```',
    ''
  ];
  atomicWriteFile(reportPath, lines.join('\n'));
  return reportPath;
}

function assertDiffReviewEligible(metadata) {
  if (metadata.manifest.status !== 'diff-review' || metadata.manifest.currentPhase !== 'diff-review') {
    failStateValidation('record-diff-review requires Status: diff-review and Current phase: diff-review');
  }
  if (!metadata.manifest.lastFixReportPath || metadata.manifest.lastFixReportPath === 'none') {
    failStateValidation('record-diff-review requires latest fix report');
  }
  const latestFix = readManifestReport(metadata, metadata.manifest.lastFixReportPath, 'Last fix report path');
  if (Number(latestFix.report.round) !== Number(metadata.manifest.currentRound || 1)) {
    failStateValidation('record-diff-review requires latest fix report for current round');
  }
  return latestFix;
}

function resumeStateValidationFailure(parsed, options, error) {
  let base;
  try {
    base = workflowBase(parsed, options);
  } catch {
    base = {
      targetStateDir: null,
      targetKey: null,
      manifestPath: null,
      ledgerPath: null,
      round: null,
      documentType: 'none',
      strictness: 'none',
      requestedMode: null,
      mode: null,
      modeSource: null,
      modeNormalizedFrom: null,
      requestedAssurance: null,
      assuranceSource: null,
      assuranceNormalizedFrom: null,
      assurance: null,
      runtimePlatform: null
    };
  }
  let targetStateDir = null;
  if (base.targetKey) {
    try {
      targetStateDir = targetStateDirectory(resolveProjectRoot({
        explicitRoot: parsed.invocation.root,
        targetPath: parsed.invocation.target,
        cwd: options.cwd || process.cwd(),
        persistentStateRequired: true
      }), base.targetKey);
    } catch {
      targetStateDir = null;
    }
  }
  return {
    ...base,
    ok: false,
    status: 'blocked',
    targetStateDir,
    manifestPath: targetStateDir ? path.join(targetStateDir, 'MANIFEST.md') : null,
    ledgerPath: null,
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: error && error.code ? error.code : 'ERR_STATE_VALIDATION_FAILED',
    message: error && error.message ? error.message : String(error),
    nextAction: 'repair target state before resuming'
  };
}

function readOptionalContinuity(targetStateDir) {
  const continuityPath = path.join(targetStateDir, 'CONTINUITY.md');
  if (!fs.existsSync(continuityPath)) return null;
  try {
    const text = fs.readFileSync(continuityPath, 'utf8');
    if (text.includes('\0')) return 'malformed-continuity-ignored';
  } catch {
    return 'malformed-continuity-ignored';
  }
  return null;
}

function currentProofForResume(parsed) {
  if (parsed.assurance !== 'strict-verified' || !parsed.proofRunId) return null;
  return `capability-descriptor:${descriptorPlatformFor(parsed.runtimePlatform)}:${parsed.proofRunId}`;
}

function resumeRequiresReceipt(status) {
  return [
    'blocked',
    'checkpoint',
    'unsupported',
    'externally-changed',
    'possible-target-replacement',
    'read-only-findings',
    'stopped-with-deferrals',
    'stopped-no-progress'
  ].includes(status);
}

function writeResumeReceipt(metadata, resumeState, nextAction) {
  return writeRoundReceipt({
    projectRoot: metadata.projectRoot,
    targetKey: metadata.targetKey,
    round: Number(metadata.manifest.currentRound || 1),
    kind: `resume-${resumeState.status}`,
    status: resumeState.status,
    target: metadata.normalizedTarget,
    issueIds: [],
    filesChanged: 'none',
    verification: 'resume state validation',
    blockingReason: resumeState.blockingReason || 'none',
    statusReason: resumeState.statusReason || 'none',
    summary: resumeState.conflict
      ? `${resumeState.conflict.field} conflict`
      : (resumeState.strictProofError || 'resume state selected deterministic phase'),
    nextAction
  });
}

// Terminal statuses whose state dir is archived (never deleted) so a re-run starts
// fresh without `reset`. Used by finalize (archive on reaching the status) and resume
// (archive a leftover live one, then fresh-start). Keep in sync with shared/long-task.md.
const ARCHIVE_ON_FINALIZE = new Set(['pass', 'read-only-clean']);

function ensureArchiveRootDirectory(archiveRoot) {
  let stats;
  try {
    stats = fs.lstatSync(archiveRoot);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    fs.mkdirSync(archiveRoot, { recursive: true });
    stats = fs.lstatSync(archiveRoot);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail('ERR_STATE_RESET', 'archiving requires a regular archive root directory; refusing to archive into a symlink or non-directory');
  }
}

function archiveFailureNextAction({ fileSet = false } = {}) {
  return fileSet
    ? 'delete or reset the leftover terminal file-set state directory, then retry'
    : 'delete or reset the leftover terminal state directory, then retry';
}

// Hard-fail archive primitive (also used by the `reset` path). Renames the target state
// dir to .drfx/archived/<targetKey>-<ISO-ts> (numeric suffix on collision). Returns the
// archive path, or null when the dir is already absent. Throws (via fail) on a symlink /
// non-directory; propagates fs errors.
function archiveTargetState({ targetStateDir, options }) {
  let stats;
  try {
    stats = fs.lstatSync(targetStateDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail('ERR_STATE_RESET', 'archiving requires a regular target-state directory; refusing to archive a symlink or non-directory');
  }
  const drfxDir = path.dirname(path.dirname(targetStateDir));
  const targetKey = path.basename(targetStateDir);
  const stamp = (options.now || new Date()).toISOString().replace(/[:.]/g, '-');
  const archiveRoot = path.join(drfxDir, 'archived');
  ensureArchiveRootDirectory(archiveRoot);
  let archivePath = path.join(archiveRoot, `${targetKey}-${stamp}`);
  let counter = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(archiveRoot, `${targetKey}-${stamp}-${counter}`);
    counter += 1;
  }
  fs.renameSync(targetStateDir, archivePath);
  return archivePath;
}

// Best-effort archive for finalize / resume. Never throws: a finished PASS is never
// downgraded to an error because the rename failed. Returns one of:
//   { archivedStatePath: <path>, archiveWarning: null }  // archived
//   { archivedStatePath: null,   archiveWarning: null }  // dir already absent
//   { archivedStatePath: null,   archiveWarning: <msg> } // archive failed; dir remains
function archiveTerminalStateBestEffort({ targetStateDir, options }) {
  try {
    const archivedStatePath = archiveTargetState({ targetStateDir, options });
    return { archivedStatePath: archivedStatePath || null, archiveWarning: null };
  } catch (error) {
    return { archivedStatePath: null, archiveWarning: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  BLOCKING_REASONS,
  NO_STATE_TOKEN_MAX_AGE_MS,
  STATUS_REASONS,
  acceptedNonBlockingLowIssueIdsFromLedger,
  acquireLock,
  activeLeaseOrBlock,
  applyTriageDecisions,
  assertDiffReviewEligible,
  assertFixEligible,
  assertPreFixFingerprint,
  assertReadableWritableTarget,
  assertReferencesUnchanged,
  ARCHIVE_ON_FINALIZE,
  archiveFailureNextAction,
  archiveTargetState,
  archiveTerminalStateBestEffort,
  atomicWriteFile,
  beginFixBlocked,
  blockPersistentReviewerMutation,
  blockPersistentStateValidation,
  blockingFindingsFromReviewerResult,
  blockingFindingsFromTriage,
  buildContextPack,
  buildFileSetContextPack,
  buildFinalValidationState,
  buildFixerGuard,
  buildFileSetFixerGuard,
  resolvedFileSetMemberSet,
  normalizeFileSetEntry,
  captureFileSetBaseline,
  validateFileSetBaseline,
  restoreFileSetBaseline,
  checkFileSetWorktree,
  computeFileSetFingerprint,
  buildPrIdentity,
  buildCodeIdentity,
  comparePrIdentity,
  compareCodeIdentity,
  describeCodeBlock,
  loadRouteRuleContext,
  resolveTargetContext,
  resolveCodeTarget,
  resolveR2pWorkIdTarget,
  checkGitRollbackAnchor,
  checkSnapshotRollbackAnchor,
  captureSnapshot,
  checkTargetOnlyWorktree,
  checkSnapshotTargetOnly,
  compareGuardBaseline,
  computeFingerprint,
  contextManifestPathFor,
  contextPhase,
  createPreflightToken,
  createReviewGuard,
  crypto,
  currentProofForResume,
  deriveTargetKey,
  endFixBlocked,
  enrichTriageDecisions,
  fail,
  failStartStateValidation,
  failStateValidation,
  finalizationRequiresReceipt,
  fileSetReviewFingerprintSummary,
  fixableIssuesFromLedger,
  formatLedger,
  formatManifestV2,
  fs,
  guardBaselineFor,
  inspectActualChangedFiles,
  inspectActualChangedFilesSnapshot,
  isStateValidationError,
  loadMergedRules,
  lockReleaseFailureResult,
  metadataExpectedGuard,
  nextReportPath,
  nextStateToken,
  noStateBase,
  noStateOutputOrTooLarge,
  noStateValidationFailure,
  normalizeReferences,
  normalizedReferencePath,
  padRound,
  parseDiffReview,
  parseFinalResponseBlock,
  parseFixReport,
  persistFileSetBaseline,
  parseReviewerResult,
  parseTriageResult,
  path,
  persistentBase,
  preflightBase,
  producerForAssurance,
  readContextManifest,
  readFixReportPayload,
  readPersistedFileSetBaseline,
  readLatestFixGuardBaseline,
  readLedgerIfPresent,
  readManifestReport,
  readOptionalContinuity,
  readResumeDeterministicInputs,
  readReviewerReport,
  readStateCommandPayload,
  readWorkflowPayload,
  receiptFailureResult,
  refreshLock,
  releaseLock,
  releasePersistedLease,
  reportIssueIds,
  reportResult,
  restoreSnapshot,
  requiredSchemaForPhase,
  resolveNoStateMetadata,
  resolvePersistentMetadata,
  resolveFileSetPersistentMetadata,
  resolveFileSetStateMetadata,
  resolveProjectRoot,
  resolveStateCommandMetadata,
  resumeRequiresReceipt,
  resumeStateValidationFailure,
  stableJson,
  stateCommandBase,
  statePathFromManifest,
  stateRelativePath,
  stateValidationResult,
  targetStateDirectory,
  targetStatePathFromManifest,
  tokenHasBlockingFindings,
  triageOutcome,
  updateFixedIssues,
  updatePersistentManifest,
  validateDeclaredFilesChanged,
  validateFinalResponse,
  validateFixedIssueIds,
  validateLedgerPath,
  validateNoStateTokenFingerprints,
  validatePersistentStartStatePaths,
  validateResumeState,
  validateReviewGuard,
  validateStateToken,
  validateTriageReviewerIds,
  withReadOnlyMode,
  workflowBase,
  writeBeginFixGuardReport,
  writeContextManifest,
  writeDiffReviewReport,
  writeFinalReceipt,
  writeFixReceipt,
  writeNormalizedFixReport,
  writeResumeReceipt,
  writeReviewerReport,
  writeTriageReport,
  writeWorkflowSummary
};
