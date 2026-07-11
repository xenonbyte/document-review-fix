'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ALLOWED_ISSUE_STATUSES,
  formatLedger,
  parseLedger,
  nextIssueId,
  addAcceptedFinding,
  mergeIssue,
  rejectIssue,
  deferIssue,
  reopenIssue,
  applyTriageDecisions
} = require('../lib/ledger');

const TABLE_HEADER = '| ID | Severity | Status | Location | Summary | Resolution |';

test('formats and parses the issue ledger table', () => {
  const ledger = {
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'fixed',
        location: 'Requirements / Auth',
        summary: 'Missing failure behavior',
        resolution: 'Added invalid-token flow'
      }
    ]
  };

  const text = formatLedger(ledger);

  assert.equal(text.split('\n')[0], TABLE_HEADER);
  assert.deepEqual(parseLedger(text), ledger);
});

test('validates allowed statuses and rejects unknown status', () => {
  assert.deepEqual(ALLOWED_ISSUE_STATUSES, ['accepted', 'fixed', 'merged', 'rejected', 'deferred', 'reopened']);
  assert.throws(
    () => formatLedger({ issues: [{ id: 'ISSUE-001', severity: 'high', status: 'unknown', location: 'A', summary: 'B', resolution: 'C' }] }),
    /unknown status/i
  );
  assert.throws(
    () => parseLedger(`${TABLE_HEADER}\n| --- | --- | --- | --- | --- | --- |\n| ISSUE-001 | high | unknown | A | B | C |`),
    /unknown status/i
  );
});

test('rejects unknown severities and duplicate issue ids in ledger input', () => {
  assert.throws(
    () => formatLedger({
      issues: [{ id: 'ISSUE-001', severity: 'critical', status: 'accepted', location: 'A', summary: 'B', resolution: 'C' }]
    }),
    /unknown severity/i
  );
  assert.throws(
    () => parseLedger([
      TABLE_HEADER,
      '| --- | --- | --- | --- | --- | --- |',
      '| ISSUE-001 | high | accepted | A | B | C |',
      '| ISSUE-001 | medium | accepted | D | E | F |'
    ].join('\n')),
    /duplicate.*ISSUE-001/i
  );
});

test('rejects invalid ledger table separators', () => {
  assert.throws(
    () => parseLedger(`${TABLE_HEADER}\n${TABLE_HEADER}\n| ISSUE-001 | high | accepted | A | B | C |`),
    /separator/i
  );
  assert.throws(
    () => parseLedger(`${TABLE_HEADER}\n| --- | bad | --- | --- | --- | --- |\n| ISSUE-001 | high | accepted | A | B | C |`),
    /separator/i
  );
});

test('assigns stable issue ids without reusing existing ids', () => {
  assert.equal(nextIssueId([]), 'ISSUE-001');
  assert.equal(nextIssueId([{ id: 'ISSUE-001' }, { id: 'ISSUE-004' }, { id: 'NOTE-999' }]), 'ISSUE-005');

  const ledger = addAcceptedFinding({ issues: [{ id: 'ISSUE-003', severity: 'low', status: 'fixed', location: 'A', summary: 'B', resolution: 'C' }] }, {
    severity: 'medium',
    location: 'Plan / Rollback',
    issue: 'No rollback step',
    suggested_fix: 'Add rollback procedure'
  });

  assert.equal(ledger.issues[1].id, 'ISSUE-004');
  assert.equal(ledger.issues[1].status, 'accepted');
  assert.equal(ledger.issues[1].summary, 'No rollback step');
  assert.equal(ledger.issues[1].resolution, 'Add rollback procedure');
});

test('preserves reopened issue ids', () => {
  const ledger = addAcceptedFinding({ issues: [] }, {
    severity: 'medium',
    location: 'Plan / Rollback',
    issue: 'No rollback step',
    suggested_fix: 'Add rollback procedure'
  });

  const reopened = reopenIssue(ledger, 'ISSUE-001', 'Regression after edit');

  assert.equal(reopened.issues[0].id, 'ISSUE-001');
  assert.equal(reopened.issues[0].status, 'reopened');
  assert.match(reopened.issues[0].resolution, /Regression after edit/);
});

test('records merged references', () => {
  const base = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'Primary', resolution: 'Pending fix' },
      { id: 'ISSUE-002', severity: 'medium', status: 'accepted', location: 'B', summary: 'Duplicate', resolution: 'Pending fix' }
    ]
  };

  const merged = mergeIssue(base, 'ISSUE-002', 'ISSUE-001');

  assert.equal(merged.issues[1].status, 'merged');
  assert.match(merged.issues[1].resolution, /Merged into ISSUE-001/);
});

test('triage merge graph rejects cycles and non-active canonical survivors', () => {
  const active = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'A', resolution: 'Pending' },
      { id: 'ISSUE-002', severity: 'medium', status: 'accepted', location: 'B', summary: 'B', resolution: 'Pending' }
    ]
  };
  assert.throws(
    () => applyTriageDecisions(active, [
      { reviewer_id: 'R001', issue_id: 'ISSUE-001', decision: 'merged', severity: 'high', merged_into: 'ISSUE-002', rationale: 'Duplicate' },
      { reviewer_id: 'R002', issue_id: 'ISSUE-002', decision: 'merged', severity: 'medium', merged_into: 'ISSUE-001', rationale: 'Duplicate' }
    ]),
    /merge.*cycle|cyclic/i
  );

  const fixedSurvivor = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'A', resolution: 'Pending' },
      { id: 'ISSUE-002', severity: 'high', status: 'fixed', location: 'B', summary: 'B', resolution: 'Fixed' }
    ]
  };
  assert.throws(
    () => applyTriageDecisions(fixedSurvivor, [
      { reviewer_id: 'R001', issue_id: 'ISSUE-001', decision: 'merged', severity: 'high', merged_into: 'ISSUE-002', rationale: 'Duplicate' }
    ]),
    /canonical|accepted|reopened|fixed/i
  );
});

test('triage merge preserves the highest blocking severity on the survivor', () => {
  const merged = applyTriageDecisions({
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'A', resolution: 'Pending' },
      { id: 'ISSUE-002', severity: 'low', status: 'accepted', location: 'B', summary: 'B', resolution: 'Pending' }
    ]
  }, [
    { reviewer_id: 'R001', issue_id: 'ISSUE-001', decision: 'merged', severity: 'high', merged_into: 'ISSUE-002', rationale: 'Duplicate' }
  ]);

  assert.equal(merged.issues.find((issue) => issue.id === 'ISSUE-001').status, 'merged');
  assert.equal(merged.issues.find((issue) => issue.id === 'ISSUE-002').status, 'accepted');
  assert.equal(merged.issues.find((issue) => issue.id === 'ISSUE-002').severity, 'high');
});

test('triage rejects a batch that transitions a canonical merge survivor out of blocking state', () => {
  const active = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'A', resolution: 'Pending' },
      { id: 'ISSUE-002', severity: 'low', status: 'accepted', location: 'B', summary: 'B', resolution: 'Pending' }
    ]
  };

  for (const terminalDecision of [
    { reviewer_id: 'R002', issue_id: 'ISSUE-002', decision: 'rejected', severity: 'low', rationale: 'Not actionable' },
    {
      reviewer_id: 'R002',
      issue_id: 'ISSUE-002',
      decision: 'deferred',
      severity: 'low',
      rationale: 'Later work',
      deferred_owner: 'maintainer',
      deferred_next_action: 'Revisit the issue'
    }
  ]) {
    assert.throws(
      () => applyTriageDecisions(active, [
        { reviewer_id: 'R001', issue_id: 'ISSUE-001', decision: 'merged', severity: 'high', merged_into: 'ISSUE-002', rationale: 'Duplicate' },
        terminalDecision
      ]),
      /canonical.*survivor|merge.*survivor|accepted.*reopened/i
    );
  }
});

test('records rejected reasons and requires a reason', () => {
  const base = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'Primary', resolution: 'Pending fix' }
    ]
  };

  const rejected = rejectIssue(base, 'ISSUE-001', 'False premise');

  assert.equal(rejected.issues[0].status, 'rejected');
  assert.match(rejected.issues[0].resolution, /False premise/);
  assert.throws(() => rejectIssue(base, 'ISSUE-001', ''), /reason/i);
});

test('records deferred reason and owner and requires both', () => {
  const base = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'Primary', resolution: 'Pending fix' }
    ]
  };

  const deferred = deferIssue(base, 'ISSUE-001', { reason: 'Needs owner decision', owner: 'user' });

  assert.equal(deferred.issues[0].status, 'deferred');
  assert.match(deferred.issues[0].resolution, /Needs owner decision/);
  assert.match(deferred.issues[0].resolution, /owner: user/);
  assert.throws(() => deferIssue(base, 'ISSUE-001', { reason: 'No owner' }), /owner/i);
  assert.throws(() => deferIssue(base, 'ISSUE-001', { owner: 'user' }), /reason/i);
});

test('redacts sensitive values in accepted findings and ledger output', () => {
  const ledger = addAcceptedFinding({ issues: [] }, {
    severity: 'high',
    location: 'Config token=plain-secret-token',
    issue: 'Token sk-live-1234567890abcdef leaked',
    suggested_fix: 'Remove password=hunter2'
  });

  assert.equal(ledger.issues[0].location.includes('plain-secret-token'), false);
  assert.equal(ledger.issues[0].summary.includes('sk-live-1234567890abcdef'), false);
  assert.equal(ledger.issues[0].resolution.includes('hunter2'), false);

  const text = formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'Config token=plain-secret-token',
        summary: 'Token sk-live-1234567890abcdef leaked',
        resolution: 'Remove password=hunter2'
      }
    ]
  });

  assert.match(text, /\[REDACTED:api-token\]/);
  assert.match(text, /\[REDACTED:credential\]/);
  assert.doesNotMatch(text, /plain-secret-token|sk-live-1234567890abcdef|hunter2/);
});

test('redacts secret-derived fragments in accepted findings', () => {
  const ledger = addAcceptedFinding({ issues: [] }, {
    severity: 'high',
    location: 'Auth secret prefix sk-live- and credential checksum: abc123',
    issue: 'Token suffix abcdef and token checksum deadbeef leaked',
    suggested_fix: 'Remove token hash: 0123456789abcdef from notes'
  });

  const rowText = JSON.stringify(ledger.issues[0]);

  assert.match(rowText, /\[REDACTED:api-token\]/);
  assert.match(rowText, /\[REDACTED:credential\]/);
  assert.doesNotMatch(rowText, /sk-live-|abcdef|deadbeef|abc123|0123456789abcdef/);
});

test('redacts secret-derived fragments in formatted ledger cells without deleting ordinary anchors', () => {
  const text = formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'Config secret prefix sk-live- and credential checksum: abc123',
        summary: 'Token suffix abcdef and token checksum deadbeef leaked',
        resolution: 'Remove token hash: 0123456789abcdef; keep build anchor deadbeef'
      }
    ]
  });

  assert.match(text, /\[REDACTED:api-token\]/);
  assert.match(text, /\[REDACTED:credential\]/);
  assert.match(text, /keep build anchor deadbeef/);
  assert.doesNotMatch(text, /sk-live-|suffix abcdef|checksum deadbeef|checksum: abc123|hash: 0123456789abcdef/);
});

test('redacts compound secret-keyword derived fragments (client_secret, jwt_secret, secret_key)', () => {
  const text = formatLedger({
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'high',
        status: 'accepted',
        location: 'client_secret prefix: shhhh and secret_key checksum: aaa111',
        summary: 'jwt_secret hash: bbb222 leaked',
        resolution: 'rotate session-secret suffix: ccc333; keep build anchor deadbeef'
      }
    ]
  });

  assert.match(text, /\[REDACTED:api-token\]/);
  assert.match(text, /keep build anchor deadbeef/);
  assert.doesNotMatch(text, /shhhh|aaa111|bbb222|ccc333/);
});

test('round-trips literal br tags newlines pipes and backslashes', () => {
  const ledger = {
    issues: [
      {
        id: 'ISSUE-001',
        severity: 'medium',
        status: 'accepted',
        location: String.raw`Docs \ Paths | API`,
        summary: 'Literal <br> anchor',
        resolution: String.raw`Line one
Line two with | pipe and C:\tmp\file`
      }
    ]
  };

  assert.deepEqual(parseLedger(formatLedger(ledger)), ledger);
});

test('issue transition helpers do not mutate input ledger', () => {
  const base = {
    issues: [
      { id: 'ISSUE-001', severity: 'high', status: 'accepted', location: 'A', summary: 'Primary', resolution: 'Pending fix' },
      { id: 'ISSUE-002', severity: 'medium', status: 'accepted', location: 'B', summary: 'Duplicate', resolution: 'Pending fix' }
    ]
  };
  const snapshot = JSON.parse(JSON.stringify(base));

  addAcceptedFinding(base, { severity: 'low', location: 'C', issue: 'New issue', suggested_fix: 'Fix it' });
  mergeIssue(base, 'ISSUE-002', 'ISSUE-001');
  rejectIssue(base, 'ISSUE-002', 'False premise');
  deferIssue(base, 'ISSUE-002', { reason: 'Needs decision', owner: 'user' });
  reopenIssue(base, 'ISSUE-001', 'Regression after edit');

  assert.deepEqual(base, snapshot);
});
