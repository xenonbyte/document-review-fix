'use strict';

// README content parity tests (PLAN-TASK-010).
// Verifies that README.md and README.zh-CN.md:
//   - cover all seven route names including the two new code routes and r2p
//   - carry the required technical literals for the code-route invocation tokens
//   - align on section headings and identical technical literals across both files
//   - describe Gemini advisory-only behavior for code routes correctly

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const {
  CODE_EXCLUDED_DIRECTORIES,
  CODE_EXCLUDED_DIRECTORY_PATHS,
  DRFXIGNORE_FILENAME
} = require('../lib/target-context');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// All seven route names present in both READMEs
// ---------------------------------------------------------------------------

test('both READMEs list all seven route names', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  const routes = [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
    'review-fix-pr',
    'review-fix-code',
    'review-fix-r2p'
  ];
  for (const route of routes) {
    assert.match(en, new RegExp(escapeRegExp(route)), `README.md missing ${route}`);
    assert.match(zh, new RegExp(escapeRegExp(route)), `README.zh-CN.md missing ${route}`);
  }
});

// ---------------------------------------------------------------------------
// Required code-route invocation tokens in both READMEs
// ---------------------------------------------------------------------------

test('both READMEs document required code-route invocation tokens', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  const tokens = [
    'base=<branch>',
    'scope=<path>',
    'rounds=<n>',
    'guard=git',
    'guard=snapshot',
    'resume'
  ];
  for (const token of tokens) {
    assert.match(en, new RegExp(escapeRegExp(token)), `README.md missing token: ${token}`);
    assert.match(zh, new RegExp(escapeRegExp(token)), `README.zh-CN.md missing token: ${token}`);
  }
});

// ---------------------------------------------------------------------------
// PR route rules: base= required, local-only, no fetch
// ---------------------------------------------------------------------------

test('both READMEs document that base=<branch> is required for review-fix-pr', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // base= is required and is documented near review-fix-pr
  assert.match(en, /review-fix-pr[\s\S]{0,600}base=<branch>/i);
  assert.match(zh, /review-fix-pr[\s\S]{0,600}base=<branch>/i);
});

test('both READMEs state review-fix-pr does not fetch from remote', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // Implemented behavior: local git only, no fetch
  assert.match(en, /no fetch|local git|local.only|does not fetch/i);
  assert.match(zh, /no fetch|local git|local.only|does not fetch/i);
});

// ---------------------------------------------------------------------------
// CODE route rules: scope= optional/repeatable, base= rejected
// ---------------------------------------------------------------------------

test('both READMEs document scope= repeatable for review-fix-code', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /scope=[\s\S]{0,200}repeat|repeat[\s\S]{0,200}scope=/i);
  assert.match(zh, /scope=[\s\S]{0,200}repeat|repeat[\s\S]{0,200}scope=/i);
});

// ---------------------------------------------------------------------------
// CODE exclusion rules: full built-in list, no-gitignore, .drfxignore syntax
// ---------------------------------------------------------------------------

test('both READMEs list every built-in CODE excluded directory', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  for (const directory of CODE_EXCLUDED_DIRECTORIES) {
    const literal = `\`${directory}\``;
    assert.ok(en.includes(literal), `README.md missing built-in exclusion: ${literal}`);
    assert.ok(zh.includes(literal), `README.zh-CN.md missing built-in exclusion: ${literal}`);
  }
  for (const directory of CODE_EXCLUDED_DIRECTORY_PATHS) {
    const literal = `\`${directory}\``;
    assert.ok(en.includes(literal), `README.md missing built-in path exclusion: ${literal}`);
    assert.ok(zh.includes(literal), `README.zh-CN.md missing built-in path exclusion: ${literal}`);
  }
});

test('both READMEs state that version-control-ignored files are excluded via git', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /Version-control-ignored files are excluded automatically/);
  assert.match(zh, /版本忽略的文件自动排除/);
  // git's own semantics: tracked files are never version-ignored.
  assert.match(en, /tracked files are never version-ignored/i);
  assert.match(zh, /tracked 文件永远不会被版本忽略/);
  // Non-git roots skip this source instead of failing.
  assert.match(en, /non-git root/i);
  assert.match(zh, /非 git 根目录/);
});

test('both READMEs state non-root explicit scope= runs stay single-pass regardless of size', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /Explicit non-root directory\/file scopes are reviewed in a single pass regardless of size/);
  assert.match(en, /`scope=\.`[\s\S]{0,120}treated as whole-root/);
  assert.match(zh, /显式传入非根目录\/文件 `scope=` 的运行无论大小都按单遍审查/);
  assert.match(zh, /`scope=\.`[\s\S]{0,120}whole-root/);
});

test('both READMEs document the .drfxignore contract', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  const literal = `\`${DRFXIGNORE_FILENAME}\``;
  assert.ok(en.includes(literal), `README.md missing ${literal}`);
  assert.ok(zh.includes(literal), `README.zh-CN.md missing ${literal}`);
  // .drfxignore shares .gitignore syntax: negation, anchoring, globs.
  assert.match(en, /\.drfxignore[\s\S]{0,200}`\.gitignore` syntax/i);
  assert.match(zh, /语法与 `\.gitignore` 一致/);
  assert.match(en, /last-match-wins/i);
  assert.match(zh, /后匹配规则胜出|后匹配胜出/);
  // Explicit scope= always wins over every ignore source, never silently.
  assert.match(en, /Explicit `scope=` always wins/i);
  assert.match(zh, /显式 `scope=` 永远优先/);
  assert.match(en, /reported, never silent/i);
  assert.match(zh, /覆盖会被报告，绝不静默/);
  // Pattern lines (order included) join the review-target identity.
  assert.match(en, /pattern lines[\s\S]{0,200}identity|identity[\s\S]{0,200}pattern/i);
  assert.match(zh, /pattern 行[\s\S]{0,80}身份/);
  // Raw pattern text must not be persisted in workflow state.
  assert.match(en, /Raw pattern text is not stored in workflow state/);
  assert.match(zh, /Raw pattern text 不会写入 workflow state/);
  assert.match(en, /ordered digests carry identity/);
  assert.match(zh, /身份由有序 digest 承载/);
});

test('both READMEs document directory-or-file scopes for review-fix-code', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /scope=<path>` names a directory to walk or a single file/i);
  assert.match(zh, /指定要遍历的目录或要直接纳入的单个文件/);
});

// ---------------------------------------------------------------------------
// rounds=<n> for document routes and code routes, incompatible with read-only
// ---------------------------------------------------------------------------

test('both READMEs document rounds=<n> and its read-only incompatibility', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // rounds=<n> must appear
  assert.match(en, /rounds=<n>/);
  assert.match(zh, /rounds=<n>/);
  // read-only incompatibility must be noted
  assert.match(en, /rounds[\s\S]{0,200}read-only|read-only[\s\S]{0,200}rounds/i);
  assert.match(zh, /rounds[\s\S]{0,200}read-only|read-only[\s\S]{0,200}rounds/i);
});

// ---------------------------------------------------------------------------
// guard= behavior: default git, explicit snapshot, never silent switch
// ---------------------------------------------------------------------------

test('both READMEs document guard=git as default and guard=snapshot as explicit option', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // guard=git is the default (English README uses "default"; zh-CN uses "默认")
  assert.match(en, /guard=git[\s\S]{0,200}default|default[\s\S]{0,200}guard=git/i);
  assert.match(zh, /guard=git[\s\S]{0,200}(?:default|默认)|(?:default|默认)[\s\S]{0,200}guard=git/i);
  // guard=snapshot is documented in both
  assert.match(en, /guard=snapshot/);
  assert.match(zh, /guard=snapshot/);
});

// ---------------------------------------------------------------------------
// Code-route explicit resume behavior
// ---------------------------------------------------------------------------

test('both READMEs document explicit resume for PR and CODE routes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // resume must appear near the PR/CODE routes section
  assert.match(en, /review-fix-pr[\s\S]{0,2000}resume|resume[\s\S]{0,500}review-fix-pr/i);
  assert.match(zh, /review-fix-pr[\s\S]{0,2000}resume|resume[\s\S]{0,500}review-fix-pr/i);
  assert.match(en, /review-fix-code[\s\S]{0,2000}resume|resume[\s\S]{0,500}review-fix-code/i);
  assert.match(zh, /review-fix-code[\s\S]{0,2000}resume|resume[\s\S]{0,500}review-fix-code/i);
});

// ---------------------------------------------------------------------------
// PR/CODE rule paths documented (no COMMON layer for code routes)
// ---------------------------------------------------------------------------

test('both READMEs document PR and CODE custom rule paths', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // user-global and project-local rule paths for PR and CODE
  assert.match(en, /~\/\.drfx\/rules\/PR\.md/);
  assert.match(zh, /~\/\.drfx\/rules\/PR\.md/);
  assert.match(en, /~\/\.drfx\/rules\/CODE\.md/);
  assert.match(zh, /~\/\.drfx\/rules\/CODE\.md/);
  assert.match(en, /\.drfx\/rules\/PR\.md/);
  assert.match(zh, /\.drfx\/rules\/PR\.md/);
  assert.match(en, /\.drfx\/rules\/CODE\.md/);
  assert.match(zh, /\.drfx\/rules\/CODE\.md/);
});

test('both READMEs state code routes have no COMMON rule layer', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // The rubric header for PR/CODE is self-contained: "no COMMON layer"
  assert.match(en, /no COMMON layer|self-contained|COMMON layer[\s\S]{0,80}code route|code route[\s\S]{0,80}COMMON layer/i);
  assert.match(zh, /no COMMON layer|self-contained|COMMON layer[\s\S]{0,80}code route|code route[\s\S]{0,80}COMMON layer/i);
});

// ---------------------------------------------------------------------------
// Gemini advisory-only for code routes: no automatic fixing, no workflow PASS
// ---------------------------------------------------------------------------

test('both READMEs say Gemini code routes are advisory-only with no automatic fixing', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // advisory-only for code routes on Gemini
  assert.match(en, /Gemini[\s\S]{0,400}advisory[\s\S]{0,200}code route|code route[\s\S]{0,400}advisory[\s\S]{0,200}Gemini/i);
  assert.match(zh, /Gemini[\s\S]{0,400}advisory[\s\S]{0,200}code route|code route[\s\S]{0,400}advisory[\s\S]{0,200}Gemini/i);
  // Must NOT say "Gemini can automatically fix" code route files.
  // "Gemini [...] automatic fixing never runs" is correct — reject the positive claim only.
  assert.doesNotMatch(en, /Gemini[\s\S]{0,100}(?:will|can|runs?)\s+(?:automatically?\s+fix|auto.fix)/i);
  assert.doesNotMatch(zh, /Gemini[\s\S]{0,100}(?:will|can|runs?)\s+(?:automatically?\s+fix|auto.fix)/i);
});

test('both READMEs do not claim Gemini code routes can reach workflow PASS', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // Must NOT say "workflow PASS is available/supported" for Gemini code routes.
  // "workflow PASS is unavailable" is the correct wording — ensure we only block the positive claim.
  assert.doesNotMatch(en, /Gemini[\s\S]{0,300}workflow PASS\s+is\s+(?:available|supported)/i);
  assert.doesNotMatch(zh, /Gemini[\s\S]{0,300}workflow PASS\s+is\s+(?:available|supported)/i);
  // Verify the README positively states that workflow PASS is unavailable for code routes on Gemini.
  // EN uses "unavailable"; zh-CN uses "不可用" (unavailable in Chinese).
  assert.match(en, /workflow PASS[\s\S]{0,100}unavailable|unavailable[\s\S]{0,100}workflow PASS/i);
  assert.match(zh, /workflow PASS[\s\S]{0,100}(?:unavailable|不可用)|(?:unavailable|不可用)[\s\S]{0,100}workflow PASS/i);
});

// ---------------------------------------------------------------------------
// Required examples in both READMEs
// ---------------------------------------------------------------------------

test('both READMEs include a PR review example with base=', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /review-fix-pr base=/);
  assert.match(zh, /review-fix-pr base=/);
});

test('both READMEs include a whole-project CODE root review example (no scope=)', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // The examples use the slash-command form and document Codex's `$` prefix separately.
  // Match the explicit command on its own line so a scoped form cannot satisfy it.
  assert.match(en, /^\/review-fix-code\s*$/m);
  assert.match(zh, /^\/review-fix-code\s*$/m);
});

test('both READMEs include a scoped CODE review example (scope=)', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /review-fix-code scope=/);
  assert.match(zh, /review-fix-code scope=/);
});

test('both READMEs include a read-only code review example', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  // A read-only example for one of the code routes
  assert.match(en, /review-fix-(?:pr|code)[\s\S]{0,200}read-only|read-only[\s\S]{0,200}review-fix-(?:pr|code)/);
  assert.match(zh, /review-fix-(?:pr|code)[\s\S]{0,200}read-only|read-only[\s\S]{0,200}review-fix-(?:pr|code)/);
});

test('both READMEs include an explicit snapshot guard example for code routes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /review-fix-(?:pr|code)[\s\S]{0,400}guard=snapshot|guard=snapshot[\s\S]{0,200}review-fix-(?:pr|code)/);
  assert.match(zh, /review-fix-(?:pr|code)[\s\S]{0,400}guard=snapshot|guard=snapshot[\s\S]{0,200}review-fix-(?:pr|code)/);
});

test('both READMEs include a rounds= example for code routes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /review-fix-(?:pr|code|spec|plan|design|doc)[\s\S]{0,600}rounds=\d|rounds=\d[\s\S]{0,200}review-fix-/);
  assert.match(zh, /review-fix-(?:pr|code|spec|plan|design|doc)[\s\S]{0,600}rounds=\d|rounds=\d[\s\S]{0,200}review-fix-/);
});

test('both READMEs include an explicit resume example for code routes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /review-fix-(?:pr|code)[\s\S]{0,600}resume/);
  assert.match(zh, /review-fix-(?:pr|code)[\s\S]{0,600}resume/);
});

test('both READMEs document workflow compact and full JSON modes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  for (const literal of ['drfx workflow', '--json', '--json=full', '--json=compact']) {
    assert.match(en, new RegExp(escapeRegExp(literal)), `README.md missing literal: ${literal}`);
    assert.match(zh, new RegExp(escapeRegExp(literal)), `README.zh-CN.md missing literal: ${literal}`);
  }
  assert.match(en, /generated routes[\s\S]{0,300}`--json=compact`|`--json=compact`[\s\S]{0,300}generated routes/i);
  assert.match(zh, /generated routes[\s\S]{0,300}`--json=compact`|`--json=compact`[\s\S]{0,300}generated routes/i);
});

test('both READMEs document full JSON and debug artifact paths for diagnosis', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /`--json=full`[\s\S]{0,400}artifact paths|artifact paths[\s\S]{0,400}`--json=full`/i);
  assert.match(zh, /`--json=full`[\s\S]{0,400}artifact paths|artifact paths[\s\S]{0,400}`--json=full`/i);
  assert.match(en, /`debug`[\s\S]{0,400}artifact paths|artifact paths[\s\S]{0,400}`debug`/i);
  assert.match(zh, /`debug`[\s\S]{0,400}artifact paths|artifact paths[\s\S]{0,400}`debug`/i);
});

test('both READMEs distinguish safe fix-report-mismatch retry from reset and manual recovery', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  for (const literal of ['fix-report-mismatch', 'retry end-fix with a valid fix report', 'reset']) {
    assert.match(en, new RegExp(escapeRegExp(literal)), `README.md missing literal: ${literal}`);
    assert.match(zh, new RegExp(escapeRegExp(literal)), `README.zh-CN.md missing literal: ${literal}`);
  }
  assert.match(en, /safe retry[\s\S]{0,500}manual recovery|manual recovery[\s\S]{0,500}safe retry/i);
  assert.match(zh, /safe retry[\s\S]{0,500}manual recovery|manual recovery[\s\S]{0,500}safe retry/i);
});

// ---------------------------------------------------------------------------
// Section-level alignment: both files must have the same ## and ### headings
// ---------------------------------------------------------------------------

test('README.md and README.zh-CN.md have identical section heading structure', () => {
  function sectionHeadings(text) {
    return text
      .split('\n')
      .filter((line) => /^#{2,3} /.test(line))
      .map((line) => line.trim());
  }
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.deepEqual(sectionHeadings(zh), sectionHeadings(en));
});

// ---------------------------------------------------------------------------
// Technical literal parity: critical tokens must appear identically in both
// ---------------------------------------------------------------------------

test('critical technical literals are identical in both READMEs', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  const literals = [
    'review-fix-pr',
    'review-fix-code',
    'base=<branch>',
    'scope=<path>',
    'rounds=<n>',
    'guard=git',
    'guard=snapshot',
    'resume',
    'read-only',
    'review-and-fix',
    '.drfxignore',
    '--json=full',
    '--json=compact',
    'fix-report-mismatch',
    '~/.drfx/rules/PR.md',
    '~/.drfx/rules/CODE.md',
    '.drfx/rules/PR.md',
    '.drfx/rules/CODE.md'
  ];
  for (const literal of literals) {
    assert.match(en, new RegExp(escapeRegExp(literal)), `README.md missing literal: ${literal}`);
    assert.match(zh, new RegExp(escapeRegExp(literal)), `README.zh-CN.md missing literal: ${literal}`);
  }
});

// ---------------------------------------------------------------------------
// Document-route regression: existing document route content still accurate
// ---------------------------------------------------------------------------

test('both READMEs still cover all four document routes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  for (const route of ['review-fix-spec', 'review-fix-plan', 'review-fix-design', 'review-fix-doc']) {
    assert.match(en, new RegExp(escapeRegExp(route)));
    assert.match(zh, new RegExp(escapeRegExp(route)));
  }
});

test('both READMEs still document guard=git|snapshot for document routes', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /guard=git\|snapshot/);
  assert.match(zh, /guard=git\|snapshot/);
});
