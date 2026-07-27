'use strict';

// Unit tests for lib/yaml-block-mapping.js.
//
// The parser exists to gate `drfx install` on the Codex invocation policy, so it is
// deliberately narrower than YAML: it accepts the plain block-mapping subset the
// generator emits and returns null for everything else rather than approximating.
// null must always mean "refuse", never "close enough" — these tests pin both
// directions, because a silent widening here would let a permissive
// `agents/openai.yaml` install.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseYamlBlockMapping } = require('../lib/yaml-block-mapping');

const plain = (value) => ({ kind: 'scalar', style: 'plain', value });
const quoted = (value) => ({ kind: 'scalar', style: 'quoted', value });

function parsed(content) {
  const mapping = parseYamlBlockMapping(content);
  assert.ok(mapping instanceof Map, `expected a mapping for: ${JSON.stringify(content)}`);
  return mapping;
}

function rejected(content, label) {
  assert.equal(parseYamlBlockMapping(content), null, `must reject: ${label}`);
}

// ---------------------------------------------------------------------------
// Accepted subset
// ---------------------------------------------------------------------------

test('parses a flat block mapping of plain scalars', () => {
  const mapping = parsed('a: 1\nb: two\n');
  assert.deepEqual([...mapping.keys()], ['a', 'b']);
  assert.deepEqual(mapping.get('a'), plain('1'));
  assert.deepEqual(mapping.get('b'), plain('two'));
});

test('parses nested mappings and reports their kind', () => {
  const mapping = parsed('policy:\n  allow_implicit_invocation: false\n');
  const policy = mapping.get('policy');
  assert.equal(policy.kind, 'mapping');
  assert.deepEqual(policy.value.get('allow_implicit_invocation'), plain('false'));
});

test('nests to arbitrary depth and keeps each level distinct', () => {
  const mapping = parsed('a:\n  b:\n    c: deep\n');
  const b = mapping.get('a').value.get('b');
  assert.equal(b.kind, 'mapping');
  assert.deepEqual(b.value.get('c'), plain('deep'));
  // The leaf key must NOT be visible on an ancestor: the install gate relies on this to
  // reject policy.<other>.allow_implicit_invocation.
  assert.equal(mapping.get('a').value.get('c'), undefined);
});

test('a child indent of any width is accepted as long as siblings agree', () => {
  for (const indent of [' ', '  ', '    ', '        ']) {
    const mapping = parsed(`policy:\n${indent}allow_implicit_invocation: false\n`);
    assert.deepEqual(mapping.get('policy').value.get('allow_implicit_invocation'), plain('false'));
  }
});

test('a key with no value is null, and a deeper block turns it into a mapping', () => {
  assert.deepEqual(parsed('policy:\n').get('policy'), { kind: 'null', value: null });
  assert.deepEqual(parsed('policy:\nother: 1\n').get('policy'), { kind: 'null', value: null });
  assert.equal(parsed('policy:\n  a: 1\n').get('policy').kind, 'mapping');
});

test('blank lines, comment lines, and inline comments are ignored', () => {
  const mapping = parsed([
    '# leading comment',
    '',
    'policy:',
    '  # indented comment',
    '  allow_implicit_invocation: false # trailing comment',
    '',
    '# closing comment'
  ].join('\n'));
  assert.deepEqual(mapping.get('policy').value.get('allow_implicit_invocation'), plain('false'));
});

test('a # that is not preceded by a space stays part of the plain scalar', () => {
  assert.deepEqual(parsed('a: red#not-a-comment\n').get('a'), plain('red#not-a-comment'));
});

test('trailing spaces and a missing final newline do not change the value', () => {
  assert.deepEqual(parsed('a: 1   \n').get('a'), plain('1'));
  assert.deepEqual(parsed('a: 1').get('a'), plain('1'));
});

test('preserves Unicode whitespace that YAML keeps in plain scalars', () => {
  assert.deepEqual(parsed('a: false\u00a0\n').get('a'), plain('false\u00a0'));
  assert.deepEqual(parsed('a: \u00a0false\n').get('a'), plain('\u00a0false'));
});

test('preserves printable Unicode text in plain scalars', () => {
  assert.deepEqual(parsed('a: café 中文 😀\n').get('a'), plain('café 中文 😀'));
});

test('CRLF line endings parse the same as LF', () => {
  assert.deepEqual(
    parsed('policy:\r\n  allow_implicit_invocation: false\r\n'),
    parsed('policy:\n  allow_implicit_invocation: false\n')
  );
});

test('double-quoted scalars are decoded and marked quoted', () => {
  const mapping = parsed('a: "plain"\nb: "with space"\nc: "esc \\"q\\" and \\\\"\nd: "#3B82F6"\ne: ""\n');
  assert.deepEqual(mapping.get('a'), quoted('plain'));
  assert.deepEqual(mapping.get('b'), quoted('with space'));
  assert.deepEqual(mapping.get('c'), quoted('esc "q" and \\'));
  assert.deepEqual(mapping.get('d'), quoted('#3B82F6'));
  assert.deepEqual(mapping.get('e'), quoted(''));
});

test("single-quoted scalars decode '' as one quote", () => {
  const mapping = parsed("a: 'plain'\nb: 'it''s here'\nc: '# not a comment'\n");
  assert.deepEqual(mapping.get('a'), quoted('plain'));
  assert.deepEqual(mapping.get('b'), quoted("it's here"));
  assert.deepEqual(mapping.get('c'), quoted('# not a comment'));
});

test('a quoted scalar keeps a # that appears inside the quotes', () => {
  assert.deepEqual(parsed('a: "keep # this" # drop this\n').get('a'), quoted('keep # this'));
});

test('keys may contain underscores, digits, and hyphens', () => {
  const mapping = parsed('allow_implicit_invocation: false\nicon-2x: "x"\n_private: 1\n');
  assert.deepEqual([...mapping.keys()], ['allow_implicit_invocation', 'icon-2x', '_private']);
});

// ---------------------------------------------------------------------------
// Rejected: structure
// ---------------------------------------------------------------------------

test('rejects non-string and empty input', () => {
  for (const content of [undefined, null, 42, {}, [], Buffer.from('a: 1\n')]) {
    assert.equal(parseYamlBlockMapping(content), null, `must reject: ${String(content)}`);
  }
  rejected('', 'empty string');
  rejected('\n\n', 'only blank lines');
  rejected('# only a comment\n', 'only a comment');
});

test('rejects duplicate keys at any level', () => {
  rejected('a: 1\na: 2\n', 'duplicate top-level key');
  rejected('policy:\n  a: 1\n  a: 2\n', 'duplicate nested key');
  rejected('policy:\n  a: 1\npolicy:\n  b: 2\n', 'duplicate block key');
});

test('rejects sequences', () => {
  rejected('policy:\n  - a: 1\n', 'sequence under a key');
  rejected('- a: 1\n', 'top-level sequence');
});

test('rejects flow style', () => {
  rejected('policy: {allow_implicit_invocation: false}\n', 'flow mapping');
  rejected('tools: [a, b]\n', 'flow sequence');
  rejected('policy:\n  a: [1]\n', 'nested flow sequence');
});

test('rejects document markers and unparsed leftovers', () => {
  rejected('---\na: 1\n', 'document start marker');
  rejected('a: 1\n...\n', 'document end marker');
  rejected('a: 1\nbare\n', 'a line that is not a key');
});

test('rejects tab indentation and control characters', () => {
  rejected('policy:\n\ta: 1\n', 'tab indentation');
  rejected('a:\tb\n', 'tab inside a line');
  rejected('a: \u0000\n', 'NUL byte');
  rejected('a: b\u001f\n', 'unit separator');
});

test('rejects every YAML-non-printable character range before discarding comments', () => {
  const ranges = [
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x84],
    [0x86, 0x9f]
  ];
  const codePoints = ranges.flatMap(([start, end]) =>
    Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
  );
  codePoints.push(0xd800, 0xdfff, 0xfffe, 0xffff);

  for (const codePoint of codePoints) {
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    rejected(`a: false # hidden ${String.fromCodePoint(codePoint)}\n`, `U+${hex}`);
  }
});

test('rejects unsupported Unicode line separators before discarding comments', () => {
  for (const codePoint of [0x85, 0x2028, 0x2029]) {
    const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
    const separator = String.fromCodePoint(codePoint);
    rejected(`a: false # hidden${separator}b: true\n`, `U+${hex}`);
  }
});

test('rejects indentation that does not line up', () => {
  rejected('  a: 1\n', 'indented first line');
  rejected('policy:\n    a: 1\n  b: 2\n', 'sibling dedent to an unopened level');
  rejected('a: 1\n  b: 2\n', 'child block under a scalar value');
});

test('rejects keys outside the supported character set', () => {
  rejected('"policy":\n  a: 1\n', 'quoted key');
  rejected('2fa: 1\n', 'key starting with a digit');
  rejected('a.b: 1\n', 'key containing a dot');
  rejected('<<: *anchor\n', 'merge key');
});

// ---------------------------------------------------------------------------
// Rejected: scalars
// ---------------------------------------------------------------------------

test('rejects a key/value with no space after the colon', () => {
  rejected('a:1\n', 'no space after colon');
});

test('rejects unterminated or malformed quoted scalars', () => {
  rejected('a: "unterminated\n', 'unterminated double quote');
  rejected("a: 'unterminated\n", 'unterminated single quote');
  rejected('a: "bad \\x escape"\n', 'invalid escape');
  rejected('a: "trailing" junk\n', 'text after a closing quote');
});

test('rejects YAML features outside the subset', () => {
  for (const [value, label] of [
    ['&anchor x', 'anchor'],
    ['*alias', 'alias'],
    ['!!str x', 'tag'],
    ['| block', 'literal block scalar'],
    ['> folded', 'folded block scalar'],
    ['? complex', 'explicit key indicator'],
    ['%TAG', 'directive indicator']
  ]) {
    rejected(`a: ${value}\n`, label);
  }
});

test('rejects a plain scalar that itself looks like a mapping', () => {
  rejected('a: b: c\n', 'colon-space inside a plain scalar');
});

// ---------------------------------------------------------------------------
// The shipped policy template
// ---------------------------------------------------------------------------

test('the shipped Codex policy template parses and disables implicit invocation', () => {
  const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'codex-openai.yaml'), 'utf8');
  const mapping = parsed(template);
  const policy = mapping.get('policy');
  assert.equal(policy.kind, 'mapping');
  assert.deepEqual(policy.value.get('allow_implicit_invocation'), plain('false'));
});
