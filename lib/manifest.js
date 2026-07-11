'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generatePlatformFiles } = require('./generator');
const { atomicWriteFile } = require('./atomic-write');

const PACKAGE_NAME = '@xenonbyte/drfx';
const SCHEMA_VERSION = 2;
const PLATFORMS = new Set(['claude', 'codex', 'gemini', 'opencode']);
const OWNERSHIP_MARKER = '.drfx-owned';
const DOCUMENTED_HOME_LOCATIONS = ['~/.drfx/shared'];
const DOCUMENTED_HOME_PREFIXES = ['~/.drfx/capabilities', '~/.drfx/backups'];
const TOP_LEVEL_SCALARS = new Set([
  'schemaVersion',
  'packageName',
  'packageVersion',
  'platform',
  'installedAt',
  'updatedAt',
  'installRoot'
]);
const TOP_LEVEL_SECTIONS = new Set(['allowedRoots', 'sharedAssets', 'capabilityDescriptor', 'generated', 'backups']);
const SECTION_FIELDS = {
  sharedAssets: new Set(['path', 'checksum']),
  capabilityDescriptor: new Set(['path', 'mutable']),
  generated: new Set(['path', 'kind', 'action', 'checksum', 'treeChecksum', 'childFiles']),
  backups: new Set(['originalPath', 'backupPath', 'checksum'])
};
const LIST_FIRST_FIELDS = {
  generated: 'path',
  backups: 'originalPath'
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertPlatform(platform) {
  if (!PLATFORMS.has(platform)) fail('ERR_PLATFORM', `unsupported platform: ${platform}`);
}

function manifestPathForPlatform(platform, { homeDir = os.homedir() } = {}) {
  assertPlatform(platform);
  return path.join(homeDir, '.drfx', 'manifests', `${platform}.manifest`);
}

function quote(value) {
  return JSON.stringify(value);
}

function unquote(value, lineNumber) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (!value.startsWith('"') || !value.endsWith('"')) {
    fail('ERR_MANIFEST_PARSE', `unsupported manifest scalar at line ${lineNumber}`);
  }
  try {
    return JSON.parse(value);
  } catch {
    fail('ERR_MANIFEST_PARSE', `invalid quoted manifest scalar at line ${lineNumber}`);
  }
}

function serializeKeyValue(key, value) {
  if (typeof value === 'boolean' || typeof value === 'number') return `${key}: ${value}`;
  return `${key}: ${quote(value)}`;
}

function serializeNestedObject(lines, key, object, fields) {
  lines.push(`${key}:`);
  for (const field of fields) lines.push(`  ${serializeKeyValue(field, object[field])}`);
}

function serializeList(lines, key, rows, fields) {
  lines.push(`${key}:`);
  for (const row of rows) {
    if (!fields.length) {
      lines.push(`  - ${quote(row)}`);
      continue;
    }
    lines.push(`  - ${serializeKeyValue(fields[0], row[fields[0]])}`);
    for (const field of fields.slice(1)) lines.push(`    ${serializeKeyValue(field, row[field])}`);
  }
}

function serializeGenerated(lines, rows) {
  lines.push('generated:');
  for (const row of rows) {
    lines.push(`  - ${serializeKeyValue('path', row.path)}`);
    lines.push(`    ${serializeKeyValue('kind', row.kind)}`);
    lines.push(`    ${serializeKeyValue('action', row.action)}`);
    lines.push(`    ${serializeKeyValue('checksum', row.checksum)}`);
    if (row.treeChecksum !== undefined) lines.push(`    ${serializeKeyValue('treeChecksum', row.treeChecksum)}`);
    if (row.childFiles !== undefined) lines.push(`    ${serializeKeyValue('childFiles', row.childFiles)}`);
  }
}

function normalizeManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object') fail('ERR_MANIFEST', 'manifest is required');
  return {
    schemaVersion: manifest.schemaVersion,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    platform: manifest.platform,
    installedAt: manifest.installedAt,
    updatedAt: manifest.updatedAt,
    installRoot: manifest.installRoot,
    allowedRoots: manifest.allowedRoots,
    sharedAssets: manifest.sharedAssets,
    capabilityDescriptor: manifest.capabilityDescriptor,
    generated: manifest.generated,
    backups: manifest.backups
  };
}

function serializeManifest(input) {
  const manifest = normalizeManifestShape(input);
  validateManifestShapeForSerialization(manifest);
  const lines = [];
  for (const field of [
    'schemaVersion',
    'packageName',
    'packageVersion',
    'platform',
    'installedAt',
    'updatedAt',
    'installRoot'
  ]) {
    lines.push(serializeKeyValue(field, manifest[field]));
  }
  serializeList(lines, 'allowedRoots', manifest.allowedRoots, []);
  serializeNestedObject(lines, 'sharedAssets', manifest.sharedAssets, ['path', 'checksum']);
  serializeNestedObject(lines, 'capabilityDescriptor', manifest.capabilityDescriptor, ['path', 'mutable']);
  serializeGenerated(lines, manifest.generated);
  serializeList(lines, 'backups', manifest.backups, ['originalPath', 'backupPath', 'checksum']);
  return `${lines.join('\n')}\n`;
}

function parseManifestText(text) {
  if (typeof text !== 'string') fail('ERR_MANIFEST_PARSE', 'manifest text must be a string');
  const manifest = {};
  let section = null;
  let currentRow = null;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line === '') continue;

    const topMatch = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line);
    if (topMatch) {
      const [, key, rawValue] = topMatch;
      currentRow = null;
      if (rawValue === undefined) {
        if (!TOP_LEVEL_SECTIONS.has(key)) {
          fail('ERR_MANIFEST_PARSE', `unsupported manifest section: ${key}`);
        }
        if (Object.hasOwn(manifest, key)) fail('ERR_MANIFEST_PARSE', `duplicate manifest section: ${key}`);
        if (key === 'allowedRoots' || key === 'generated' || key === 'backups') manifest[key] = [];
        else manifest[key] = {};
        section = key;
      } else {
        if (!TOP_LEVEL_SCALARS.has(key)) {
          fail('ERR_MANIFEST_PARSE', `unsupported manifest key: ${key}`);
        }
        if (Object.hasOwn(manifest, key)) fail('ERR_MANIFEST_PARSE', `duplicate manifest key: ${key}`);
        manifest[key] = unquote(rawValue, lineNumber);
        section = null;
      }
      continue;
    }

    const listObjectMatch = /^  - ([A-Za-z][A-Za-z0-9]*): (.*)$/.exec(line);
    if (listObjectMatch) {
      if (!['generated', 'backups'].includes(section)) fail('ERR_MANIFEST_PARSE', `unexpected object row at line ${lineNumber}`);
      if (listObjectMatch[1] !== LIST_FIRST_FIELDS[section]) {
        fail('ERR_MANIFEST_PARSE', `unsupported ${section} field at line ${lineNumber}`);
      }
      currentRow = {};
      manifest[section].push(currentRow);
      currentRow[listObjectMatch[1]] = unquote(listObjectMatch[2], lineNumber);
      continue;
    }

    const listScalarMatch = /^  - (.*)$/.exec(line);
    if (listScalarMatch) {
      if (section !== 'allowedRoots') fail('ERR_MANIFEST_PARSE', `unexpected list row at line ${lineNumber}`);
      manifest.allowedRoots.push(unquote(listScalarMatch[1], lineNumber));
      currentRow = null;
      continue;
    }

    const nestedMatch = /^    ([A-Za-z][A-Za-z0-9]*): (.*)$/.exec(line);
    if (nestedMatch) {
      if (!currentRow || !['generated', 'backups'].includes(section)) {
        fail('ERR_MANIFEST_PARSE', `unexpected nested row at line ${lineNumber}`);
      }
      if (!SECTION_FIELDS[section].has(nestedMatch[1])) {
        fail('ERR_MANIFEST_PARSE', `unsupported ${section} field at line ${lineNumber}`);
      }
      if (Object.hasOwn(currentRow, nestedMatch[1])) {
        fail('ERR_MANIFEST_PARSE', `duplicate ${section} field at line ${lineNumber}`);
      }
      currentRow[nestedMatch[1]] = unquote(nestedMatch[2], lineNumber);
      continue;
    }

    const objectMatch = /^  ([A-Za-z][A-Za-z0-9]*): (.*)$/.exec(line);
    if (objectMatch) {
      if (!['sharedAssets', 'capabilityDescriptor'].includes(section)) {
        fail('ERR_MANIFEST_PARSE', `unexpected object field at line ${lineNumber}`);
      }
      if (!SECTION_FIELDS[section].has(objectMatch[1])) {
        fail('ERR_MANIFEST_PARSE', `unsupported ${section} field at line ${lineNumber}`);
      }
      if (Object.hasOwn(manifest[section], objectMatch[1])) {
        fail('ERR_MANIFEST_PARSE', `duplicate ${section} field at line ${lineNumber}`);
      }
      manifest[section][objectMatch[1]] = unquote(objectMatch[2], lineNumber);
      currentRow = null;
      continue;
    }

    fail('ERR_MANIFEST_PARSE', `unsupported manifest syntax at line ${lineNumber}`);
  }

  return normalizeManifestShape(manifest);
}

function writeInstallManifest(manifest, { homeDir = os.homedir() } = {}) {
  const normalized = normalizeManifestShape(manifest);
  assertPlatform(normalized.platform);
  const manifestPath = manifestPathForPlatform(normalized.platform, { homeDir });
  atomicWriteFile(manifestPath, serializeManifest(normalized));
  return manifestPath;
}

function readInstallManifest(platform, { homeDir = os.homedir() } = {}) {
  const manifestPath = manifestPathForPlatform(platform, { homeDir });
  if (!fs.existsSync(manifestPath)) return { missing: true, manifest: null };
  return { missing: false, manifest: parseManifestText(fs.readFileSync(manifestPath, 'utf8')) };
}

function pathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function treeFilePath(root, relativePath) {
  return path.join(root, ...relativePath.split('/'));
}

function hashDirectoryFiles(root, childFiles) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of childFiles) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(treeFilePath(root, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function directoryTreeMetadata(directoryPath) {
  const root = path.resolve(directoryPath);
  const childFiles = [];
  const childEntries = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relativePath = toPosix(path.relative(root, entryPath));
      if (current === root && entry.name === OWNERSHIP_MARKER) continue;
      if (entry.isSymbolicLink()) {
        childEntries.push(`L:${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        childEntries.push(`D:${relativePath}`);
        walk(entryPath);
        continue;
      }
      if (entry.isFile()) {
        childFiles.push(relativePath);
        childEntries.push(`F:${relativePath}`);
        continue;
      }
      childEntries.push(`O:${relativePath}`);
    }
  }
  walk(root);
  childFiles.sort();
  childEntries.sort();
  const hash = crypto.createHash('sha256');
  for (const entry of childEntries) {
    hash.update(entry);
    hash.update('\0');
    if (entry.startsWith('F:')) {
      hash.update(fs.readFileSync(treeFilePath(root, entry.slice(2))));
      hash.update('\0');
    }
  }
  return {
    childFiles: childFiles.join(','),
    childFilesList: childFiles,
    childEntriesList: childEntries,
    treeChecksum: hash.digest('hex')
  };
}

function addRecognizedGeneratedPath(recognized, relativePath) {
  const normalized = toPosix(relativePath);
  recognized.add(`F:${normalized}`);
  let directory = path.posix.dirname(normalized);
  while (directory && directory !== '.') {
    recognized.add(`D:${directory}`);
    directory = path.posix.dirname(directory);
  }
}

function recognizedGeneratedEntriesForSkill(skillName, generatePlatformFilesArg) {
  const recognized = new Set();
  for (const skill of generatePlatformFilesArg('codex')) {
    if (path.basename(skill.relativePath || '') !== skillName) continue;
    for (const file of skill.files || []) {
      if (file.relativePath === OWNERSHIP_MARKER) continue;
      addRecognizedGeneratedPath(recognized, file.relativePath);
    }
  }
  return recognized;
}

function currentTreeIsRecognized(current, recognized) {
  if (recognized.size === 0) return false;
  return current.childEntriesList.every((name) => recognized.has(name));
}

function directoryIsRemovable(entry, generatePlatformFilesArg) {
  const current = directoryTreeMetadata(entry.path);
  const skillName = path.basename(entry.path);
  const recognized = recognizedGeneratedEntriesForSkill(skillName, generatePlatformFilesArg);
  if (entry.treeChecksum !== undefined && entry.childFiles !== undefined) {
    if (current.treeChecksum === entry.treeChecksum && current.childFiles === entry.childFiles) return true;
    // Back-compatible schema v2 path for manifests written before directory entries
    // were included in the tree checksum. Only allow it when every current entry is
    // still explainable by the generated Codex skill layout.
    return hashDirectoryFiles(path.resolve(entry.path), current.childFilesList) === entry.treeChecksum &&
      current.childFiles === entry.childFiles &&
      currentTreeIsRecognized(current, recognized);
  }
  // schemaVersion 1 manifest: conservative path — every current file must be a recognized generated name.
  // generateCodexSkill returns { relativePath: 'skills/<name>', files: [{ relativePath }, ...] };
  // the ownership marker is excluded just like directoryTreeMetadata excludes it.
  return currentTreeIsRecognized(current, recognized);
}

function realDirectory(directoryPath, label) {
  const realPath = fs.realpathSync.native(directoryPath);
  if (!fs.statSync(realPath).isDirectory()) fail('ERR_NOT_DIRECTORY', `${label} must be a directory`);
  return realPath;
}

function canonicalGeneratedPath(generatedPath) {
  if (pathExists(generatedPath)) return fs.realpathSync.native(generatedPath);
  const absolutePath = path.resolve(generatedPath);
  let existingParent = path.dirname(absolutePath);
  while (!pathExists(existingParent)) {
    const parent = path.dirname(existingParent);
    if (parent === existingParent) {
      fail('ERR_GENERATED_PATH_PARENT', `generated path has no existing parent: ${generatedPath}`);
    }
    existingParent = parent;
  }
  const parentRealPath = fs.realpathSync.native(existingParent);
  return path.join(parentRealPath, path.relative(existingParent, absolutePath));
}

function isInsideOrEqual(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultPlatformRoots(homeDir) {
  return {
    claude: path.join(homeDir, '.claude'),
    codex: path.join(homeDir, '.codex'),
    gemini: path.join(homeDir, '.gemini'),
    opencode: path.join(homeDir, '.config', 'opencode')
  };
}

function routeNameMatches(name, extension) {
  return name.startsWith('review-fix-') && name.endsWith(extension);
}

function platformAllowlist(platform, candidatePath, {
  platformRoots = defaultPlatformRoots(os.homedir()),
  manifestRecorded = false,
  ownershipMarked = false
} = {}) {
  assertPlatform(platform);
  const configuredRoot = path.resolve(platformRoots[platform] || defaultPlatformRoots(os.homedir())[platform]);
  const platformRoot = pathExists(configuredRoot) ? fs.realpathSync.native(configuredRoot) : configuredRoot;
  const requestedPath = path.resolve(candidatePath);
  const resolvedPath = pathExists(requestedPath) ? fs.realpathSync.native(requestedPath) : requestedPath;
  const relative = path.relative(platformRoot, resolvedPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);

  if (platform === 'claude' || platform === 'opencode') {
    return parts.length === 2 && parts[0] === 'commands' && routeNameMatches(parts[1], '.md');
  }
  if (platform === 'gemini') {
    return parts.length === 2 && parts[0] === 'commands' && routeNameMatches(parts[1], '.toml');
  }

  if (parts[0] === 'skills' && parts[1] && parts[1].startsWith('review-fix-')) return true;
  if (parts[0] === 'prompts' && parts[1] && parts[1].startsWith('review-fix-')) {
    return manifestRecorded || ownershipMarked;
  }
  return false;
}

function expandDocumentedHomePath(value, { homeDir, label }) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_MANIFEST_PATH', `${label} path is required`);
  if (/\$(?:\{?[A-Za-z_][A-Za-z0-9_]*\}?)/.test(value) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) {
    fail('ERR_ENV_EXPANSION', `${label} must not use environment variable expansion`);
  }
  if (!value.startsWith('~')) return path.resolve(value);
  const allowedExact = DOCUMENTED_HOME_LOCATIONS.includes(value);
  const allowedPrefix = DOCUMENTED_HOME_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
  if (!allowedExact && !allowedPrefix) {
    fail('ERR_HOME_EXPANSION', `${label} may use ~ only for documented user-home locations`);
  }
  return path.join(homeDir, value.slice(2));
}

function canonicalCapabilityDescriptorPath(manifest, homeDir) {
  const documentedPath = `~/.drfx/capabilities/${manifest.platform}.json`;
  if (manifest.capabilityDescriptor.path !== documentedPath) {
    fail(
      'ERR_CAPABILITY_DESCRIPTOR_PATH',
      `capability descriptor must use the exact current platform path: ${documentedPath}`
    );
  }

  const canonicalHome = realDirectory(homeDir, 'home directory');
  const expectedPath = path.join(canonicalHome, '.drfx', 'capabilities', `${manifest.platform}.json`);
  const requestedPath = expandDocumentedHomePath(documentedPath, {
    homeDir,
    label: 'capabilityDescriptor'
  });
  const canonicalPath = canonicalGeneratedPath(requestedPath);
  if (canonicalPath !== expectedPath) {
    fail(
      'ERR_CAPABILITY_DESCRIPTOR_PATH',
      'capability descriptor canonical parent must stay inside the current home capability directory'
    );
  }
  return canonicalPath;
}

function validateSchema(manifest) {
  if (![1, SCHEMA_VERSION].includes(manifest.schemaVersion)) fail('ERR_SCHEMA_VERSION', 'manifest schemaVersion must be 1 or 2');
  if (manifest.packageName !== PACKAGE_NAME) fail('ERR_PACKAGE_NAME', `manifest packageName must be ${PACKAGE_NAME}`);
  assertPlatform(manifest.platform);
  if (typeof manifest.packageVersion !== 'string' || manifest.packageVersion.length === 0) {
    fail('ERR_PACKAGE_VERSION', 'manifest packageVersion is required');
  }
  if (typeof manifest.installedAt !== 'string' || Number.isNaN(Date.parse(manifest.installedAt))) {
    fail('ERR_INSTALLED_AT', 'manifest installedAt must be an ISO-8601 timestamp');
  }
  if (typeof manifest.updatedAt !== 'string' || Number.isNaN(Date.parse(manifest.updatedAt))) {
    fail('ERR_UPDATED_AT', 'manifest updatedAt must be an ISO-8601 timestamp');
  }
  if (typeof manifest.installRoot !== 'string' || manifest.installRoot.length === 0) {
    fail('ERR_INSTALL_ROOT', 'manifest installRoot is required');
  }
  if (!Array.isArray(manifest.allowedRoots)) fail('ERR_ALLOWED_ROOTS', 'manifest allowedRoots must be a list');
  if (!Array.isArray(manifest.generated)) fail('ERR_GENERATED', 'manifest generated must be a list');
  if (!Array.isArray(manifest.backups)) fail('ERR_BACKUPS', 'manifest backups must be a list');
  validateExactKeys('sharedAssets', manifest.sharedAssets, ['path', 'checksum']);
  requireString(manifest.sharedAssets.path, 'sharedAssets.path');
  requireString(manifest.sharedAssets.checksum, 'sharedAssets.checksum');
  validateExactKeys('capabilityDescriptor', manifest.capabilityDescriptor, ['path', 'mutable']);
  requireString(manifest.capabilityDescriptor.path, 'capabilityDescriptor.path');
  if (!manifest.capabilityDescriptor || manifest.capabilityDescriptor.mutable !== true) {
    fail('ERR_CAPABILITY_DESCRIPTOR_MUTABLE', 'capabilityDescriptor.mutable must be true');
  }
  for (let index = 0; index < manifest.generated.length; index += 1) validateGeneratedEntry(manifest.generated[index], index);
  for (let index = 0; index < manifest.backups.length; index += 1) validateBackupEntry(manifest.backups[index], index);
}

function validateManifestShapeForSerialization(manifest) {
  if (!Array.isArray(manifest.allowedRoots)) fail('ERR_ALLOWED_ROOTS', 'manifest allowedRoots must be a list');
  if (!manifest.sharedAssets || typeof manifest.sharedAssets !== 'object') fail('ERR_SHARED_ASSETS', 'sharedAssets is required');
  if (!manifest.capabilityDescriptor || typeof manifest.capabilityDescriptor !== 'object') {
    fail('ERR_CAPABILITY_DESCRIPTOR', 'capabilityDescriptor is required');
  }
  if (!Array.isArray(manifest.generated)) fail('ERR_GENERATED', 'manifest generated must be a list');
  if (!Array.isArray(manifest.backups)) fail('ERR_BACKUPS', 'manifest backups must be a list');
}

function validateExactKeys(label, value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ERR_MANIFEST_FIELD', `${label} is required`);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('ERR_MANIFEST_FIELD', `${label}.${key} is not supported`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_REQUIRED_FIELD', `${label} is required`);
}

function validateGeneratedEntry(entry, index) {
  if (!entry || typeof entry !== 'object') fail('ERR_GENERATED_ENTRY', `generated entry ${index} is malformed`);
  validateExactKeys(`generated entry ${index}`, entry, ['path', 'kind', 'action', 'checksum', 'treeChecksum', 'childFiles']);
  if (typeof entry.path !== 'string' || entry.path.length === 0) fail('ERR_GENERATED_PATH', `generated entry ${index} path is required`);
  if (!path.isAbsolute(entry.path)) fail('ERR_GENERATED_PATH', `generated entry ${index} path must be absolute`);
  if (!['file', 'directory'].includes(entry.kind)) fail('ERR_GENERATED_KIND', `generated entry ${index} kind is invalid`);
  if (!['created', 'overwritten'].includes(entry.action)) fail('ERR_GENERATED_ACTION', `generated entry ${index} action is invalid`);
  if (typeof entry.checksum !== 'string' || entry.checksum.length === 0) {
    fail('ERR_GENERATED_CHECKSUM', `generated entry ${index} checksum is required`);
  }
  if (entry.kind === 'directory') {
    if (entry.treeChecksum !== undefined && (typeof entry.treeChecksum !== 'string' || entry.treeChecksum.length === 0)) {
      fail('ERR_GENERATED_TREE_CHECKSUM', `generated entry ${index} treeChecksum must be a non-empty string`);
    }
    if (entry.childFiles !== undefined && typeof entry.childFiles !== 'string') {
      fail('ERR_GENERATED_CHILD_FILES', `generated entry ${index} childFiles must be a string`);
    }
    if ((entry.treeChecksum === undefined) !== (entry.childFiles === undefined)) {
      fail('ERR_GENERATED_TREE_PAIR', `generated entry ${index} must have both treeChecksum and childFiles or neither`);
    }
  } else if (entry.treeChecksum !== undefined || entry.childFiles !== undefined) {
    fail('ERR_GENERATED_FILE_FIELDS', `generated entry ${index} file rows must not carry treeChecksum/childFiles`);
  }
}

function validateBackupEntry(entry, index) {
  if (!entry || typeof entry !== 'object') fail('ERR_BACKUP_ENTRY', `backups entry ${index} is malformed`);
  validateExactKeys(`backups entry ${index}`, entry, ['originalPath', 'backupPath', 'checksum']);
  requireString(entry.originalPath, `backups entry ${index} originalPath`);
  requireString(entry.backupPath, `backups entry ${index} backupPath`);
  requireString(entry.checksum, `backups entry ${index} checksum`);
}

function hasOwnershipMarker(directoryPath) {
  const markerPath = path.join(directoryPath, OWNERSHIP_MARKER);
  if (!fs.existsSync(markerPath)) return false;
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile()) return false;
  return fs.readFileSync(markerPath, 'utf8').includes(PACKAGE_NAME);
}

function codexSkillDirectoryFor(candidatePath, { platformRoots }) {
  const codexRoot = pathExists(platformRoots.codex)
    ? fs.realpathSync.native(platformRoots.codex)
    : path.resolve(platformRoots.codex);
  const resolvedPath = pathExists(candidatePath) ? fs.realpathSync.native(candidatePath) : path.resolve(candidatePath);
  const relative = path.relative(codexRoot, resolvedPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  if (parts[0] !== 'skills' || !parts[1] || !parts[1].startsWith('review-fix-')) return null;
  return path.join(codexRoot, 'skills', parts[1]);
}

function normalizeManifestInput(input) {
  if (input && typeof input === 'object' && Object.hasOwn(input, 'missing') && Object.hasOwn(input, 'manifest')) {
    return input;
  }
  return { missing: false, manifest: input };
}

function validateGeneratedRemoval(input, {
  homeDir = os.homedir(),
  platformRoots = defaultPlatformRoots(homeDir),
  expectedPlatform = null
} = {}) {
  const manifestRead = normalizeManifestInput(input);
  if (manifestRead.missing || !manifestRead.manifest) return { ok: true, missing: true, removable: [] };

  const manifest = normalizeManifestShape(manifestRead.manifest);
  validateSchema(manifest);
  if (expectedPlatform !== null) {
    assertPlatform(expectedPlatform);
    if (manifest.platform !== expectedPlatform) {
      fail('ERR_MANIFEST_PLATFORM_MISMATCH', 'install manifest platform does not match the requested platform');
    }
  }

  const sharedAssetsPath = expandDocumentedHomePath(manifest.sharedAssets.path, { homeDir, label: 'sharedAssets' });
  const capabilityDescriptorPath = canonicalCapabilityDescriptorPath(manifest, homeDir);

  const allowedRoots = manifest.allowedRoots.map((allowedRoot) => {
    if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
      fail('ERR_ALLOWED_ROOTS_ABSOLUTE', 'allowedRoots entries must be absolute canonical directories');
    }
    const realPath = realDirectory(allowedRoot, 'allowedRoots entry');
    if (path.resolve(allowedRoot) !== realPath) {
      fail('ERR_ALLOWED_ROOTS_CANONICAL', 'allowedRoots entries must be absolute canonical directories');
    }
    return realPath;
  });

  const skipped = [];
  const generatedEntries = [];
  for (let index = 0; index < manifest.generated.length; index += 1) {
    const entry = manifest.generated[index];
    validateGeneratedEntry(entry, index);
    const existingLstat = pathExists(entry.path) ? fs.lstatSync(entry.path) : null;
    if (existingLstat && existingLstat.isSymbolicLink()) {
      fail('ERR_REMOVE_SYMLINK', `refusing to remove symlink: ${entry.path}`);
    }
    const canonicalPath = canonicalGeneratedPath(entry.path);
    if (!allowedRoots.some((allowedRoot) => isInsideOrEqual(canonicalPath, allowedRoot))) {
      fail('ERR_OUTSIDE_ALLOWED_ROOTS', `generated path is outside allowed roots: ${entry.path}`);
    }
    if (!existingLstat) {
      skipped.push({
        path: entry.path,
        kind: entry.kind,
        removable: false,
        reason: 'missing'
      });
      continue;
    }
    generatedEntries.push({ entry, lstat: existingLstat, canonicalPath });
  }

  const removable = [];

  for (const { entry, lstat, canonicalPath } of generatedEntries) {
    const ownershipMarked = entry.kind === 'directory' && lstat.isDirectory() && hasOwnershipMarker(entry.path);
    const manifestRecorded = true;
    if (!platformAllowlist(manifest.platform, canonicalPath, { platformRoots, manifestRecorded, ownershipMarked })) {
      fail('ERR_PLATFORM_ALLOWLIST', `generated path does not match ${manifest.platform} route allowlist: ${entry.path}`);
    }

    if (entry.kind === 'directory') {
      if (!lstat.isDirectory()) fail('ERR_DIRECTORY_KIND', `generated path is not a directory: ${entry.path}`);
      if (!ownershipMarked) {
        fail('ERR_DIRECTORY_OWNERSHIP', `directory removal requires ownership marker; refusing non-owned directory: ${entry.path}`);
      }
      if (!directoryIsRemovable(entry, generatePlatformFiles)) {
        skipped.push({ path: entry.path, kind: 'directory', removable: false, reason: 'modified' });
        continue;
      }
    } else if (!lstat.isFile()) {
      fail('ERR_FILE_KIND', `generated path is not a file: ${entry.path}`);
    } else {
      if (entry.checksum !== 'none') {
        let currentChecksum;
        try {
          currentChecksum = sha256File(entry.path);
        } catch {
          skipped.push({ path: entry.path, kind: entry.kind, removable: false, reason: 'modified' });
          continue;
        }
        if (currentChecksum !== entry.checksum) {
          skipped.push({ path: entry.path, kind: entry.kind, removable: false, reason: 'modified' });
          continue;
        }
      }
      if (manifest.platform === 'codex') {
        const skillDirectory = codexSkillDirectoryFor(entry.path, { platformRoots });
        if (skillDirectory && !hasOwnershipMarker(skillDirectory)) {
          fail('ERR_DIRECTORY_OWNERSHIP', `Codex skill file removal requires ownership marker; refusing non-owned directory: ${skillDirectory}`);
        }
      }
    }

    removable.push({
      path: entry.path,
      canonicalPath,
      kind: entry.kind,
      action: entry.action
    });
  }

  return {
    ok: true,
    missing: false,
    sharedAssetsPath,
    capabilityDescriptor: {
      path: capabilityDescriptorPath,
      mutable: true
    },
    skipped,
    removable
  };
}

module.exports = {
  SCHEMA_VERSION,
  manifestPathForPlatform,
  serializeManifest,
  parseManifestText,
  writeInstallManifest,
  readInstallManifest,
  validateGeneratedRemoval,
  platformAllowlist,
  directoryTreeMetadata
};
