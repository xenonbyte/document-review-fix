'use strict';

// Drift guard for the hand-maintained source skill descriptors under skills/.
//
// skills/<route>/SKILL.md are concise, hand-authored descriptors that ship in
// the npm package (package.json files[] -> "skills/") and are read directly by
// users. They are NOT the install-time generated platform skill (that is
// rendered fresh from templates/ into each platform root and is ~20x longer),
// so they can silently drift from the route registry and templates — exactly
// how review-fix-r2p's descriptor lost its bare-target shorthand line while
// the parser, README, and generated codex skill all documented it.
//
// These invariants are deliberately minimal and zero-false-positive: they
// assert only the facts that actually drifted (route name + the bare-target or
// bare-workId affordance representation). Token-level accept/reject correctness
// is owned by the parser's own tests (test/input-parsing.test.js), not by
// descriptor prose.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listRoutes } = require('../lib/routes');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

// Routes whose parser accepts a bare path as shorthand for the primary target.
const BARE_TARGET_KINDS = new Set(['document']);
// Routes that have no bare-path form (PR keys on base=, CODE on scope=).
const NON_BARE_KINDS = new Set(['pr', 'code']);

function readDescriptor(routeName) {
  const file = path.join(SKILLS_DIR, routeName, 'SKILL.md');
  return { file, text: fs.readFileSync(file, 'utf8') };
}

function frontmatterName(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const nameLine = m[1].match(/^name:\s*(.+)$/m);
  return nameLine ? nameLine[1].trim() : null;
}

for (const route of listRoutes()) {
  test(`source descriptor ${route.routeName}: exists with matching frontmatter name`, () => {
    const { file, text } = readDescriptor(route.routeName);
    assert.ok(fs.existsSync(file), `missing source descriptor: ${file}`);
    assert.equal(
      frontmatterName(text),
      route.routeName,
      `frontmatter name must equal the registered route name in ${file}`
    );
  });

  test(`source descriptor ${route.routeName}: represents the bare-target affordance consistently`, () => {
    const { file, text } = readDescriptor(route.routeName);
    if (BARE_TARGET_KINDS.has(route.routeKind)) {
      assert.match(
        text,
        /bare[\s\S]*?shorthand/i,
        `${route.routeKind} route accepts a bare target — its descriptor must document the shorthand (${file})`
      );
    } else if (route.routeKind === 'r2p') {
      assert.match(
        text,
        /bare[\s\S]*?WF-[\s\S]*?shorthand/i,
        `r2p accepts a bare workId shorthand — its descriptor must document that affordance (${file})`
      );
    } else if (NON_BARE_KINDS.has(route.routeKind)) {
      assert.match(
        text,
        /no bare-path/i,
        `${route.routeKind} route has no bare-path form — its descriptor must say so (${file})`
      );
    }
  });
}

test('source descriptors preserve explicit Codex invocation syntax', () => {
  for (const route of listRoutes()) {
    const { file, text } = readDescriptor(route.routeName);

    assert.ok(
      text.includes(`\`\`\`text\n$${route.routeName}`),
      `Invocation syntax must use the Codex $ prefix (${file})`
    );
    if (text.includes('Full form:')) {
      assert.ok(
        text.includes(`Full form: \`$${route.routeName}`),
        `Full form must use the Codex $ prefix (${file})`
      );
    }
  }

  const { file, text } = readDescriptor('review-fix-r2p');
  assert.ok(
    text.includes('then rerun `$review-fix-r2p workId=<new-or-same-WF-...>`'),
    `clean rerun guidance must use the Codex $ prefix (${file})`
  );
});
