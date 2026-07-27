'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDescriptor,
  checkPlatformCapabilities,
  checkPlatforms,
  createRunId,
  runFingerprintGuardProbe,
  validateCurrentDescriptor
} = require('../lib/capability');
const {
  manifestPathForPlatform,
  parseManifestText,
  platformAllowlist,
  readInstallManifest,
  serializeManifest,
  validateGeneratedRemoval,
  writeInstallManifest
} = require('../lib/manifest');
const claude = require('../lib/adapters/claude');
const codex = require('../lib/adapters/codex');
const gemini = require('../lib/adapters/gemini');
const opencode = require('../lib/adapters/opencode');
const {
  ROUTES,
  copySharedAssets,
  generatePlatformFiles,
  renderPlatformRoute
} = require('../lib/generator');
const {
  parsePlatformList,
  installPlatforms,
  uninstallPlatforms,
  installPlatform,
  uninstallPlatform,
  validateGeneratedPlan
} = require('../lib/install');
const { runCheck, formatCheckReport, sweepStaleDoctorTempDirs } = require('../lib/check');

const PACKAGE_VERSION = '0.1.1';
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'descriptors');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allRequiredCapabilities(descriptor) {
  return [
    descriptor.capabilities.can_spawn_isolated_reviewer,
    descriptor.capabilities.reviewer_write_blocked,
    descriptor.capabilities.fingerprint_guard_available
  ];
}

function makeInstallFixture(t) {
  const rawHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-manifest-home-'));
  const homeDir = fs.realpathSync.native(rawHomeDir);
  const platformRoots = {
    claude: path.join(homeDir, '.claude'),
    codex: path.join(homeDir, '.codex'),
    gemini: path.join(homeDir, '.gemini')
  };
  for (const root of Object.values(platformRoots)) fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });
  t.after(() => {
    fs.rmSync(rawHomeDir, { recursive: true, force: true });
  });
  return { homeDir, platformRoots };
}

function makeCommandSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-install-'));
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  const platformRoots = {
    claude: path.join(homeDir, '.claude', 'commands'),
    codexSkills: path.join(homeDir, '.codex', 'skills'),
    codexPrompts: path.join(homeDir, '.codex', 'prompts'),
    gemini: path.join(homeDir, '.gemini', 'commands'),
    opencode: path.join(homeDir, '.config', 'opencode', 'commands')
  };
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  for (const value of Object.values(platformRoots)) fs.mkdirSync(value, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, homeDir, cwd, platformRoots };
}

function makeManifest({ homeDir, platformRoots, platform = 'claude', generated = [], allowedRoots, capabilityMutable = true } = {}) {
  return {
    schemaVersion: 1,
    packageName: '@xenonbyte/drfx',
    packageVersion: PACKAGE_VERSION,
    platform,
    installedAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    installRoot: platformRoots[platform],
    allowedRoots: allowedRoots || [path.join(platformRoots[platform], platform === 'codex' ? 'skills' : 'commands')],
    sharedAssets: {
      path: '~/.drfx/shared',
      checksum: 'none'
    },
    capabilityDescriptor: {
      path: `~/.drfx/capabilities/${platform}.json`,
      mutable: capabilityMutable
    },
    generated,
    backups: [
      {
        originalPath: generated[0] ? generated[0].path : path.join(platformRoots[platform], 'commands', 'review-fix-spec.md'),
        backupPath: `~/.drfx/backups/${platform}/20260520/review-fix-spec`,
        checksum: 'b'.repeat(64)
      }
    ]
  };
}

test('builds descriptor with required schema fields and advisory reason', async () => {
  const runId = createRunId();
  const checkedAt = '2026-05-20T00:00:00.000Z';
  const descriptor = buildDescriptor({
    platform: 'claude',
    packageVersion: PACKAGE_VERSION,
    runId,
    checkedAt,
    adapterCapabilities: await claude.checkCapabilities({ packageVersion: PACKAGE_VERSION, runId }),
    fingerprintGuard: {
      status: 'verified',
      proof: 'node-crypto-stat-probe',
      proofRunId: runId,
      detail: 'Mutation detection was verified against OS temp fixture files.'
    }
  });

  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.packageName, '@xenonbyte/drfx');
  assert.equal(descriptor.packageVersion, PACKAGE_VERSION);
  assert.equal(descriptor.platform, 'claude');
  assert.equal(descriptor.adapterVersion, 'v1');
  assert.equal(descriptor.checkedAt, checkedAt);
  assert.deepEqual(descriptor.provenance, {
    source: 'drfx-doctor-probe',
    runId,
    generatedBy: 'drfx doctor',
    packageVersion: PACKAGE_VERSION
  });
  assert.deepEqual(Object.keys(descriptor.capabilities).sort(), [
    'can_spawn_isolated_reviewer',
    'fingerprint_guard_available',
    'reviewer_write_blocked'
  ]);
  assert.equal(descriptor.capabilities.fingerprint_guard_available.status, 'verified');
  assert.equal(descriptor.capabilities.fingerprint_guard_available.proofRunId, runId);
  assert.match(descriptor.advisoryReason, /reviewer isolation|write blocking|advisory/i);

  const validation = validateCurrentDescriptor(descriptor, { packageVersion: PACKAGE_VERSION, platform: 'claude', runId });
  assert.equal(validation.valid, true);
  assert.equal(validation.passCapable, false);
  assert.equal(validation.trusted, false);
});

test('installer-default descriptor is schema-valid but never trusted as current verified proof', () => {
  const descriptor = readFixture('installer-default.json');
  const validation = validateCurrentDescriptor(descriptor, {
    packageVersion: PACKAGE_VERSION,
    platform: 'claude',
    runId: createRunId(),
    requireVerified: true
  });

  assert.equal(validation.valid, true);
  assert.equal(validation.trusted, false);
  assert.equal(validation.passCapable, false);
  assert.match(validation.errors.join('\n'), /installer-default|not verified/i);
  assert.ok(allRequiredCapabilities(descriptor).every((capability) => capability.status !== 'verified'));
});

test('rejects verified capabilities when proofRunId does not match current run', () => {
  const descriptor = readFixture('stale-verified.json');
  const validation = validateCurrentDescriptor(descriptor, {
    packageVersion: PACKAGE_VERSION,
    platform: 'claude',
    runId: createRunId(),
    requireVerified: true
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.trusted, false);
  assert.equal(validation.passCapable, false);
  assert.match(validation.errors.join('\n'), /proofRunId|current run/i);
});

test('fingerprint guard probe uses only temp fixtures, detects mutation, and cleans up', (t) => {
  const runId = createRunId();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-capability-workspace-'));
  const projectState = path.join(workspace, '.drfx');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-capability-probe-'));
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = runFingerprintGuardProbe({ tmpDir, runId });

  assert.equal(result.capability.status, 'verified');
  assert.equal(result.capability.proof, 'node-crypto-stat-probe');
  assert.equal(result.capability.proofRunId, runId);
  assert.equal(result.mutationDetected, true);
  assert.ok(result.fixtureDir.startsWith(fs.realpathSync.native(tmpDir)));
  assert.ok(result.files.every((filePath) => filePath.startsWith(fs.realpathSync.native(tmpDir))));
  assert.equal(fs.existsSync(projectState), false);
  assert.equal(fs.existsSync(result.fixtureDir), false);
  assert.ok(result.files.every((filePath) => !fs.existsSync(filePath)));
});

test('fingerprint guard probe rejects drfx temp paths before writing fixtures', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-capability-project-'));
  const stateProbeDir = path.join(root, 'project', '.drfx', 'probe');
  fs.mkdirSync(stateProbeDir, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.throws(
    () => runFingerprintGuardProbe({ tmpDir: stateProbeDir, runId: createRunId() }),
    /drfx|project state/i
  );

  assert.deepEqual(fs.readdirSync(stateProbeDir), []);
});

test('fingerprint guard probe rejects missing non-temp tmpDir without creating it', () => {
  const nonTempDir = path.join(process.cwd(), `drfx-non-temp-probe-${createRunId()}`);

  assert.equal(fs.existsSync(nonTempDir), false);
  assert.throws(
    () => runFingerprintGuardProbe({ tmpDir: nonTempDir, runId: createRunId() }),
    /OS temp|temp directory/i
  );
  assert.equal(fs.existsSync(nonTempDir), false);
});

test('validateCurrentDescriptor rejects missing required schema fields', () => {
  const runId = createRunId();
  const descriptor = buildDescriptor({
    platform: 'claude',
    packageVersion: PACKAGE_VERSION,
    runId,
    checkedAt: '2026-05-20T00:00:00.000Z',
    adapterCapabilities: {
      can_spawn_isolated_reviewer: {
        status: 'unverified',
        proof: 'none',
        proofRunId: 'none',
        detail: 'No non-interactive reviewer isolation proof is available.'
      },
      reviewer_write_blocked: {
        status: 'unverified',
        proof: 'none',
        proofRunId: 'none',
        detail: 'Prompt-only read-only instructions are not proof of write blocking.'
      }
    },
    fingerprintGuard: {
      status: 'verified',
      proof: 'node-crypto-stat-probe',
      proofRunId: runId,
      detail: 'Mutation detection was verified against OS temp fixture files.'
    }
  });

  for (const [field, matcher] of [
    ['schemaVersion', /schemaVersion/i],
    ['packageName', /packageName/i],
    ['packageVersion', /packageVersion.*required/i],
    ['platform', /platform/i],
    ['adapterVersion', /adapterVersion/i],
    ['checkedAt', /checkedAt/i],
    ['provenance', /provenance/i],
    ['capabilities', /capabilities/i],
    ['advisoryReason', /advisoryReason/i]
  ]) {
    const missing = clone(descriptor);
    delete missing[field];
    const validation = validateCurrentDescriptor(missing, {
      packageVersion: PACKAGE_VERSION,
      platform: 'claude',
      runId
    });
    assert.equal(validation.valid, false, field);
    assert.match(validation.errors.join('\n'), matcher, field);
  }

  const missingProvenanceVersion = clone(descriptor);
  delete missingProvenanceVersion.provenance.packageVersion;
  const validation = validateCurrentDescriptor(missingProvenanceVersion, {
    packageVersion: PACKAGE_VERSION,
    platform: 'claude',
    runId
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /provenance\.packageVersion.*required/i);

  const numericCheckedAt = clone(descriptor);
  numericCheckedAt.checkedAt = 0;
  const numericCheckedAtValidation = validateCurrentDescriptor(numericCheckedAt, {
    packageVersion: PACKAGE_VERSION,
    platform: 'claude',
    runId
  });
  assert.equal(numericCheckedAtValidation.valid, false);
  assert.equal(numericCheckedAtValidation.trusted, false);
  assert.equal(numericCheckedAtValidation.passCapable, false);
  assert.match(numericCheckedAtValidation.errors.join('\n'), /checkedAt.*ISO-8601 string/i);
});

test('Claude, Codex, and opencode do not claim reviewer proof without non-interactive adapter evidence', async () => {
  for (const [name, adapter] of [['claude', claude], ['codex', codex], ['opencode', opencode]]) {
    const capabilities = await adapter.checkCapabilities({ packageVersion: PACKAGE_VERSION, runId: createRunId() });
    assert.equal(capabilities.can_spawn_isolated_reviewer.status, 'unverified', name);
    assert.equal(capabilities.can_spawn_isolated_reviewer.proof, 'none', name);
    assert.equal(capabilities.can_spawn_isolated_reviewer.proofRunId, 'none', name);
    assert.match(capabilities.can_spawn_isolated_reviewer.detail, /No non-interactive/i, name);
    assert.equal(capabilities.reviewer_write_blocked.status, 'unverified', name);
    assert.equal(capabilities.reviewer_write_blocked.proof, 'none', name);
    assert.equal(capabilities.reviewer_write_blocked.proofRunId, 'none', name);
    assert.match(capabilities.reviewer_write_blocked.detail, /Prompt-only.*not proof/i, name);
  }
});

test('Gemini reports reviewer isolation and write blocking as unsupported advisory-only capabilities', async () => {
  const capabilities = await gemini.checkCapabilities({ packageVersion: PACKAGE_VERSION, runId: createRunId() });

  assert.equal(capabilities.can_spawn_isolated_reviewer.status, 'unsupported');
  assert.equal(capabilities.can_spawn_isolated_reviewer.proof, 'none');
  assert.equal(capabilities.can_spawn_isolated_reviewer.proofRunId, 'none');
  assert.equal(capabilities.can_spawn_isolated_reviewer.detail, 'Gemini v1 route is advisory-only.');
  assert.equal(capabilities.reviewer_write_blocked.status, 'unsupported');
  assert.equal(capabilities.reviewer_write_blocked.proof, 'none');
  assert.equal(capabilities.reviewer_write_blocked.proofRunId, 'none');
  assert.equal(capabilities.reviewer_write_blocked.detail, 'Gemini v1 has no verified write-blocked reviewer adapter.');
});

test('checkPlatformCapabilities does not use manual prompt behavior or fingerprint probe as write-blocking proof', async (t) => {
  const runId = createRunId();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-capability-platform-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const descriptor = await checkPlatformCapabilities({
    platform: 'codex',
    packageVersion: PACKAGE_VERSION,
    runId,
    tmpDir
  });

  assert.equal(descriptor.capabilities.fingerprint_guard_available.status, 'verified');
  assert.equal(descriptor.capabilities.fingerprint_guard_available.proofRunId, runId);
  assert.equal(descriptor.capabilities.reviewer_write_blocked.status, 'unverified');
  assert.equal(descriptor.capabilities.reviewer_write_blocked.proof, 'none');
  assert.equal(descriptor.capabilities.reviewer_write_blocked.proofRunId, 'none');
  assert.doesNotMatch(JSON.stringify(descriptor), /manual|ask the user|prompt the user/i);
});

test('generated-route current-check validation rejects stale descriptors before automatic PASS', async (t) => {
  const stale = readFixture('stale-verified.json');
  const missingRunValidation = validateCurrentDescriptor(stale, {
    packageVersion: PACKAGE_VERSION,
    platform: 'claude',
    requireVerified: true
  });
  assert.equal(missingRunValidation.passCapable, false);
  assert.match(missingRunValidation.errors.join('\n'), /runId/i);

  const staleValidation = validateCurrentDescriptor(stale, {
    packageVersion: PACKAGE_VERSION,
    platform: 'claude',
    runId: createRunId(),
    requireVerified: true
  });
  assert.equal(staleValidation.passCapable, false);
  assert.match(staleValidation.errors.join('\n'), /current run/i);

  const runId = createRunId();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-capability-current-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const descriptors = await checkPlatforms({
    platforms: ['claude', 'codex', 'gemini', 'opencode'],
    packageVersion: PACKAGE_VERSION,
    runId,
    tmpDir
  });
  assert.deepEqual(Object.keys(descriptors).sort(), ['claude', 'codex', 'gemini', 'opencode']);
  for (const [platform, descriptor] of Object.entries(descriptors)) {
    const validation = validateCurrentDescriptor(descriptor, { packageVersion: PACKAGE_VERSION, platform, runId, requireVerified: true });
    assert.equal(validation.passCapable, false, platform);
    assert.equal(validation.trusted, false, platform);
    assert.match(validation.errors.join('\n'), /not verified|unsupported|unverified/i, platform);
  }
});

test('install manifest serializes and parses deterministic YAML subset', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const route = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(route, '# generated command\n');
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    generated: [
      {
        path: route,
        kind: 'file',
        action: 'created',
        checksum: 'a'.repeat(64)
      }
    ]
  });

  const text = serializeManifest(manifest);

  assert.equal(text, serializeManifest(parseManifestText(text)));
  assert.match(text, /^schemaVersion: 1\npackageName: "@xenonbyte\/drfx"\npackageVersion: "0\.1\.1"/);
  assert.deepEqual(parseManifestText(text), manifest);

  const descriptorExtra = text.replace('  mutable: true\n', '  mutable: true\n  checksum: "not-allowed"\n');
  assert.throws(() => parseManifestText(descriptorExtra), /unsupported|unexpected|unknown/i);

  const generatedExtra = text.replace(`    checksum: "${'a'.repeat(64)}"\n`, `    checksum: "${'a'.repeat(64)}"\n    extra: "not-allowed"\n`);
  assert.throws(() => parseManifestText(generatedExtra), /unsupported|unexpected|unknown/i);
});

test('writeInstallManifest and readInstallManifest use platform manifest path and missing reads are idempotent', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const manifestFile = manifestPathForPlatform('codex', { homeDir });
  assert.equal(manifestFile, path.join(homeDir, '.drfx', 'manifests', 'codex.manifest'));

  const routeDir = path.join(platformRoots.codex, 'skills', 'review-fix-plan');
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(path.join(routeDir, '.drfx-owned'), 'owned by @xenonbyte/drfx\n');
  fs.writeFileSync(path.join(routeDir, 'SKILL.md'), '---\nname: review-fix-plan\n---\n');
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    generated: [
      {
        path: routeDir,
        kind: 'directory',
        action: 'created',
        checksum: 'none'
      }
    ]
  });

  writeInstallManifest(manifest, { homeDir });

  assert.deepEqual(readInstallManifest('codex', { homeDir }), { missing: false, manifest });
  assert.deepEqual(readInstallManifest('gemini', { homeDir }), { missing: true, manifest: null });
  assert.deepEqual(validateGeneratedRemoval(readInstallManifest('gemini', { homeDir }), { homeDir, platformRoots }), {
    ok: true,
    missing: true,
    removable: []
  });
});

test('manifest allows only documented home expansion and never expands environment variables', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const sharedPath = path.join(homeDir, '.drfx', 'shared');
  const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', 'claude.json');
  const route = path.join(platformRoots.claude, 'commands', 'review-fix-design.md');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(route, '# generated command\n');

  const manifest = makeManifest({
    homeDir,
    platformRoots,
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }]
  });
  const result = validateGeneratedRemoval(manifest, { homeDir, platformRoots });

  assert.equal(result.sharedAssetsPath, sharedPath);
  assert.equal(result.capabilityDescriptor.path, descriptorPath);
  assert.equal(result.capabilityDescriptor.mutable, true);

  for (const allowedPath of [
    '~/.drfx/shared',
    '~/.drfx/capabilities/claude.json',
    '~/.drfx/backups/claude/20260520/review-fix-spec'
  ]) {
    assert.doesNotThrow(() =>
      validateGeneratedRemoval(
        {
          ...manifest,
          sharedAssets: { path: allowedPath, checksum: 'none' },
          capabilityDescriptor: { path: '~/.drfx/capabilities/claude.json', mutable: true }
        },
        { homeDir, platformRoots }
      )
    );
  }

  assert.throws(
    () => validateGeneratedRemoval({ ...manifest, capabilityDescriptor: { ...manifest.capabilityDescriptor, mutable: false } }, { homeDir, platformRoots }),
    /capabilityDescriptor\.mutable.*true/i
  );

  const envManifest = {
    ...manifest,
    sharedAssets: { path: '$HOME/.drfx/shared', checksum: 'none' }
  };
  assert.throws(() => validateGeneratedRemoval(envManifest, { homeDir, platformRoots }), /environment variable|not expanded/i);

  const undocumentedTilde = {
    ...manifest,
    sharedAssets: { path: '~/unexpected/shared', checksum: 'none' }
  };
  assert.throws(() => validateGeneratedRemoval(undocumentedTilde, { homeDir, platformRoots }), /documented.*home/i);

  const prefixCollision = {
    ...manifest,
    sharedAssets: { path: '~/.drfx/sharedness', checksum: 'none' }
  };
  assert.throws(() => validateGeneratedRemoval(prefixCollision, { homeDir, platformRoots }), /documented.*home/i);
});

test('manifest generated paths must be absolute', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const commandsRoot = path.join(platformRoots.claude, 'commands');
  fs.mkdirSync(commandsRoot, { recursive: true });
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    allowedRoots: [fs.realpathSync.native(commandsRoot)],
    generated: [{ path: 'review-fix-spec.md', kind: 'file', action: 'created', checksum: 'a'.repeat(64) }]
  });

  assert.throws(() => validateGeneratedRemoval(manifest, { homeDir, platformRoots }), /generated.*path.*absolute/i);
});

test('removal validation requires canonical allowed roots and platform route allowlists', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const route = path.join(platformRoots.gemini, 'commands', 'review-fix-doc.toml');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(route, 'description = "generated"\n');
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'gemini',
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'none' }]
  });

  assert.deepEqual(
    validateGeneratedRemoval(manifest, { homeDir, platformRoots }).removable.map((entry) => entry.path),
    [route]
  );
  assert.equal(platformAllowlist('gemini', route, { platformRoots, manifestRecorded: true }), true);

  const relativeAllowedRoot = { ...manifest, allowedRoots: ['.gemini/commands'] };
  assert.throws(() => validateGeneratedRemoval(relativeAllowedRoot, { homeDir, platformRoots }), /allowedRoots.*absolute/i);

  const symlinkRoot = path.join(homeDir, 'linked-gemini-commands');
  fs.symlinkSync(path.join(platformRoots.gemini, 'commands'), symlinkRoot);
  const nonCanonicalAllowedRoot = { ...manifest, allowedRoots: [symlinkRoot] };
  assert.throws(() => validateGeneratedRemoval(nonCanonicalAllowedRoot, { homeDir, platformRoots }), /allowedRoots.*canonical/i);

  const outsideRoot = { ...manifest, generated: [{ ...manifest.generated[0], path: path.join(homeDir, 'review-fix-doc.toml') }] };
  assert.throws(() => validateGeneratedRemoval(outsideRoot, { homeDir, platformRoots }), /outside allowed roots/i);

  const wrongPattern = {
    ...manifest,
    generated: [{ ...manifest.generated[0], path: path.join(platformRoots.gemini, 'commands', 'notes.toml') }]
  };
  fs.writeFileSync(wrongPattern.generated[0].path, 'description = "user"\n');
  assert.throws(() => validateGeneratedRemoval(wrongPattern, { homeDir, platformRoots }), /allowlist/i);
});

test('removal validation refuses manifest-recorded symlinks', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const target = path.join(homeDir, 'target.md');
  const route = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(target, '# target\n');
  fs.symlinkSync(target, route);
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }]
  });

  assert.throws(() => validateGeneratedRemoval(manifest, { homeDir, platformRoots }), /symlink/i);
});

test('missing manifest-recorded generated artifacts are skipped idempotently', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const route = path.join(platformRoots.claude, 'commands', 'review-fix-missing.md');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }]
  });

  const result = validateGeneratedRemoval(manifest, { homeDir, platformRoots });

  assert.deepEqual(result.removable, []);
  assert.deepEqual(result.skipped, [{ path: route, kind: 'file', removable: false, reason: 'missing' }]);
});

test('missing Codex generated skill file is skipped when parent skill directory is missing', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const route = path.join(platformRoots.codex, 'skills', 'review-fix-spec', 'SKILL.md');
  fs.mkdirSync(path.join(platformRoots.codex, 'skills'), { recursive: true });
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    allowedRoots: [path.join(platformRoots.codex, 'skills')],
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }]
  });

  const result = validateGeneratedRemoval(manifest, { homeDir, platformRoots });

  assert.deepEqual(result.removable, []);
  assert.deepEqual(result.skipped, [{ path: route, kind: 'file', removable: false, reason: 'missing' }]);
});

test('manifest validation rejects missing required install fields', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const route = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(route, '# generated command\n');
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }]
  });

  for (const [label, mutate, matcher] of [
    ['installRoot', (copy) => delete copy.installRoot, /installRoot.*required/i],
    ['sharedAssets.path', (copy) => delete copy.sharedAssets.path, /sharedAssets\.path.*required/i],
    ['sharedAssets.checksum', (copy) => delete copy.sharedAssets.checksum, /sharedAssets\.checksum.*required/i],
    ['capabilityDescriptor.path', (copy) => delete copy.capabilityDescriptor.path, /capabilityDescriptor\.path.*required/i],
    ['capabilityDescriptor.mutable', (copy) => delete copy.capabilityDescriptor.mutable, /capabilityDescriptor\.mutable.*true|required/i],
    ['generated.path', (copy) => delete copy.generated[0].path, /generated.*path.*required/i],
    ['generated.kind', (copy) => delete copy.generated[0].kind, /generated.*kind/i],
    ['generated.action', (copy) => delete copy.generated[0].action, /generated.*action/i],
    ['generated.checksum', (copy) => delete copy.generated[0].checksum, /generated.*checksum.*required/i],
    ['backups.originalPath', (copy) => delete copy.backups[0].originalPath, /backups.*originalPath.*required/i],
    ['backups.backupPath', (copy) => delete copy.backups[0].backupPath, /backups.*backupPath.*required/i],
    ['backups.checksum', (copy) => delete copy.backups[0].checksum, /backups.*checksum.*required/i]
  ]) {
    const copy = clone(manifest);
    mutate(copy);
    assert.throws(() => validateGeneratedRemoval(copy, { homeDir, platformRoots }), matcher, label);
  }
});

test('Codex skill directory removal requires ownership marker', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const ownedRoute = path.join(platformRoots.codex, 'skills', 'review-fix-spec');
  fs.mkdirSync(ownedRoute, { recursive: true });
  fs.writeFileSync(path.join(ownedRoute, '.drfx-owned'), 'owned by @xenonbyte/drfx\n');
  fs.writeFileSync(path.join(ownedRoute, 'SKILL.md'), '---\nname: review-fix-spec\n---\n');
  const ownedManifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    generated: [{ path: ownedRoute, kind: 'directory', action: 'created', checksum: 'none' }]
  });
  assert.deepEqual(validateGeneratedRemoval(ownedManifest, { homeDir, platformRoots }).removable[0].path, ownedRoute);

  const nonOwnedRoute = path.join(platformRoots.codex, 'skills', 'review-fix-plan');
  fs.mkdirSync(nonOwnedRoute, { recursive: true });
  fs.writeFileSync(path.join(nonOwnedRoute, 'SKILL.md'), 'user skill\n');
  const nonOwnedManifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    generated: [{ path: nonOwnedRoute, kind: 'directory', action: 'created', checksum: 'none' }]
  });
  assert.throws(() => validateGeneratedRemoval(nonOwnedManifest, { homeDir, platformRoots }), /ownership marker|non-owned/i);

  const completeRoute = path.join(platformRoots.codex, 'skills', 'review-fix-design');
  fs.mkdirSync(completeRoute, { recursive: true });
  fs.writeFileSync(path.join(completeRoute, 'SKILL.md'), 'generated skill\n');
  const completeManifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    generated: [
      { path: completeRoute, kind: 'directory', action: 'created', checksum: 'none' },
      { path: path.join(completeRoute, 'SKILL.md'), kind: 'file', action: 'created', checksum: 'none' }
    ]
  });
  assert.throws(() => validateGeneratedRemoval(completeManifest, { homeDir, platformRoots }), /ownership marker|non-owned/i);

  const nonOwnedFileRoute = path.join(platformRoots.codex, 'skills', 'review-fix-doc');
  fs.mkdirSync(nonOwnedFileRoute, { recursive: true });
  fs.writeFileSync(path.join(nonOwnedFileRoute, 'SKILL.md'), 'user skill\n');
  const nonOwnedFileManifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    allowedRoots: [path.join(platformRoots.codex, 'skills')],
    generated: [
      {
        path: path.join(nonOwnedFileRoute, 'SKILL.md'),
        kind: 'file',
        action: 'created',
        checksum: 'none'
      }
    ]
  });
  assert.throws(() => validateGeneratedRemoval(nonOwnedFileManifest, { homeDir, platformRoots }), /ownership marker|non-owned/i);
});

test('Codex legacy prompt routes are removable only when manifest-recorded or ownership-marked', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const manifestRecordedPrompt = path.join(platformRoots.codex, 'prompts', 'review-fix-spec.md');
  fs.mkdirSync(path.dirname(manifestRecordedPrompt), { recursive: true });
  fs.writeFileSync(manifestRecordedPrompt, '# legacy generated prompt\n');
  const manifest = makeManifest({
    homeDir,
    platformRoots,
    platform: 'codex',
    allowedRoots: [path.join(platformRoots.codex, 'prompts')],
    generated: [{ path: manifestRecordedPrompt, kind: 'file', action: 'created', checksum: 'none' }]
  });

  assert.deepEqual(validateGeneratedRemoval(manifest, { homeDir, platformRoots }).removable[0].path, manifestRecordedPrompt);
  assert.equal(platformAllowlist('codex', manifestRecordedPrompt, { platformRoots, manifestRecorded: true }), true);

  const unrecordedPrompt = path.join(platformRoots.codex, 'prompts', 'review-fix-plan.md');
  fs.writeFileSync(unrecordedPrompt, '# user prompt\n');
  assert.equal(platformAllowlist('codex', unrecordedPrompt, { platformRoots, manifestRecorded: false }), false);
  assert.equal(platformAllowlist('codex', unrecordedPrompt, { platformRoots, manifestRecorded: false, ownershipMarked: true }), true);
});

test('parsePlatformList accepts comma-separated platform lists', () => {
  assert.deepEqual(parsePlatformList('claude,codex,gemini,opencode'), ['claude', 'codex', 'gemini', 'opencode']);
});

test('install writes manifests and installer-default descriptors into isolated home', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);

  const result = await installPlatforms({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: parsePlatformList('claude,codex,gemini,opencode')
  });

  assert.deepEqual(Object.keys(result.platforms).sort(), ['claude', 'codex', 'gemini', 'opencode']);
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const manifestRead = readInstallManifest(platform, { homeDir });
    assert.equal(manifestRead.missing, false, platform);
    assert.equal(manifestRead.manifest.platform, platform);
    assert.ok(manifestRead.manifest.generated.length > 0, platform);

    const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', `${platform}.json`);
    assert.equal(fs.existsSync(descriptorPath), true, platform);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.equal(descriptor.provenance.source, 'installer-default', platform);
    assert.equal(descriptor.provenance.generatedBy, 'drfx install', platform);
    assert.ok(allRequiredCapabilities(descriptor).every((capability) => capability.status !== 'verified'), platform);
    const validation = validateCurrentDescriptor(descriptor, {
      packageVersion: PACKAGE_VERSION,
      platform,
      runId: createRunId(),
      requireVerified: true
    });
    assert.equal(validation.trusted, false, platform);
    assert.equal(validation.passCapable, false, platform);
  }

  assert.equal(fs.existsSync(path.join(platformRoots.claude, 'review-fix-spec.md')), true);
  const codexSpecDir = path.join(platformRoots.codexSkills, 'review-fix-spec');
  assert.equal(fs.existsSync(path.join(codexSpecDir, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(codexSpecDir, '.drfx-owned')), true);
  assert.equal(fs.existsSync(path.join(codexSpecDir, 'shared', '.drfx-owned')), true);
  assert.equal(fs.existsSync(path.join(codexSpecDir, 'shared', 'core.md')), true);
  assert.match(fs.readFileSync(path.join(codexSpecDir, 'SKILL.md'), 'utf8'), /fail closed/i);
  for (const routeName of [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
    'review-fix-pr',
    'review-fix-code',
    'review-fix-r2p'
  ]) {
    const policyPath = path.join(platformRoots.codexSkills, routeName, 'agents', 'openai.yaml');
    assert.equal(fs.existsSync(policyPath), true, `${routeName} Codex policy metadata must be installed`);
    assert.equal(
      fs.readFileSync(policyPath, 'utf8'),
      'policy:\n  allow_implicit_invocation: false\n',
      `${routeName} Codex policy metadata must disable implicit invocation`
    );
  }
  assert.equal(fs.existsSync(path.join(platformRoots.gemini, 'review-fix-spec.toml')), true);
  assert.equal(fs.existsSync(path.join(platformRoots.opencode, 'review-fix-spec.md')), true);
});

test('install copies all shared package assets for regeneration', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);

  await installPlatform('claude', {
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION
  });

  for (const relativePath of [
    'core.md',
    'long-task.md',
    path.join('prompts', 'coordinator.md'),
    path.join('prompts', 'fixer.md'),
    path.join('prompts', 'reviewer.md'),
    path.join('rubrics', 'common.md'),
    path.join('rubrics', 'spec.md'),
    path.join('rubrics', 'plan.md'),
    path.join('rubrics', 'design.md')
  ]) {
    assert.equal(fs.existsSync(path.join(homeDir, '.drfx', 'shared', relativePath)), true, relativePath);
  }
});

test('install refuses symlinked shared asset destinations', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const outside = path.join(homeDir, 'outside-core.md');
  const sharedDir = path.join(homeDir, '.drfx', 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(outside, '# outside\n');
  fs.symlinkSync(outside, path.join(sharedDir, 'core.md'));

  await assert.rejects(
    () =>
      installPlatform('claude', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION
      }),
    (error) => error && error.code === 'ERR_SHARED_ASSET_TARGET_KIND'
  );

  assert.equal(fs.readFileSync(outside, 'utf8'), '# outside\n');
  assert.equal(readInstallManifest('claude', { homeDir }).missing, true);
});

test('install rolls shared assets back when a later generated write fails', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const sharedCore = path.join(homeDir, '.drfx', 'shared', 'core.md');
  fs.mkdirSync(path.dirname(sharedCore), { recursive: true });
  fs.writeFileSync(sharedCore, '# user shared core\n');

  await assert.rejects(
    () =>
      installPlatform('codex', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION,
        _onBeforeReplaceGeneratedDirectory: () => {
          throw new Error('simulated generated directory write failure');
        }
      }),
    /simulated generated directory write failure/
  );

  assert.equal(fs.readFileSync(sharedCore, 'utf8'), '# user shared core\n');
  assert.equal(readInstallManifest('codex', { homeDir }).missing, true);
});

test('install backs up existing Claude and Gemini files and records overwritten action', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const claudeRoute = path.join(platformRoots.claude, 'review-fix-spec.md');
  const geminiRoute = path.join(platformRoots.gemini, 'review-fix-spec.toml');
  fs.writeFileSync(claudeRoute, '# user claude command\n');
  fs.writeFileSync(geminiRoute, 'description = "user gemini command"\n');

  await installPlatforms({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude', 'gemini']
  });

  for (const [platform, route, original] of [
    ['claude', claudeRoute, '# user claude command\n'],
    ['gemini', geminiRoute, 'description = "user gemini command"\n']
  ]) {
    const manifest = readInstallManifest(platform, { homeDir }).manifest;
    const generated = manifest.generated.find((entry) => entry.path === route);
    assert.equal(generated.action, 'overwritten', platform);
    const backup = manifest.backups.find((entry) => entry.originalPath === route);
    assert.ok(backup, platform);
    assert.equal(fs.readFileSync(backup.backupPath, 'utf8'), original, platform);
    assert.notEqual(fs.readFileSync(route, 'utf8'), original, platform);
  }
});

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('install uninstalls the previous install first so routes dropped from the new plan are not orphaned', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['claude'] });
  const realRoute = path.join(platformRoots.claude, 'review-fix-spec.md');
  assert.equal(fs.existsSync(realRoute), true);

  // Simulate a route a previous version installed but the current plan no longer emits: a real,
  // package-owned file recorded in the manifest with a matching checksum.
  const staleRoute = path.join(platformRoots.claude, 'review-fix-legacy.md');
  fs.writeFileSync(staleRoute, '# legacy generated route\n');
  const manifest = readInstallManifest('claude', { homeDir }).manifest;
  manifest.generated.push({ path: staleRoute, kind: 'file', action: 'created', checksum: sha256OfFile(staleRoute) });
  writeInstallManifest(manifest, { homeDir });

  // Reinstall must remove the stale route (uninstall-first) and keep the real route set.
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['claude'] });

  assert.equal(fs.existsSync(staleRoute), false, 'stale route removed on reinstall');
  assert.equal(fs.existsSync(realRoute), true, 'real route reinstalled');
  const after = readInstallManifest('claude', { homeDir }).manifest;
  assert.equal(after.generated.some((entry) => entry.path === staleRoute), false, 'stale route dropped from new manifest');
  assert.ok(after.generated.some((entry) => entry.path === realRoute), 'real route recorded in new manifest');
});

test('install preserves a user-modified out-of-plan route instead of deleting it on reinstall', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['claude'] });

  const staleRoute = path.join(platformRoots.claude, 'review-fix-legacy.md');
  fs.writeFileSync(staleRoute, '# legacy generated route\n');
  const manifest = readInstallManifest('claude', { homeDir }).manifest;
  manifest.generated.push({ path: staleRoute, kind: 'file', action: 'created', checksum: sha256OfFile(staleRoute) });
  writeInstallManifest(manifest, { homeDir });
  // The user edits the recorded route, so its checksum no longer matches the manifest.
  fs.writeFileSync(staleRoute, '# user-edited legacy route\n');

  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['claude'] });

  assert.equal(fs.existsSync(staleRoute), true, 'user-modified out-of-plan route preserved');
  assert.equal(fs.readFileSync(staleRoute, 'utf8'), '# user-edited legacy route\n', 'user edit retained');
});

test('install preflights the new plan before uninstalling the previous install', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['codex'] });

  const oldRoute = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const blockedRoute = path.join(platformRoots.codexSkills, 'review-fix-r2p');
  assert.equal(fs.existsSync(path.join(oldRoute, 'SKILL.md')), true, 'old install should exist before reinstall');
  assert.equal(fs.existsSync(blockedRoute), true, 'current generated route should exist before simulating an older install');

  const manifest = readInstallManifest('codex', { homeDir }).manifest;
  manifest.generated = manifest.generated.filter((entry) => entry.path !== blockedRoute);
  writeInstallManifest(manifest, { homeDir });
  fs.rmSync(blockedRoute, { recursive: true, force: true });
  fs.mkdirSync(blockedRoute, { recursive: true });
  fs.writeFileSync(path.join(blockedRoute, 'SKILL.md'), '# user-owned skill\n');

  await assert.rejects(
    () =>
      installPlatforms({
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION,
        platforms: ['codex']
      }),
    /ownership|non-owned/i
  );

  assert.equal(fs.existsSync(path.join(oldRoute, 'SKILL.md')), true, 'old installed route must survive failed preflight');
  assert.equal(readInstallManifest('codex', { homeDir }).missing, false, 'old manifest must survive failed preflight');
  assert.equal(fs.readFileSync(path.join(blockedRoute, 'SKILL.md'), 'utf8'), '# user-owned skill\n');
});

test('install restores the previous install when reinstall fails after uninstall', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['codex'] });

  const oldRoute = path.join(platformRoots.codexSkills, 'review-fix-spec');
  const oldRouteSkill = path.join(oldRoute, 'SKILL.md');
  const manifestPath = manifestPathForPlatform('codex', { homeDir });
  const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', 'codex.json');
  const beforeManifest = fs.readFileSync(manifestPath, 'utf8');
  const beforeDescriptor = fs.readFileSync(descriptorPath, 'utf8');
  const beforeSkill = fs.readFileSync(oldRouteSkill, 'utf8');
  let failed = false;

  await assert.rejects(
    () =>
      installPlatforms({
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION,
        platforms: ['codex'],
        _onBeforeReplaceGeneratedDirectory: () => {
          if (!failed) {
            failed = true;
            throw new Error('simulated generated directory write failure');
          }
        }
      }),
    /simulated generated directory write failure/
  );

  assert.equal(fs.readFileSync(oldRouteSkill, 'utf8'), beforeSkill, 'previous route restored');
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), beforeManifest, 'previous manifest restored');
  assert.equal(fs.readFileSync(descriptorPath, 'utf8'), beforeDescriptor, 'previous descriptor restored');
});

test('a successful reinstall leaves no orphaned uninstall-rollback backups', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['codex'] });
  await installPlatforms({ homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION, platforms: ['codex'] });

  const backupsDir = path.join(homeDir, '.drfx', 'backups', 'codex');
  const leftover = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
  assert.deepEqual(leftover, [], 'reinstall discards its safety backups on success');
});

test('install refuses symlink targets', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const target = path.join(homeDir, 'user-command.md');
  const route = path.join(platformRoots.claude, 'review-fix-spec.md');
  fs.writeFileSync(target, '# user target\n');
  fs.symlinkSync(target, route);

  await assert.rejects(
    () =>
      installPlatform('claude', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION
      }),
    /symlink/i
  );
});

test('install refuses non-owned Codex skill directories', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.codexSkills, 'review-fix-plan');
  fs.mkdirSync(route, { recursive: true });
  fs.writeFileSync(path.join(route, 'SKILL.md'), '# user skill\n');

  await assert.rejects(
    () =>
      installPlatform('codex', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION
      }),
    /ownership|non-owned/i
  );
});

test('uninstall missing manifest is idempotent', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);

  const result = await uninstallPlatforms({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude', 'codex', 'gemini']
  });

  assert.equal(result.platforms.claude.missing, true);
  assert.equal(result.platforms.codex.missing, true);
  assert.equal(result.platforms.gemini.missing, true);
});

test('Codex uninstall removes ownership-marked legacy prompts not recorded in manifest', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);

  await installPlatform('codex', {
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION
  });

  const ownedLegacyPrompt = path.join(platformRoots.codexPrompts, 'review-fix-spec.md');
  const userLegacyPrompt = path.join(platformRoots.codexPrompts, 'review-fix-plan.md');
  fs.writeFileSync(ownedLegacyPrompt, '# legacy prompt\nGenerated by `@xenonbyte/drfx` 0.1.0.\n');
  fs.writeFileSync(userLegacyPrompt, '# user prompt\nNotes about @xenonbyte/drfx, but not generated by it.\n');

  const result = await uninstallPlatform('codex', {
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION
  });

  assert.equal(fs.existsSync(ownedLegacyPrompt), false);
  assert.equal(fs.existsSync(userLegacyPrompt), true);
  assert.ok(result.removed.includes(ownedLegacyPrompt));
});

test('uninstall refuses paths outside allowed roots', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const outsideRoute = path.join(homeDir, 'outside', 'review-fix-spec.md');
  fs.mkdirSync(path.dirname(outsideRoute), { recursive: true });
  fs.writeFileSync(outsideRoute, '# outside generated\n');
  writeInstallManifest(
    makeManifest({
      homeDir,
      platformRoots: { claude: path.dirname(platformRoots.claude), codex: path.dirname(platformRoots.codexSkills), gemini: path.dirname(platformRoots.gemini) },
      generated: [{ path: outsideRoute, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }],
      allowedRoots: [fs.realpathSync.native(platformRoots.claude)]
    }),
    { homeDir }
  );

  await assert.rejects(
    () =>
      uninstallPlatform('claude', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION
      }),
    /outside allowed roots/i
  );
});

test('uninstall validates unsafe capability descriptor before deleting routes', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.claude, 'review-fix-spec.md');
  const descriptorTarget = path.join(homeDir, 'descriptor-target.json');
  const descriptorSymlink = path.join(homeDir, '.drfx', 'capabilities', 'claude.json');
  fs.writeFileSync(route, '# generated command\n');
  fs.writeFileSync(descriptorTarget, '{}\n');
  fs.mkdirSync(path.dirname(descriptorSymlink), { recursive: true });
  fs.symlinkSync(descriptorTarget, descriptorSymlink);

  writeInstallManifest(
    makeManifest({
      homeDir,
      platformRoots: { claude: path.dirname(platformRoots.claude), codex: path.dirname(platformRoots.codexSkills), gemini: path.dirname(platformRoots.gemini) },
      generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }],
      allowedRoots: [fs.realpathSync.native(platformRoots.claude)]
    }),
    { homeDir }
  );

  await assert.rejects(
    () =>
      uninstallPlatform('claude', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION
      }),
    /capability descriptor|symlink|unsafe/i
  );

  assert.equal(fs.existsSync(route), true);
  assert.equal(fs.lstatSync(descriptorSymlink).isSymbolicLink(), true);
  assert.equal(readInstallManifest('claude', { homeDir }).missing, false);
});

test('uninstall rejects a manifest descriptor outside the exact current-platform path before deleting routes', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.claude, 'review-fix-spec.md');
  const victim = path.join(homeDir, 'keep-me.json');
  fs.writeFileSync(route, '# generated command\n');
  fs.writeFileSync(victim, '{"user":true}\n');

  const manifest = makeManifest({
    homeDir,
    platformRoots: {
      claude: path.dirname(platformRoots.claude),
      codex: path.dirname(platformRoots.codexSkills),
      gemini: path.dirname(platformRoots.gemini)
    },
    generated: [{ path: route, kind: 'file', action: 'created', checksum: 'a'.repeat(64) }],
    allowedRoots: [fs.realpathSync.native(platformRoots.claude)]
  });
  manifest.capabilityDescriptor.path = victim;
  writeInstallManifest(manifest, { homeDir });

  await assert.rejects(
    () => uninstallPlatform('claude', { homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION }),
    /capability descriptor.*exact|current platform|canonical/i
  );

  assert.equal(fs.readFileSync(victim, 'utf8'), '{"user":true}\n');
  assert.equal(fs.existsSync(route), true);
  assert.equal(readInstallManifest('claude', { homeDir }).missing, false);
});

test('uninstall binds a manifest platform to the requested platform before deleting artifacts', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.codexPrompts, 'review-fix-spec.md');
  const descriptor = path.join(homeDir, '.drfx', 'capabilities', 'codex.json');
  const routeContent = '# codex generated prompt\n';
  fs.writeFileSync(route, routeContent);
  fs.mkdirSync(path.dirname(descriptor), { recursive: true });
  fs.writeFileSync(descriptor, '{"platform":"codex"}\n');

  const manifestRoots = {
    claude: path.dirname(platformRoots.claude),
    codex: path.dirname(platformRoots.codexSkills),
    gemini: path.dirname(platformRoots.gemini)
  };
  const tampered = makeManifest({
    homeDir,
    platformRoots: manifestRoots,
    platform: 'codex',
    generated: [{
      path: route,
      kind: 'file',
      action: 'created',
      checksum: crypto.createHash('sha256').update(routeContent).digest('hex')
    }],
    allowedRoots: [fs.realpathSync.native(path.dirname(platformRoots.codexPrompts))]
  });
  const claudeManifestPath = manifestPathForPlatform('claude', { homeDir });
  fs.mkdirSync(path.dirname(claudeManifestPath), { recursive: true });
  fs.writeFileSync(claudeManifestPath, serializeManifest(tampered));

  await assert.rejects(
    () => uninstallPlatform('claude', { homeDir, platformRoots, cwd, packageVersion: PACKAGE_VERSION }),
    /manifest platform|requested platform|platform mismatch/i
  );

  assert.equal(fs.readFileSync(route, 'utf8'), routeContent);
  assert.equal(fs.readFileSync(descriptor, 'utf8'), '{"platform":"codex"}\n');
  assert.equal(fs.existsSync(claudeManifestPath), true);
});

test('removal validation rejects descriptor traversal, cross-platform names, and symlinked parent chains', (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  const manifest = makeManifest({ homeDir, platformRoots, platform: 'claude' });

  for (const descriptorPath of [
    'relative-descriptor.json',
    '~/.drfx/capabilities/../victim.json',
    '~/.drfx/capabilities/codex.json'
  ]) {
    assert.throws(
      () => validateGeneratedRemoval({
        ...manifest,
        capabilityDescriptor: { path: descriptorPath, mutable: true }
      }, { homeDir, platformRoots }),
      /capability descriptor.*exact|current platform|canonical/i,
      descriptorPath
    );
  }

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-descriptor-parent-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const capabilities = path.join(homeDir, '.drfx', 'capabilities');
  fs.rmSync(capabilities, { recursive: true, force: true });
  fs.symlinkSync(outside, capabilities);
  assert.throws(
    () => validateGeneratedRemoval(manifest, { homeDir, platformRoots }),
    /capability descriptor.*canonical|parent/i
  );
});

test('uninstall preserves RULE.md, preferences.md, and project .drfx', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const userState = path.join(homeDir, '.drfx');
  const projectState = path.join(cwd, '.drfx');
  fs.mkdirSync(userState, { recursive: true });
  fs.mkdirSync(projectState, { recursive: true });
  fs.writeFileSync(path.join(userState, 'RULE.md'), '# User rules\n');
  fs.writeFileSync(path.join(userState, 'preferences.md'), '# User preferences\n');
  fs.writeFileSync(path.join(projectState, 'ISSUES.md'), '| id | status |\n');

  await installPlatforms({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude', 'codex', 'gemini']
  });
  await uninstallPlatforms({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude', 'codex', 'gemini']
  });

  assert.equal(fs.readFileSync(path.join(userState, 'RULE.md'), 'utf8'), '# User rules\n');
  assert.equal(fs.readFileSync(path.join(userState, 'preferences.md'), 'utf8'), '# User preferences\n');
  assert.equal(fs.readFileSync(path.join(projectState, 'ISSUES.md'), 'utf8'), '| id | status |\n');
  assert.equal(fs.existsSync(path.join(platformRoots.claude, 'review-fix-spec.md')), false);
  assert.equal(fs.existsSync(path.join(platformRoots.codexSkills, 'review-fix-spec')), false);
});

test('failed Codex skill directory overwrite preserves old owned directory and does not write manifest', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.codexSkills, 'review-fix-spec');
  fs.mkdirSync(route, { recursive: true });
  fs.writeFileSync(path.join(route, '.drfx-owned'), 'owned by @xenonbyte/drfx\n');
  fs.writeFileSync(path.join(route, 'SKILL.md'), '# original owned skill\n');
  fs.writeFileSync(path.join(route, 'user-note.md'), 'preserve this backup source\n');

  await assert.rejects(
    () =>
      installPlatform('codex', {
        homeDir,
        platformRoots,
        cwd,
        packageVersion: PACKAGE_VERSION,
        _onBeforeReplaceGeneratedDirectory({ targetPath }) {
          if (targetPath === route) throw new Error('injected codex write failure');
        }
      }),
    /injected codex write failure/i
  );

  assert.equal(fs.readFileSync(path.join(route, 'SKILL.md'), 'utf8'), '# original owned skill\n');
  assert.equal(fs.readFileSync(path.join(route, 'user-note.md'), 'utf8'), 'preserve this backup source\n');
  assert.equal(readInstallManifest('codex', { homeDir }).missing, true);
});

test('post-swap Codex directory failure restores the displaced original directory', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.codexSkills, 'review-fix-spec');
  fs.mkdirSync(route, { recursive: true });
  fs.writeFileSync(path.join(route, '.drfx-owned'), 'owned by @xenonbyte/drfx\n');
  fs.writeFileSync(path.join(route, 'SKILL.md'), '# original owned skill\n');
  fs.writeFileSync(path.join(route, 'user-note.md'), 'preserve after swap failure\n');

  await assert.rejects(
    () => installPlatform('codex', {
      homeDir,
      platformRoots,
      cwd,
      packageVersion: PACKAGE_VERSION,
      _onAfterReplaceGeneratedDirectory({ targetPath }) {
        if (targetPath === route) throw new Error('injected post-swap cleanup failure');
      }
    }),
    /post-swap cleanup failure/i
  );

  assert.equal(fs.readFileSync(path.join(route, 'SKILL.md'), 'utf8'), '# original owned skill\n');
  assert.equal(fs.readFileSync(path.join(route, 'user-note.md'), 'utf8'), 'preserve after swap failure\n');
  assert.equal(readInstallManifest('codex', { homeDir }).missing, true);
});

test('displaced Codex directory cleanup failure is non-fatal after a successful swap', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const route = path.join(platformRoots.codexSkills, 'review-fix-spec');
  fs.mkdirSync(route, { recursive: true });
  fs.writeFileSync(path.join(route, '.drfx-owned'), 'owned by @xenonbyte/drfx\n');
  fs.writeFileSync(path.join(route, 'SKILL.md'), '# original owned skill\n');
  fs.writeFileSync(path.join(route, 'user-note.md'), 'old displaced content\n');
  let cleanupAttempted = false;

  const result = await installPlatform('codex', {
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    _removeReplacedGeneratedDirectory({ targetPath }) {
      if (targetPath !== route) return;
      cleanupAttempted = true;
      throw new Error('injected displaced cleanup failure');
    }
  });

  assert.equal(cleanupAttempted, true);
  assert.equal(result.cleanupResidues.length, 1);
  assert.equal(fs.existsSync(result.cleanupResidues[0].path), true);
  assert.notEqual(fs.readFileSync(path.join(route, 'SKILL.md'), 'utf8'), '# original owned skill\n');
  assert.equal(fs.existsSync(path.join(route, 'user-note.md')), false);
  assert.equal(readInstallManifest('codex', { homeDir }).missing, false);
});

test('fresh install failure restores an existing doctor capability descriptor', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', 'claude.json');
  const original = '{"source":"drfx doctor","status":"unverified"}\n';
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, original, { mode: 0o640 });

  await assert.rejects(
    () => installPlatform('claude', {
      homeDir,
      platformRoots,
      cwd,
      packageVersion: PACKAGE_VERSION,
      _onBeforeWriteInstallManifest() {
        throw new Error('injected manifest write failure');
      }
    }),
    /manifest write failure/i
  );

  assert.equal(fs.readFileSync(descriptorPath, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o640);
  assert.equal(readInstallManifest('claude', { homeDir }).missing, true);
});

test('check reruns current probes and reports advisory reason', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  fs.mkdirSync(path.join(homeDir, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.drfx', 'rules', 'COMMON.md'), '# User rules\n');
  fs.writeFileSync(path.join(homeDir, '.drfx', 'rules', 'CHECKLIST.md'), '# User checklist\n');
  fs.writeFileSync(path.join(homeDir, '.drfx', 'RULE.md'), '# Stale user rules\n');
  fs.mkdirSync(path.join(cwd, '.drfx', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.drfx', 'rules', 'SPEC.md'), '# Project rules\n');
  fs.writeFileSync(path.join(cwd, '.drfx', 'RULE.md'), '# Stale project rules\n');

  const result = await runCheck({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude', 'codex', 'gemini']
  });
  const report = formatCheckReport(result);

  assert.equal(result.userRules.present, true);
  assert.equal(result.userRules.staleRulePresent, true);
  assert.equal(result.userRules.staleRulePath, path.join(homeDir, '.drfx', 'RULE.md'));
  assert.equal(result.projectRules.present, true);
  assert.equal(result.projectRules.staleRulePresent, true);
  assert.equal(result.projectRules.staleRulePath, path.join(cwd, '.drfx', 'RULE.md'));
  assert.equal(result.projectState.present, true);
  assert.equal(result.ruleWarnings.length, 1);
  assert.match(result.ruleWarnings[0].message, /Unknown custom rule file/i);
  assert.match(report, /^warn: Unknown custom rule file:/m);
  assert.match(report, /Advisory-only/i);
  assert.match(report, /user rules: present; stale RULE\.md present/i);
  assert.match(report, /project rules: present; stale RULE\.md present/i);
  assert.match(report, /project state: present/i);

  for (const platform of ['claude', 'codex', 'gemini']) {
    const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', `${platform}.json`);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
    assert.equal(descriptor.provenance.source, 'drfx-doctor-probe', platform);
    assert.equal(descriptor.provenance.runId, result.runId, platform);
    const validation = validateCurrentDescriptor(descriptor, {
      packageVersion: PACKAGE_VERSION,
      platform,
      runId: result.runId,
      requireVerified: true
    });
    assert.equal(validation.passCapable, false, platform);
    assert.match(validation.errors.join('\n'), /not verified|unsupported|unverified/i, platform);
  }
});

test('runCheck json mode returns current-run descriptor metadata', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const result = await runCheck({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude', 'codex', 'gemini'],
    json: true
  });

  assert.equal(typeof result.runId, 'string');
  assert.ok(result.runId.length > 0);
  assert.equal(path.basename(result.descriptorDirectory).startsWith('drfx-doctor-'), true);

  for (const platform of ['claude', 'codex', 'gemini']) {
    const report = result.platforms[platform];
    assert.equal(path.basename(report.descriptorPath), `${platform}.json`);
    assert.equal(path.dirname(report.descriptorPath), result.descriptorDirectory);
    assert.equal(report.descriptor.provenance.runId, result.runId);
    assert.equal(report.validation.passCapable, false);
  }
});

test('sweepStaleDoctorTempDirs removes only stale drfx-doctor dirs and preserves active dirs', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-sweep-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);

  // Stale descriptor temp dirs (with content) left by prior --json doctor runs.
  const staleA = path.join(tmpDir, 'drfx-doctor-aaaaaa');
  const staleB = path.join(tmpDir, 'drfx-doctor-bbbbbb');
  fs.mkdirSync(staleA);
  fs.mkdirSync(staleB);
  fs.writeFileSync(path.join(staleA, 'claude.json'), '{}');
  fs.utimesSync(staleA, staleTime, staleTime);
  fs.utimesSync(staleB, staleTime, staleTime);

  // A recent descriptor temp dir may belong to another active strict proof flow.
  const active = path.join(tmpDir, 'drfx-doctor-active');
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, 'codex.json'), '{}');

  // Unrelated siblings that must survive the sweep.
  const otherDir = path.join(tmpDir, 'drfx-capability-probe-keep');
  fs.mkdirSync(otherDir);
  const namesakeFile = path.join(tmpDir, 'drfx-doctor-not-a-dir');
  fs.writeFileSync(namesakeFile, 'a regular file, not a temp dir');

  sweepStaleDoctorTempDirs(tmpDir);

  assert.equal(fs.existsSync(staleA), false);
  assert.equal(fs.existsSync(staleB), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(otherDir), true);
  assert.equal(fs.existsSync(namesakeFile), true);
});

test('sweepStaleDoctorTempDirs is a no-op on a missing tmpDir', () => {
  const missing = path.join(os.tmpdir(), `drfx-sweep-missing-${process.pid}-${Date.now()}`);
  assert.doesNotThrow(() => sweepStaleDoctorTempDirs(missing));
});

test('runCheck json mode sweeps stale descriptor dirs without deleting active proof dirs', async (t) => {
  const { homeDir, cwd, platformRoots } = makeCommandSandbox(t);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-doctor-tmp-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const stale = path.join(tmpDir, 'drfx-doctor-stale-run');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'claude.json'), '{}');
  fs.utimesSync(stale, staleTime, staleTime);

  const active = path.join(tmpDir, 'drfx-doctor-active-run');
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, 'codex.json'), '{}');

  const result = await runCheck({
    homeDir,
    platformRoots,
    cwd,
    packageVersion: PACKAGE_VERSION,
    platforms: ['claude'],
    json: true,
    tmpDir
  });

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(path.dirname(result.descriptorDirectory), tmpDir);
  assert.equal(path.basename(result.descriptorDirectory).startsWith('drfx-doctor-'), true);
  assert.notEqual(result.descriptorDirectory, stale);
  assert.notEqual(result.descriptorDirectory, active);
});

test('generator exposes fixed route to document type mapping', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ROUTES).map(([routeName, route]) => [routeName, route.documentType])),
    {
      'review-fix-spec': 'SPEC',
      'review-fix-plan': 'PLAN',
      'review-fix-design': 'DESIGN',
      'review-fix-doc': 'COMMON'
    }
  );
});

test('generated Claude commands use fixed type, current checks, target-local resume, and no user type', () => {
  const text = renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: PACKAGE_VERSION });

  assert.match(text, /review-fix-spec/);
  assert.match(text, /Document type:\s*SPEC/i);
  assert.match(text, new RegExp(`Package version:\\s*${PACKAGE_VERSION.replaceAll('.', '\\.')}`, 'i'));
  assert.match(text, /run `drfx doctor`|run the same package capability check/i);
  assert.match(text, /must not trust old|stale descriptor/i);
  assert.match(text, /users? must not pass `?type`?/i);
  assert.match(text, /must not infer.*type.*filename|must not infer.*type.*path/i);
  assert.match(text, /\.drfx\/targets\/<target-key>\//);
});

test('generated Codex skills use manifest-owned copied shared source and fail-closed guidance', () => {
  const files = generatePlatformFiles('codex', { packageVersion: PACKAGE_VERSION });
  const specSkill = files.find((entry) => entry.routeName === 'review-fix-spec');

  assert.equal(specSkill.kind, 'directory');
  assert.equal(specSkill.requiresOwnedSharedSource, true);
  assert.equal(specSkill.relativePath, path.join('skills', 'review-fix-spec'));
  assert.ok(specSkill.files.some((file) => file.relativePath === 'SKILL.md'));
  assert.ok(specSkill.files.some((file) => file.relativePath === '.drfx-owned'));
  assert.ok(specSkill.files.some((file) => file.relativePath === path.join('shared', '.drfx-owned')));
  assert.ok(specSkill.files.some((file) => file.relativePath === path.join('shared', 'core.md')));
  assert.ok(specSkill.files.some((file) => file.relativePath === path.join('shared', 'long-task.md')));
  assert.ok(specSkill.files.some((file) => file.relativePath === path.join('shared', 'rubrics', 'spec.md')));

  const skillText = specSkill.files.find((file) => file.relativePath === 'SKILL.md').content;
  const copiedCore = specSkill.files.find((file) => file.relativePath === path.join('shared', 'core.md')).content;
  const copiedReviewer = specSkill.files.find((file) => file.relativePath === path.join('shared', 'prompts', 'reviewer.md')).content;
  assert.doesNotMatch(skillText, /Document Review Loop Core/);
  assert.doesNotMatch(skillText, /Reviewer Prompt Template/);
  assert.match(copiedCore, /Document Review Loop Core/);
  assert.match(copiedReviewer, /Reviewer Prompt Template/);
  assert.match(skillText, /Codex copied shared source mode is active/);
  assert.match(skillText, /shared\/\.drfx-owned/);
  assert.match(skillText, /fail closed/i);
  assert.match(skillText, /Do not silently fall back/i);
  assert.match(skillText, /`~\/\.drfx\/shared`/);
  assert.match(skillText, /this skill directory offline/i);
});

test('validateGeneratedPlan fails closed when a Codex generated skill plan is incomplete', () => {
  const intactCodexPlan = () => generatePlatformFiles('codex', { packageVersion: PACKAGE_VERSION });

  // A complete copied-shared-source plan must pass.
  assert.doesNotThrow(() => validateGeneratedPlan('codex', intactCodexPlan()));

  function corruptedSpecSkill(mutate) {
    const entries = intactCodexPlan();
    const spec = entries.find((entry) => entry.routeName === 'review-fix-spec');
    spec.files = mutate(spec.files.map((file) => ({ ...file })));
    return entries;
  }

  const dropFile = (relativePath) => (files) => files.filter((file) => file.relativePath !== relativePath);

  // Codex treats an absent allow_implicit_invocation as true, so a present-but-wrong
  // agents/openai.yaml is exactly as unsafe as a missing one and must fail closed too.
  const rewritePolicy = (content) => (files) => files.map((file) => (
    file.relativePath === path.join('agents', 'openai.yaml') ? { ...file, content } : file
  ));

  const invocationPolicyCases = [
    { name: 'missing agents/openai.yaml', mutate: dropFile(path.join('agents', 'openai.yaml')) },
    { name: 'empty policy file', mutate: rewritePolicy('') },
    { name: 'implicit invocation explicitly allowed', mutate: rewritePolicy('policy:\n  allow_implicit_invocation: true\n') },
    { name: 'policy key absent from the block', mutate: rewritePolicy('policy:\n  something_else: false\n') },
    { name: 'key outside the policy block', mutate: rewritePolicy('allow_implicit_invocation: false\n') },
    {
      name: 'key indented under a different top-level block',
      mutate: rewritePolicy('policy:\ninterface:\n  allow_implicit_invocation: false\n')
    },
    {
      name: 'policy is not a top-level key',
      mutate: rewritePolicy('interface:\n  policy:\n    allow_implicit_invocation: false\n')
    },
    // Only a DIRECT child of `policy:` sets the field. A deeper
    // `policy.<other>.allow_implicit_invocation` leaves the real field absent, which
    // Codex reads as the default `true`.
    {
      name: 'key nested one level below a direct child',
      mutate: rewritePolicy('policy:\n  nested:\n    allow_implicit_invocation: false\n')
    },
    {
      name: 'key nested two levels below a direct child',
      mutate: rewritePolicy('policy:\n  a:\n    b:\n      allow_implicit_invocation: false\n')
    },
    {
      name: 'nested false cannot override a direct true',
      mutate: rewritePolicy('policy:\n  allow_implicit_invocation: true\n  nested:\n    allow_implicit_invocation: false\n')
    },
    {
      name: 'nested false read before a direct true',
      mutate: rewritePolicy('policy:\n  nested:\n    allow_implicit_invocation: false\n  allow_implicit_invocation: true\n')
    },
    {
      name: 'policy block is a sequence, not a mapping',
      mutate: rewritePolicy('policy:\n  - allow_implicit_invocation: false\n')
    },
    { name: 'tab indentation', mutate: rewritePolicy('policy:\n\tallow_implicit_invocation: false\n') },
    { name: 'quoted string value', mutate: rewritePolicy('policy:\n  allow_implicit_invocation: "false"\n') }
  ];

  for (const testCase of invocationPolicyCases) {
    assert.throws(
      () => validateGeneratedPlan('codex', corruptedSpecSkill(testCase.mutate)),
      (error) => error && error.code === 'ERR_CODEX_INVOCATION_POLICY_PLAN',
      `validateGeneratedPlan must fail closed for: ${testCase.name}`
    );
  }

  // Shapes that genuinely set policy.allow_implicit_invocation must still pass.
  const acceptedPolicyCases = [
    { name: 'sibling block before policy', content: 'interface:\n  display_name: "drfx"\n\npolicy:\n  allow_implicit_invocation: false\n' },
    { name: 'nested sibling key before the direct key', content: 'policy:\n  nested:\n    x: 1\n  allow_implicit_invocation: false\n' },
    { name: 'four-space child indent', content: 'policy:\n    allow_implicit_invocation: false\n' }
  ];

  for (const testCase of acceptedPolicyCases) {
    assert.doesNotThrow(
      () => validateGeneratedPlan('codex', corruptedSpecSkill(rewritePolicy(testCase.content))),
      `validateGeneratedPlan must accept: ${testCase.name}`
    );
  }

  const cases = [
    { name: 'missing SKILL.md', entries: corruptedSpecSkill(dropFile('SKILL.md')) },
    { name: 'missing root ownership marker', entries: corruptedSpecSkill(dropFile('.drfx-owned')) },
    {
      name: 'missing shared ownership marker',
      entries: corruptedSpecSkill(dropFile(path.join('shared', '.drfx-owned')))
    },
    {
      name: 'no copied shared source files',
      entries: corruptedSpecSkill((files) => files.filter((file) => !file.sourcePath))
    }
  ];

  for (const testCase of cases) {
    assert.throws(
      () => validateGeneratedPlan('codex', testCase.entries),
      (error) => error && error.code === 'ERR_CODEX_SHARED_SOURCE_PLAN',
      `validateGeneratedPlan must fail closed for: ${testCase.name}`
    );
  }

  // Embedded-shared-source plans still require invocation policy metadata, but skip copied-source validation.
  assert.doesNotThrow(() => validateGeneratedPlan('codex', [{
    kind: 'directory',
    routeName: 'review-fix-spec',
    requiresOwnedSharedSource: false,
    files: [
      { relativePath: 'SKILL.md', content: '# embedded' },
      {
        relativePath: path.join('agents', 'openai.yaml'),
        content: 'policy:\n  allow_implicit_invocation: false\n'
      }
    ]
  }]));

  // A copied-shared-source flag on a non-directory plan must also fail closed.
  assert.throws(
    () => validateGeneratedPlan('codex', [{
      kind: 'file',
      routeName: 'review-fix-spec',
      requiresOwnedSharedSource: true,
      files: []
    }]),
    (error) => error && error.code === 'ERR_CODEX_SHARED_SOURCE_PLAN',
    'validateGeneratedPlan must reject a copied-shared-source flag on a non-directory plan'
  );
});

test('copySharedAssets copies minimal shared references into a Codex skill directory', (t) => {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-codex-skill-'));
  t.after(() => {
    fs.rmSync(skillDir, { recursive: true, force: true });
  });

  const copied = copySharedAssets(skillDir, { documentType: 'PLAN' });

  assert.deepEqual(
    copied.map((entry) => entry.relativePath).sort(),
    [
      path.join('shared', 'core.md'),
      path.join('shared', 'long-task.md'),
      path.join('shared', 'prompts', 'coordinator.md'),
      path.join('shared', 'prompts', 'fixer.md'),
      path.join('shared', 'prompts', 'reviewer.md'),
      path.join('shared', 'rubrics', 'common.md'),
      path.join('shared', 'rubrics', 'plan.md')
    ].sort()
  );
  assert.equal(fs.existsSync(path.join(skillDir, 'shared', 'core.md')), true);
  assert.match(fs.readFileSync(path.join(skillDir, 'shared', 'rubrics', 'plan.md'), 'utf8'), /PLAN Rubric/);
});

test('generated Gemini TOML commands are advisory-only read-only findings routes', () => {
  const text = renderPlatformRoute('gemini', 'review-fix-doc', { packageVersion: PACKAGE_VERSION });

  assert.match(text, /^description = "Review COMMON documents/m);
  assert.match(text, /\[prompt\]/);
  assert.match(text, /Document type: COMMON/);
  assert.match(text, /advisory-only/i);
  assert.match(text, /read-only findings/i);
  assert.match(text, /automatic fixing.*unavailable in Gemini v1/i);
  assert.match(text, /workflow PASS.*unavailable in Gemini v1/i);
  assert.doesNotMatch(text, /review-and-fix mode is available/i);
});

test('generated platform files include all Claude, Codex, and Gemini route contracts', () => {
  assert.deepEqual(
    generatePlatformFiles('claude', { packageVersion: PACKAGE_VERSION }).map((entry) => entry.relativePath).sort(),
    [
      path.join('commands', 'review-fix-code.md'),
      path.join('commands', 'review-fix-design.md'),
      path.join('commands', 'review-fix-doc.md'),
      path.join('commands', 'review-fix-plan.md'),
      path.join('commands', 'review-fix-pr.md'),
      path.join('commands', 'review-fix-r2p.md'),
      path.join('commands', 'review-fix-spec.md')
    ].sort()
  );
  assert.deepEqual(
    generatePlatformFiles('gemini', { packageVersion: PACKAGE_VERSION }).map((entry) => entry.relativePath).sort(),
    [
      path.join('commands', 'review-fix-code.toml'),
      path.join('commands', 'review-fix-design.toml'),
      path.join('commands', 'review-fix-doc.toml'),
      path.join('commands', 'review-fix-plan.toml'),
      path.join('commands', 'review-fix-pr.toml'),
      path.join('commands', 'review-fix-r2p.toml'),
      path.join('commands', 'review-fix-spec.toml')
    ].sort()
  );
  assert.deepEqual(
    generatePlatformFiles('codex', { packageVersion: PACKAGE_VERSION }).map((entry) => entry.relativePath).sort(),
    [
      path.join('skills', 'review-fix-code'),
      path.join('skills', 'review-fix-design'),
      path.join('skills', 'review-fix-doc'),
      path.join('skills', 'review-fix-plan'),
      path.join('skills', 'review-fix-pr'),
      path.join('skills', 'review-fix-r2p'),
      path.join('skills', 'review-fix-spec')
    ].sort()
  );
});

test('uninstall skips a modified Claude command file and retains the manifest', async (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  await installPlatform('claude', { homeDir, platformRoots });
  const routePath = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');
  fs.appendFileSync(routePath, '\n<!-- user edit -->\n');

  const result = await uninstallPlatform('claude', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.reason === 'modified' && s.path === routePath));
  assert.equal(fs.existsSync(routePath), true);
  const manifestPath = path.join(homeDir, '.drfx', 'manifests', 'claude.manifest');
  assert.equal(fs.existsSync(manifestPath), true);
  const retained = readInstallManifest('claude', { homeDir }).manifest.generated.map((entry) => entry.path);
  assert.deepEqual(retained, [routePath]);
  assert.equal(fs.existsSync(path.join(homeDir, '.drfx', 'capabilities', 'claude.json')), true);
});

test('uninstall skips a modified Gemini command file and retains the manifest', async (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  await installPlatform('gemini', { homeDir, platformRoots });
  const routePath = path.join(platformRoots.gemini, 'commands', 'review-fix-spec.toml');
  fs.appendFileSync(routePath, '\n# user edit\n');

  const result = await uninstallPlatform('gemini', { homeDir, platformRoots });

  assert.equal(result.partial, true);
  assert.ok(result.skipped.some((s) => s.reason === 'modified' && s.path === routePath));
  assert.equal(fs.existsSync(routePath), true);
  const retained = readInstallManifest('gemini', { homeDir }).manifest.generated.map((entry) => entry.path);
  assert.deepEqual(retained, [routePath]);
  assert.equal(fs.existsSync(path.join(homeDir, '.drfx', 'capabilities', 'gemini.json')), true);
});

test('uninstall still removes an unchanged Claude command file and its manifest', async (t) => {
  const { homeDir, platformRoots } = makeInstallFixture(t);
  await installPlatform('claude', { homeDir, platformRoots });
  const routePath = path.join(platformRoots.claude, 'commands', 'review-fix-spec.md');

  const result = await uninstallPlatform('claude', { homeDir, platformRoots });

  assert.notEqual(result.partial, true);
  assert.equal(fs.existsSync(routePath), false);
  const manifestPath = path.join(homeDir, '.drfx', 'manifests', 'claude.manifest');
  assert.equal(fs.existsSync(manifestPath), false);
});

test('generated-output scan rejects runtime memory continuity claims', () => {
  const allGeneratedText = ['claude', 'codex', 'gemini']
    .flatMap((platform) => generatePlatformFiles(platform, { packageVersion: PACKAGE_VERSION }))
    .flatMap((entry) => (entry.files ? entry.files : [entry]))
    .filter((entry) => typeof entry.content === 'string')
    .map((entry) => entry.content)
    .join('\n\n--- route boundary ---\n\n');

  assert.doesNotMatch(
    allGeneratedText,
    /\b(?:resume|long-task continuity|continuity)\b.{0,120}\b(?:runtime objective state|session memory|platform memory|chat history)\b/i
  );
  assert.match(allGeneratedText, /\.drfx\/targets\/<target-key>\//);
});
