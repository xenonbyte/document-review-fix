'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  computeFingerprint,
  deriveR2pTargetKey,
  deriveTargetKey,
  readManifest
} = require('./target-state');
const { atomicWriteFile } = require('./atomic-write');
const { deriveFileSetTargetKey } = require('./workflow/target-resolution');

const SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MUTATION_SCHEMA_VERSION = 1;
const DEFAULT_MUTATION_LEASE_MS = 60 * 1000;
const REQUIRED_LEASE_FIELDS = [
  'schemaVersion',
  'targetKey',
  'targetPath',
  'ownerId',
  'processId',
  'hostname',
  'startedAt',
  'updatedAt',
  'expiresAt',
  'mode',
  'strictness',
  'targetFingerprintAtAcquire'
];
const REQUIRED_MUTATION_FIELDS = [
  'schemaVersion',
  'targetKey',
  'ownerId',
  'processId',
  'hostname',
  'startedAt',
  'updatedAt',
  'expiresAt'
];
const REQUIRED_TAKEOVER_FIELDS = [
  'schemaVersion',
  'previousOwnerId',
  'recoveryOwnerId',
  'createdAt',
  'expiresAt'
];

function lockPaths(projectRoot, targetKey) {
  const targetDir = path.join(path.resolve(projectRoot), '.drfx', 'targets', targetKey);
  const lockDir = path.join(targetDir, 'LOCK');
  const staleDir = path.join(targetDir, 'stale-locks');
  return {
    targetDir,
    lockDir,
    leasePath: path.join(lockDir, 'lease.json'),
    staleDir,
    mutationDir: path.join(staleDir, '.mutation'),
    mutationLeasePath: path.join(staleDir, '.mutation', 'owner.json')
  };
}

function makeError(code, status, reason, message, metadata = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.reason = reason;
  Object.assign(error, metadata);
  return error;
}

function stateValidationError(message) {
  const error = new Error(`state-validation-failed: ${message}`);
  error.code = 'ERR_STATE_VALIDATION_FAILED';
  return error;
}

function corruptLock(lockDir, cause = null) {
  return makeError(
    'ERR_CORRUPT_LOCK',
    'blocked',
    'corrupt-lock',
    `lock lease is missing or invalid: ${lockDir}`,
    { lockDir, cause }
  );
}

function lockHeld(lockDir, lease) {
  return makeError(
    'ERR_LOCK_HELD',
    'blocked',
    'lock-held',
    `target lock is held by another owner: ${lockDir}`,
    { lockDir, lease }
  );
}

function mutationLockHeld(lockDir, mutationDir, mutationLease = null) {
  return makeError(
    'ERR_LOCK_HELD',
    'blocked',
    'lock-held',
    `target lock mutation is already in progress: ${mutationDir}`,
    { lockDir, mutationDir, mutationLease }
  );
}

function corruptMutationLock(lockDir, mutationDir, cause = null) {
  return makeError(
    'ERR_CORRUPT_LOCK',
    'blocked',
    'corrupt-lock',
    `mutation mutex metadata is missing or invalid; archive or remove after verifying no mutation is active: ${mutationDir}`,
    { lockDir, mutationDir, cause }
  );
}

function externallyChanged(reason, metadata) {
  return makeError(
    'ERR_EXTERNALLY_CHANGED',
    'externally-changed',
    reason,
    `target fingerprint changed before lock operation: ${reason}`,
    metadata
  );
}

function releaseFailed(lockDir, lease, cause) {
  return makeError(
    'ERR_LOCK_RELEASE_FAILED',
    'blocked',
    'lock-release-failed',
    `failed to release target lock after owner verification: ${lockDir}`,
    { lockDir, lease, cause }
  );
}

function parseDateMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function assertFingerprintShape(fingerprint) {
  return fingerprint
    && typeof fingerprint.sha256 === 'string'
    && typeof fingerprint.size === 'number'
    && typeof fingerprint.mtimeMs === 'number';
}

function validateLease(lease, lockDir) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw corruptLock(lockDir);
  for (const field of REQUIRED_LEASE_FIELDS) {
    if (!(field in lease)) throw corruptLock(lockDir);
  }
  if (lease.schemaVersion !== SCHEMA_VERSION) throw corruptLock(lockDir);
  if ('leaseId' in lease && typeof lease.leaseId !== 'string') throw corruptLock(lockDir);
  if (!assertFingerprintShape(lease.targetFingerprintAtAcquire)) throw corruptLock(lockDir);
  if (parseDateMs(lease.startedAt) === null || parseDateMs(lease.updatedAt) === null || parseDateMs(lease.expiresAt) === null) {
    throw corruptLock(lockDir);
  }
  return lease;
}

function validateMutationLease(lease, { lockDir, mutationDir, targetKey }) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  for (const field of REQUIRED_MUTATION_FIELDS) {
    if (!(field in lease)) throw corruptMutationLock(lockDir, mutationDir);
  }
  if (lease.schemaVersion !== MUTATION_SCHEMA_VERSION) throw corruptMutationLock(lockDir, mutationDir);
  if (lease.targetKey !== targetKey || typeof lease.ownerId !== 'string' || lease.ownerId.length === 0) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  if (!Number.isInteger(lease.processId) || typeof lease.hostname !== 'string' || lease.hostname.length === 0) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  if (parseDateMs(lease.startedAt) === null || parseDateMs(lease.updatedAt) === null || parseDateMs(lease.expiresAt) === null) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  return lease;
}

function readLease({ projectRoot, targetKey }) {
  const { lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  if (!fs.existsSync(lockDir)) return null;
  let text;
  try {
    text = fs.readFileSync(leasePath, 'utf8');
  } catch (error) {
    throw corruptLock(lockDir, error);
  }
  try {
    return validateLease(JSON.parse(text), lockDir);
  } catch (error) {
    if (error && error.reason === 'corrupt-lock') throw error;
    throw corruptLock(lockDir, error);
  }
}

function readPersistedLeaseForTarget({ projectRoot, targetKey, targetPath = null }) {
  const { lockDir } = lockPaths(projectRoot, targetKey);
  const lease = readLease({ projectRoot, targetKey });
  if (!lease) throw corruptLock(lockDir);
  if (lease.targetKey !== targetKey) throw corruptLock(lockDir);
  if (targetPath && path.resolve(lease.targetPath) !== path.resolve(targetPath)) {
    throw corruptLock(lockDir);
  }
  return lease;
}

function writeLease(leasePath, lease) {
  atomicWriteFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
}

function validateDocumentStateIdentity({ projectRoot, targetPath, manifest, targetKey }) {
  let targetStat;
  try {
    targetStat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw stateValidationError(`unable to inspect manifest target path: ${error.message}`);
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) return;
  let derived;
  try {
    derived = deriveTargetKey(projectRoot, targetPath);
  } catch (error) {
    throw stateValidationError(`unable to derive target identity from manifest path: ${error.message}`);
  }
  if (derived.targetKey !== targetKey) {
    throw stateValidationError('derived target key does not match manifest Target key');
  }
  if (manifest.normalizedTarget !== derived.normalizedTarget) {
    throw stateValidationError('manifest Normalized target does not match canonical target identity');
  }
}

function deriveFileSetStateKey({ projectRoot, manifest }) {
  const routeKind = manifest.targetContextKind;
  try {
    if (routeKind === 'pr') {
      return deriveFileSetTargetKey({ invocation: { routeKind, base: manifest.base } });
    }
    if (routeKind === 'code') {
      const normalizedScopes = Array.isArray(manifest.normalizedScopes) ? manifest.normalizedScopes : [];
      const normalizedUserExcludes = Array.isArray(manifest.userExcludes) ? manifest.userExcludes : [];
      return deriveFileSetTargetKey(
        { invocation: { routeKind, scopes: normalizedScopes } },
        { normalizedScopes, normalizedUserExcludes }
      );
    }
    if (routeKind === 'r2p') {
      return deriveR2pTargetKey({ projectRoot, workId: manifest.workId }).targetKey;
    }
  } catch (error) {
    throw stateValidationError(`unable to derive ${routeKind} target identity from manifest: ${error.message}`);
  }
  throw stateValidationError(`unsupported target context kind: ${routeKind}`);
}

function createLease({ targetKey, targetPath, ownerId, mode, strictness, now, leaseMs }) {
  const startedAt = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    leaseId: crypto.randomUUID(),
    targetKey,
    targetPath: path.resolve(targetPath),
    ownerId,
    processId: process.pid,
    hostname: os.hostname(),
    startedAt,
    updatedAt: startedAt,
    expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    mode,
    strictness,
    targetFingerprintAtAcquire: computeFingerprint(targetPath)
  };
}

function timestampForPath(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function trustedBaselineSha({ lastKnownContentSha256, manifest }) {
  if (lastKnownContentSha256) return lastKnownContentSha256;
  if (manifest && manifest.lastKnownContentSha256) return manifest.lastKnownContentSha256;
  return null;
}

function createMutationLease({ targetKey, now, leaseMs }) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: MUTATION_SCHEMA_VERSION,
    targetKey,
    ownerId: crypto.randomUUID(),
    processId: process.pid,
    hostname: os.hostname(),
    startedAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(now.getTime() + leaseMs).toISOString()
  };
}

function readMutationLease({ projectRoot, targetKey }) {
  const { lockDir, mutationDir, mutationLeasePath } = lockPaths(projectRoot, targetKey);
  let mutationStat;
  try {
    mutationStat = fs.lstatSync(mutationDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw corruptMutationLock(lockDir, mutationDir, error);
  }
  if (mutationStat.isSymbolicLink() || !mutationStat.isDirectory()) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  let ownerStat;
  let text;
  try {
    ownerStat = fs.lstatSync(mutationLeasePath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) throw new Error('owner metadata must be a regular file');
    text = fs.readFileSync(mutationLeasePath, 'utf8');
  } catch (error) {
    throw corruptMutationLock(lockDir, mutationDir, error);
  }
  try {
    return validateMutationLease(JSON.parse(text), { lockDir, mutationDir, targetKey });
  } catch (error) {
    if (error && error.reason === 'corrupt-lock') throw error;
    throw corruptMutationLock(lockDir, mutationDir, error);
  }
}

function createMutationDirectory({ staleDir, mutationDir, mutationLease }) {
  const stagingDir = path.join(staleDir, `.mutation-${mutationLease.ownerId}.staging`);
  fs.mkdirSync(stagingDir);
  try {
    fs.writeFileSync(
      path.join(stagingDir, 'owner.json'),
      `${JSON.stringify(mutationLease, null, 2)}\n`,
      { flag: 'wx' }
    );
    try {
      fs.lstatSync(mutationDir);
      const existsError = new Error(`mutation mutex already exists: ${mutationDir}`);
      existsError.code = 'EEXIST';
      throw existsError;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    fs.renameSync(stagingDir, mutationDir);
  } catch (error) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // A staging orphan never owns the canonical mutex path and cannot block recovery.
    }
    throw error;
  }
}

function readTakeoverClaim({ lockDir, mutationDir, claimPath }) {
  let stat;
  let claim;
  try {
    stat = fs.lstatSync(claimPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('takeover claim must be a regular file');
    claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  } catch (error) {
    throw corruptMutationLock(lockDir, mutationDir, error);
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  for (const field of REQUIRED_TAKEOVER_FIELDS) {
    if (!(field in claim)) throw corruptMutationLock(lockDir, mutationDir);
  }
  if (
    claim.schemaVersion !== MUTATION_SCHEMA_VERSION ||
    typeof claim.previousOwnerId !== 'string' ||
    typeof claim.recoveryOwnerId !== 'string' ||
    parseDateMs(claim.createdAt) === null ||
    parseDateMs(claim.expiresAt) === null
  ) {
    throw corruptMutationLock(lockDir, mutationDir);
  }
  return claim;
}

function claimExpiredMutation({ projectRoot, targetKey, existing, recoveryOwnerId, now, leaseMs }) {
  const { lockDir, mutationDir } = lockPaths(projectRoot, targetKey);
  const claimPath = path.join(mutationDir, '.takeover.json');
  let claimed = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(claimPath, `${JSON.stringify({
        schemaVersion: MUTATION_SCHEMA_VERSION,
        previousOwnerId: existing.ownerId,
        recoveryOwnerId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseMs).toISOString()
      })}\n`, { flag: 'wx' });
      claimed = true;
      break;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      if (!error || error.code !== 'EEXIST') throw corruptMutationLock(lockDir, mutationDir, error);
      const claim = readTakeoverClaim({ lockDir, mutationDir, claimPath });
      if (parseDateMs(claim.expiresAt) > now.getTime()) {
        throw mutationLockHeld(lockDir, mutationDir, existing);
      }
      const staleClaimPath = path.join(
        mutationDir,
        `.takeover-stale-${timestampForPath(now)}-${crypto.randomUUID()}.json`
      );
      try {
        fs.renameSync(claimPath, staleClaimPath);
      } catch (renameError) {
        if (renameError && renameError.code === 'ENOENT') continue;
        throw corruptMutationLock(lockDir, mutationDir, renameError);
      }
      continue;
    }
  }
  if (!claimed) return false;

  // The directory may have been released and reacquired between the stale read and the
  // exclusive claim write. The claim prevents that directory from being removed now;
  // verify its owner before the atomic rename so a fresh mutex is never stolen.
  let current = null;
  try {
    current = readMutationLease({ projectRoot, targetKey });
  } catch (error) {
    if (!error || error.reason !== 'corrupt-lock') throw error;
    // The prior owner may have removed owner.json immediately before the claim landed.
    // Because the exclusive claim now prevents rmdir, no fresh owner can occupy this
    // directory; archiving the already-expired instance remains safe.
  }
  if (current && current.ownerId !== existing.ownerId) {
    try {
      fs.unlinkSync(claimPath);
    } catch {
      // If claim cleanup fails, leave a visible corrupt mutex instead of stealing it.
    }
    throw mutationLockHeld(lockDir, mutationDir, current);
  }
  return true;
}

function acquireMutationMutex({ projectRoot, targetKey, now, leaseMs }) {
  const { lockDir, staleDir, mutationDir } = lockPaths(projectRoot, targetKey);
  fs.mkdirSync(staleDir, { recursive: true });
  const mutationLease = createMutationLease({ targetKey, now, leaseMs });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createMutationDirectory({ staleDir, mutationDir, mutationLease });
      return mutationLease;
    } catch (error) {
      if (!error || !['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }

    const existing = readMutationLease({ projectRoot, targetKey });
    if (!existing) continue;
    if (parseDateMs(existing.expiresAt) > now.getTime()) {
      throw mutationLockHeld(lockDir, mutationDir, existing);
    }
    if (!claimExpiredMutation({
      projectRoot,
      targetKey,
      existing,
      recoveryOwnerId: mutationLease.ownerId,
      now,
      leaseMs
    })) continue;
    const archivePath = path.join(
      staleDir,
      `.mutation-stale-${timestampForPath(now)}-${crypto.randomUUID()}`
    );
    try {
      fs.renameSync(mutationDir, archivePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw corruptMutationLock(lockDir, mutationDir, error);
    }
  }
  throw mutationLockHeld(lockDir, mutationDir, readMutationLease({ projectRoot, targetKey }));
}

function releaseMutationMutex({ projectRoot, targetKey, ownerId, onAfterRetire = null }) {
  const { lockDir, staleDir, mutationDir } = lockPaths(projectRoot, targetKey);
  const current = readMutationLease({ projectRoot, targetKey });
  if (!current || current.ownerId !== ownerId) throw mutationLockHeld(lockDir, mutationDir, current);
  const retiredPath = path.join(staleDir, `.mutation-retired-${ownerId}-${crypto.randomUUID()}`);
  try {
    fs.renameSync(mutationDir, retiredPath);
  } catch (error) {
    throw corruptMutationLock(lockDir, mutationDir, error);
  }
  if (typeof onAfterRetire === 'function') onAfterRetire({ retiredPath, ownerId });
  try {
    fs.rmSync(retiredPath, { recursive: true, force: true });
  } catch {
    // A retired mutex is non-canonical and cannot block a future mutation.
  }
}

function withTargetMutationLock({
  projectRoot,
  targetKey,
  now = new Date(),
  leaseMs = DEFAULT_MUTATION_LEASE_MS,
  _onAfterRetireMutation = null
}, operation) {
  const mutationLease = acquireMutationMutex({ projectRoot, targetKey, now, leaseMs });
  let operationError = null;
  try {
    return operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseMutationMutex({
        projectRoot,
        targetKey,
        ownerId: mutationLease.ownerId,
        onAfterRetire: _onAfterRetireMutation
      });
    } catch (cleanupError) {
      if (!operationError) throw cleanupError;
      operationError.mutationCleanupError = cleanupError;
    }
  }
}

function archiveStaleLease({ projectRoot, targetKey, staleLease, now }) {
  const { leasePath, lockDir, staleDir } = lockPaths(projectRoot, targetKey);
  fs.mkdirSync(staleDir, { recursive: true });
  const archivePath = path.join(staleDir, `${timestampForPath(now)}.json`);
  fs.writeFileSync(archivePath, `${JSON.stringify(staleLease, null, 2)}\n`, { flag: 'wx' });
  fs.unlinkSync(leasePath);
  fs.rmdirSync(lockDir);
  return archivePath;
}

function acquireLock({
  projectRoot,
  targetKey,
  targetPath,
  ownerId,
  mode = 'review-and-fix',
  strictness = 'normal',
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  lastKnownContentSha256 = null,
  manifest = null,
  _onAfterValidateBeforeArchive = null
}) {
  const { targetDir, lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
    return withTargetMutationLock({ projectRoot, targetKey, now }, () => {
      const existingLease = readLease({ projectRoot, targetKey });
      if (!existingLease) throw corruptLock(lockDir);
      const expiresAtMs = parseDateMs(existingLease.expiresAt);
      if (expiresAtMs === null) throw corruptLock(lockDir);
      if (expiresAtMs > now.getTime()) throw lockHeld(lockDir, existingLease);

      const currentFingerprint = computeFingerprint(targetPath);
      const baselineSha = trustedBaselineSha({ lastKnownContentSha256, manifest });
      if (!baselineSha || currentFingerprint.sha256 !== baselineSha) {
        throw externallyChanged('stale-fingerprint-mismatch', {
          lockDir,
          lease: existingLease,
          currentFingerprint,
          baselineSha
        });
      }
      if (_onAfterValidateBeforeArchive) _onAfterValidateBeforeArchive(existingLease);
      archiveStaleLease({ projectRoot, targetKey, staleLease: existingLease, now });
      fs.mkdirSync(lockDir);
      const takeoverLease = createLease({ targetKey, targetPath, ownerId, mode, strictness, now, leaseMs });
      writeLease(leasePath, takeoverLease);
      return takeoverLease;
    });
  }

  try {
    const lease = createLease({ targetKey, targetPath, ownerId, mode, strictness, now, leaseMs });
    writeLease(leasePath, lease);
    return lease;
  } catch (error) {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Leave the original acquire failure intact; non-empty lock cleanup is handled by normal lock validation.
    }
    throw error;
  }
}

function refreshLock({
  projectRoot,
  targetKey,
  ownerId,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  _onAfterValidateBeforeWrite = null,
  _onAfterRetireMutation = null
}) {
  const { lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  return withTargetMutationLock({ projectRoot, targetKey, now, _onAfterRetireMutation }, () => {
    const lease = readLease({ projectRoot, targetKey });
    if (!lease) throw corruptLock(lockDir);
    if (lease.ownerId !== ownerId) throw lockHeld(lockDir, lease);

    const refreshed = {
      ...lease,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + leaseMs).toISOString()
    };
    if (_onAfterValidateBeforeWrite) _onAfterValidateBeforeWrite(lease);
    writeLease(leasePath, refreshed);
    return refreshed;
  });
}

function fingerprintsMatch(current, baseline) {
  return current.sha256 === baseline.sha256
    && current.size === baseline.size
    && current.mtimeMs === baseline.mtimeMs;
}

function manifestLastKnownSha({ manifest, manifestPath, projectRoot, targetKey }) {
  if (manifest && manifest.lastKnownContentSha256) return manifest.lastKnownContentSha256;
  if (manifestPath) return readManifest(manifestPath).lastKnownContentSha256;
  if (projectRoot && targetKey) {
    const defaultPath = path.join(path.resolve(projectRoot), '.drfx', 'targets', targetKey, 'MANIFEST.md');
    if (fs.existsSync(defaultPath)) return readManifest(defaultPath).lastKnownContentSha256;
  }
  return null;
}

function assertPreFixFingerprint({
  targetPath,
  lease,
  projectRoot = null,
  targetKey = null,
  manifest = null,
  manifestPath = null
}) {
  const activeLease = lease || readLease({ projectRoot, targetKey });
  if (!activeLease) throw corruptLock(lockPaths(projectRoot, targetKey).lockDir);
  const currentFingerprint = computeFingerprint(targetPath);

  if (!fingerprintsMatch(currentFingerprint, activeLease.targetFingerprintAtAcquire)) {
    throw externallyChanged('target-fingerprint-mismatch', {
      lease: activeLease,
      currentFingerprint,
      baselineFingerprint: activeLease.targetFingerprintAtAcquire
    });
  }

  const lastKnownContentSha256 = manifestLastKnownSha({ manifest, manifestPath, projectRoot, targetKey });
  if (lastKnownContentSha256 && currentFingerprint.sha256 !== lastKnownContentSha256) {
    throw externallyChanged('manifest-fingerprint-mismatch', {
      lease: activeLease,
      currentFingerprint,
      lastKnownContentSha256
    });
  }
  return currentFingerprint;
}

function releaseLock({ projectRoot, targetKey, ownerId, now = new Date(), _onAfterValidateBeforeDelete = null }) {
  const { lockDir, leasePath } = lockPaths(projectRoot, targetKey);
  return withTargetMutationLock({ projectRoot, targetKey, now }, () => {
    const lease = readLease({ projectRoot, targetKey });
    if (!lease) return { released: false };
    if (lease.ownerId !== ownerId) throw lockHeld(lockDir, lease);

    if (_onAfterValidateBeforeDelete) _onAfterValidateBeforeDelete(lease);
    try {
      fs.unlinkSync(leasePath);
      fs.rmdirSync(lockDir);
    } catch (error) {
      throw releaseFailed(lockDir, lease, error);
    }
    return { released: true };
  });
}

module.exports = {
  acquireLock,
  refreshLock,
  assertPreFixFingerprint,
  releaseLock,
  readLease,
  readPersistedLeaseForTarget,
  validateDocumentStateIdentity,
  deriveFileSetStateKey
};
