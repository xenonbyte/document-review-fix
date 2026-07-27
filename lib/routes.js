'use strict';

// Shared route registry — single source of truth for all seven route descriptors.
// Generator and input modules consume this; they must not maintain their own route lists.

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Platform policy: describes per-platform support for review-and-fix vs advisory-only.
// Gemini is advisory-only on all routes. Claude, Codex, and opencode support review-and-fix
// on all routes. PR/CODE generation support on Codex/Claude is handled in PLAN-TASK-008.
const DEFAULT_PLATFORM_POLICY = Object.freeze({
  claude: 'review-and-fix',
  codex: 'review-and-fix',
  gemini: 'advisory-only',
  opencode: 'review-and-fix'
});
const SLASH_INVOCATION_PLATFORMS = Object.freeze([
  'claude',
  'claude-code',
  'gemini',
  'opencode'
]);

// Registry: seven routes in canonical order (four document routes, then pr, code, r2p).
//
// `routeKind` and `targetContextKind` are deliberately separate axes. For the four
// document routes and pr/code they co-vary 1:1; r2p is the first route that mixes them
// (routeKind/targetContextKind 'r2p' resolves a file-set context, yet documentType PLAN
// drives the COMMON+PLAN document rule stack). `routeKind` drives parser/generation/rulebook
// dispatch (PLAN-TASK-002/007/008); `targetContextKind` drives target resolution and
// state identity (single-file document vs git diff file-set vs source-scope file-set —
// PLAN-TASK-003/004/009). Keep them distinct so a future route can mix them (e.g. a new
// document-kind route that resolves a file-set context) without re-deriving one from the other.
const ROUTE_LIST = Object.freeze([
  Object.freeze({
    routeName: 'review-fix-spec',
    routeKind: 'document',
    documentType: 'SPEC',
    rubric: 'spec',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-plan',
    routeKind: 'document',
    documentType: 'PLAN',
    rubric: 'plan',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-design',
    routeKind: 'document',
    documentType: 'DESIGN',
    rubric: 'design',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-doc',
    routeKind: 'document',
    documentType: 'COMMON',
    rubric: null,
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'document',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-pr',
    routeKind: 'pr',
    documentType: null,
    rubric: 'pr',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'pr',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  }),
  Object.freeze({
    routeName: 'review-fix-code',
    routeKind: 'code',
    documentType: null,
    rubric: 'code',
    defaultMode: 'review-and-fix',
    defaultGuard: 'git',
    targetContextKind: 'code',
    platformPolicy: DEFAULT_PLATFORM_POLICY
  }),
  // review-fix-r2p reviews the 07-plan.md anchor of an active workId run and maps
  // accepted findings back to their owning upstream stage (03–06), but it never writes
  // those docs: 03–07 and run.md are read-only evidence and repair happens only through
  // r2p lifecycle commands. Although it resolves a FILE-SET context (targetContextKind
  // 'r2p', routeKind 'r2p'), it is a DOCUMENT-rubric route: documentType PLAN maps it to
  // the COMMON+PLAN document rule stack, NOT the PR/CODE route-rule stack. The route is
  // read-only with respect to artifacts and only permits r2p lifecycle repair commands.
  Object.freeze({
    routeName: 'review-fix-r2p',
    routeKind: 'r2p',
    documentType: 'PLAN',
    rubric: 'plan',
    defaultMode: 'review-and-fix',
    targetContextKind: 'r2p',
    artifactWritePolicy: 'forbidden',
    repairPolicy: 'r2p-lifecycle',
    repairCommands: Object.freeze(['r2p-reopen', 'r2p-gap-open']),
    platformPolicy: DEFAULT_PLATFORM_POLICY
  })
]);

// Build a fast lookup map from routeName → descriptor.
const ROUTE_MAP = Object.freeze(
  Object.fromEntries(ROUTE_LIST.map((route) => [route.routeName, route]))
);

// Pre-computed, frozen slice of document routes so listDocumentRoutes() returns a stable,
// immutable value with the same guarantees as listRoutes() (no fresh mutable array per call).
const DOCUMENT_ROUTE_LIST = Object.freeze(
  ROUTE_LIST.filter((route) => route.routeKind === 'document')
);

/**
 * Return all seven route descriptors in canonical order.
 * @returns {readonly object[]}
 */
function listRoutes() {
  return ROUTE_LIST;
}

/**
 * Return only the four document routes (routeKind === 'document').
 * Generator uses this to avoid attempting to render PR/CODE routes with document templates.
 * @returns {readonly object[]}
 */
function listDocumentRoutes() {
  return DOCUMENT_ROUTE_LIST;
}

/**
 * Return the descriptor for a single route by name.
 * Throws ERR_ROUTE for unknown names, matching the fail(code, message) pattern used in this package.
 * @param {string} routeName
 * @returns {object}
 */
function getRouteDescriptor(routeName) {
  const descriptor = ROUTE_MAP[routeName];
  if (!descriptor) fail('ERR_ROUTE', `unsupported route: ${routeName}`);
  return descriptor;
}

/**
 * Format one explicit, user-facing route invocation for an install/runtime platform.
 * Manual or unknown runtimes keep both syntaxes visible instead of guessing or throwing.
 * @param {string} routeName
 * @param {string|null|undefined} platform
 * @param {string} [argumentText]
 * @returns {string}
 */
function explicitRouteInvocation(routeName, platform, argumentText = '') {
  getRouteDescriptor(routeName);
  const suffix = String(argumentText || '').trim();
  const withArguments = (prefix) => `${prefix}${routeName}${suffix ? ` ${suffix}` : ''}`;
  const normalizedPlatform = String(platform || '').trim();
  if (normalizedPlatform === 'codex') return withArguments('$');
  if (SLASH_INVOCATION_PLATFORMS.includes(normalizedPlatform)) return withArguments('/');
  return `${withArguments('$')} on Codex or ${withArguments('/')} on other platforms`;
}

module.exports = {
  listRoutes,
  listDocumentRoutes,
  getRouteDescriptor,
  explicitRouteInvocation
};
