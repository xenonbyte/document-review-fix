'use strict';

// PLAN-TASK-003: PR target resolver + PR state-identity helpers.
//
// PURE / read-only by construction:
//   - resolveTargetContext() runs LOCAL read-only git plumbing and working-tree
//     content reads only. It NEVER fetches, pushes, mutates refs, or contacts a remote.
//   - The identity helpers (buildPrIdentity / format / parse / compare) are pure
//     functions over plain objects. No file-set MANIFEST.md is written here;
//     live persistence is PLAN-TASK-009.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { stableJson } = require('./workflow/serialization');
const { createDrfxignoreMatcher } = require('./drfxignore-matcher');
const { redactSensitive } = require('./redaction');
const { explicitRouteInvocation } = require('./routes');

const INVENTORY_HASH_CONCURRENCY = 16;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/');
}

// Read-only git plumbing allowlist. resolveTargetContext refuses to spawn any
// git subcommand outside this set, so a future edit cannot accidentally
// introduce fetch/push/remote/branch mutations.
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'rev-parse',
  'symbolic-ref',
  'merge-base',
  'diff',
  'ls-files'
]);

/**
 * Run a single read-only git command and resolve with { stdout, status }.
 * Records the full argv into commandLog (when provided) so tests can assert no
 * forbidden subcommand (fetch/push/...) was ever spawned.
 */
function runGit(args, { cwd, commandLog }) {
  const subcommand = args[0];
  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    fail('ERR_PR_GIT_SUBCOMMAND_FORBIDDEN', `refusing to run non-read-only git subcommand: ${subcommand}`);
  }
  if (Array.isArray(commandLog)) commandLog.push(['git', ...args].join(' '));
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, stdout: '', status: typeof error.code === 'number' ? error.code : 1 });
        return;
      }
      resolve({ ok: true, stdout, status: 0 });
    });
  });
}

async function resolveRevision(ref, ctx) {
  // `<ref>^{commit}` resolves branches, tags, and commit-ish revisions to a
  // commit sha, and fails for anything that is not a real local commit.
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], ctx);
  if (!result.ok) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

async function currentBranchName(ctx) {
  const result = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], ctx);
  if (!result.ok) return null; // detached HEAD
  const name = result.stdout.trim();
  return name === '' ? null : name;
}

function parseNameStatus(stdout, { nulDelimited = false } = {}) {
  if (nulDelimited) return parseNameStatusNul(stdout);
  const files = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (line === '') continue;
    const parts = line.split('\t');
    const code = parts[0];
    if (code.startsWith('R')) {
      // Rename: "R<score>\t<from>\t<to>"
      files.push({ path: parts[2], fromPath: parts[1], status: 'renamed' });
    } else if (code.startsWith('C')) {
      // Copy: "C<score>\t<from>\t<to>"
      files.push({ path: parts[2], fromPath: parts[1], status: 'copied' });
    } else if (code === 'A') {
      files.push({ path: parts[1], status: 'added' });
    } else if (code === 'D') {
      files.push({ path: parts[1], status: 'deleted' });
    } else if (code === 'M') {
      files.push({ path: parts[1], status: 'modified' });
    } else if (code === 'T') {
      files.push({ path: parts[1], status: 'type-changed' });
    } else {
      files.push({ path: parts[parts.length - 1], status: 'modified' });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function parseNameStatusNul(stdout) {
  const files = [];
  const fields = stdout.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    if (code.startsWith('R')) {
      const fromPath = fields[index++];
      const nextPath = fields[index++];
      if (!fromPath || !nextPath) fail('ERR_PR_DIFF_PARSE', 'malformed rename entry in PR diff');
      files.push({ path: nextPath, fromPath, status: 'renamed' });
    } else if (code.startsWith('C')) {
      const fromPath = fields[index++];
      const nextPath = fields[index++];
      if (!fromPath || !nextPath) fail('ERR_PR_DIFF_PARSE', 'malformed copy entry in PR diff');
      files.push({ path: nextPath, fromPath, status: 'copied' });
    } else {
      const filePath = fields[index++];
      if (!filePath) fail('ERR_PR_DIFF_PARSE', 'malformed path entry in PR diff');
      if (code === 'A') {
        files.push({ path: filePath, status: 'added' });
      } else if (code === 'D') {
        files.push({ path: filePath, status: 'deleted' });
      } else if (code === 'M') {
        files.push({ path: filePath, status: 'modified' });
      } else if (code === 'T') {
        files.push({ path: filePath, status: 'type-changed' });
      } else {
        files.push({ path: filePath, status: 'modified' });
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function gitBlobOid(buffer) {
  return crypto
    .createHash('sha1')
    .update(Buffer.from(`blob ${buffer.length}\0`))
    .update(buffer)
    .digest('hex');
}

function worktreeBlobSha(filePath, ctx) {
  const root = path.resolve(ctx.cwd || process.cwd());
  if (typeof filePath !== 'string' || filePath === '' || filePath.includes('\0')) {
    fail('ERR_PR_WORKTREE_PATH', 'unsafe PR diff path');
  }
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    fail('ERR_PR_WORKTREE_PATH', 'PR diff path must be project-relative');
  }
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('ERR_PR_WORKTREE_PATH', 'PR diff path must stay inside the project root');
  }

  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') return 'none';
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return gitBlobOid(Buffer.from(fs.readlinkSync(absolute)));
  }
  if (!stats.isFile()) return 'none';
  return gitBlobOid(fs.readFileSync(absolute));
}

/**
 * Resolve a PR target context from LOCAL git state only.
 *
 * @param {object} input
 * @param {string} input.routeName - must be 'review-fix-pr'
 * @param {string} input.base - base ref (branch / tag / commit-ish), local only
 * @param {string} input.cwd - repo working directory
 * @param {string[]} [input.commandLog] - optional sink for the git command log
 * @returns {Promise<object>} resolved PR context
 */
async function resolveTargetContext({ routeName, base, cwd, commandLog } = {}) {
  if (routeName !== 'review-fix-pr') {
    fail('ERR_PR_ROUTE', `resolveTargetContext only supports review-fix-pr, got: ${routeName}`);
  }
  const ctx = { cwd, commandLog };
  const baseRef = typeof base === 'string' ? base.trim() : '';
  if (baseRef === '') fail('ERR_PR_BASE_MISSING', 'review-fix-pr requires a base ref');

  const head = await resolveRevision('HEAD', ctx);
  if (!head) fail('ERR_PR_HEAD_UNRESOLVABLE', 'unable to resolve current HEAD commit');

  const currentBranch = await currentBranchName(ctx);
  if (currentBranch !== null && currentBranch === baseRef) {
    fail('ERR_PR_BASE_IS_CURRENT_BRANCH', `base cannot equal the current branch: ${baseRef}`);
  }

  const baseRevision = await resolveRevision(baseRef, ctx);
  if (!baseRevision) fail('ERR_PR_BASE_UNRESOLVABLE', `unable to resolve base ref to a local commit: ${baseRef}`);
  if (baseRevision === head) {
    fail('ERR_PR_BASE_IS_HEAD', `base cannot resolve to the current HEAD commit: ${baseRef}`);
  }

  const mergeBaseResult = await runGit(['merge-base', baseRevision, head], ctx);
  if (!mergeBaseResult.ok) fail('ERR_PR_NO_MERGE_BASE', `no merge base between ${baseRef} and HEAD`);
  const mergeBase = mergeBaseResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
    fail('ERR_PR_NO_MERGE_BASE', `no merge base between ${baseRef} and HEAD`);
  }

  const diffResult = await runGit(['diff', '--name-status', '-z', '--find-renames', `${mergeBase}..${head}`], ctx);
  if (!diffResult.ok) fail('ERR_PR_DIFF_FAILED', 'unable to compute PR diff between merge base and HEAD');
  const rawFiles = parseNameStatus(diffResult.stdout, { nulDelimited: true });

  const files = [];
  for (const entry of rawFiles) {
    // Per-file identity token for the file set. For PR routes this is the git
    // blob OID (40-hex) of the CURRENT WORKTREE content. Fix rounds are
    // intentionally uncommitted, so HEAD blobs would leave file-set state stale
    // after end-fix. Missing worktree paths use 'none'.
    const contentId = worktreeBlobSha(entry.path, ctx);
    files.push({ ...entry, contentId });
  }

  return {
    routeKind: 'pr',
    base: baseRef,
    baseRevision,
    head,
    mergeBase,
    currentBranch,
    files
  };
}

/**
 * Deterministic, order-independent fingerprint over a file set.
 * Each entry contributes { path, status, contentId }, where contentId is the
 * per-file identity token (a git blob OID for PR, a content hash for CODE).
 * Sorting + stableJson make the same logical set always hash to the same value.
 */
function computeFileSetFingerprint(files) {
  const canonical = (Array.isArray(files) ? files : [])
    .map((entry) => ({
      path: String(entry.path),
      status: String(entry.status || 'modified'),
      contentId: String(entry.contentId || 'none')
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash('sha256').update(stableJson(canonical)).digest('hex');
}

// ---------------------------------------------------------------------------
// CODE target resolver (PLAN-TASK-004)
//
// Deterministic working-tree traversal under in-root scopes, with mandatory
// exclusions for non-source / build / cache / temp directories, .drfxignore
// patterns, and version-ignored paths. Read-only: it reads file content +
// stats and runs only allowlisted read-only git plumbing (rev-parse /
// ls-files) for the version-ignore set — it never writes, never mutates git
// state, and never contacts a remote. Git absence is a supported mode. No
// new npm dependency — node:fs/node:path/node:crypto only.
// ---------------------------------------------------------------------------

// Whole-root (no narrowing scope) CODE review must stay verifiably readable.
// Over these limits the route blocks and asks for a narrower scope instead of
// claiming a full review it cannot prove. Tunable constants, not load-bearing.
const MAX_WHOLE_ROOT_FILES = 300;
const MAX_WHOLE_ROOT_BYTES = 1_500_000;

// Mandatory exclusions for CODE source discovery. Owned here (single source of
// truth) and EXPORTED so route descriptors/prompts reference it instead of
// duplicating the list. These are working-tree directory basenames pruned at
// every traversal level. This is intentionally distinct from
// target-state.js's RESERVED_DIRECTORIES (which names .drfx-internal
// subdirs): CODE excludes the whole current/legacy state tree plus VCS,
// dependency, build-output, cache, and temp directories from source review.
const CODE_EXCLUDED_DIRECTORIES = Object.freeze(new Set([
  // VCS + this tool's own current/legacy state trees
  '.git',
  '.hg',
  '.svn',
  '.drfx',
  '.docs-review-fix',
  // Local agent/tool state and generated workflow artifacts
  '.claude',
  '.codex',
  '.codegraph',
  '.gemini',
  '.opencode',
  '.req-to-plan',
  // dependency trees + language/package caches
  'node_modules',
  'bower_components',
  'vendor',
  '.pnp',
  '.yarn',
  '.pnpm-store',
  '.gradle',
  '.m2',
  // build / distribution outputs
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  // coverage + test/build caches
  'coverage',
  '.nyc_output',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  // temp / OS / editor scratch
  'tmp',
  'temp',
  '.tmp',
  '.idea',
  '.vscode'
]));

const CODE_EXCLUDED_DIRECTORY_PATHS = Object.freeze(new Set([
  '.config/opencode'
]));

// Excluded working-tree FILE basenames (OS/editor scratch files). Unlike the
// directory set above, these are matched against regular files during traversal
// so they never enter the CODE file set or its fingerprint.
const CODE_EXCLUDED_FILES = Object.freeze(new Set([
  '.DS_Store',
  'Thumbs.db'
]));

function hasCodeExcludedDirectory(relativePath) {
  const segments = String(relativePath || '').split('/').filter(Boolean);
  for (const segment of segments) {
    if (CODE_EXCLUDED_DIRECTORIES.has(segment)) return true;
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (CODE_EXCLUDED_DIRECTORY_PATHS.has(`${segments[index]}/${segments[index + 1]}`)) return true;
  }
  return false;
}

function codeExcludedDirectoryEntries() {
  return [...CODE_EXCLUDED_DIRECTORIES, ...CODE_EXCLUDED_DIRECTORY_PATHS].sort();
}

function isExcludedFile(basename) {
  return CODE_EXCLUDED_FILES.has(basename);
}

// ---------------------------------------------------------------------------
// User-level CODE exclusions (.drfxignore) + version ignores (git)
//
// A project may carry a `.drfxignore` file at the project root. Its syntax
// IS gitignore syntax (comments, blank lines, `!` negation with
// last-match-wins, `/` anchoring, trailing-`/` directory-only patterns,
// `*` / `?` / `[...]` / `**` globs) — see lib/drfxignore-matcher.js. Only the
// root file is read (no nested ignore files).
//
// Independently, files the VERSION CONTROL system ignores are excluded from
// CODE review: one read-only `git ls-files --others --ignored
// --exclude-standard --directory` query captures the full gitignore stack
// (nested .gitignore files, the global excludes file, .git/info/exclude),
// with git's own semantics — tracked files are never version-ignored. In a
// non-git root the version-ignore source is simply absent (.drfxignore still
// applies), keeping CODE review usable without git.
//
// Explicit scope= ALWAYS wins: a walk root (directory scope) or file scope
// is never pruned by either source; only paths reached DURING traversal are
// tested. Scopes that an ignore source would have covered are reported as
// scopeIgnoreOverrides, never silently re-included.
// ---------------------------------------------------------------------------
const DRFXIGNORE_FILENAME = '.drfxignore';

function digestUserExcludePattern(pattern) {
  return crypto
    .createHash('sha256')
    .update('drfxignore-pattern\0')
    .update(String(pattern))
    .digest('hex');
}

function digestUserExcludePatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : []).map((pattern) => digestUserExcludePattern(pattern));
}

function redactUserExcludePatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : []).map((pattern) => redactSensitive(String(pattern)));
}

// Load the project's .drfxignore as a gitignore-syntax matcher.
// Missing file ⇒ null matcher + empty pattern list. A symlinked .drfxignore
// is refused outright (matching the repo-wide symlink posture): strict mode
// throws; lenient (identity-only) mode returns the empty form because key
// derivation must never throw — the resolver reports the actionable error.
function loadUserExcludeMatcher(rootRealPath, { lenient = false } = {}) {
  const empty = { matcher: null, patterns: [], patternDigests: [], redactedPatterns: [] };
  const ignorePath = path.join(rootRealPath, DRFXIGNORE_FILENAME);
  let configStats;
  try {
    configStats = fs.lstatSync(ignorePath);
  } catch {
    return empty;
  }
  if (configStats.isSymbolicLink()) {
    if (lenient) return empty;
    fail(
      'ERR_CODE_USER_EXCLUDE_CONFIG_SYMLINK',
      `${DRFXIGNORE_FILENAME} must be a regular file, not a symlink`
    );
  }
  if (!configStats.isFile()) {
    if (lenient) return empty;
    fail(
      'ERR_CODE_USER_EXCLUDE_CONFIG_NOT_FILE',
      `${DRFXIGNORE_FILENAME} must be a regular file`
    );
  }
  let content;
  try {
    content = fs.readFileSync(ignorePath, 'utf8');
  } catch {
    if (!lenient) {
      fail(
        'ERR_CODE_USER_EXCLUDE_CONFIG_UNREADABLE',
        `unable to read ${DRFXIGNORE_FILENAME}`
      );
    }
    return empty;
  }
  const matcher = createDrfxignoreMatcher(content);
  if (matcher.patterns.length === 0) return empty;
  return {
    matcher,
    patterns: matcher.patterns,
    patternDigests: digestUserExcludePatterns(matcher.patterns),
    redactedPatterns: redactUserExcludePatterns(matcher.patterns)
  };
}

// Resolve the set of version-ignored paths under the CODE root via ONE
// read-only git query. `--directory` collapses fully-ignored directories to
// a single `dir/` entry, so the result stays small even with huge ignored
// trees. Returns { source: 'git'|'none', directoryPrefixes, files } —
// 'none' means no usable git worktree (or git itself failed), which is a
// supported mode, not an error.
async function resolveVersionIgnores(rootRealPath, { commandLog } = {}) {
  const empty = { source: 'none', directoryPrefixes: new Set(), files: new Set() };
  const ctx = { cwd: rootRealPath, commandLog };
  const inWorktree = await runGit(['rev-parse', '--is-inside-work-tree'], ctx);
  if (!inWorktree.ok || inWorktree.stdout.trim() !== 'true') return empty;
  const listed = await runGit(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
    ctx
  );
  if (!listed.ok) return empty;
  const directoryPrefixes = new Set();
  const files = new Set();
  for (const entry of listed.stdout.split('\0')) {
    if (entry === '') continue;
    if (entry.endsWith('/')) {
      directoryPrefixes.add(entry.replace(/\/+$/, ''));
    } else {
      files.add(entry);
    }
  }
  return { source: 'git', directoryPrefixes, files };
}

// Is a root-relative path covered by the version-ignore result (exactly a
// collapsed directory, inside one, or a directly ignored file)?
function isVersionIgnored(versionIgnores, relativePath, isDirectory) {
  if (!isDirectory && versionIgnores.files.has(relativePath)) return true;
  for (const prefix of versionIgnores.directoryPrefixes) {
    if (relativePath === prefix || relativePath.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

function isUserIgnoredOrInsideIgnoredParent(userMatcher, relativePath, isDirectory) {
  if (!userMatcher) return false;
  if (userMatcher.ignores(relativePath, isDirectory)) return true;
  const segments = relativePath.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join('/');
    if (userMatcher.ignores(parent, true)) return true;
  }
  return false;
}

// Scope-wins view of the version-ignore set for ONE walk root: directory
// prefixes that cover the walk root itself are disabled (explicitly scoping
// INTO a version-ignored directory reviews it), while prefixes for DEEPER
// independently-ignored directories keep pruning.
function versionIgnoresForWalkRoot(versionIgnores, walkRoot) {
  if (!versionIgnores || walkRoot === '') return versionIgnores;
  const covering = [...versionIgnores.directoryPrefixes].filter(
    (prefix) => walkRoot === prefix || walkRoot.startsWith(`${prefix}/`)
  );
  if (covering.length === 0) return versionIgnores;
  const directoryPrefixes = new Set(versionIgnores.directoryPrefixes);
  for (const prefix of covering) directoryPrefixes.delete(prefix);
  return { source: versionIgnores.source, directoryPrefixes, files: versionIgnores.files };
}

// Resolve a requested scope to a real, in-root, posix root-relative path.
// Throws a coded error for missing / outside-root / symlink-escaping scopes.
function resolveScope(rootRealPath, scope) {
  const raw = typeof scope === 'string' ? scope.trim() : '';
  if (raw === '') fail('ERR_CODE_SCOPE_MISSING', 'review-fix-code scope must not be empty');

  const absolute = path.resolve(rootRealPath, raw);
  // Lexical escape check FIRST: a scope whose normalized form steps outside the
  // root (via `..` or an absolute path) is rejected as outside-root regardless
  // of whether the escaping path happens to exist on disk.
  const lexicalRelative = path.relative(rootRealPath, absolute);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
    fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
  }
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    fail('ERR_CODE_SCOPE_MISSING', `scope path must exist: ${scope}`);
  }
  // Reject a scope that IS a symlink up front; we never traverse through one.
  if (stats.isSymbolicLink()) {
    const linkReal = fs.realpathSync.native(absolute);
    if (!isInsideOrEqualRoot(rootRealPath, linkReal)) {
      fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
    }
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(absolute);
  } catch {
    fail('ERR_CODE_SCOPE_MISSING', `scope path must exist: ${scope}`);
  }
  if (!isInsideOrEqualRoot(rootRealPath, realPath)) {
    fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
  }
  // A scope names a directory to walk or a single regular file to include
  // directly. Anything else (device/fifo/socket) fails loudly.
  const realStats = fs.statSync(realPath);
  if (!realStats.isDirectory() && !realStats.isFile()) {
    fail('ERR_CODE_SCOPE_NOT_DIRECTORY', `scope must be a directory or regular file: ${scope}`);
  }

  const relative = path.relative(rootRealPath, realPath);
  // Empty relative ⇒ the scope is the root itself ⇒ treat as whole-root (no scope).
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('ERR_CODE_SCOPE_OUTSIDE_ROOT', `scope resolves outside project root: ${scope}`);
  }
  return relative.split(path.sep).join('/');
}

function isInsideOrEqualRoot(rootRealPath, candidateRealPath) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Walk one directory (root-relative posix prefix) and append regular-file
// entries to `out`. Pruned/skipped during traversal: built-in excluded
// basenames, .drfxignore pattern matches, and version-ignored paths. Walk
// ROOTS are never tested here (explicit scope= always wins). Symlinks are
// never followed (so an escaping link can never leak content outside the
// root); device / fifo / socket files are skipped. The whole-root cap counts
// only files that SURVIVE every ignore source.
function walkDirectory(rootRealPath, relativePrefix, out, wholeRootStats, ignoreContext) {
  if (wholeRootStats && wholeRootStats.blocked) return;
  const absoluteDir = relativePrefix === '' ? rootRealPath : path.join(rootRealPath, relativePrefix);
  let dirents;
  try {
    dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    const displayPath = relativePrefix === '' ? '.' : relativePrefix;
    fail('ERR_CODE_SCOPE_UNREADABLE', `unable to read in-scope directory: ${displayPath}`);
  }
  const userMatcher = ignoreContext ? ignoreContext.userMatcher : null;
  const versionIgnores = ignoreContext ? ignoreContext.versionIgnores : null;
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const dirent of dirents) {
    const name = dirent.name;
    const childRelative = relativePrefix === '' ? name : `${relativePrefix}/${name}`;
    if (dirent.isSymbolicLink()) {
      // Never follow symlinks: they can escape the root and break determinism.
      continue;
    }
    if (dirent.isDirectory()) {
      if (hasCodeExcludedDirectory(childRelative)) continue;
      if (userMatcher && userMatcher.ignores(childRelative, true)) continue;
      if (versionIgnores && isVersionIgnored(versionIgnores, childRelative, true)) continue;
      walkDirectory(rootRealPath, childRelative, out, wholeRootStats, ignoreContext);
      if (wholeRootStats && wholeRootStats.blocked) return;
    } else if (dirent.isFile()) {
      if (isExcludedFile(name)) continue;
      if (userMatcher && userMatcher.ignores(childRelative, false)) continue;
      if (versionIgnores && isVersionIgnored(versionIgnores, childRelative, false)) continue;
      if (wholeRootStats) {
        wholeRootStats.fileCount += 1;
        wholeRootStats.totalBytes += fs.statSync(path.join(rootRealPath, childRelative)).size;
        if (
          wholeRootStats.fileCount > MAX_WHOLE_ROOT_FILES ||
          wholeRootStats.totalBytes > MAX_WHOLE_ROOT_BYTES
        ) {
          wholeRootStats.blocked = true;
          return;
        }
      }
      out.push(childRelative);
    }
    // Anything else (device/fifo/socket) is skipped.
  }
}

function hashFileContent(absolutePath) {
  const content = fs.readFileSync(absolutePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// PLAN-TASK-002: Whole-tree uncapped inventory builder (resolveCodeInventory)
//
// streamingContentId: async streaming sha256 over a file's raw bytes via
// fs.createReadStream. Produces a byte-identical digest to hashFileContent for
// the same file (sha256 over the same byte sequence) — frozen identity
// namespace (SCOPE-OUT-003). Streaming avoids loading the entire file into a
// single Buffer for large files (anti-OOM intent).
//
// resolveCodeInventory: reuses the same lower-level helpers as resolveCodeTarget
// (resolveScope / loadUserExcludeMatcher / resolveVersionIgnores /
// versionIgnoresForWalkRoot / walkDirectory) so .drfxignore / version-ignore /
// scope-wins behave identically. Differs in three ways:
//   (a) wholeRootStats=null — walk is UNCAPPED (no 300-file / 1.5MB gate)
//   (b) inventory row shape {path, size, ext, contentId} with streaming contentId
//   (c) projectReviewFingerprint computed over sorted {path, contentId} rows
//
// Design decision: SIBLING approach — resolveCodeInventory calls the same
// lower-level helpers directly rather than extracting a shared helper.
// Rationale: the scope-normalization + ignore-setup + walk block inside
// resolveCodeTarget is subtle (blocked/excluded-scope early returns, file-scope
// special-casing, version-ignore scope-wins). Extracting it would risk changing
// resolveCodeTarget's return value; a clean sibling using the same primitives
// is demonstrably safe and leaves resolveCodeTarget byte-identical.
//
// Fingerprint construction (CONTROLLER DECISION):
//   projectReviewFingerprint = sha256(JSON(sorted [{path, contentId}]))
// The path is identity-bearing: a rename or move can change module behavior even
// when bytes are identical, so drift detection must not key on content alone.
// This mirrors computeFileSetFingerprint's projection of path + content identity.
// ---------------------------------------------------------------------------

/**
 * Async streaming sha256 hash of a file — byte-identical to hashFileContent
 * but avoids loading the whole file into one Buffer (anti-OOM for large files).
 * @param {string} absolutePath
 * @returns {Promise<string>} lowercase hex sha256
 */
function streamingContentId(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absolutePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(1, limit), items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Root-relative POSIX extension of a path (e.g. '.js', '.md', '' for no-ext).
 * @param {string} relativePath
 * @returns {string}
 */
function extOf(relativePath) {
  return path.extname(relativePath);
}

/**
 * File size in bytes for an absolute path. Returns 0 on stat failure (treated
 * as empty / unreadable) — resolveCodeInventory already walked the file so it
 * exists, but a defensive 0 avoids a hard throw during mapping.
 * @param {string} absolutePath
 * @returns {number}
 */
function statSize(absolutePath) {
  try {
    return fs.statSync(absolutePath).size;
  } catch {
    return 0;
  }
}

/**
 * Compute the projectReviewFingerprint from an inventory array.
 * Algorithm: sort inventory by path, project {path, contentId}, JSON stringify,
 * then sha256 the result. Sorting makes the fingerprint order-independent over
 * directory-read order while still detecting path drift.
 * @param {Array<{path:string, contentId:string}>} inventory
 * @returns {string} lowercase hex sha256
 */
function computeProjectReviewFingerprint(inventory) {
  const rows = (Array.isArray(inventory) ? inventory : [])
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((row) => ({
      path: String(row.path),
      contentId: String(row.contentId)
    }));
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Resolve a whole-tree UNCAPPED CODE inventory for partitioned project review.
 *
 * Reuses the same scope-normalization, ignore-loading, and walk machinery as
 * resolveCodeTarget, but passes wholeRootStats=null so the walk is never
 * cap-truncated. Returns the pre-partition inventory rows and a fingerprint.
 *
 * @param {object} input
 * @param {string} input.cwd - project root working directory
 * @param {string[]} [input.scopes] - optional in-root scope paths (same semantics
 *   as resolveCodeTarget); empty ⇒ whole project root (uncapped).
 * @param {string[]} [input.commandLog] - optional sink recording spawned git argv.
 * @returns {Promise<{inventory: Array<{path,size,ext,contentId}>, projectReviewFingerprint: string,
 *   userExcludes: string[]}>} userExcludes are the ordered .drfxignore pattern digests.
 */
async function resolveCodeInventory({ cwd, scopes, commandLog } = {}) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(cwd || '.'));
  } catch {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code requires an existing project root');
  }
  if (!fs.statSync(rootRealPath).isDirectory()) {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code project root must be a directory');
  }

  // --- Scope normalization (identical to resolveCodeTarget) ---
  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const normalizedSet = new Set();
  const scopeKinds = new Map();
  let rootScopeRequested = false;
  for (const scope of requestedScopes) {
    const relative = resolveScope(rootRealPath, scope);
    if (relative === '') {
      rootScopeRequested = true;
      normalizedSet.clear();
      scopeKinds.clear();
      continue;
    }
    const isDirectory = fs.statSync(path.join(rootRealPath, relative)).isDirectory();
    // Refuse a scope that IS, or descends into, a built-in excluded directory.
    const segments = relative.split('/');
    const testPath = isDirectory ? relative : segments.slice(0, -1).join('/');
    if (hasCodeExcludedDirectory(testPath)) {
      return { status: 'blocked', reason: 'excluded-scope', scope: relative };
    }
    if (!isDirectory && isExcludedFile(path.basename(relative))) {
      return { status: 'blocked', reason: 'excluded-scope', scope: relative };
    }
    if (!rootScopeRequested) {
      normalizedSet.add(relative);
      scopeKinds.set(relative, isDirectory ? 'directory' : 'file');
    }
  }

  const normalizedScopes = [...normalizedSet].sort();
  const wholeRoot = normalizedScopes.length === 0;
  const walkRoots = wholeRoot
    ? ['']
    : normalizedScopes.filter((scopeRelative) => scopeKinds.get(scopeRelative) === 'directory');
  const fileScopeRoots = wholeRoot
    ? []
    : normalizedScopes.filter((scopeRelative) => scopeKinds.get(scopeRelative) === 'file');

  // --- Ignore sources (identical to resolveCodeTarget) ---
  // patternDigests are the ordered (negation-order-significant) sha256 digests of the
  // raw .drfxignore pattern lines; raw pattern text never leaves this module. They join
  // the partitioned CODE identity so a rule-only change (one that does not move the
  // content fingerprint, e.g. a git-ignored .drfxignore edit) is still detected on resume.
  const { matcher: userMatcher, patternDigests: userExcludes } = loadUserExcludeMatcher(rootRealPath);
  const versionIgnores = await resolveVersionIgnores(rootRealPath, { commandLog });
  const activeVersionIgnores = versionIgnores.source === 'git' ? versionIgnores : null;

  // --- Walk (UNCAPPED: wholeRootStats=null) ---
  const seen = new Set();
  const relativeFiles = [];
  for (const scopeRelative of walkRoots) {
    const ignoreContext = {
      userMatcher,
      versionIgnores: versionIgnoresForWalkRoot(activeVersionIgnores, scopeRelative)
    };
    // wholeRootStats=null => cap branch in walkDirectory is skipped entirely.
    walkDirectory(rootRealPath, scopeRelative, relativeFiles, null, ignoreContext);
  }
  // File scopes bypass all ignore sources (scope always wins).
  for (const fileRoot of fileScopeRoots) {
    relativeFiles.push(fileRoot);
  }
  for (const relative of relativeFiles) {
    if (seen.has(relative)) continue;
    seen.add(relative);
  }

  // --- Build inventory rows (sorted by path) with streaming contentId ---
  const sortedRelatives = [...seen].sort();
  const inventory = await mapWithConcurrency(
    sortedRelatives,
    INVENTORY_HASH_CONCURRENCY,
    async (relative) => {
      const absolutePath = path.join(rootRealPath, relative);
      const size = statSize(absolutePath);
      const ext = extOf(relative);
      const contentId = await streamingContentId(absolutePath);
      return { path: relative, size, ext, contentId };
    }
  );

  const projectReviewFingerprint = computeProjectReviewFingerprint(inventory);

  return { inventory, projectReviewFingerprint, userExcludes };
}

/**
 * Resolve a CODE target context from the local working tree.
 *
 * @param {object} input
 * @param {string} input.cwd - project root working directory
 * @param {string[]} [input.scopes] - optional repeated in-root scope paths
 *   (directories are walked; regular files are included directly);
 *   empty ⇒ whole project root.
 * @param {string[]} [input.commandLog] - optional sink recording spawned git argv.
 * @returns {Promise<object>} { routeKind:'code', normalizedScopes, exclusions,
 *   userExcludes, userExcludePatterns, scopeIgnoreOverrides, versionIgnoreSource, files } or
 *   { status:'blocked', reason:'excluded-scope', ... } when a scope IS an
 *   excluded directory.
 */
async function resolveCodeTarget({ cwd, scopes, commandLog } = {}) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(cwd || '.'));
  } catch {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code requires an existing project root');
  }
  if (!fs.statSync(rootRealPath).isDirectory()) {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code project root must be a directory');
  }

  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const normalizedSet = new Set();
  const scopeKinds = new Map();
  let rootScopeRequested = false;
  for (const scope of requestedScopes) {
    const relative = resolveScope(rootRealPath, scope);
    if (relative === '') {
      // The root itself means whole-project traversal and covers any narrower
      // scopes collected before it.
      rootScopeRequested = true;
      normalizedSet.clear();
      scopeKinds.clear();
      continue;
    }
    const isDirectory = fs.statSync(path.join(rootRealPath, relative)).isDirectory();
    // Refuse a scope that IS, or descends into, a built-in excluded directory
    // at ANY path segment (e.g. `node_modules` or `node_modules/foo`) before
    // review starts — the walk root itself cannot be pruned by walkDirectory.
    // A FILE scope tests its parent segments only: a regular file may share a
    // name with an excluded DIRECTORY (e.g. a file literally named `build`).
    // Excluded FILE basenames are refused separately below.
    const segments = relative.split('/');
    const testPath = isDirectory ? relative : segments.slice(0, -1).join('/');
    if (hasCodeExcludedDirectory(testPath)) {
      return { status: 'blocked', reason: 'excluded-scope', scope: relative };
    }
    if (!isDirectory && isExcludedFile(path.basename(relative))) {
      return { status: 'blocked', reason: 'excluded-scope', scope: relative };
    }
    if (!rootScopeRequested) {
      normalizedSet.add(relative);
      scopeKinds.set(relative, isDirectory ? 'directory' : 'file');
    }
  }

  const normalizedScopes = [...normalizedSet].sort();
  const wholeRoot = normalizedScopes.length === 0;
  const walkRoots = wholeRoot
    ? ['']
    : normalizedScopes.filter((scopeRelative) => scopeKinds.get(scopeRelative) === 'directory');
  const fileScopeRoots = wholeRoot
    ? []
    : normalizedScopes.filter((scopeRelative) => scopeKinds.get(scopeRelative) === 'file');
  const wholeRootStats = wholeRoot
    ? { fileCount: 0, totalBytes: 0, blocked: false }
    : null;

  // Both ignore sources resolve BEFORE the walk: .drfxignore patterns and the
  // git version-ignore set prune traversal, so the whole-root cap counts only
  // surviving files. Explicit scope roots are exempt by construction (the walk
  // never tests its own roots; file scopes are appended directly).
  const {
    matcher: userMatcher,
    patternDigests: userExcludes,
    redactedPatterns: userExcludePatterns
  } = loadUserExcludeMatcher(rootRealPath);
  const versionIgnores = await resolveVersionIgnores(rootRealPath, { commandLog });
  const activeVersionIgnores = versionIgnores.source === 'git' ? versionIgnores : null;

  // Scope-wins visibility: report every explicit scope an ignore source would
  // have covered — it is reviewed anyway, but never silently.
  const scopeIgnoreOverrides = normalizedScopes.filter((scopeRelative) => {
    const isDirectory = scopeKinds.get(scopeRelative) === 'directory';
    if (isUserIgnoredOrInsideIgnoredParent(userMatcher, scopeRelative, isDirectory)) return true;
    return versionIgnores.source === 'git' && isVersionIgnored(versionIgnores, scopeRelative, isDirectory);
  });

  const seen = new Set();
  const relativeFiles = [];
  for (const scopeRelative of walkRoots) {
    const ignoreContext = {
      userMatcher,
      versionIgnores: versionIgnoresForWalkRoot(activeVersionIgnores, scopeRelative)
    };
    walkDirectory(rootRealPath, scopeRelative, relativeFiles, wholeRootStats, ignoreContext);
    if (wholeRootStats && wholeRootStats.blocked) {
      return {
        status: 'blocked',
        reason: 'file-set-too-large',
        fileCount: wholeRootStats.fileCount,
        totalBytes: wholeRootStats.totalBytes
      };
    }
  }
  // File scopes are explicit review intent: include them regardless of any
  // ignore source (rule: scope always wins).
  for (const fileRoot of fileScopeRoots) {
    relativeFiles.push(fileRoot);
  }
  for (const relative of relativeFiles) {
    if (seen.has(relative)) continue;
    seen.add(relative);
  }

  const files = [...seen]
    .sort()
    .map((relative) => ({
      path: relative,
      status: 'present',
      contentId: hashFileContent(path.join(rootRealPath, relative))
    }));

  return {
    routeKind: 'code',
    normalizedScopes,
    exclusions: codeExcludedDirectoryEntries(),
    userExcludes,
    userExcludePatterns,
    scopeIgnoreOverrides,
    versionIgnoreSource: versionIgnores.source,
    files
  };
}

// Ordered identity fields. This order is also the manifest field order for the
// PR/file-set branch so format/parse stay deterministic.
const PR_IDENTITY_FIELDS = Object.freeze([
  ['targetContextKind', 'Target context kind'],
  ['base', 'Base'],
  ['baseRevision', 'Base revision'],
  ['mergeBase', 'Merge base'],
  ['head', 'Head'],
  ['guardMode', 'Guard mode'],
  ['roundLimit', 'Round limit'],
  ['fileSetFingerprint', 'File set fingerprint']
]);

/**
 * Build a PR identity object from a resolved context + guard mode + round limit.
 * roundLimit is stored as a string ('none' when unset) so it round-trips
 * through the text manifest and compares strictly.
 */
function buildPrIdentity({ context, guardMode, roundLimit } = {}) {
  if (!context || context.routeKind !== 'pr') {
    fail('ERR_PR_IDENTITY', 'buildPrIdentity requires a resolved pr context');
  }
  return {
    targetContextKind: 'pr',
    base: String(context.base),
    baseRevision: String(context.baseRevision),
    mergeBase: String(context.mergeBase),
    head: String(context.head),
    guardMode: String(guardMode),
    roundLimit: roundLimit === null || roundLimit === undefined ? 'none' : String(roundLimit),
    fileSetFingerprint: computeFileSetFingerprint(context.files)
  };
}

function formatPrIdentityFields(identity) {
  const fields = {};
  for (const [key] of PR_IDENTITY_FIELDS) {
    fields[key] = identity[key];
  }
  return fields;
}

function parsePrIdentityFields(fields) {
  const identity = {};
  for (const [key] of PR_IDENTITY_FIELDS) {
    identity[key] = fields[key];
  }
  return identity;
}

/**
 * Compare a stored PR identity against a requested one for explicit resume.
 * STRICT equality on every identity field; ANY drift (including roundLimit)
 * makes the stored state stale. Returns { match, mismatches:[...] }.
 */
function comparePrIdentity({ stored, requested } = {}) {
  const mismatches = [];
  for (const [key] of PR_IDENTITY_FIELDS) {
    if (String(stored && stored[key]) !== String(requested && requested[key])) {
      mismatches.push(key);
    }
  }
  return { match: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// CODE identity helpers (PLAN-TASK-004) — PURE, mirror the PR helpers.
//
// Scalar fields compare like PR. The scope/exclusion LIST fields are sorted
// before serialize/compare so list ordering never causes false staleness.
// ---------------------------------------------------------------------------

// Scalar identity fields (ordered). The scope/exclusion lists are handled
// separately as list fields, so they are NOT in this scalar list.
const CODE_IDENTITY_SCALAR_FIELDS = Object.freeze([
  ['targetContextKind', 'Target context kind'],
  ['guardMode', 'Guard mode'],
  ['roundLimit', 'Round limit'],
  ['fileSetFingerprint', 'File set fingerprint']
]);
const CODE_IDENTITY_LIST_FIELDS = Object.freeze(['normalizedScopes', 'exclusions', 'userExcludes']);

function sortedStringList(value) {
  return (Array.isArray(value) ? value : []).map((entry) => String(entry)).sort();
}

// Map a blocked CODE resolution to a user-facing message + next action. Keeps
// every CODE blocked exit reason-aware instead of hardcoding excluded-scope.
function describeCodeBlock(context) {
  if (context && context.reason === 'file-set-too-large') {
    // The counts are EARLY-TERMINATION values: traversal stops the moment the
    // cap is crossed, so the real file set is "at least" this large — wording
    // must not suggest the project is only marginally over the limit.
    return {
      message: `file-set-too-large: at least ${context.fileCount} files / ${context.totalBytes}+ bytes (counting stopped at the cap) exceed the whole-root review limit (max ${MAX_WHOLE_ROOT_FILES} files, ${MAX_WHOLE_ROOT_BYTES} bytes)`,
      nextAction: `pass scope=<path> to narrow the review, or add ignore patterns to ${DRFXIGNORE_FILENAME} to shrink the whole-root file set`
    };
  }
  // Only two blocked reasons exist today (file-set-too-large above, excluded-scope
  // here). Add a dedicated branch when a new blocked reason is introduced so it is
  // not silently misreported as excluded-scope.
  return {
    message: `excluded-scope: ${context && context.scope}`,
    nextAction: 'choose a source scope outside built-in exclusions'
  };
}

function normalizeCodeScopesForIdentity({ cwd, scopes } = {}) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(cwd || '.'));
  } catch {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code requires an existing project root');
  }
  if (!fs.statSync(rootRealPath).isDirectory()) {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code project root must be a directory');
  }

  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const normalizedSet = new Set();
  let rootScopeRequested = false;
  for (const scope of requestedScopes) {
    // Identity-only normalization must NEVER throw on an invalid scope. The target-state key
    // is derived before the resolver enforces scope validity, so an unsafe/outside-root scope
    // must not surface here as an uncaught throw (which would diverge from the excluded-scope
    // case that returns a clean blocked result). Fall back to the raw token: the invalid scope
    // still yields a deterministic (throwaway) key, and the resolver layer reports the scope
    // error uniformly as a clean blocked result. Valid equivalent spellings still collapse.
    let relative;
    try {
      relative = resolveScope(rootRealPath, scope);
    } catch {
      relative = String(scope == null ? '' : scope).trim();
    }
    if (relative === '') {
      rootScopeRequested = true;
      normalizedSet.clear();
      continue;
    }
    if (!rootScopeRequested) normalizedSet.add(relative);
  }
  return [...normalizedSet].sort();
}

// Identity-only counterpart of the resolver's .drfxignore handling: ordered
// sha256 digests of normalized pattern lines. Lenient like
// normalizeCodeScopesForIdentity — a problematic .drfxignore (e.g. a symlink)
// must yield a deterministic (empty) result here, never an uncaught throw;
// the resolver layer reports the actionable error. Digests are used because
// raw pattern text may contain sensitive strings and workflow state/output must
// remain redacted while keeping strict identity stable.
function normalizeCodeUserExcludesForIdentity({ cwd } = {}) {
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(cwd || '.'));
  } catch {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code requires an existing project root');
  }
  if (!fs.statSync(rootRealPath).isDirectory()) {
    fail('ERR_CODE_ROOT_MISSING', 'review-fix-code project root must be a directory');
  }
  return loadUserExcludeMatcher(rootRealPath, { lenient: true }).patternDigests;
}

// Ordered string list WITHOUT sorting — for the userExcludes digest list, where
// order is semantic (gitignore negation is last-match-wins).
function orderedStringList(value) {
  return (Array.isArray(value) ? value : []).map((entry) => String(entry));
}

/**
 * Build a CODE identity from a resolved code context + guard mode + round
 * limit. Scope/exclusion lists are sorted so identity is order-stable;
 * userExcludes preserves ordered .drfxignore pattern digests (negation order
 * matters, raw pattern text must not be persisted).
 */
function buildCodeIdentity({ context, guardMode, roundLimit } = {}) {
  if (!context || context.routeKind !== 'code') {
    fail('ERR_CODE_IDENTITY', 'buildCodeIdentity requires a resolved code context');
  }
  return {
    targetContextKind: 'code',
    normalizedScopes: sortedStringList(context.normalizedScopes),
    exclusions: sortedStringList(context.exclusions),
    userExcludes: orderedStringList(context.userExcludes),
    guardMode: String(guardMode),
    roundLimit: roundLimit === null || roundLimit === undefined ? 'none' : String(roundLimit),
    fileSetFingerprint: computeFileSetFingerprint(context.files)
  };
}

// Per-field list normalization: sorted for path lists, ordered for patterns.
function normalizeCodeIdentityList(key, value) {
  return key === 'userExcludes' ? orderedStringList(value) : sortedStringList(value);
}

function formatCodeIdentityFields(identity) {
  const fields = {};
  for (const [key] of CODE_IDENTITY_SCALAR_FIELDS) {
    fields[key] = identity[key];
  }
  for (const key of CODE_IDENTITY_LIST_FIELDS) {
    fields[key] = normalizeCodeIdentityList(key, identity[key]);
  }
  return fields;
}

function parseCodeIdentityFields(fields) {
  const identity = {};
  for (const [key] of CODE_IDENTITY_SCALAR_FIELDS) {
    identity[key] = fields[key];
  }
  for (const key of CODE_IDENTITY_LIST_FIELDS) {
    identity[key] = normalizeCodeIdentityList(key, fields[key]);
  }
  return identity;
}

/**
 * Compare a stored CODE identity against a requested one for explicit resume.
 * Round limit, guard mode, scopes, and the actual file-set fingerprint remain
 * strict. Exclusions are versioned resolver policy; when the live file set is
 * identical, additive/default exclusion drift alone must not strand resumable
 * state. User excludes (.drfxignore) are explicit user intent, NOT resolver
 * policy: they stay STRICT like scopes — an edited pattern list (content OR
 * order; negation is last-match-wins) is a different review target, never a
 * silent resume. Path lists compare sorted; the pattern list compares in
 * file order.
 */
function compareCodeIdentity({ stored, requested } = {}) {
  const mismatches = [];
  const storedFingerprint = stored && stored.fileSetFingerprint != null ? String(stored.fileSetFingerprint) : '';
  const requestedFingerprint = requested && requested.fileSetFingerprint != null ? String(requested.fileSetFingerprint) : '';
  const sameFileSet = storedFingerprint !== '' && storedFingerprint === requestedFingerprint;
  for (const [key] of CODE_IDENTITY_SCALAR_FIELDS) {
    if (String(stored && stored[key]) !== String(requested && requested[key])) {
      mismatches.push(key);
    }
  }
  for (const key of CODE_IDENTITY_LIST_FIELDS) {
    const a = stableJson(normalizeCodeIdentityList(key, stored && stored[key]));
    const b = stableJson(normalizeCodeIdentityList(key, requested && requested[key]));
    if (key === 'exclusions' && sameFileSet) continue;
    if (a !== b) mismatches.push(key);
  }
  return { match: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// R2P target resolver + r2p identity helpers (Task 4)
//
// PURE / read-only by construction. Resolves and validates an active
// <project>/.req-to-plan/WF-* directory, enforcing shape, symlink, archive,
// run.md gate, and owner-doc chain constraints before returning the editable
// file set and its fingerprint.
//
// NOTE: The run.md gate fields are CONFIRMED against real r2p output. Real r2p
// emits "## Status: closed_at_plan_checkpoint" once the plan checkpoint is
// approved, and "## Active Artifacts" as a markdown table whose plan row reads
// `| plan | 07-plan.md | <version> | approved |`. test/fixtures/r2p/real-r2p-run.md
// is the faithful-shape regression sample (modeled on real r2p serializer output);
// test/fixtures/r2p/approved/run.md keeps a simplified bullet shape the parser also
// accepts. parseRunMdGate is intentionally lenient across both shapes. If a future
// r2p serializer changes these tokens, adjust the extraction predicates here (only).
// ---------------------------------------------------------------------------

const R2P_EDITABLE_DOCS = Object.freeze([
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
]);

/**
 * Extract the content of the "## Active Artifacts" section from a run.md —
 * everything between the heading and the next "## " heading (or end of text).
 *
 * No /m flag: a per-line `$` would let the non-greedy capture stop at the very
 * first line, so only the header row of a real r2p markdown table got captured
 * and the table data rows (e.g. `| plan | 07-plan.md | N | approved |`) were
 * never seen by the plan-approved fallback. The lookahead stops at the next
 * `## ` heading so sibling sections (Stale / Superseded, Open Routes) never
 * bleed in. Returns empty string when the section is absent.
 */
function activeArtifactsSection(text) {
  const m = text.match(/(?:^|\n)##\s+Active Artifacts[^\n]*\n([\s\S]*?)(?=\n##\s|$)/);
  return m ? m[1] : '';
}

function activeArtifactsHasApprovedPlan(section) {
  for (const rawLine of String(section || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('|')) {
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '');
      const state = cells[cells.length - 1];
      if (cells[0] === 'plan' && (state === 'approved' || state === 'active')) {
        return true;
      }
      continue;
    }

    if (/^(?:[-*]\s*)?plan\s*:\s*(approved|active)\s*$/.test(line)) return true;
  }
  return false;
}

/**
 * Parse the few run.md fields the gate needs.
 * Throws ERR_R2P_RUNMD_UNRECOGNIZED on a run.md that lacks the fields the
 * gate needs — no silent fallback (principle 2).
 *
 * UNCONFIRMED: exact status token values and Active Artifacts plan-stage
 * tokens depend on r2p's run.md serializer; the committed fixture is drfx's
 * own self-authored shape, not a real r2p output. Adjust the extraction
 * predicates here (only) when a real r2p run.md confirms the exact text.
 */
function parseRunMdGate(runMdText) {
  const text = String(runMdText || '');
  const statusMatch = text.match(/^##\s+Status\s*\n+\s*([^\n]+)/m);
  if (!statusMatch) fail('ERR_R2P_RUNMD_UNRECOGNIZED', 'run.md has no recognizable "## Status" section');
  const status = statusMatch[1].trim();
  // Plan generated: status closed at the plan checkpoint, OR the plan stage
  // is approved/active in "## Active Artifacts".
  const planApproved =
    status === 'closed_at_plan_checkpoint' ||
    activeArtifactsHasApprovedPlan(activeArtifactsSection(text));
  return { planApproved, status };
}

/**
 * True when an "archive" segment sits between .req-to-plan/ and the WF-* dir.
 */
function isArchivedRequirementDir(absDir) {
  const parts = String(absDir).split(path.sep);
  const reqIdx = parts.lastIndexOf('.req-to-plan');
  if (reqIdx === -1) return false;
  // archived ⇒ an "archive" segment sits between .req-to-plan/ and the WF-* dir
  return parts.slice(reqIdx + 1, parts.length - 1).includes('archive');
}

/**
 * True when any path segment from .req-to-plan onward (inclusive) is a
 * symlink. Uses lstat to detect the symlink; a missing segment is not a
 * symlink — the later realpath/statSync will report it as a kind error.
 */
function hasSymlinkSegmentFromReqToPlan(absDir) {
  const parts = String(absDir).split(path.sep);
  const reqIdx = parts.lastIndexOf('.req-to-plan');
  if (reqIdx === -1) return false;
  let current = parts[0] === '' ? path.sep : parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (index < reqIdx) continue;
    let segStats;
    try { segStats = fs.lstatSync(current); }
    catch { return false; } // missing segment is not a symlink; later check reports it cleanly
    if (segStats.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Shape gate: an r2p target is a WF-* directory living under a .req-to-plan
 * ancestor (active OR archived). The active/archived split is made separately
 * by isArchivedRequirementDir so an archived dir still passes this shape
 * check and then fails loudly with ERR_R2P_GATE_ARCHIVED.
 */
function isRequirementDirShape(absDir) {
  if (!/^WF-/.test(path.basename(absDir))) return false;
  return String(absDir).split(path.sep).includes('.req-to-plan');
}

/**
 * Project root = the directory that contains the .req-to-plan tree.
 */
function projectRootFromRequirementDir(absDir) {
  const parts = String(absDir).split(path.sep);
  const reqIdx = parts.lastIndexOf('.req-to-plan');
  if (reqIdx <= 0) return null;
  return parts.slice(0, reqIdx).join(path.sep) || path.sep;
}

function failR2pRoute(blockingReason, message, nextAction, code = 'ERR_R2P_ROUTE') {
  const error = new Error(message);
  error.code = code;
  error.blockingReason = blockingReason;
  error.nextAction = nextAction;
  throw error;
}

function resolveR2pReviewFile(absolutePath, relativePath) {
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch {
    failR2pRoute(
      'r2p-artifact-missing-or-unsafe',
      `required r2p artifact is missing: ${relativePath}`,
      'restore the active run artifacts before rerunning',
      'ERR_R2P_ARTIFACT_MISSING'
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    failR2pRoute(
      'r2p-artifact-missing-or-unsafe',
      `required r2p artifact must be a regular non-symlink file: ${relativePath}`,
      'repair the active run artifacts before rerunning',
      'ERR_R2P_ARTIFACT_UNSAFE'
    );
  }
  const buf = fs.readFileSync(absolutePath);
  return {
    relativePath,
    absolutePath,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length
  };
}

function assertR2pDirectChildPath(candidatePath, parentPath, code = 'ERR_R2P_WORK_ID_SHAPE') {
  const relative = path.relative(parentPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    failR2pRoute(
      'r2p-run-not-found',
      `r2p workId must resolve to a direct child of ${parentPath}: ${candidatePath}`,
      `rerun explicitly as ${explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=<single-active-WF-...>')}`,
      code
    );
  }
}

// True only when the path is a real (non-symlink) directory. Used for archive
// presence: a stray symlink at archive/<workId> must not masquerade as an archived
// run (which would spuriously block a legitimate active run as a conflict). The
// archive path is never read, so this stays a presence guard, not a security boundary.
function r2pRealDirectoryExists(candidatePath) {
  try {
    const stats = fs.lstatSync(candidatePath);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveR2pWorkIdTarget({ projectRoot, workId } = {}) {
  const rootRealPath = fs.realpathSync.native(path.resolve(projectRoot));
  const workspacePath = path.join(rootRealPath, '.req-to-plan');
  let workspaceStats;
  try {
    workspaceStats = fs.lstatSync(workspacePath);
  } catch {
    failR2pRoute(
      'r2p-workspace-not-found',
      `r2p workspace not found: ${workspacePath}`,
      'create or restore the active .req-to-plan workspace before rerunning',
      'ERR_R2P_WORKSPACE'
    );
  }
  if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()) {
    failR2pRoute(
      'unsafe-r2p-workspace',
      `r2p workspace must be a real directory: ${workspacePath}`,
      'repair the .req-to-plan workspace before rerunning',
      'ERR_R2P_WORKSPACE_UNSAFE'
    );
  }

  const normalizedWorkId = String(workId || '');
  const runDir = path.join(workspacePath, normalizedWorkId);
  const archiveRoot = path.join(workspacePath, 'archive');
  const archiveDir = path.join(archiveRoot, normalizedWorkId);
  assertR2pDirectChildPath(runDir, workspacePath);
  assertR2pDirectChildPath(archiveDir, archiveRoot);
  const runExists = fs.existsSync(runDir);
  const archiveExists = r2pRealDirectoryExists(archiveDir);
  if (runExists && archiveExists) {
    failR2pRoute(
      'r2p-work-id-conflict',
      `workId exists in both active and archive workspaces: ${normalizedWorkId}`,
      'remove the duplicate active/archive workId before rerunning',
      'ERR_R2P_WORK_ID_CONFLICT'
    );
  }
  if (archiveExists && !runExists) {
    failR2pRoute(
      'r2p-run-archived',
      `workId exists only in archive: ${normalizedWorkId}`,
      `rerun explicitly as ${explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=<active-WF-...>')}`,
      'ERR_R2P_WORK_ID_ARCHIVED'
    );
  }
  if (!runExists) {
    failR2pRoute(
      'r2p-run-not-found',
      `active workId not found: ${normalizedWorkId}`,
      `rerun explicitly as ${explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=<existing-active-WF-...>')}`,
      'ERR_R2P_WORK_ID_MISSING'
    );
  }

  let runStats;
  try {
    runStats = fs.lstatSync(runDir);
  } catch {
    failR2pRoute(
      'r2p-run-not-found',
      `active workId not found: ${normalizedWorkId}`,
      `rerun explicitly as ${explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=<existing-active-WF-...>')}`,
      'ERR_R2P_WORK_ID_MISSING'
    );
  }
  if (runStats.isSymbolicLink() || !runStats.isDirectory()) {
    failR2pRoute(
      'unsafe-r2p-run-dir',
      `active r2p run directory must be a real directory: ${runDir}`,
      'repair the active run directory before rerunning',
      'ERR_R2P_RUN_DIR_UNSAFE'
    );
  }

  const runDirRealPath = fs.realpathSync.native(runDir);
  const runMdPath = path.join(runDirRealPath, 'run.md');
  const runMd = resolveR2pReviewFile(runMdPath, 'run.md');
  const reviewFiles = R2P_EDITABLE_DOCS.map((name) => resolveR2pReviewFile(path.join(runDirRealPath, name), name));
  const fingerprintEntries = reviewFiles.map((file) => ({
    path: file.relativePath,
    status: 'modified',
    contentId: file.sha256
  }));

  return {
    routeKind: 'r2p',
    targetContextKind: 'r2p',
    workId: normalizedWorkId,
    projectRoot: rootRealPath,
    requirementDir: runDirRealPath,
    runDir: runDirRealPath,
    runLocation: toPosixPath(path.relative(rootRealPath, runDirRealPath)),
    reviewFileEntries: reviewFiles.map((file) => ({
      path: toPosixPath(path.relative(rootRealPath, file.absolutePath)),
      requirementRelativePath: file.relativePath,
      status: 'modified',
      contentId: file.sha256,
      absolutePath: file.absolutePath,
      sha256: file.sha256,
      size: file.size
    })),
    reviewFiles: reviewFiles.map((file) => file.relativePath),
    protectedDependencies: ['run.md'],
    editableFiles: [],
    directArtifactWrites: 'forbidden',
    fileSetFingerprint: computeFileSetFingerprint(fingerprintEntries),
    runMdPath,
    runMdSha256: runMd.sha256
  };
}

module.exports = {
  resolveTargetContext,
  resolveCodeTarget,
  resolveCodeInventory,
  streamingContentId,
  hashFileContent,
  describeCodeBlock,
  MAX_WHOLE_ROOT_FILES,
  MAX_WHOLE_ROOT_BYTES,
  normalizeCodeScopesForIdentity,
  normalizeCodeUserExcludesForIdentity,
  DRFXIGNORE_FILENAME,
  CODE_EXCLUDED_DIRECTORIES,
  CODE_EXCLUDED_DIRECTORY_PATHS,
  hasCodeExcludedDirectory,
  codeExcludedDirectoryEntries,
  computeFileSetFingerprint,
  buildPrIdentity,
  formatPrIdentityFields,
  parsePrIdentityFields,
  comparePrIdentity,
  buildCodeIdentity,
  formatCodeIdentityFields,
  parseCodeIdentityFields,
  compareCodeIdentity,
  parseRunMdGate,
  activeArtifactsSection,
  isArchivedRequirementDir,
  hasSymlinkSegmentFromReqToPlan,
  isRequirementDirShape,
  projectRootFromRequirementDir,
  resolveR2pWorkIdTarget
};
