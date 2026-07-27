'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claude = require('./adapters/claude');
const codex = require('./adapters/codex');
const gemini = require('./adapters/gemini');
const opencode = require('./adapters/opencode');
const { buildDescriptor } = require('./capability');
const { atomicWriteFile } = require('./atomic-write');
const { ROUTES, generatePlatformFiles, copySharedAssets } = require('./generator');
const { parseYamlBlockMapping } = require('./yaml-block-mapping');
const {
  SCHEMA_VERSION,
  manifestPathForPlatform,
  readInstallManifest,
  validateGeneratedRemoval,
  writeInstallManifest,
  directoryTreeMetadata
} = require('./manifest');

const PACKAGE_NAME = '@xenonbyte/drfx';
const PLATFORMS = ['claude', 'codex', 'gemini', 'opencode'];
const OWNERSHIP_MARKER = '.drfx-owned';
const CODEX_AGENTS_METADATA_PATH = path.join('agents', 'openai.yaml');
const CODEX_METADATA_TOP_LEVEL_FIELDS = ['policy'];
const CODEX_POLICY_FIELDS = ['allow_implicit_invocation'];
const ADAPTERS = { claude, codex, gemini, opencode };

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return packageJson.version;
}

function parsePlatformList(value) {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (raw === undefined || raw === null || raw === '') return [...PLATFORMS];
  if (typeof raw !== 'string') fail('ERR_PLATFORM_LIST', 'platform list must be a comma-separated string');
  const platforms = raw
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean);
  if (platforms.length === 0) fail('ERR_PLATFORM_LIST', 'platform list must include at least one platform');
  const seen = new Set();
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
    if (seen.has(platform)) fail('ERR_PLATFORM_DUPLICATE', `duplicate platform: ${platform}`);
    seen.add(platform);
  }
  return platforms;
}

function hasBasename(filePath, basename) {
  return path.basename(path.resolve(filePath)) === basename;
}

function normalizePlatformRoots(homeDir, platformRoots = {}) {
  const claudeRoot = platformRoots.claude
    ? hasBasename(platformRoots.claude, 'commands')
      ? path.dirname(platformRoots.claude)
      : platformRoots.claude
    : path.join(homeDir, '.claude');
  const claudeCommands = platformRoots.claude && hasBasename(platformRoots.claude, 'commands')
    ? platformRoots.claude
    : path.join(claudeRoot, 'commands');

  const codexRoot = platformRoots.codex || (platformRoots.codexSkills ? path.dirname(platformRoots.codexSkills) : path.join(homeDir, '.codex'));
  const codexSkills = platformRoots.codexSkills || path.join(codexRoot, 'skills');
  const codexPrompts = platformRoots.codexPrompts || path.join(codexRoot, 'prompts');

  const geminiRoot = platformRoots.gemini
    ? hasBasename(platformRoots.gemini, 'commands')
      ? path.dirname(platformRoots.gemini)
      : platformRoots.gemini
    : path.join(homeDir, '.gemini');
  const geminiCommands = platformRoots.gemini && hasBasename(platformRoots.gemini, 'commands')
    ? platformRoots.gemini
    : path.join(geminiRoot, 'commands');

  const opencodeRoot = platformRoots.opencode
    ? hasBasename(platformRoots.opencode, 'commands')
      ? path.dirname(platformRoots.opencode)
      : platformRoots.opencode
    : path.join(homeDir, '.config', 'opencode');
  const opencodeCommands = platformRoots.opencode && hasBasename(platformRoots.opencode, 'commands')
    ? platformRoots.opencode
    : path.join(opencodeRoot, 'commands');

  return {
    installRoots: {
      claude: path.resolve(claudeRoot),
      codex: path.resolve(codexRoot),
      gemini: path.resolve(geminiRoot),
      opencode: path.resolve(opencodeRoot)
    },
    allowedRoots: {
      claude: path.resolve(claudeCommands),
      codex: path.resolve(codexSkills),
      gemini: path.resolve(geminiCommands),
      opencode: path.resolve(opencodeCommands)
    },
    codexPrompts: path.resolve(codexPrompts),
    manifestPlatformRoots: {
      claude: path.resolve(claudeRoot),
      codex: path.resolve(codexRoot),
      gemini: path.resolve(geminiRoot),
      opencode: path.resolve(opencodeRoot)
    }
  };
}

function ensureBaseDirectories(platform, roots, homeDir, cwd) {
  fs.mkdirSync(homeDir, { recursive: true });
  if (cwd) fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(roots.installRoots[platform], { recursive: true });
  fs.mkdirSync(roots.allowedRoots[platform], { recursive: true });
  if (platform === 'codex') fs.mkdirSync(roots.codexPrompts, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.drfx', 'backups', platform), { recursive: true });
}

function hasOwnershipMarker(directoryPath) {
  const markerPath = path.join(directoryPath, OWNERSHIP_MARKER);
  if (!pathExists(markerPath)) return false;
  const stat = fs.lstatSync(markerPath);
  return stat.isFile() && fs.readFileSync(markerPath, 'utf8').includes(PACKAGE_NAME);
}

function hasFileOwnershipMarker(filePath) {
  if (!pathExists(filePath)) return false;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) fail('ERR_REMOVE_SYMLINK', `refusing to remove symlink: ${filePath}`);
  if (!stat.isFile()) return false;
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .some((line) => line.startsWith(`Generated by \`${PACKAGE_NAME}\``));
}

function codexLegacyPromptTargets(roots) {
  return Object.keys(ROUTES).map((routeName) => path.join(roots.codexPrompts, `${routeName}.md`));
}

function ownershipMarkedCodexLegacyPrompts(roots, recordedPaths = new Set()) {
  const prompts = [];
  for (const promptPath of codexLegacyPromptTargets(roots)) {
    if (recordedPaths.has(promptPath)) continue;
    if (hasFileOwnershipMarker(promptPath)) prompts.push({ path: promptPath, kind: 'file', action: 'legacy-owned' });
  }
  return prompts;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checksumFile(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function checksumContent(content) {
  return sha256Buffer(Buffer.from(content));
}

function backupPathFor(platform, originalPath, homeDir) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const nonce = crypto.randomBytes(4).toString('hex');
  const basename = path.basename(originalPath);
  return path.join(homeDir, '.drfx', 'backups', platform, `${stamp}-${nonce}`, basename);
}

function backupExisting(platform, targetPath, homeDir, stat) {
  const backupPath = backupPathFor(platform, targetPath, homeDir);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(targetPath, backupPath, { recursive: true });
    return { originalPath: targetPath, backupPath, checksum: 'none' };
  }
  fs.copyFileSync(targetPath, backupPath);
  return { originalPath: targetPath, backupPath, checksum: checksumFile(backupPath) };
}

function restoreBackup(backup, kind) {
  if (pathExists(backup.originalPath)) fs.rmSync(backup.originalPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(backup.originalPath), { recursive: true });
  if (kind === 'directory') fs.cpSync(backup.backupPath, backup.originalPath, { recursive: true });
  else fs.copyFileSync(backup.backupPath, backup.originalPath);
}

function discardBackup(backup) {
  // Each backup owns a unique `<stamp>-<nonce>` directory (see backupPathFor), so removing
  // the parent leaves no empty litter. Best-effort: a leftover backup must never fail a good install.
  try {
    fs.rmSync(path.dirname(backup.backupPath), { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures; the orphaned backup is harmless and matches the pre-cleanup behavior.
  }
}

function cleanupCreated(targetPath) {
  if (pathExists(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
}

function installTargetFor(platform, generated, roots) {
  return path.join(roots.installRoots[platform], generated.relativePath);
}

function flattenGeneratedEntry(platform, generated, roots) {
  const targetPath = installTargetFor(platform, generated, roots);
  if (generated.kind === 'directory') {
    return {
      platform,
      kind: 'directory',
      targetPath,
      generated
    };
  }
  return {
    platform,
    kind: 'file',
    targetPath,
    content: generated.content,
    generated
  };
}

function generatedRelativePathSet(generated) {
  return new Set((generated.files || []).map((file) => file.relativePath));
}

function validateCodexGeneratedFilePaths(generated) {
  if (generated.kind !== 'directory') return;
  if (!Array.isArray(generated.files)) {
    fail('ERR_CODEX_GENERATED_PATH_PLAN', 'Codex generated skill files must be an array');
  }

  const pathsByCollisionKey = new Map();
  for (const file of generated.files) {
    const relativePath = file && file.relativePath;
    if (typeof relativePath !== 'string' || relativePath === '') {
      fail(
        'ERR_CODEX_GENERATED_PATH_PLAN',
        'Codex generated file relativePath must be a non-empty string'
      );
    }
    if (path.isAbsolute(relativePath)) {
      fail('ERR_CODEX_GENERATED_PATH_PLAN', `Codex generated file path must be relative: ${relativePath}`);
    }

    const normalizedPath = path.normalize(relativePath);
    if (normalizedPath !== relativePath) {
      fail(
        'ERR_CODEX_GENERATED_PATH_PLAN',
        `Codex generated file path must already be normalized: ${relativePath}`
      );
    }
    const segments = relativePath.split(path.sep);
    if (segments.some((segment) => (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      /[. ]$/.test(segment)
    ))) {
      fail(
        'ERR_CODEX_GENERATED_PATH_PLAN',
        `Codex generated file path contains an unsafe segment: ${relativePath}`
      );
    }

    const collisionKey = normalizedPath.toLowerCase();
    const collidingPath = pathsByCollisionKey.get(collisionKey);
    if (collidingPath !== undefined) {
      fail(
        'ERR_CODEX_GENERATED_PATH_PLAN',
        `Codex generated file paths collide across case-insensitive filesystems: ${collidingPath}, ${relativePath}`
      );
    }
    pathsByCollisionKey.set(collisionKey, relativePath);
  }
}

function validateCodexOwnedSharedSource(generated) {
  if (!generated.requiresOwnedSharedSource) return;
  if (generated.kind !== 'directory') {
    fail('ERR_CODEX_SHARED_SOURCE_PLAN', 'Codex copied shared source requires a generated skill directory');
  }
  const relativePaths = generatedRelativePathSet(generated);
  for (const requiredPath of ['SKILL.md', OWNERSHIP_MARKER, path.join('shared', OWNERSHIP_MARKER)]) {
    if (!relativePaths.has(requiredPath)) {
      fail('ERR_CODEX_SHARED_SOURCE_PLAN', `Codex copied shared source is missing ${requiredPath}`);
    }
  }
  const copiedSharedFiles = (generated.files || []).filter((file) => (
    file.sourcePath &&
    file.relativePath.startsWith(`shared${path.sep}`) &&
    file.relativePath !== path.join('shared', OWNERSHIP_MARKER)
  ));
  if (copiedSharedFiles.length === 0) {
    fail('ERR_CODEX_SHARED_SOURCE_PLAN', 'Codex copied shared source requires at least one copied shared file');
  }
}

// Codex reads `<skill>/agents/openai.yaml` and treats `policy.allow_implicit_invocation`
// as `true` when metadata is absent or rejected, so any schema-invalid sibling can
// silently re-enable implicit invocation even when this field itself says `false`.
// Validate the complete schema the generator currently emits: exactly one top-level
// `policy:` mapping containing exactly one plain `allow_implicit_invocation: false`.
// Future metadata fields must extend this validator before the generator can emit them.
// This is a fail-closed check on drfx's own generated artifact, not a general YAML reader:
// only the block-mapping subset the generator emits is accepted.
// Returns null when the metadata disables implicit invocation, otherwise a message
// naming the ACTUAL defect. An unreadable document and a readable-but-permissive one
// are different operator problems: reporting both as "must set ... to false" points at
// a line that may already say exactly that.
function codexInvocationPolicyDefect(content) {
  const metadata = parseYamlBlockMapping(content);
  if (!metadata) {
    return 'is not a supported YAML block mapping (no sequences, flow style, document markers, tabs, or duplicate keys)';
  }
  const unsupportedTopLevelField = [...metadata.keys()]
    .find((field) => !CODEX_METADATA_TOP_LEVEL_FIELDS.includes(field));
  if (unsupportedTopLevelField) {
    return `contains unsupported top-level field \`${unsupportedTopLevelField}\`; the current generated schema permits only \`policy\``;
  }
  const policy = metadata.get('policy');
  if (!policy || policy.kind !== 'mapping') {
    return 'has no top-level `policy:` block mapping';
  }
  const unsupportedPolicyField = [...policy.value.keys()]
    .find((field) => !CODEX_POLICY_FIELDS.includes(field));
  if (unsupportedPolicyField) {
    return `contains unsupported policy field \`${unsupportedPolicyField}\`; the current generated schema permits only \`allow_implicit_invocation\``;
  }
  const setting = policy.value.get('allow_implicit_invocation');
  if (!setting || setting.kind !== 'scalar') {
    return 'does not set `allow_implicit_invocation` as a direct child of `policy:`';
  }
  if (setting.style !== 'plain' || setting.value !== 'false') {
    return 'must set policy.allow_implicit_invocation to the plain value false';
  }
  return null;
}

function validateCodexInvocationPolicy(generated) {
  if (generated.kind !== 'directory') {
    fail('ERR_CODEX_INVOCATION_POLICY_PLAN', 'Codex invocation policy requires a generated skill directory');
  }
  const metadataFiles = (generated.files || [])
    .filter((file) => file.relativePath === CODEX_AGENTS_METADATA_PATH);
  if (metadataFiles.length === 0) {
    fail(
      'ERR_CODEX_INVOCATION_POLICY_PLAN',
      `Codex generated skill is missing ${CODEX_AGENTS_METADATA_PATH}`
    );
  }
  if (metadataFiles.length !== 1) {
    fail(
      'ERR_CODEX_INVOCATION_POLICY_PLAN',
      `Codex generated skill must contain exactly one ${CODEX_AGENTS_METADATA_PATH}; found ${metadataFiles.length}`
    );
  }
  const [metadata] = metadataFiles;
  const defect = codexInvocationPolicyDefect(metadata.content);
  if (defect) {
    fail(
      'ERR_CODEX_INVOCATION_POLICY_PLAN',
      `Codex ${CODEX_AGENTS_METADATA_PATH} ${defect}`
    );
  }
}

function validateGeneratedPlan(platform, generatedEntries) {
  if (platform !== 'codex') return;
  for (const generated of generatedEntries) {
    validateCodexOwnedSharedSource(generated);
    validateCodexInvocationPolicy(generated);
    validateCodexGeneratedFilePaths(generated);
  }
}

function planInstall(platform, roots, packageVersion) {
  const generatedEntries = generatePlatformFiles(platform, { packageVersion });
  validateGeneratedPlan(platform, generatedEntries);
  return generatedEntries.map((entry) => flattenGeneratedEntry(platform, entry, roots));
}

function preflightInstall(platform, planned) {
  for (const item of planned) {
    if (!pathExists(item.targetPath)) continue;
    const stat = fs.lstatSync(item.targetPath);
    if (stat.isSymbolicLink()) fail('ERR_INSTALL_SYMLINK', `refusing to install over symlink: ${item.targetPath}`);

    if (platform === 'codex') {
      if (!stat.isDirectory()) {
        fail('ERR_CODEX_TARGET_KIND', `refusing non-owned Codex skill target that is not a directory: ${item.targetPath}`);
      }
      if (!hasOwnershipMarker(item.targetPath)) {
        fail('ERR_CODEX_OWNERSHIP', `refusing non-owned Codex skill directory: ${item.targetPath}`);
      }
      continue;
    }

    if (!stat.isFile()) fail('ERR_INSTALL_TARGET_KIND', `refusing to install over non-file target: ${item.targetPath}`);
  }
}

function preflightPlatformInstall(platform, options = {}) {
  const [normalizedPlatform] = parsePlatformList(platform);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const packageVersion = options.packageVersion || readPackageVersion();
  const roots = normalizePlatformRoots(homeDir, options.platformRoots);
  const planned = planInstall(normalizedPlatform, roots, packageVersion);
  preflightInstall(normalizedPlatform, planned);
}

function tempSiblingPath(targetPath, suffix) {
  const parent = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  return path.join(parent, `.${basename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.${suffix}`);
}

function writeGeneratedDirectory(targetPath, generated, hooks = {}) {
  const stagingPath = tempSiblingPath(targetPath, 'staging');
  const replacedPath = tempSiblingPath(targetPath, 'replaced');
  let targetMoved = false;
  let cleanupResidue = null;
  try {
    fs.mkdirSync(stagingPath, { recursive: true });
    for (const file of generated.files) {
      const filePath = path.join(stagingPath, file.relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content);
    }
    if (typeof hooks._onBeforeReplaceGeneratedDirectory === 'function') {
      hooks._onBeforeReplaceGeneratedDirectory({ targetPath, stagingPath, generated });
    }
    if (pathExists(targetPath)) {
      fs.renameSync(targetPath, replacedPath);
      targetMoved = true;
    }
    fs.renameSync(stagingPath, targetPath);
    if (typeof hooks._onAfterReplaceGeneratedDirectory === 'function') {
      hooks._onAfterReplaceGeneratedDirectory({ targetPath, replacedPath, generated });
    }
    if (targetMoved) {
      try {
        if (typeof hooks._removeReplacedGeneratedDirectory === 'function') {
          hooks._removeReplacedGeneratedDirectory({ targetPath, replacedPath, generated });
        }
        fs.rmSync(replacedPath, { recursive: true, force: true });
      } catch (cleanupError) {
        // The new target is already committed and the complete original also exists in
        // the install backup. Keep the successful swap and report the cleanup residue.
        cleanupResidue = { path: replacedPath, message: cleanupError.message };
      }
    }
  } catch (error) {
    try {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch {
      // The original failure remains authoritative; staging cleanup is best-effort.
    }
    if (targetMoved && pathExists(replacedPath)) {
      try {
        if (pathExists(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
        fs.renameSync(replacedPath, targetPath);
      } catch (rollbackError) {
        // Preserve the displaced original at replacedPath when rollback itself fails.
        // The caller receives both errors and can recover without data loss.
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
  return cleanupResidue;
}

function writeGeneratedFile(targetPath, content) {
  atomicWriteFile(targetPath, content);
}

async function writeInstallerDefaultDescriptor(platform, { homeDir, packageVersion }) {
  const adapterCapabilities = await ADAPTERS[platform].checkCapabilities({ packageVersion });
  const descriptor = buildDescriptor({
    platform,
    packageVersion,
    adapterCapabilities,
    fingerprintGuard: {
      status: 'unverified',
      proof: 'none',
      proofRunId: 'none',
      detail: 'Installer default has not run the local probe.'
    },
    provenanceSource: 'installer-default',
    generatedBy: 'drfx install'
  });
  const descriptorPath = path.join(homeDir, '.drfx', 'capabilities', `${platform}.json`);
  writeGeneratedFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return descriptorPath;
}

async function installPlatform(platform, options = {}) {
  const [normalizedPlatform] = parsePlatformList(platform);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const cwd = path.resolve(options.cwd || process.cwd());
  const packageVersion = options.packageVersion || readPackageVersion();
  const roots = normalizePlatformRoots(homeDir, options.platformRoots);

  ensureBaseDirectories(normalizedPlatform, roots, homeDir, cwd);
  const planned = planInstall(normalizedPlatform, roots, packageVersion);
  preflightInstall(normalizedPlatform, planned);

  const generated = [];
  const backups = [];
  const transientBackups = [];
  const applied = [];
  const cleanupResidues = [];
  let descriptorPath = null;
  let descriptorTransaction = null;
  try {
    copySharedAssets(path.join(homeDir, '.drfx'), {
      all: true,
      onBeforeWrite: ({ destinationPath, action, stat }) => {
        const backup = action === 'overwritten'
          ? backupExisting(normalizedPlatform, destinationPath, homeDir, stat)
          : null;
        if (backup) transientBackups.push(backup);
        applied.push({ path: destinationPath, kind: 'file', action, backup });
      }
    });

    for (const item of planned) {
      const exists = pathExists(item.targetPath);
      const stat = exists ? fs.lstatSync(item.targetPath) : null;
      const action = exists ? 'overwritten' : 'created';
      const backup = exists ? backupExisting(normalizedPlatform, item.targetPath, homeDir, stat) : null;
      if (backup) backups.push(backup);

      if (item.kind === 'directory') {
        const cleanupResidue = writeGeneratedDirectory(item.targetPath, item.generated, options);
        if (cleanupResidue) cleanupResidues.push(cleanupResidue);
      } else writeGeneratedFile(item.targetPath, item.content);

      applied.push({ path: item.targetPath, kind: item.kind, action, backup });
      if (item.kind === 'directory') {
        const tree = directoryTreeMetadata(item.targetPath);
        generated.push({
          path: item.targetPath,
          kind: 'directory',
          action,
          checksum: 'none',
          treeChecksum: tree.treeChecksum,
          childFiles: tree.childFiles
        });
      } else {
        generated.push({
          path: item.targetPath,
          kind: 'file',
          action,
          checksum: checksumContent(item.content)
        });
      }
    }

    const plannedDescriptorPath = path.join(homeDir, '.drfx', 'capabilities', `${normalizedPlatform}.json`);
    const descriptorExists = pathExists(plannedDescriptorPath);
    const descriptorStat = descriptorExists ? fs.lstatSync(plannedDescriptorPath) : null;
    if (descriptorStat && (descriptorStat.isSymbolicLink() || !descriptorStat.isFile())) {
      fail('ERR_INSTALL_DESCRIPTOR_KIND', `refusing to install over unsafe capability descriptor: ${plannedDescriptorPath}`);
    }
    descriptorTransaction = {
      path: plannedDescriptorPath,
      action: descriptorExists ? 'overwritten' : 'created',
      backup: descriptorExists
        ? backupExisting(normalizedPlatform, plannedDescriptorPath, homeDir, descriptorStat)
        : null
    };
    descriptorPath = await writeInstallerDefaultDescriptor(normalizedPlatform, { homeDir, packageVersion });
    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      packageName: PACKAGE_NAME,
      packageVersion,
      platform: normalizedPlatform,
      installedAt: now,
      updatedAt: now,
      installRoot: fs.realpathSync.native(roots.installRoots[normalizedPlatform]),
      allowedRoots: [fs.realpathSync.native(roots.allowedRoots[normalizedPlatform])],
      sharedAssets: {
        path: '~/.drfx/shared',
        checksum: 'none'
      },
      capabilityDescriptor: {
        path: `~/.drfx/capabilities/${normalizedPlatform}.json`,
        mutable: true
      },
      generated,
      backups
    };
    if (typeof options._onBeforeWriteInstallManifest === 'function') {
      options._onBeforeWriteInstallManifest({ manifest, descriptorPath });
    }
    const manifestPath = writeInstallManifest(manifest, { homeDir });
    for (const backup of transientBackups) discardBackup(backup);
    if (descriptorTransaction.backup) discardBackup(descriptorTransaction.backup);

    return {
      platform: normalizedPlatform,
      manifestPath,
      descriptorPath,
      generated,
      backups,
      cleanupResidues
    };
  } catch (error) {
    for (const item of applied.reverse()) {
      if (item.action === 'overwritten' && item.backup) restoreBackup(item.backup, item.kind);
      else cleanupCreated(item.path);
    }
    if (descriptorTransaction) {
      if (descriptorTransaction.action === 'overwritten' && descriptorTransaction.backup) {
        restoreBackup(descriptorTransaction.backup, 'file');
        discardBackup(descriptorTransaction.backup);
      } else {
        cleanupCreated(descriptorTransaction.path);
      }
    }
    throw error;
  }
}

async function installPlatforms(options = {}) {
  const platforms = parsePlatformList(options.platforms);
  const results = {};
  for (const platform of platforms) {
    preflightPlatformInstall(platform, options);
  }
  for (const platform of platforms) {
    let uninstallRollback = null;
    // Clean reinstall after the new plan is known writable: remove the previous install
    // (by its own manifest) before writing the new plan, so routes dropped or renamed
    // between versions are not orphaned (left on disk yet absent from the new manifest,
    // hence un-reclaimable by a later uninstall).
    // uninstallPlatform no-ops when nothing is installed and preserves user-modified files
    // via its partial-uninstall path.
    try {
      await uninstallPlatform(platform, {
        ...options,
        _captureUninstallRollback: (rollback) => {
          uninstallRollback = rollback;
        }
      });
      results[platform] = await installPlatform(platform, options);
      if (uninstallRollback) uninstallRollback.cleanup();
    } catch (error) {
      if (uninstallRollback) {
        try {
          uninstallRollback.restore();
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
      }
      throw error;
    }
  }
  return { platforms: results };
}

function validateCapabilityDescriptorRemoval(validation) {
  if (!validation.capabilityDescriptor || !validation.capabilityDescriptor.mutable) {
    return { removable: false, path: null };
  }
  const descriptorPath = validation.capabilityDescriptor.path;
  if (!pathExists(descriptorPath)) return { removable: false, path: descriptorPath };
  const stat = fs.lstatSync(descriptorPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ERR_DESCRIPTOR_REMOVE', `refusing to remove unsafe capability descriptor: ${descriptorPath}`);
  }
  return { removable: true, path: descriptorPath };
}

function validateManifestRemoval(platform, homeDir) {
  const manifestPath = manifestPathForPlatform(platform, { homeDir });
  if (!pathExists(manifestPath)) fail('ERR_MANIFEST_REMOVE', `manifest disappeared before uninstall: ${manifestPath}`);
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ERR_MANIFEST_REMOVE', `refusing to remove unsafe manifest: ${manifestPath}`);
  }
  return manifestPath;
}

function removeCapabilityDescriptor(validatedDescriptor) {
  if (!validatedDescriptor.removable) return false;
  const descriptorPath = validatedDescriptor.path;
  fs.unlinkSync(descriptorPath);
  return true;
}

function createUninstallRollback(platform, { homeDir, removalItems, descriptorRemoval, manifestPath }) {
  const routeBackups = removalItems.map((item) => ({
    kind: item.kind,
    backup: backupExisting(platform, item.path, homeDir, fs.lstatSync(item.path))
  }));
  const descriptorBackup = descriptorRemoval.removable
    ? {
      kind: 'file',
      backup: backupExisting(platform, descriptorRemoval.path, homeDir, fs.lstatSync(descriptorRemoval.path))
    }
    : null;
  const manifestBackup = {
    kind: 'file',
    backup: backupExisting(platform, manifestPath, homeDir, fs.lstatSync(manifestPath))
  };
  let settled = false;

  return {
    restore() {
      if (settled) return;
      settled = true;
      for (const item of routeBackups) restoreBackup(item.backup, item.kind);
      if (descriptorBackup) restoreBackup(descriptorBackup.backup, descriptorBackup.kind);
      restoreBackup(manifestBackup.backup, manifestBackup.kind);
    },
    // Drop the safety backups once the reinstall has committed, so successful reinstalls
    // do not accumulate orphaned copies of the prior install under ~/.drfx/backups/.
    cleanup() {
      if (settled) return;
      settled = true;
      for (const item of routeBackups) discardBackup(item.backup);
      if (descriptorBackup) discardBackup(descriptorBackup.backup);
      discardBackup(manifestBackup.backup);
    }
  };
}

async function uninstallPlatform(platform, options = {}) {
  const [normalizedPlatform] = parsePlatformList(platform);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const roots = normalizePlatformRoots(homeDir, options.platformRoots);
  const manifestRead = readInstallManifest(normalizedPlatform, { homeDir });
  if (manifestRead.missing) return { platform: normalizedPlatform, missing: true, removed: [], skipped: [] };

  const validation = validateGeneratedRemoval(manifestRead, {
    homeDir,
    platformRoots: roots.manifestPlatformRoots,
    expectedPlatform: normalizedPlatform
  });
  const descriptorRemoval = validateCapabilityDescriptorRemoval(validation);
  const manifestPath = validateManifestRemoval(normalizedPlatform, homeDir);

  const removed = [];
  const recordedRemovalPaths = new Set(validation.removable.map((item) => item.path));
  const legacyPrompts =
    normalizedPlatform === 'codex' ? ownershipMarkedCodexLegacyPrompts(roots, recordedRemovalPaths) : [];
  const removalItems = [...validation.removable, ...legacyPrompts];
  if (typeof options._captureUninstallRollback === 'function') {
    options._captureUninstallRollback(createUninstallRollback(normalizedPlatform, {
      homeDir,
      removalItems,
      descriptorRemoval,
      manifestPath
    }));
  }
  for (const item of removalItems) {
    const stat = fs.lstatSync(item.path);
    if (stat.isSymbolicLink()) fail('ERR_REMOVE_SYMLINK', `refusing to remove symlink: ${item.path}`);
    if (item.kind === 'directory') fs.rmSync(item.path, { recursive: true, force: false });
    else fs.unlinkSync(item.path);
    removed.push(item.path);
  }
  const skipped = validation.skipped || [];
  const retained = skipped.filter((item) => item.reason === 'modified');
  const partial = retained.length > 0;

  let descriptorRemoved = false;
  if (!partial) {
    descriptorRemoved = removeCapabilityDescriptor(descriptorRemoval);
    fs.unlinkSync(manifestPath);
  } else {
    const manifest = manifestRead.manifest;
    const retainedPaths = new Set(retained.map((item) => item.path));
    writeInstallManifest({
      ...manifest,
      updatedAt: new Date().toISOString(),
      generated: manifest.generated.filter((entry) => retainedPaths.has(entry.path))
    }, { homeDir });
  }

  return {
    platform: normalizedPlatform,
    missing: false,
    partial,
    removed,
    skipped,
    descriptorRemoved
  };
}

async function uninstallPlatforms(options = {}) {
  const platforms = parsePlatformList(options.platforms);
  const results = {};
  for (const platform of platforms) {
    results[platform] = await uninstallPlatform(platform, options);
  }
  return { platforms: results };
}

module.exports = {
  parsePlatformList,
  installPlatforms,
  uninstallPlatforms,
  installPlatform,
  uninstallPlatform,
  validateGeneratedPlan,
  writeGeneratedFile
};
