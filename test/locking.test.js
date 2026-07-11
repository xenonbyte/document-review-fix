'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireLock,
  refreshLock,
  assertPreFixFingerprint,
  releaseLock,
  readLease,
  readPersistedLeaseForTarget
} = require('../lib/lock');
const { computeFingerprint } = require('../lib/target-state');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-lock-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const targetPath = path.join(root, 'docs', 'target.md');
  fs.writeFileSync(targetPath, '# Target\n');
  return {
    root,
    targetPath,
    targetKey: 'target-md-123456789abc'
  };
}

function statePaths(root, targetKey) {
  const targetDir = path.join(root, '.drfx', 'targets', targetKey);
  const staleDir = path.join(targetDir, 'stale-locks');
  const mutationDir = path.join(staleDir, '.mutation');
  return {
    targetDir,
    lockDir: path.join(targetDir, 'LOCK'),
    leasePath: path.join(targetDir, 'LOCK', 'lease.json'),
    staleDir,
    mutationDir,
    mutationLeasePath: path.join(mutationDir, 'owner.json')
  };
}

function writeMutationLease(workspace, overrides = {}) {
  const { mutationDir, mutationLeasePath } = statePaths(workspace.root, workspace.targetKey);
  fs.mkdirSync(mutationDir, { recursive: true });
  const startedAt = overrides.startedAt || '2026-05-20T00:00:00.000Z';
  fs.writeFileSync(mutationLeasePath, `${JSON.stringify({
    schemaVersion: 1,
    targetKey: workspace.targetKey,
    ownerId: overrides.ownerId || 'crashed-mutation-owner',
    processId: overrides.processId || 999999,
    hostname: overrides.hostname || 'crashed-host',
    startedAt,
    updatedAt: overrides.updatedAt || startedAt,
    expiresAt: overrides.expiresAt || '2026-05-20T00:01:00.000Z'
  }, null, 2)}\n`);
}

function writeTakeoverClaim(workspace, overrides = {}) {
  const { mutationDir } = statePaths(workspace.root, workspace.targetKey);
  const createdAt = overrides.createdAt || '2026-05-20T00:00:00.000Z';
  fs.writeFileSync(path.join(mutationDir, '.takeover.json'), `${JSON.stringify({
    schemaVersion: 1,
    previousOwnerId: overrides.previousOwnerId || 'crashed-mutation-owner',
    recoveryOwnerId: overrides.recoveryOwnerId || 'crashed-recovery-owner',
    createdAt,
    expiresAt: overrides.expiresAt || '2026-05-20T00:01:00.000Z'
  }, null, 2)}\n`);
}

function acquireDefaults(overrides = {}) {
  const workspace = overrides.workspace || makeWorkspace();
  return acquireLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    targetPath: workspace.targetPath,
    ownerId: overrides.ownerId || 'owner-a',
    mode: overrides.mode || 'review-and-fix',
    strictness: overrides.strictness || 'normal',
    now: overrides.now || new Date('2026-05-20T00:00:00.000Z'),
    ...overrides
  });
}

test('acquires lock atomically and writes required lease fields', () => {
  const workspace = makeWorkspace();
  const now = new Date('2026-05-20T00:00:00.000Z');
  const lease = acquireDefaults({ workspace, now, ownerId: 'owner-a', mode: 'review-and-fix', strictness: 'strict' });
  const { lockDir, leasePath } = statePaths(workspace.root, workspace.targetKey);

  assert.equal(fs.statSync(lockDir).isDirectory(), true);
  assert.deepEqual(readLease({ projectRoot: workspace.root, targetKey: workspace.targetKey }), lease);
  assert.equal(fs.existsSync(leasePath), true);
  assert.equal(lease.schemaVersion, 1);
  assert.equal(lease.targetKey, workspace.targetKey);
  assert.equal(lease.targetPath, path.resolve(workspace.targetPath));
  assert.equal(lease.ownerId, 'owner-a');
  assert.equal(lease.processId, process.pid);
  assert.equal(typeof lease.hostname, 'string');
  assert.equal(lease.startedAt, now.toISOString());
  assert.equal(lease.updatedAt, now.toISOString());
  assert.equal(lease.expiresAt, new Date(now.getTime() + FIFTEEN_MINUTES_MS).toISOString());
  assert.equal(lease.mode, 'review-and-fix');
  assert.equal(lease.strictness, 'strict');
  assert.deepEqual(lease.targetFingerprintAtAcquire, computeFingerprint(workspace.targetPath));
});

test('blocks an unexpired held lock and reports owner metadata', () => {
  const workspace = makeWorkspace();
  const now = new Date('2026-05-20T00:00:00.000Z');
  const first = acquireDefaults({ workspace, now, ownerId: 'owner-a' });

  assert.throws(
    () => acquireDefaults({ workspace, now: new Date(now.getTime() + 1000), ownerId: 'owner-b' }),
    (error) => {
      assert.equal(error.status, 'blocked');
      assert.equal(error.reason, 'lock-held');
      assert.equal(error.lease.ownerId, 'owner-a');
      assert.equal(error.lease.expiresAt, first.expiresAt);
      return true;
    }
  );
});

test('blocks missing or invalid lease as corrupt-lock', () => {
  const workspace = makeWorkspace();
  const { lockDir, leasePath } = statePaths(workspace.root, workspace.targetKey);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir);

  assert.throws(
    () => acquireDefaults({ workspace }),
    (error) => error.status === 'blocked' && error.reason === 'corrupt-lock'
  );

  fs.writeFileSync(leasePath, '{not json');
  assert.throws(
    () => readLease({ projectRoot: workspace.root, targetKey: workspace.targetKey }),
    (error) => error.status === 'blocked' && error.reason === 'corrupt-lock'
  );
});

test('failed initial acquire does not leave a corrupt empty lock directory', () => {
  const workspace = makeWorkspace();
  const missingTarget = path.join(workspace.root, 'docs', 'missing.md');

  assert.throws(
    () => acquireLock({
      projectRoot: workspace.root,
      targetKey: workspace.targetKey,
      targetPath: missingTarget,
      ownerId: 'owner-a'
    }),
    /ENOENT|no such file/i
  );
  assert.equal(readLease({ projectRoot: workspace.root, targetKey: workspace.targetKey }), null);
});

test('archives stale lock and replaces it when target still matches trusted baseline', () => {
  const workspace = makeWorkspace();
  const staleStarted = new Date('2026-05-20T00:00:00.000Z');
  const stale = acquireDefaults({ workspace, now: staleStarted, ownerId: 'stale-owner' });
  const takeoverAt = new Date(staleStarted.getTime() + FIFTEEN_MINUTES_MS + 1000);
  const replacement = acquireDefaults({
    workspace,
    now: takeoverAt,
    ownerId: 'owner-b',
    lastKnownContentSha256: stale.targetFingerprintAtAcquire.sha256
  });
  const { staleDir } = statePaths(workspace.root, workspace.targetKey);
  const archived = fs.readdirSync(staleDir);

  assert.equal(replacement.ownerId, 'owner-b');
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(staleDir, archived[0]), 'utf8')).ownerId, 'stale-owner');
});

test('stale takeover mutation lock blocks acquire after validation before archive', () => {
  const workspace = makeWorkspace();
  const staleStarted = new Date('2026-05-20T00:00:00.000Z');
  const stale = acquireDefaults({ workspace, now: staleStarted, ownerId: 'stale-owner' });
  const takeoverAt = new Date(staleStarted.getTime() + FIFTEEN_MINUTES_MS + 1000);
  let raced = false;

  const lease = acquireLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    targetPath: workspace.targetPath,
    ownerId: 'late-owner',
    now: takeoverAt,
    lastKnownContentSha256: stale.targetFingerprintAtAcquire.sha256,
    _onAfterValidateBeforeArchive() {
      raced = true;
      assert.throws(
        () => acquireLock({
          projectRoot: workspace.root,
          targetKey: workspace.targetKey,
          targetPath: workspace.targetPath,
          ownerId: 'winner-owner',
          now: new Date(takeoverAt.getTime() + 1000),
          lastKnownContentSha256: stale.targetFingerprintAtAcquire.sha256
        }),
        (error) => error.status === 'blocked' && error.reason === 'lock-held'
      );
    }
  });

  assert.equal(raced, true);
  assert.equal(lease.ownerId, 'late-owner');
  assert.equal(readLease({ projectRoot: workspace.root, targetKey: workspace.targetKey }).ownerId, 'late-owner');
});

test('blocks stale lock takeover when target fingerprint mismatches baseline', () => {
  const workspace = makeWorkspace();
  const staleStarted = new Date('2026-05-20T00:00:00.000Z');
  const stale = acquireDefaults({ workspace, now: staleStarted, ownerId: 'stale-owner' });
  fs.appendFileSync(workspace.targetPath, '\nExternal edit\n');

  assert.throws(
    () => acquireDefaults({
      workspace,
      now: new Date(staleStarted.getTime() + FIFTEEN_MINUTES_MS + 1000),
      ownerId: 'owner-b',
      lastKnownContentSha256: stale.targetFingerprintAtAcquire.sha256
    }),
    (error) => {
      assert.equal(error.status, 'externally-changed');
      assert.equal(error.reason, 'stale-fingerprint-mismatch');
      return true;
    }
  );
});

test('refreshes owner lease timestamps and keeps the refresh interval within 60 seconds', () => {
  const workspace = makeWorkspace();
  const started = new Date('2026-05-20T00:00:00.000Z');
  const lease = acquireDefaults({ workspace, now: started, ownerId: 'owner-a' });
  const refreshAt = new Date(started.getTime() + 60 * 1000);
  const refreshed = refreshLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    ownerId: 'owner-a',
    now: refreshAt
  });

  assert.equal(refreshed.updatedAt, refreshAt.toISOString());
  assert.equal(refreshed.expiresAt, new Date(refreshAt.getTime() + FIFTEEN_MINUTES_MS).toISOString());
  assert.equal(refreshed.ownerId, lease.ownerId);
  assert.equal(refreshed.leaseId, lease.leaseId);
  assert.ok(Date.parse(refreshed.updatedAt) - Date.parse(refreshed.startedAt) <= 60 * 1000);
});

test('persisted lease ownership helper rejects target mismatch', () => {
  const workspace = makeWorkspace();
  acquireDefaults({ workspace, ownerId: 'owner-a' });
  assert.equal(
    readPersistedLeaseForTarget({
      projectRoot: workspace.root,
      targetKey: workspace.targetKey,
      targetPath: workspace.targetPath
    }).ownerId,
    'owner-a'
  );

  const otherTarget = path.join(workspace.root, 'docs', 'other.md');
  fs.writeFileSync(otherTarget, '# Other\n');
  assert.throws(
    () => readPersistedLeaseForTarget({
      projectRoot: workspace.root,
      targetKey: workspace.targetKey,
      targetPath: otherTarget
    }),
    (error) => error.status === 'blocked' && error.reason === 'corrupt-lock'
  );
});

test('refresh mutation lock blocks takeover after validation before write', () => {
  const workspace = makeWorkspace();
  const started = new Date('2026-05-20T00:00:00.000Z');
  const stale = acquireDefaults({ workspace, now: started, ownerId: 'owner-a' });
  const takeoverAt = new Date(started.getTime() + FIFTEEN_MINUTES_MS + 1000);
  let raced = false;

  const refreshed = refreshLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    ownerId: 'owner-a',
    now: takeoverAt,
    _onAfterValidateBeforeWrite() {
      raced = true;
      assert.throws(
        () => acquireLock({
          projectRoot: workspace.root,
          targetKey: workspace.targetKey,
          targetPath: workspace.targetPath,
          ownerId: 'owner-b',
          now: takeoverAt,
          lastKnownContentSha256: stale.targetFingerprintAtAcquire.sha256
        }),
        (error) => error.status === 'blocked' && error.reason === 'lock-held'
      );
    }
  });

  assert.equal(raced, true);
  assert.equal(refreshed.ownerId, 'owner-a');
  assert.equal(readLease({ projectRoot: workspace.root, targetKey: workspace.targetKey }).ownerId, 'owner-a');
});

test('refresh atomically recovers a valid expired mutation mutex left by a crashed process', () => {
  const workspace = makeWorkspace();
  const started = new Date('2026-05-20T00:00:00.000Z');
  acquireDefaults({ workspace, now: started, ownerId: 'owner-a' });
  writeMutationLease(workspace);

  const refreshed = refreshLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    ownerId: 'owner-a',
    now: new Date('2026-05-20T00:02:00.000Z')
  });
  const { staleDir, mutationDir } = statePaths(workspace.root, workspace.targetKey);

  assert.equal(refreshed.ownerId, 'owner-a');
  assert.equal(fs.existsSync(mutationDir), false);
  assert.equal(fs.readdirSync(staleDir).some((name) => name.startsWith('.mutation-stale-')), true);
});

test('malformed mutation mutex reports corrupt-lock instead of permanent lock-held', () => {
  const workspace = makeWorkspace();
  acquireDefaults({ workspace, ownerId: 'owner-a' });
  const { mutationDir } = statePaths(workspace.root, workspace.targetKey);
  fs.mkdirSync(mutationDir, { recursive: true });

  assert.throws(
    () => refreshLock({
      projectRoot: workspace.root,
      targetKey: workspace.targetKey,
      ownerId: 'owner-a',
      now: new Date('2026-05-20T00:02:00.000Z')
    }),
    (error) => error.status === 'blocked' && error.reason === 'corrupt-lock' && /mutation mutex/i.test(error.message)
  );
});

test('refresh recovers an expired takeover claim left by a crash before rename', () => {
  const workspace = makeWorkspace();
  acquireDefaults({ workspace, now: new Date('2026-05-20T00:00:00.000Z'), ownerId: 'owner-a' });
  writeMutationLease(workspace);
  writeTakeoverClaim(workspace);

  const refreshed = refreshLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    ownerId: 'owner-a',
    now: new Date('2026-05-20T00:02:00.000Z')
  });

  assert.equal(refreshed.ownerId, 'owner-a');
  assert.equal(fs.existsSync(statePaths(workspace.root, workspace.targetKey).mutationDir), false);
});

test('refresh recovers after a crash immediately after atomically retiring its mutation mutex', () => {
  const workspace = makeWorkspace();
  const started = new Date('2026-05-20T00:00:00.000Z');
  acquireDefaults({ workspace, now: started, ownerId: 'owner-a' });
  let retiredPath = null;

  assert.throws(
    () => refreshLock({
      projectRoot: workspace.root,
      targetKey: workspace.targetKey,
      ownerId: 'owner-a',
      now: new Date('2026-05-20T00:00:30.000Z'),
      _onAfterRetireMutation(metadata) {
        retiredPath = metadata.retiredPath;
        throw new Error('injected crash after mutation retirement');
      }
    }),
    /crash after mutation retirement/i
  );

  assert.equal(fs.existsSync(statePaths(workspace.root, workspace.targetKey).mutationDir), false);
  assert.equal(fs.existsSync(retiredPath), true);
  const refreshed = refreshLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    ownerId: 'owner-a',
    now: new Date('2026-05-20T00:00:31.000Z')
  });
  assert.equal(refreshed.ownerId, 'owner-a');
});

test('pre-fix guard rejects mismatch against lease acquire fingerprint', () => {
  const workspace = makeWorkspace();
  const lease = acquireDefaults({ workspace, ownerId: 'owner-a' });
  fs.appendFileSync(workspace.targetPath, '\nExternal edit\n');

  assert.throws(
    () => assertPreFixFingerprint({ targetPath: workspace.targetPath, lease }),
    (error) => {
      assert.equal(error.status, 'externally-changed');
      assert.equal(error.reason, 'target-fingerprint-mismatch');
      return true;
    }
  );
});

test('pre-fix guard rejects mismatch against manifest last-known sha', () => {
  const workspace = makeWorkspace();
  const lease = acquireDefaults({ workspace, ownerId: 'owner-a' });

  assert.throws(
    () => assertPreFixFingerprint({
      targetPath: workspace.targetPath,
      lease,
      manifest: { lastKnownContentSha256: '0'.repeat(64) }
    }),
    (error) => {
      assert.equal(error.status, 'externally-changed');
      assert.equal(error.reason, 'manifest-fingerprint-mismatch');
      return true;
    }
  );
});

test('release is owner checked and does not remove another owner lock', () => {
  const workspace = makeWorkspace();
  acquireDefaults({ workspace, ownerId: 'owner-a' });
  const { lockDir, leasePath } = statePaths(workspace.root, workspace.targetKey);

  assert.throws(
    () => releaseLock({ projectRoot: workspace.root, targetKey: workspace.targetKey, ownerId: 'owner-b' }),
    (error) => error.status === 'blocked' && error.reason === 'lock-held'
  );
  assert.equal(fs.existsSync(lockDir), true);
  assert.equal(JSON.parse(fs.readFileSync(leasePath, 'utf8')).ownerId, 'owner-a');

  const result = releaseLock({ projectRoot: workspace.root, targetKey: workspace.targetKey, ownerId: 'owner-a' });
  assert.deepEqual(result, { released: true });
  assert.equal(fs.existsSync(lockDir), false);
});

test('release mutation lock blocks takeover after validation before delete', () => {
  const workspace = makeWorkspace();
  const started = new Date('2026-05-20T00:00:00.000Z');
  const stale = acquireDefaults({ workspace, now: started, ownerId: 'owner-a' });
  const takeoverAt = new Date(started.getTime() + FIFTEEN_MINUTES_MS + 1000);
  let raced = false;

  const result = releaseLock({
    projectRoot: workspace.root,
    targetKey: workspace.targetKey,
    ownerId: 'owner-a',
    _onAfterValidateBeforeDelete() {
      raced = true;
      assert.throws(
        () => acquireLock({
          projectRoot: workspace.root,
          targetKey: workspace.targetKey,
          targetPath: workspace.targetPath,
          ownerId: 'owner-b',
          now: takeoverAt,
          lastKnownContentSha256: stale.targetFingerprintAtAcquire.sha256
        }),
        (error) => error.status === 'blocked' && error.reason === 'lock-held'
      );
    }
  });

  assert.equal(raced, true);
  assert.deepEqual(result, { released: true });
  assert.equal(readLease({ projectRoot: workspace.root, targetKey: workspace.targetKey }), null);
});

test('release reports lock-release-failed after owner verification without deleting unrelated files', () => {
  const workspace = makeWorkspace();
  acquireDefaults({ workspace, ownerId: 'owner-a' });
  const { lockDir } = statePaths(workspace.root, workspace.targetKey);
  const unrelated = path.join(lockDir, 'unexpected.tmp');
  fs.writeFileSync(unrelated, 'keep\n');

  assert.throws(
    () => releaseLock({ projectRoot: workspace.root, targetKey: workspace.targetKey, ownerId: 'owner-a' }),
    (error) => {
      assert.equal(error.status, 'blocked');
      assert.equal(error.reason, 'lock-release-failed');
      assert.equal(error.lockDir, lockDir);
      return true;
    }
  );
  assert.equal(fs.existsSync(unrelated), true);
});
