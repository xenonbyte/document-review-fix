'use strict';

// Read-side backward compatibility for the file-set baseline `mode` field.
// Baselines persisted by versions before mode tracking omit `mode` on their entries.
// readPersistedFileSetBaseline must tolerate a MISSING mode (and skip the downstream
// chmod), while still rejecting a PRESENT-but-invalid mode as corruption.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BODY = Buffer.from('hello');
const BODY_SHA256 = crypto.createHash('sha256').update(BODY).digest('hex');

const {
  persistFileSetBaseline,
  readPersistedFileSetBaseline
} = require('../lib/workflow/helpers');

function makeMetadata(t) {
  const targetStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drfx-baseline-mode-'));
  t.after(() => fs.rmSync(targetStateDir, { recursive: true, force: true }));
  return { targetStateDir };
}

function persistWithMode(metadata) {
  persistFileSetBaseline(metadata, {
    status: 'passed',
    guardMode: 'snapshot',
    entries: [{
      path: 'src/a.js',
      pathSha256: 'a'.repeat(64),
      missing: false,
      sha256: BODY_SHA256,
      size: BODY.length,
      mtimeMs: 123,
      mode: 0o644,
      body: BODY
    }],
    treeEntries: [],
    excludedDirectories: []
  });
}

function rewritePersistedEntry(metadata, mutate) {
  const file = path.join(metadata.targetStateDir, fs.readdirSync(metadata.targetStateDir)
    .find((name) => name.endsWith('.json')));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(parsed.entries[0]);
  fs.writeFileSync(file, JSON.stringify(parsed));
}

test('readPersistedFileSetBaseline tolerates a legacy entry with no mode and skips it', (t) => {
  const metadata = makeMetadata(t);
  persistWithMode(metadata);
  // Simulate a pre-mode baseline: drop the field entirely, as older versions wrote it.
  rewritePersistedEntry(metadata, (entry) => { delete entry.mode; });

  const baseline = readPersistedFileSetBaseline(metadata);
  assert.ok(baseline, 'legacy baseline must still load');
  const [entry] = baseline.entries;
  assert.equal(entry.missing, false);
  assert.equal('mode' in entry, false, 'missing mode must not be materialized (downstream skips chmod)');
  assert.equal(entry.body.toString('utf8'), 'hello', 'body must still load for a present monitored file');
});

test('readPersistedFileSetBaseline treats an explicit null mode as absent', (t) => {
  const metadata = makeMetadata(t);
  persistWithMode(metadata);
  rewritePersistedEntry(metadata, (entry) => { entry.mode = null; });

  const baseline = readPersistedFileSetBaseline(metadata);
  assert.ok(baseline);
  assert.equal('mode' in baseline.entries[0], false);
});

test('readPersistedFileSetBaseline still rejects a present but invalid mode as corruption', (t) => {
  const metadata = makeMetadata(t);
  persistWithMode(metadata);
  rewritePersistedEntry(metadata, (entry) => { entry.mode = 0o10000; });

  // The reader degrades any validation failure to null (no usable baseline) rather than
  // throwing; an out-of-range mode must NOT be silently accepted as a legacy-absent mode.
  assert.equal(readPersistedFileSetBaseline(metadata), null);
});

test('readPersistedFileSetBaseline preserves a valid present mode', (t) => {
  const metadata = makeMetadata(t);
  persistWithMode(metadata);

  const baseline = readPersistedFileSetBaseline(metadata);
  assert.equal(baseline.entries[0].mode, 0o644);
});
