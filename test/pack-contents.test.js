'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function packFiles() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const report = JSON.parse(stdout);
  return report[0].files.map((entry) => entry.path);
}

function packTopLevelEntries(files) {
  return new Set(files.map((p) => (p.includes('/') ? `${p.split('/')[0]}/` : p)));
}

const ROUTE_NAMES = [
  'review-fix-spec',
  'review-fix-plan',
  'review-fix-design',
  'review-fix-doc',
  'review-fix-pr',
  'review-fix-code',
  'review-fix-r2p'
];

test('npm pack ships exactly the runtime whitelist and no tests', () => {
  const tops = packTopLevelEntries(packFiles());
  const expected = [
    'LICENSE',
    'README.md',
    'README.zh-CN.md',
    'bin/',
    'lib/',
    'package.json',
    'shared/',
    'skills/',
    'templates/'
  ];
  assert.deepEqual([...tops].sort(), expected);
  assert.equal(tops.has('test/'), false);
});

// The generated Codex policy is rendered from templates/codex-openai.yaml at install
// time, and the source descriptors under skills/ carry their own copy. Both must ship,
// or an install (or a hand-copied descriptor) silently falls back to Codex's
// allow_implicit_invocation default of true.
test('npm pack ships the explicit-invocation policy source and every source skill copy', () => {
  const files = new Set(packFiles());
  assert.equal(files.has('templates/codex-openai.yaml'), true, 'npm pack must ship templates/codex-openai.yaml');
  for (const routeName of ROUTE_NAMES) {
    const required = `skills/${routeName}/agents/openai.yaml`;
    assert.equal(files.has(required), true, `npm pack must ship ${required}`);
  }
});

test('npm pack ships the code-route skills, rubrics, and template fragments', () => {
  const files = new Set(packFiles());
  for (const required of [
    'skills/review-fix-pr/SKILL.md',
    'skills/review-fix-code/SKILL.md',
    'shared/rubrics/pr.md',
    'shared/rubrics/code.md',
    'templates/fragments/route-contract.pr.claude.md',
    'templates/fragments/route-contract.code.codex.md',
    'templates/fragments/route-contract.pr.gemini.md',
    'templates/fragments/invocation-gate.code.claude.md',
    'templates/fragments/invocation-gate.pr.gemini.md'
  ]) {
    assert.equal(files.has(required), true, `npm pack must ship ${required}`);
  }
});

test('npm pack ships the r2p skill and all four-platform r2p template fragments', () => {
  const files = new Set(packFiles());
  for (const required of [
    'skills/review-fix-r2p/SKILL.md',
    'templates/fragments/route-contract.r2p.claude.md',
    'templates/fragments/route-contract.r2p.codex.md',
    'templates/fragments/route-contract.r2p.gemini.md',
    'templates/fragments/route-contract.r2p.opencode.md',
    'templates/fragments/invocation-gate.r2p.claude.md',
    'templates/fragments/invocation-gate.r2p.codex.md',
    'templates/fragments/invocation-gate.r2p.gemini.md',
    'templates/fragments/invocation-gate.r2p.opencode.md'
  ]) {
    assert.equal(files.has(required), true, `npm pack must ship ${required}`);
  }
});
