'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  explicitRouteInvocation,
  getRouteDescriptor,
  listRoutes,
  listDocumentRoutes
} = require('../lib/routes');
const { mergeRules } = require('../lib/rulebook');

// ---------------------------------------------------------------------------
// SPEC-FR-001: Seven first-class routes
// ---------------------------------------------------------------------------

test('route registry exposes seven supported routes with defaults', () => {
  assert.deepEqual(listRoutes().map((route) => route.routeName), [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
    'review-fix-pr',
    'review-fix-code',
    'review-fix-r2p',
  ]);
  assert.equal(getRouteDescriptor('review-fix-pr').defaultMode, 'review-and-fix');
  assert.equal(getRouteDescriptor('review-fix-pr').defaultGuard, 'git');
});

test('explicit route invocation preserves platform syntax and arguments', () => {
  assert.equal(
    explicitRouteInvocation('review-fix-r2p', 'codex', 'workId=WF-1 resume'),
    '$review-fix-r2p workId=WF-1 resume'
  );
  for (const platform of ['claude', 'claude-code', 'gemini', 'opencode']) {
    assert.equal(
      explicitRouteInvocation('review-fix-r2p', platform, 'workId=WF-1 resume'),
      '/review-fix-r2p workId=WF-1 resume'
    );
  }
  assert.equal(
    explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=WF-1 resume'),
    '$review-fix-r2p workId=WF-1 resume on Codex or /review-fix-r2p workId=WF-1 resume on other platforms'
  );
});

test('route registry exposes correct routeKind for each route', () => {
  assert.equal(getRouteDescriptor('review-fix-spec').routeKind, 'document');
  assert.equal(getRouteDescriptor('review-fix-plan').routeKind, 'document');
  assert.equal(getRouteDescriptor('review-fix-design').routeKind, 'document');
  assert.equal(getRouteDescriptor('review-fix-doc').routeKind, 'document');
  assert.equal(getRouteDescriptor('review-fix-pr').routeKind, 'pr');
  assert.equal(getRouteDescriptor('review-fix-code').routeKind, 'code');
});

test('all routes have defaultMode review-and-fix; defaultGuard git except r2p snapshot', () => {
  for (const route of listRoutes()) {
    assert.equal(route.defaultMode, 'review-and-fix', `${route.routeName}.defaultMode`);
    if (route.routeName === 'review-fix-r2p') {
      assert.equal(route.artifactWritePolicy, 'forbidden', `${route.routeName}.artifactWritePolicy`);
      assert.equal(route.repairPolicy, 'r2p-lifecycle', `${route.routeName}.repairPolicy`);
      assert.deepEqual(
        route.repairCommands,
        ['r2p-reopen', 'r2p-gap-open'],
        `${route.routeName}.repairCommands`
      );
      assert.equal('defaultGuard' in route, false, `${route.routeName}.defaultGuard`);
      continue;
    }

    assert.equal(route.defaultGuard, 'git', `${route.routeName}.defaultGuard`);
  }
});

test('review-fix-r2p descriptor maps to the document PLAN stack with r2p lifecycle repair', () => {
  const r2p = getRouteDescriptor('review-fix-r2p');
  assert.equal(r2p.routeKind, 'r2p');
  assert.equal(r2p.documentType, 'PLAN');
  assert.equal(r2p.rubric, 'plan');
  assert.equal(r2p.targetContextKind, 'r2p');
  assert.equal(r2p.defaultMode, 'review-and-fix');
  assert.equal(r2p.artifactWritePolicy, 'forbidden');
  assert.equal(r2p.repairPolicy, 'r2p-lifecycle');
  assert.deepEqual(r2p.repairCommands, ['r2p-reopen', 'r2p-gap-open']);
  assert.equal('defaultGuard' in r2p, false);
  // r2p is NOT a single-file document route, so it is excluded from listDocumentRoutes().
  assert.equal(listDocumentRoutes().some((route) => route.routeName === 'review-fix-r2p'), false);
});

test('review-fix-r2p merges the COMMON + PLAN document rule stack (same as review-fix-plan)', () => {
  // r2p maps to documentType PLAN, so the merged document rule stack is identical to
  // the PLAN document route: hard constraints + built-in COMMON + built-in PLAN.
  const r2p = getRouteDescriptor('review-fix-r2p');
  const plan = getRouteDescriptor('review-fix-plan');
  assert.equal(r2p.documentType, plan.documentType);

  const builtIn = { COMMON: 'common-rules', PLAN: 'plan-rules' };
  const r2pMerged = mergeRules({ documentType: r2p.documentType, builtIn });
  const planMerged = mergeRules({ documentType: plan.documentType, builtIn });

  assert.deepEqual(r2pMerged.sources, planMerged.sources);
  assert.deepEqual(r2pMerged.sources, ['hard', 'built-in-common', 'built-in-PLAN']);
  assert.equal(r2pMerged.text, planMerged.text);
});

// ---------------------------------------------------------------------------
// SPEC-IF-001: Route descriptor fields
// ---------------------------------------------------------------------------

test('document route descriptors expose documentType and rubric', () => {
  const spec = getRouteDescriptor('review-fix-spec');
  assert.equal(spec.documentType, 'SPEC');
  assert.equal(spec.rubric, 'spec');
  assert.equal(spec.targetContextKind, 'document');

  const plan = getRouteDescriptor('review-fix-plan');
  assert.equal(plan.documentType, 'PLAN');
  assert.equal(plan.rubric, 'plan');
  assert.equal(plan.targetContextKind, 'document');

  const design = getRouteDescriptor('review-fix-design');
  assert.equal(design.documentType, 'DESIGN');
  assert.equal(design.rubric, 'design');
  assert.equal(design.targetContextKind, 'document');

  const doc = getRouteDescriptor('review-fix-doc');
  assert.equal(doc.documentType, 'COMMON');
  assert.equal(doc.rubric, null);
  assert.equal(doc.targetContextKind, 'document');
});

test('pr and code route descriptors have null documentType and correct rubric', () => {
  const pr = getRouteDescriptor('review-fix-pr');
  assert.equal(pr.documentType, null);
  assert.equal(pr.rubric, 'pr');
  assert.equal(pr.targetContextKind, 'pr');

  const code = getRouteDescriptor('review-fix-code');
  assert.equal(code.documentType, null);
  assert.equal(code.rubric, 'code');
  assert.equal(code.targetContextKind, 'code');
});

test('route descriptors expose platform policy field', () => {
  // Document routes: claude and codex support review-and-fix; gemini is advisory-only
  const spec = getRouteDescriptor('review-fix-spec');
  assert.ok(spec.platformPolicy, 'descriptor must have platformPolicy');
  assert.equal(typeof spec.platformPolicy, 'object');

  // PR/code routes: gemini is advisory-only (review-and-fix unsupported)
  const pr = getRouteDescriptor('review-fix-pr');
  assert.ok(pr.platformPolicy, 'pr descriptor must have platformPolicy');
  assert.equal(typeof pr.platformPolicy, 'object');

  const code = getRouteDescriptor('review-fix-code');
  assert.ok(code.platformPolicy, 'code descriptor must have platformPolicy');
  assert.equal(typeof code.platformPolicy, 'object');
});

test('platform policy marks gemini as advisory-only for all routes', () => {
  for (const route of listRoutes()) {
    assert.equal(
      route.platformPolicy.gemini,
      'advisory-only',
      `${route.routeName} gemini policy must be advisory-only`
    );
  }
});

test('platform policy marks claude and codex as review-and-fix for all routes', () => {
  for (const route of listRoutes()) {
    assert.equal(
      route.platformPolicy.claude,
      'review-and-fix',
      `${route.routeName} claude policy`
    );
    assert.equal(
      route.platformPolicy.codex,
      'review-and-fix',
      `${route.routeName} codex policy`
    );
  }
});

// ---------------------------------------------------------------------------
// Document-only listing helper
// ---------------------------------------------------------------------------

test('listDocumentRoutes returns exactly the four document routes in order', () => {
  const names = listDocumentRoutes().map((r) => r.routeName);
  assert.deepEqual(names, [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
  ]);
  for (const route of listDocumentRoutes()) {
    assert.equal(route.routeKind, 'document');
  }
});

test('listRoutes and listDocumentRoutes return frozen, stable arrays', () => {
  assert.ok(Object.isFrozen(listRoutes()), 'listRoutes() must be frozen');
  assert.ok(Object.isFrozen(listDocumentRoutes()), 'listDocumentRoutes() must be frozen');
  assert.equal(listRoutes(), listRoutes(), 'listRoutes() identity is stable across calls');
  assert.equal(
    listDocumentRoutes(),
    listDocumentRoutes(),
    'listDocumentRoutes() identity is stable across calls'
  );
});

// ---------------------------------------------------------------------------
// getRouteDescriptor error behavior
// ---------------------------------------------------------------------------

test('getRouteDescriptor throws a coded error for unknown route names', () => {
  let err;
  try {
    getRouteDescriptor('review-fix-unknown');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should throw');
  assert.equal(err.code, 'ERR_ROUTE');
  assert.match(err.message, /unsupported route/i);
});

// ---------------------------------------------------------------------------
// Document route compatibility assertions (SPEC-PLAN-001)
// ---------------------------------------------------------------------------

test('document route descriptors match the generator ROUTES shape exactly', () => {
  // These values must stay identical to the current generator.js ROUTES for
  // backwards compatibility with downstream code that consumes documentType/rubric.
  const expectedDocRoutes = [
    { routeName: 'review-fix-spec', documentType: 'SPEC', rubric: 'spec' },
    { routeName: 'review-fix-plan', documentType: 'PLAN', rubric: 'plan' },
    { routeName: 'review-fix-design', documentType: 'DESIGN', rubric: 'design' },
    { routeName: 'review-fix-doc', documentType: 'COMMON', rubric: null },
  ];

  for (const expected of expectedDocRoutes) {
    const descriptor = getRouteDescriptor(expected.routeName);
    assert.equal(descriptor.routeName, expected.routeName);
    assert.equal(descriptor.documentType, expected.documentType);
    assert.equal(descriptor.rubric, expected.rubric);
  }
});

test('descriptors are immutable (frozen)', () => {
  const descriptor = getRouteDescriptor('review-fix-spec');
  assert.throws(() => {
    descriptor.routeName = 'mutated';
  }, TypeError);
});
