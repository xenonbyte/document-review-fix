'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  explicitRouteInvocation,
  listDocumentRoutes,
  getRouteDescriptor
} = require('./routes');

// DOCUMENT_TYPES is derived from the shared registry so it stays in sync automatically.
// It maps entry-skill name → documentType for the four document routes only.
// PR/CODE routes have no documentType entry here — documentTypeFor() rejects them as unknown.
const DOCUMENT_TYPES = Object.freeze(
  Object.fromEntries(
    listDocumentRoutes().map((route) => [route.routeName, route.documentType])
  )
);

const STRICTNESS_FLAGS = new Set(['strict', 'normal']);
const MODE_FLAGS = new Set(['read-only', 'review-and-fix']);
const ASSURANCE_VALUES = new Set(['advisory', 'practical', 'strict-verified']);
const GUARD_MODES = new Set(['git', 'snapshot']);
const DEFAULT_GUARD_MODE = 'git';
const R2P_WORK_ID_RE = /^WF-[A-Za-z0-9._-]+$/;
const R2P_PATH_TOKEN_MESSAGE = 'Blocked: review-fix-r2p expects workId=<WF-...>, not a path.';
const R2P_INVALID_NEXT_ACTION =
  `rerun explicitly as ${explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=<WF-...>')}`;
// Parsing runs before a runtime platform is known, so route guidance shown here keeps
// both explicit syntaxes visible rather than guessing one.
const PR_ROUTE_INVOCATION = explicitRouteInvocation('review-fix-pr', 'manual');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function failR2pInvocation(message) {
  const error = new Error(message);
  error.code = 'ERR_INVALID_R2P_INVOCATION';
  error.blockingReason = 'invalid-r2p-invocation';
  error.nextAction = R2P_INVALID_NEXT_ACTION;
  throw error;
}

function parseKeyValue(token) {
  const index = token.indexOf('=');
  if (index === -1) return null;
  return [token.slice(0, index), token.slice(index + 1)];
}

function unique(values) {
  return Array.from(new Set(values));
}

function documentTypeFor(entrySkill) {
  const documentType = DOCUMENT_TYPES[entrySkill];
  if (!documentType) fail('ERR_UNKNOWN_ENTRY_SKILL', `Unknown entry skill: ${entrySkill}`);
  return documentType;
}

/**
 * Parse and validate the rounds=<n> token value.
 * Throws a coded error if the value is invalid (zero, negative, non-integer, or missing).
 * @param {string} value - raw string after the '='
 * @returns {number} positive integer round limit
 */
function parseRoundsValue(value) {
  if (!value) fail('ERR_ROUNDS_INVALID', 'rounds= requires a positive integer value');
  // Strictly a positive decimal integer: rejects 0, leading zeros, hex (0x3),
  // scientific (1e2), floats, padded spaces, and any non-digit content.
  if (!/^[1-9]\d*$/.test(value)) {
    fail('ERR_ROUNDS_INVALID', `rounds= requires a positive integer; got: ${value}`);
  }
  return Number(value);
}

function isValidWorkId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes('\0') &&
    !value.includes('..') &&
    R2P_WORK_ID_RE.test(value);
}

/**
 * Parse shared tokens that are common to PR and CODE routes (but not document-only tokens).
 * Handles: mode flags, guard=, resume, root=, rounds=<n>.
 * Throws on any token not in the shared or route-specific allowed set.
 * @param {string} token
 * @param {object} state - mutable parsing state
 * @param {object} result - mutable result object
 * @returns {boolean} true if the token was consumed, false if it's route-specific (caller handles)
 */
function parseSharedCodeRouteToken(token, state, result) {
  if (MODE_FLAGS.has(token)) {
    if (state.sawMode && result.mode !== token) {
      fail('ERR_CONFLICTING_MODE', 'read-only and review-and-fix are mutually exclusive');
    }
    state.sawMode = true;
    result.mode = token;
    state.explicitMode = token;
    return true;
  }

  if (token === 'resume') {
    if (result.reset) fail('ERR_CONFLICTING_RESUME_RESET', 'resume and reset are mutually exclusive');
    result.resume = true;
    return true;
  }

  if (token === 'reset') {
    if (result.resume) fail('ERR_CONFLICTING_RESUME_RESET', 'resume and reset are mutually exclusive');
    result.reset = true;
    return true;
  }

  const pair = parseKeyValue(token);
  if (!pair) return false;

  const [key, value] = pair;

  if (key === 'root') {
    if (state.sawRoot) fail('ERR_DUPLICATE_ROOT', 'Duplicate root path');
    state.sawRoot = true;
    result.root = value;
    return true;
  }

  if (key === 'guard') {
    if (state.sawGuard) fail('ERR_DUPLICATE_GUARD', 'Duplicate guard mode');
    if (!GUARD_MODES.has(value)) fail('ERR_GUARD_MODE', `Invalid guard mode: ${value}`);
    state.sawGuard = true;
    result.guardMode = value;
    return true;
  }

  if (key === 'rounds') {
    if (state.sawRounds) fail('ERR_DUPLICATE_ROUNDS', 'Duplicate rounds token');
    state.sawRounds = true;
    result.roundLimit = parseRoundsValue(value);
    return true;
  }

  return false;
}

function parseInvocationDocument(entrySkill, tokens, options) {
  const documentType = documentTypeFor(entrySkill);
  const includeMetadata = Boolean(options && options.includeMetadata);
  const defaultMode = includeMetadata ? options.defaultMode || 'review-and-fix' : 'review-and-fix';
  const defaultAssurance = includeMetadata && options.defaultAssurance !== undefined
    ? options.defaultAssurance
    : null;
  if (includeMetadata && !MODE_FLAGS.has(defaultMode)) fail('ERR_DEFAULT_MODE', `Invalid default mode: ${defaultMode}`);
  if (
    includeMetadata &&
    defaultAssurance !== null &&
    !ASSURANCE_VALUES.has(defaultAssurance)
  ) {
    fail('ERR_DEFAULT_ASSURANCE', `Invalid default assurance: ${defaultAssurance}`);
  }
  const result = {
    entrySkill,
    routeKind: 'document',
    documentType,
    target: null,
    refs: [],
    strictness: 'normal',
    mode: defaultMode,
    resume: false,
    reset: false,
    ledger: null,
    root: null,
    guardMode: DEFAULT_GUARD_MODE,
    roundLimit: null
  };
  let sawTarget = false;
  let sawBareTarget = false;
  let sawRoot = false;
  let sawStrictness = false;
  let sawMode = false;
  let sawGuard = false;
  let sawRounds = false;
  let explicitMode = null;
  let explicitAssurance = null;

  for (const token of tokens) {
    const pair = parseKeyValue(token);
    if (pair) {
      const [key, value] = pair;
      if (key === 'target') {
        if (sawTarget || sawBareTarget) fail('ERR_DUPLICATE_TARGET', 'Duplicate target document');
        sawTarget = true;
        result.target = value;
        continue;
      }
      if (key === 'ref') {
        result.refs.push(value);
        continue;
      }
      if (key === 'ledger') {
        result.ledger = value;
        continue;
      }
      if (key === 'root') {
        if (sawRoot) fail('ERR_DUPLICATE_ROOT', 'Duplicate root path');
        sawRoot = true;
        result.root = value;
        continue;
      }
      if (key === 'guard') {
        if (sawGuard) fail('ERR_DUPLICATE_GUARD', 'Duplicate guard mode');
        if (!GUARD_MODES.has(value)) fail('ERR_GUARD_MODE', `Invalid guard mode: ${value}`);
        sawGuard = true;
        result.guardMode = value;
        continue;
      }
      if (key === 'type') {
        fail('ERR_TYPE_OVERRIDE', 'Document type is fixed by entry skill and must not be supplied');
      }
      if (key === 'rounds') {
        if (sawRounds) fail('ERR_DUPLICATE_ROUNDS', 'Duplicate rounds token');
        sawRounds = true;
        result.roundLimit = parseRoundsValue(value);
        continue;
      }
      if (includeMetadata && key === 'assurance') {
        if (!ASSURANCE_VALUES.has(value)) fail('ERR_ASSURANCE', `Invalid assurance: ${value}`);
        if (explicitAssurance && explicitAssurance !== value) {
          fail('ERR_CONFLICTING_ASSURANCE', 'Conflicting assurance values');
        }
        explicitAssurance = value;
        continue;
      }
      fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    }

    if (STRICTNESS_FLAGS.has(token)) {
      if (sawStrictness && result.strictness !== token) {
        fail('ERR_CONFLICTING_STRICTNESS', 'strict and normal are mutually exclusive');
      }
      sawStrictness = true;
      result.strictness = token;
      continue;
    }

    if (MODE_FLAGS.has(token)) {
      if (sawMode && result.mode !== token) {
        fail('ERR_CONFLICTING_MODE', 'read-only and review-and-fix are mutually exclusive');
      }
      sawMode = true;
      result.mode = token;
      explicitMode = token;
      continue;
    }

    if (token === 'resume') {
      if (result.reset) fail('ERR_CONFLICTING_RESUME_RESET', 'resume and reset are mutually exclusive');
      result.resume = true;
      continue;
    }

    if (token === 'reset') {
      if (result.resume) fail('ERR_CONFLICTING_RESUME_RESET', 'resume and reset are mutually exclusive');
      result.reset = true;
      continue;
    }

    if (token.startsWith('-')) fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    if (sawTarget) fail('ERR_UNLABELED_PATH', `Unlabeled path is invalid when target= is present: ${token}`);
    if (sawBareTarget) fail('ERR_UNLABELED_PATH', `Multiple unlabeled paths are ambiguous: ${token}`);
    sawBareTarget = true;
    result.target = token;
  }

  result.refs = unique(result.refs);
  if (!result.target) fail('ERR_MISSING_TARGET', 'Missing target document');

  // read-only rounds=<n> is unsupported: loop semantics make no sense without fixing.
  if (result.roundLimit !== null && result.mode === 'read-only') {
    fail('ERR_ROUNDS_READ_ONLY', 'rounds=<n> loop semantics are unsupported in read-only mode');
  }

  if (includeMetadata) {
    result.requestedMode = explicitMode || defaultMode;
    result.modeSource = explicitMode ? 'explicit' : 'default';
    result.modeNormalizedFrom = null;
    result.requestedAssurance = explicitAssurance || defaultAssurance;
    result.assuranceSource = explicitAssurance ? 'explicit' : (defaultAssurance ? 'default' : null);
  }
  return result;
}

function parseInvocationPr(entrySkill, tokens, options) {
  const includeMetadata = Boolean(options && options.includeMetadata);
  const defaultMode = includeMetadata ? options.defaultMode || 'review-and-fix' : 'review-and-fix';
  if (includeMetadata && !MODE_FLAGS.has(defaultMode)) fail('ERR_DEFAULT_MODE', `Invalid default mode: ${defaultMode}`);

  const result = {
    entrySkill,
    routeKind: 'pr',
    documentType: null,
    base: null,
    mode: defaultMode,
    resume: false,
    reset: false,
    ledger: null,
    root: null,
    guardMode: DEFAULT_GUARD_MODE,
    roundLimit: null
  };

  const state = {
    sawMode: false,
    sawRoot: false,
    sawGuard: false,
    sawRounds: false,
    sawBase: false,
    explicitMode: null
  };

  for (const token of tokens) {
    const pair = parseKeyValue(token);

    if (pair) {
      const [key, value] = pair;

      if (key === 'base') {
        if (state.sawBase) fail('ERR_DUPLICATE_BASE', 'Duplicate base branch');
        state.sawBase = true;
        result.base = value;
        continue;
      }

      // Reject document-only key=value tokens explicitly
      if (key === 'target' || key === 'ref' || key === 'ledger' || key === 'assurance' || key === 'type' || key === 'scope') {
        fail('ERR_UNKNOWN_TOKEN', `Unknown token for review-fix-pr: ${token}`);
      }

      if (parseSharedCodeRouteToken(token, state, result)) continue;

      fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    }

    // Bareword tokens: mode flags and resume are shared; strictness/normal are document-only
    if (STRICTNESS_FLAGS.has(token)) {
      fail('ERR_UNKNOWN_TOKEN', `Unknown token for review-fix-pr: ${token}`);
    }

    if (!parseSharedCodeRouteToken(token, state, result)) {
      fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    }
  }

  if (!result.base) fail('ERR_MISSING_BASE', 'review-fix-pr requires base=<branch>');

  // read-only rounds=<n> is unsupported
  if (result.roundLimit !== null && result.mode === 'read-only') {
    fail('ERR_ROUNDS_READ_ONLY', 'rounds=<n> loop semantics are unsupported in read-only mode');
  }

  if (includeMetadata) {
    result.requestedMode = state.explicitMode || defaultMode;
    result.modeSource = state.explicitMode ? 'explicit' : 'default';
    result.modeNormalizedFrom = null;
    result.requestedAssurance = null;
    result.assuranceSource = null;
  }
  return result;
}

function parseInvocationCode(entrySkill, tokens, options) {
  const includeMetadata = Boolean(options && options.includeMetadata);
  const defaultMode = includeMetadata ? options.defaultMode || 'review-and-fix' : 'review-and-fix';
  if (includeMetadata && !MODE_FLAGS.has(defaultMode)) fail('ERR_DEFAULT_MODE', `Invalid default mode: ${defaultMode}`);

  const result = {
    entrySkill,
    routeKind: 'code',
    documentType: null,
    scopes: [],
    mode: defaultMode,
    resume: false,
    reset: false,
    ledger: null,
    root: null,
    guardMode: DEFAULT_GUARD_MODE,
    roundLimit: null
  };

  const state = {
    sawMode: false,
    sawRoot: false,
    sawGuard: false,
    sawRounds: false,
    explicitMode: null
  };

  for (const token of tokens) {
    const pair = parseKeyValue(token);

    if (pair) {
      const [key, value] = pair;

      if (key === 'scope') {
        result.scopes.push(value);
        continue;
      }

      if (key === 'base') {
        fail('ERR_BASE_UNSUPPORTED', `base= is only supported by review-fix-pr; run ${PR_ROUTE_INVOCATION} to review a PR diff`);
      }

      // Reject document-only key=value tokens explicitly
      if (key === 'target' || key === 'ref' || key === 'ledger' || key === 'assurance' || key === 'type') {
        fail('ERR_UNKNOWN_TOKEN', `Unknown token for review-fix-code: ${token}`);
      }

      if (parseSharedCodeRouteToken(token, state, result)) continue;

      fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    }

    // Bareword tokens: mode flags and resume are shared; strictness/normal are document-only
    if (STRICTNESS_FLAGS.has(token)) {
      fail('ERR_UNKNOWN_TOKEN', `Unknown token for review-fix-code: ${token}`);
    }

    if (!parseSharedCodeRouteToken(token, state, result)) {
      fail('ERR_UNKNOWN_TOKEN', `Unknown token: ${token}`);
    }
  }

  // read-only rounds=<n> is unsupported
  if (result.roundLimit !== null && result.mode === 'read-only') {
    fail('ERR_ROUNDS_READ_ONLY', 'rounds=<n> loop semantics are unsupported in read-only mode');
  }

  if (includeMetadata) {
    result.requestedMode = state.explicitMode || defaultMode;
    result.modeSource = state.explicitMode ? 'explicit' : 'default';
    result.modeNormalizedFrom = null;
    result.requestedAssurance = null;
    result.assuranceSource = null;
  }
  return result;
}

// review-fix-r2p parser. It accepts only a workId=<WF-...> token or one bare
// WF-... shorthand, plus the shared mode/resume/reset/root/rounds flags and a
// verbosity-only debug token.
function parseInvocationR2p(entrySkill, tokens, options) {
  const includeMetadata = Boolean(options && options.includeMetadata);
  const defaultMode = includeMetadata ? options.defaultMode || 'review-and-fix' : 'review-and-fix';
  if (includeMetadata && !MODE_FLAGS.has(defaultMode)) fail('ERR_DEFAULT_MODE', `Invalid default mode: ${defaultMode}`);

  const result = {
    entrySkill,
    routeKind: 'r2p',
    documentType: 'PLAN',
    workId: null,
    mode: defaultMode,
    resume: false,
    reset: false,
    root: null,
    roundLimit: null,
    debug: false
  };

  const state = {
    sawMode: false,
    sawRoot: false,
    sawRounds: false,
    explicitMode: null
  };
  let sawWorkId = false;
  let sawBareWorkId = false;

  function consumeSharedToken(token) {
    if (MODE_FLAGS.has(token)) {
      if (state.sawMode && result.mode !== token) {
        failR2pInvocation('read-only and review-and-fix are mutually exclusive');
      }
      state.sawMode = true;
      result.mode = token;
      state.explicitMode = token;
      return true;
    }

    if (token === 'resume') {
      if (result.reset) failR2pInvocation('resume and reset are mutually exclusive');
      result.resume = true;
      return true;
    }

    if (token === 'reset') {
      if (result.resume) failR2pInvocation('resume and reset are mutually exclusive');
      result.reset = true;
      return true;
    }

    const pair = parseKeyValue(token);
    if (!pair) return false;
    const [key, value] = pair;

    if (key === 'root') {
      if (state.sawRoot) failR2pInvocation('Duplicate root path');
      state.sawRoot = true;
      result.root = value;
      return true;
    }

    if (key === 'rounds') {
      if (state.sawRounds) failR2pInvocation('Duplicate rounds token');
      state.sawRounds = true;
      try {
        result.roundLimit = parseRoundsValue(value);
      } catch (error) {
        failR2pInvocation(error && error.message ? error.message : 'Invalid rounds token');
      }
      return true;
    }

    return false;
  }

  for (const token of tokens) {
    const pair = parseKeyValue(token);

    if (pair) {
      const [key, value] = pair;

      if (key === 'workId') {
        if (sawWorkId || sawBareWorkId) failR2pInvocation('Duplicate workId');
        if (!isValidWorkId(value)) failR2pInvocation(`Invalid workId: ${value}`);
        sawWorkId = true;
        result.workId = value;
        continue;
      }

      if (key === 'target') failR2pInvocation(R2P_PATH_TOKEN_MESSAGE);
      if (
        key === 'ref' || key === 'scope' || key === 'base' || key === 'assurance' ||
        key === 'ledger' || key === 'guard' || key === 'type'
      ) {
        failR2pInvocation(`Unknown token for review-fix-r2p: ${token}`);
      }

      if (consumeSharedToken(token)) continue;

      failR2pInvocation(`Unknown token: ${token}`);
    }

    if (STRICTNESS_FLAGS.has(token)) {
      failR2pInvocation(`Unknown token for review-fix-r2p: ${token}`);
    }

    if (token === 'debug') {
      result.debug = true;
      continue;
    }

    if (consumeSharedToken(token)) continue;

    if (token.startsWith('-')) failR2pInvocation(`Unknown token: ${token}`);
    if (token.includes('/') || token.includes('\\') || token.endsWith('.md')) {
      failR2pInvocation(R2P_PATH_TOKEN_MESSAGE);
    }
    if (sawWorkId || sawBareWorkId) failR2pInvocation(`Multiple unlabeled workIds are ambiguous: ${token}`);
    if (!isValidWorkId(token)) failR2pInvocation(`Invalid workId: ${token}`);
    sawBareWorkId = true;
    result.workId = token;
  }

  if (!result.workId) failR2pInvocation('Missing workId');

  // read-only rounds=<n> is unsupported: loop semantics make no sense without fixing.
  if (result.roundLimit !== null && result.mode === 'read-only') {
    failR2pInvocation('rounds=<n> loop semantics are unsupported in read-only mode');
  }

  if (includeMetadata) {
    result.requestedMode = state.explicitMode || defaultMode;
    result.modeSource = state.explicitMode ? 'explicit' : 'default';
    result.modeNormalizedFrom = null;
    result.requestedAssurance = null;
    result.assuranceSource = null;
  }
  return result;
}

function parseInvocation(entrySkill, tokens, options = null) {
  // Dispatch by route kind from the registry.
  // Document routes use their own (unchanged) parser; PR and CODE have new parsers.
  let routeKind;
  try {
    routeKind = getRouteDescriptor(entrySkill).routeKind;
  } catch {
    // Unknown entry skill: throw the canonical error for backward compatibility
    fail('ERR_UNKNOWN_ENTRY_SKILL', `Unknown entry skill: ${entrySkill}`);
  }

  if (routeKind === 'pr') return parseInvocationPr(entrySkill, tokens, options);
  if (routeKind === 'code') return parseInvocationCode(entrySkill, tokens, options);
  if (routeKind === 'r2p') return parseInvocationR2p(entrySkill, tokens, options);
  // routeKind === 'document': use original document parser (preserves all existing behavior)
  return parseInvocationDocument(entrySkill, tokens, options);
}

function parseNaturalLanguageInvocation(entrySkill, text) {
  const documentType = documentTypeFor(entrySkill);
  const pathPattern = /[A-Za-z0-9_./-]+\.md/g;
  const paths = text.match(pathPattern) || [];
  const editMatch = text.match(/(?:修改|修复|fix|review and fix)\s+([A-Za-z0-9_./-]+\.md)/i);
  const refs = Array.from(text.matchAll(/(?:参考|对照|reference|ref)\s+([A-Za-z0-9_./-]+\.md)/gi), (match) => match[1]);

  if (!editMatch || paths.length !== 1 + refs.length) {
    fail('ERR_AMBIGUOUS_NATURAL_LANGUAGE', 'Ambiguous natural-language input; use target= and ref=');
  }

  return {
    entrySkill,
    documentType,
    target: editMatch[1],
    refs: unique(refs),
    strictness: /\bstrict\b/.test(text) ? 'strict' : 'normal',
    mode: /\bread-only\b/.test(text) ? 'read-only' : 'review-and-fix',
    resume: /\bresume\b/.test(text),
    reset: /\breset\b/.test(text) && !/\bresume\b/.test(text),
    ledger: null,
    root: null,
    guardMode: DEFAULT_GUARD_MODE
  };
}

function realExistingFile(filePath, label) {
  const absolute = path.resolve(filePath);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    const code = label === 'target' ? 'ERR_TARGET_MISSING' : 'ERR_REFERENCE_MISSING';
    fail(code, `${label} document must exist: ${filePath}`);
  }
  if (!stats.isFile()) {
    const code = label === 'target' ? 'ERR_TARGET_MISSING' : 'ERR_REFERENCE_MISSING';
    fail(code, `${label} document must exist: ${filePath}`);
  }
  return fs.realpathSync.native(absolute);
}

function realExistingDirectory(directoryPath, label) {
  const absolute = path.resolve(directoryPath);
  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    fail('ERR_ROOT_MISSING', `${label} path must exist: ${directoryPath}`);
  }
  if (!stats.isDirectory()) fail('ERR_ROOT_MISSING', `${label} path must exist: ${directoryPath}`);
  return fs.realpathSync.native(absolute);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateEntryPaths({ target, refs = [], root }) {
  if (!target) fail('ERR_MISSING_TARGET', 'Missing target document');

  const targetPath = realExistingFile(target, 'target');
  const projectRoot = root ? realExistingDirectory(root, 'root') : null;

  if (projectRoot && !isInside(targetPath, projectRoot)) {
    fail('ERR_ROOT_CONTAINMENT', `root must contain target: ${root}`);
  }

  const references = refs.map((ref) => {
    const refPath = realExistingFile(ref, 'reference');
    if (refPath === targetPath) fail('ERR_REF_EQUALS_TARGET', 'reference path resolves to target path');
    return {
      path: refPath,
      readOnly: true,
      external: projectRoot ? !isInside(refPath, projectRoot) : null
    };
  });

  return {
    targetPath,
    projectRoot,
    references
  };
}

module.exports = {
  DOCUMENT_TYPES,
  parseInvocation,
  parseNaturalLanguageInvocation,
  validateEntryPaths
};
