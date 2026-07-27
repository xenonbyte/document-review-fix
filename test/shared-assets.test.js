'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { renderPlatformRoute, generatePlatformFiles } = require('../lib/generator');
const { buildFinalResponseChecklist } = require('../lib/final-response');
const { listDocumentRoutes, listRoutes } = require('../lib/routes');
const { parseYamlBlockMapping } = require('../lib/yaml-block-mapping');
const {
  maskEmbeddedSharedContent,
  readSnapshot,
  stripAdditiveRounds,
  extractEmbeddedSharedContent,
  readEmbeddedSnapshot
} = require('./helpers/route-shell-snapshot');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_VERSION = '0.0.0-snapshot';
const ROUTE_PLATFORMS = ['claude', 'codex', 'gemini', 'opencode'];
// templates/codex-openai.yaml is the single source for the Codex invocation policy.
// Derive the expected bytes from it so editing the template (adding guidance comments,
// for example) cannot drift from the generated and source-descriptor copies unnoticed;
// the value the file actually declares is asserted semantically below.
const CODEX_INVOCATION_POLICY_PATH = path.join('templates', 'codex-openai.yaml');
const CODEX_INVOCATION_POLICY = fs.readFileSync(path.join(ROOT, CODEX_INVOCATION_POLICY_PATH), 'utf8');
const GENERATED_SHELL_BASELINE_BYTES = Object.freeze({
  claude: Object.freeze({
    'review-fix-spec': 21775,
    'review-fix-plan': 21775,
    'review-fix-design': 21819,
    'review-fix-doc': 21759,
    'review-fix-pr': 21708,
    'review-fix-code': 29070,
    'review-fix-r2p': 21906
  }),
  codex: Object.freeze({
    'review-fix-spec': 21858,
    'review-fix-plan': 21858,
    'review-fix-design': 21906,
    'review-fix-doc': 21843,
    'review-fix-pr': 21758,
    'review-fix-code': 29103,
    'review-fix-r2p': 21903
  }),
  gemini: Object.freeze({
    'review-fix-spec': 9280,
    'review-fix-plan': 9280,
    'review-fix-design': 9308,
    'review-fix-doc': 9278,
    'review-fix-pr': 9799,
    'review-fix-code': 13141,
    'review-fix-r2p': 10051
  }),
  opencode: Object.freeze({
    'review-fix-spec': 22180,
    'review-fix-plan': 22180,
    'review-fix-design': 22226,
    'review-fix-doc': 22163,
    'review-fix-pr': 22114,
    'review-fix-code': 29466,
    'review-fix-r2p': 22325
  })
});
const CODEX_SHARED_DEDUP_EXPECTED_MEASUREMENT = Object.freeze({
  routes: Object.freeze({
    'review-fix-spec': Object.freeze({
      routeBytes: 85308,
      embeddedSharedBytes: 63015,
      copiedSharedBytes: 62717,
      duplicateBytes: 62717,
      copiedRouteBytes: 23499,
      shrinkBytes: 61809,
      shrinkPercent: 72.45,
      wouldGrow: false
    }),
    'review-fix-plan': Object.freeze({
      routeBytes: 85616,
      embeddedSharedBytes: 63323,
      copiedSharedBytes: 63025,
      duplicateBytes: 63025,
      copiedRouteBytes: 23499,
      shrinkBytes: 62117,
      shrinkPercent: 72.55,
      wouldGrow: false
    }),
    'review-fix-design': Object.freeze({
      routeBytes: 85420,
      embeddedSharedBytes: 63077,
      copiedSharedBytes: 62777,
      duplicateBytes: 62777,
      copiedRouteBytes: 23551,
      shrinkBytes: 61869,
      shrinkPercent: 72.43,
      wouldGrow: false
    }),
    'review-fix-doc': Object.freeze({
      routeBytes: 82114,
      embeddedSharedBytes: 59837,
      copiedSharedBytes: 59578,
      duplicateBytes: 59578,
      copiedRouteBytes: 23456,
      shrinkBytes: 58658,
      shrinkPercent: 71.43,
      wouldGrow: false
    }),
    'review-fix-pr': Object.freeze({
      routeBytes: 82455,
      embeddedSharedBytes: 60342,
      copiedSharedBytes: 60087,
      duplicateBytes: 60087,
      copiedRouteBytes: 23288,
      shrinkBytes: 59167,
      shrinkPercent: 71.76,
      wouldGrow: false
    }),
    'review-fix-code': Object.freeze({
      routeBytes: 93442,
      embeddedSharedBytes: 63942,
      copiedSharedBytes: 63685,
      duplicateBytes: 63685,
      copiedRouteBytes: 30677,
      shrinkBytes: 62765,
      shrinkPercent: 67.17,
      wouldGrow: false
    }),
    'review-fix-r2p': Object.freeze({
      routeBytes: 84452,
      embeddedSharedBytes: 63694,
      copiedSharedBytes: 63025,
      duplicateBytes: 63025,
      copiedRouteBytes: 21964,
      shrinkBytes: 62488,
      shrinkPercent: 73.99,
      wouldGrow: false
    })
  }),
  totals: Object.freeze({
    routeBytes: 598807,
    embeddedSharedBytes: 437230,
    copiedSharedBytes: 434894,
    duplicateBytes: 434894
  }),
  largestShellShrinkBytes: 62765,
  largestShellShrinkPercent: 67.17,
  anyCodexRouteWouldGrow: false,
  gateEntered: true
});
const CODEX_SHARED_DEDUP_GATE = Object.freeze({
  minLargestShellShrinkBytes: 16 * 1024,
  minLargestShellShrinkPercent: 12
});

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function roundPercent(numerator, denominator) {
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function codexSkill(routeName, options = {}) {
  return generatePlatformFiles('codex', {
    packageVersion: options.packageVersion || SNAPSHOT_VERSION,
    codexSharedMode: options.codexSharedMode
  }).find((entry) => entry.routeName === routeName);
}

function codexCopiedSharedBytes(routeName) {
  return codexSkill(routeName)
    .files
    .filter((file) => file.sourcePath)
    .reduce((total, file) => total + byteLength(file.content), 0);
}

function codexCopiedSharedText(routeName) {
  return codexSkill(routeName)
    .files
    .filter((file) => file.sourcePath)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((file) => `<!-- ${file.relativePath.split(path.sep).join('/')} -->\n\n${file.content.trimEnd()}`)
    .join('\n\n---\n\n');
}

function routeSharedProtocolText(platform, routeName, rendered) {
  if (platform === 'codex') return codexCopiedSharedText(routeName);
  return extractEmbeddedSharedContent(platform, rendered);
}

function codexSharedDedupMeasurement() {
  const measurement = {
    routes: {},
    totals: {
      routeBytes: 0,
      embeddedSharedBytes: 0,
      copiedSharedBytes: 0,
      duplicateBytes: 0
    },
    largestShellShrinkBytes: 0,
    largestShellShrinkPercent: 0,
    anyCodexRouteWouldGrow: false,
    gateEntered: false
  };

  for (const route of listRoutes()) {
    const embeddedRoute = renderPlatformRoute('codex', route.routeName, {
      packageVersion: SNAPSHOT_VERSION,
      codexSharedMode: 'embedded'
    });
    const copiedRoute = renderPlatformRoute('codex', route.routeName, {
      packageVersion: SNAPSHOT_VERSION,
      codexSharedMode: 'copied'
    });
    const routeBytes = byteLength(embeddedRoute);
    const copiedRouteBytes = byteLength(copiedRoute);
    const shrinkBytes = routeBytes - copiedRouteBytes;
    const copiedSharedBytes = codexCopiedSharedBytes(route.routeName);
    const row = {
      routeBytes,
      embeddedSharedBytes: byteLength(extractEmbeddedSharedContent('codex', embeddedRoute)),
      copiedSharedBytes,
      duplicateBytes: copiedSharedBytes,
      copiedRouteBytes,
      shrinkBytes,
      shrinkPercent: roundPercent(shrinkBytes, routeBytes),
      wouldGrow: copiedRouteBytes > routeBytes
    };

    measurement.routes[route.routeName] = row;
    measurement.totals.routeBytes += row.routeBytes;
    measurement.totals.embeddedSharedBytes += row.embeddedSharedBytes;
    measurement.totals.copiedSharedBytes += row.copiedSharedBytes;
    measurement.totals.duplicateBytes += row.duplicateBytes;
    if (row.shrinkBytes > measurement.largestShellShrinkBytes) {
      measurement.largestShellShrinkBytes = row.shrinkBytes;
      measurement.largestShellShrinkPercent = row.shrinkPercent;
    }
    if (row.wouldGrow) measurement.anyCodexRouteWouldGrow = true;
  }

  measurement.gateEntered =
    measurement.largestShellShrinkBytes >= CODEX_SHARED_DEDUP_GATE.minLargestShellShrinkBytes &&
    measurement.largestShellShrinkPercent >= CODEX_SHARED_DEDUP_GATE.minLargestShellShrinkPercent &&
    !measurement.anyCodexRouteWouldGrow;

  return measurement;
}

function generatedWorkflowCommandLines(rendered) {
  return rendered
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('drfx workflow '))
    .filter((line) => !line.includes('drfx workflow ...'))
    .filter((line) => !/debug|relevant/i.test(line));
}

// Some route-protocol text moved out of the platform `.tmpl` files into
// generator-filled placeholders (route contract, invocation grammar, invocation
// gate body) in PLAN-TASK-008. Tests that previously grepped the raw templates
// for that text now read the rendered DOCUMENT route output (template + its
// fragments) for one route per platform, which is the actual generated contract.
function renderedDocumentRoute(platform, routeName = 'review-fix-spec') {
  return renderPlatformRoute(platform, routeName, { packageVersion: '0.0.0-test' });
}

function renderedDocumentTemplates() {
  return ['codex', 'claude', 'gemini', 'opencode'].map((platform) => renderedDocumentRoute(platform)).join('\n\n');
}

// ---------------------------------------------------------------------------
// Golden shell snapshot (PLAN-TASK-008 PHASE 1)
//
// The regenerated DOCUMENT-route shells (embedded shared content masked,
// {{RUNTIME_FLAGS}} rendered) must equal the committed snapshots byte-for-byte
// EXCEPT for the additive `rounds=<n>` token. Any other drift in the route
// protocol/contract shell fails loudly so code-route parameterization cannot
// silently regress document routes.
// ---------------------------------------------------------------------------

test('document-route generated shells equal golden snapshots except additive rounds=<n>', () => {
  for (const platform of ROUTE_PLATFORMS) {
    for (const route of listDocumentRoutes()) {
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: SNAPSHOT_VERSION });
      const shell = maskEmbeddedSharedContent(platform, rendered);
      const snapshot = readSnapshot(platform, route.routeName);

      assert.equal(
        stripAdditiveRounds(shell),
        stripAdditiveRounds(snapshot),
        `${platform}:${route.routeName} document shell drifted beyond the additive rounds=<n> token`
      );
    }
  }
});

test('code-route generated shells equal golden snapshots byte-for-byte', () => {
  for (const platform of ROUTE_PLATFORMS) {
    for (const route of listRoutes()) {
      if (route.routeKind === 'document') continue;
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: SNAPSHOT_VERSION });
      const shell = maskEmbeddedSharedContent(platform, rendered);
      const snapshot = readSnapshot(platform, route.routeName);

      assert.equal(shell, snapshot, `${platform}:${route.routeName} code shell drifted from snapshot`);
    }
  }
});

test('generated route workflow commands use compact JSON for automated route chaining', () => {
  for (const platform of ROUTE_PLATFORMS) {
    for (const route of listRoutes()) {
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: SNAPSHOT_VERSION });
      const commandLines = generatedWorkflowCommandLines(rendered);
      assert.ok(commandLines.length > 0, `${platform}:${route.routeName} must render workflow command lines`);
      for (const line of commandLines) {
        if (line.includes('drfx doctor')) continue;
        if (!line.includes('--json')) continue;
        assert.doesNotMatch(
          line,
          /--json(?:\s|`|$)/,
          `${platform}:${route.routeName} automated workflow command must use --json=compact: ${line}`
        );
        assert.doesNotMatch(
          line,
          /--json=full/,
          `${platform}:${route.routeName} automated workflow command must reserve --json=full for debug guidance: ${line}`
        );
        assert.match(
          line,
          /--json=compact(?:\s|`|$)/,
          `${platform}:${route.routeName} automated workflow command must request compact JSON: ${line}`
        );
      }
      assert.match(
        rendered,
        /debug[\s\S]{0,260}--json=full|--json=full[\s\S]{0,260}debug/i,
        `${platform}:${route.routeName} must keep debug guidance for full JSON diagnostics`
      );
    }
  }
});

test('generated route shell sizes stay within platform-route growth budgets', () => {
  for (const platform of ROUTE_PLATFORMS) {
    for (const route of listRoutes()) {
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: SNAPSHOT_VERSION });
      const shell = maskEmbeddedSharedContent(platform, rendered);
      const baselineBytes = GENERATED_SHELL_BASELINE_BYTES[platform][route.routeName];
      const actualBytes = byteLength(shell);
      const growthBudgetBytes = Math.max(4096, Math.ceil(baselineBytes * 0.08));
      const allowedBytes = baselineBytes + growthBudgetBytes;
      const growth = actualBytes - baselineBytes;
      assert.ok(
        actualBytes <= allowedBytes,
        [
          'generated route shell size budget exceeded',
          `platform=${platform}`,
          `route=${route.routeName}`,
          `baselineBytes=${baselineBytes}`,
          `actualBytes=${actualBytes}`,
          `allowedBytes=${allowedBytes}`,
          `growthBudgetBytes=${growthBudgetBytes}`,
          `growth=${growth}`
        ].join(' ')
      );
    }
  }
});

test('Codex copied shared source de-dup measurement crosses the guarded implementation gate', () => {
  const measurement = codexSharedDedupMeasurement();

  assert.deepEqual(measurement, CODEX_SHARED_DEDUP_EXPECTED_MEASUREMENT);
  assert.equal(measurement.gateEntered, true, 'Codex shared source de-dup must enter the guarded implementation phase');
  assert.equal(measurement.anyCodexRouteWouldGrow, false, 'Codex shared source de-dup must not grow any route');
  assert.ok(
    measurement.largestShellShrinkBytes >= CODEX_SHARED_DEDUP_GATE.minLargestShellShrinkBytes,
    `largest Codex shell shrink ${measurement.largestShellShrinkBytes} bytes is below gate`
  );
  assert.ok(
    measurement.largestShellShrinkPercent >= CODEX_SHARED_DEDUP_GATE.minLargestShellShrinkPercent,
    `largest Codex shell shrink ${measurement.largestShellShrinkPercent}% is below gate`
  );
});

test('command-style generated starts preserve materialized rounds and state-control tokens', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';

  for (const platform of ['claude', 'codex', 'opencode']) {
    for (const route of listRoutes()) {
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: SNAPSHOT_VERSION });
      const startLines = rendered.split('\n').filter((line) => line.startsWith('drfx workflow start '));
      const strictNeedle = route.routeKind === 'r2p'
        ? '<selectedMode> <stateControlToken> rounds=<roundLimit> --assurance strict-verified'
        : '<selectedMode> <stateControlToken> rounds=<roundLimit> guard=<selectedGuard>';
      const practicalNeedle = route.routeKind === 'r2p'
        ? 'review-and-fix <stateControlToken> rounds=<roundLimit> --assurance practical'
        : 'review-and-fix <stateControlToken> rounds=<roundLimit> guard=<selectedGuard>';

      assert.ok(
        startLines.some((line) => line.includes(strictNeedle)),
        `${platform}:${route.routeName} strict start must carry the materialized rounds and state-control tokens`
      );
      assert.ok(
        startLines.some((line) => line.includes(practicalNeedle)),
        `${platform}:${route.routeName} practical start must carry the materialized rounds and state-control tokens`
      );
    }
  }
});

test('Claude and Codex file-set review-and-fix routes require full re-review after initial PASS', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';

  for (const platform of ['claude', 'codex', 'opencode']) {
    for (const routeName of ['review-fix-pr', 'review-fix-code']) {
      const rendered = renderPlatformRoute(platform, routeName, { packageVersion: SNAPSHOT_VERSION });

      assert.match(
        rendered,
        /If initial `record-review` returns `PASS`[\s\S]*?--phase full-re-review --json=compact[\s\S]*?--phase full-re-review --result-stdin/,
        `${platform}:${routeName} must document the clean review-and-fix full re-review path`
      );
    }
  }
});

test('generated r2p route text uses workId shorthand and exposes no user-facing guard token', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';

  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-r2p', { packageVersion: SNAPSHOT_VERSION });
    const shell = maskEmbeddedSharedContent(platform, rendered);
    if (platform !== 'gemini') {
      assert.match(
        shell,
        /persistent practical command[\s\S]*?route exposes no `guard=` token/i,
        `${platform}:review-fix-r2p practical path must document that guard is not user-facing`
      );
    } else {
      assert.match(
        rendered,
        /This route exposes no guard= token; drift detection is internal and always on/i,
        `${platform}:review-fix-r2p advisory path must document that guard is not user-facing`
      );
    }
    assert.match(
      shell,
      /bare `?WF-[^\n]*shorthand for `?workId=<WF-\.\.\.>`?/i,
      `${platform}:review-fix-r2p must document the valid bare workId shorthand`
    );
    assert.doesNotMatch(
      shell,
      /no bare-path/i,
      `${platform}:review-fix-r2p must not reject the documented bare workId shorthand`
    );
    assert.doesNotMatch(
      shell,
      /target=<requirement-dir>|guard=<selectedGuard>/,
      `${platform}:review-fix-r2p must not expose path-based target or guard tokens`
    );
    assert.doesNotMatch(
      rendered,
      /rollback-unavailable|target-only-guard-unavailable|clean rollback anchor|target-only guard (?:is unavailable|proof|unparseable)|guard=snapshot when Git rollback is unavailable/i,
      `${platform}:review-fix-r2p must not render legacy guard-blocker guidance anywhere in the full route`
    );
    assert.match(
      rendered,
      /cannot run repair commands from the current run state[\s\S]*r2p-reopen[\s\S]*r2p-gap-open/i,
      `${platform}:review-fix-r2p must render workId/run-state preflight blocker guidance in the full route`
    );
  }
});

test('generated user invocations use explicit platform prefixes while workflow route arguments stay bare', () => {
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    for (const route of listRoutes()) {
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: SNAPSHOT_VERSION });
      const shell = maskEmbeddedSharedContent(platform, rendered);
      const explicitInvocation = `${platform === 'codex' ? '$' : '/'}${route.routeName}`;
      const grammarPrefix = platform === 'gemini' ? 'Invocation:\n' : 'Invocation syntax:\n\n```text\n';
      const fullFormPrefix = platform === 'gemini'
        ? `Full form: ${explicitInvocation}`
        : `Full form: \`${explicitInvocation}`;

      assert.ok(
        shell.includes(`${grammarPrefix}${explicitInvocation}`),
        `${platform}:${route.routeName} invocation grammar must use ${explicitInvocation}`
      );
      assert.ok(
        shell.includes(fullFormPrefix),
        `${platform}:${route.routeName} full form must use ${explicitInvocation}`
      );

      // Route Output templates are copied into the user's terminal, so an invocation
      // echoed back must be one the user can actually type on this platform.
      for (const line of shell.split('\n').filter((candidate) => candidate.startsWith('Blocked: '))) {
        assert.doesNotMatch(
          line,
          new RegExp(`(^|[^$/\\w-])${route.routeName}`),
          `${platform}:${route.routeName} blocked output must not echo a bare route name: ${line}`
        );
      }

      const workflowRouteLines = generatedWorkflowCommandLines(rendered)
        .filter((line) => line.includes(route.routeName));
      assert.ok(workflowRouteLines.length > 0, `${platform}:${route.routeName} must render internal workflow route arguments`);
      for (const line of workflowRouteLines) {
        assert.match(line, new RegExp(`drfx workflow [^\\n]*${route.routeName}`), line);
        assert.doesNotMatch(line, /drfx workflow [^\n]*[$/]review-fix-/, line);
      }
    }
  }
});

test('generated r2p workflow commands preserve the root override token', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';

  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-r2p', { packageVersion: SNAPSHOT_VERSION });
    const explicitInvocation = platform === 'codex' ? '$review-fix-r2p' : '/review-fix-r2p';
    const commandLines = generatedWorkflowCommandLines(rendered)
      .filter((line) => line.includes('review-fix-r2p'));

    assert.ok(commandLines.length > 0, `${platform}:review-fix-r2p must render invocation-based workflow commands`);
    for (const line of commandLines) {
      assert.match(
        line,
        /workId=<WF-\.\.\.> <rootToken>/,
        `${platform}:review-fix-r2p workflow command must propagate root=<project-root>: ${line}`
      );
    }
    if (platform !== 'gemini') {
      assert.ok(
        rendered.includes(
          `r2p-reopen\`, rerun \`${explicitInvocation} workId=<new-WF-...> <rootToken>\`; ` +
          `for \`r2p-gap-open\`, rerun \`${explicitInvocation} workId=<same-WF-...> resume <rootToken>\``
        ),
        `${platform}:review-fix-r2p rerun guidance must preserve root=<project-root> and same-workId resume`
      );
    }
  }
});

test('generated r2p route text does not expose user-facing assurance tokens', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';
  const forbiddenUserTokenGuidance = [
    /This command accepts `assurance=practical`/,
    /For `assurance=practical` and `assurance=strict-verified`/,
    /Explicit `assurance=advisory read-only`/,
    /Only explicit `assurance=strict-verified` requests strict verified mode/,
    /For `assurance=practical`, after successful probes/,
    /For `review-and-fix assurance=strict-verified`/,
    /Advisory read-only no-state path/,
    /--assurance advisory/
  ];

  for (const platform of ['claude', 'codex', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-r2p', { packageVersion: SNAPSHOT_VERSION });
    const shell = maskEmbeddedSharedContent(platform, rendered);

    assert.match(
      shell,
      /This route has a fixed PLAN rubric and exposes no `assurance=`(?: or `guard=`)? token/,
      `${platform}:review-fix-r2p must document that assurance is internal-only`
    );
    assert.match(
      shell,
      /--assurance practical/,
      `${platform}:review-fix-r2p must keep internal practical assurance materialization`
    );

    for (const pattern of forbiddenUserTokenGuidance) {
      assert.doesNotMatch(shell, pattern, `${platform}:review-fix-r2p must not expose ${pattern}`);
    }
  }
});

test('Claude and Codex partitioned CODE flow gates aggregate FAIL fix instructions on write mode', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';

  for (const platform of ['claude', 'codex', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-code', { packageVersion: SNAPSHOT_VERSION });
    assert.match(
      rendered,
      /active mode is `review-and-fix`[^\n]*stopped-with-deferrals[^\n]*reviewer report path[^\n]*record-triage[^\n]*begin-fix/i,
      `${platform}:review-fix-code must route partitioned aggregate FAIL into the triage/fix loop only for review-and-fix`
    );
    assert.match(
      rendered,
      /active mode is `read-only`[^\n]*stopped-with-deferrals[^\n]*`reviewerReportPath`[^\n]*run `record-triage`[^\n]*ledger issue ids[^\n]*finalize the read-only findings[^\n]*do not run `begin-fix`/i,
      `${platform}:review-fix-code must triage read-only partitioned findings before finalization without entering the fix loop`
    );
    assert.match(
      rendered,
      /reason: coverage-incomplete[^\n]*review the uncovered units\/backstops[^\n]*do not run `record-triage` or `begin-fix`/i,
      `${platform}:review-fix-code may skip triage only for pure coverage-incomplete deferrals`
    );
    assert.match(
      rendered,
      /after partitioned `end-fix` returns `reviewMode: partitioned`, do not run the generic `record-diff-review` step/i,
      `${platform}:review-fix-code must keep the partitioned increment branch out of generic diff-review`
    );
    assert.doesNotMatch(
      rendered,
      /do not invoke `begin-fix` for the active partition plan/i,
      `${platform}:review-fix-code must not advertise the v1 read-only partition guard`
    );
  }
});

test('shared core contains canonical loop and no runtime memory dependency', () => {
  const core = read('shared/core.md');

  assert.match(core, /review -> triage -> fix -> diff review -> full re-review/);
  assert.match(core, /runtime objective\/session\/platform memory/i);
  assert.match(core, /must not depend/i);
});

test('shared platform contract includes opencode in source and generated opencode routes', () => {
  const core = read('shared/core.md');
  const longTask = read('shared/long-task.md');

  assert.match(
    core,
    /Generated Codex, Claude Code, and opencode routes default a valid target invocation to `review-and-fix assurance=practical`/
  );
  assert.match(
    core,
    /For document\/PR\/CODE routes on Codex, Claude Code, and opencode, explicit `assurance=advisory` without mode selects `read-only`/
  );
  assert.match(core, /Runtime platform: codex \| claude-code \| gemini \| opencode \| manual/);
  assert.match(longTask, /Runtime platform: `codex`, `claude-code`, `gemini`, `opencode`, or `manual`/);

  for (const route of listRoutes()) {
    const rendered = renderPlatformRoute('opencode', route.routeName, { packageVersion: '0.0.0-test' });
    const embedded = extractEmbeddedSharedContent('opencode', rendered);

    assert.match(
      embedded,
      /Generated Codex, Claude Code, and opencode routes default a valid target invocation/,
      `opencode:${route.routeName} embedded core default policy must include opencode`
    );
    assert.match(
      embedded,
      /Runtime platform: codex \| claude-code \| gemini \| opencode \| manual/,
      `opencode:${route.routeName} embedded final-response platform enum must include opencode`
    );
    assert.match(
      embedded,
      /Runtime platform: `codex`, `claude-code`, `gemini`, `opencode`, or `manual`/,
      `opencode:${route.routeName} embedded manifest platform enum must include opencode`
    );
  }
});

test('shared core specifies reviewer mutation detection without requiring a second reviewer', () => {
  const core = read('shared/core.md');

  assert.match(core, /record SHA-256, file size, and modified timestamp for the target and all reference documents/i);
  assert.match(core, /After the reviewer returns, recompute the same fingerprints/i);
  assert.match(core, /reviewer-mutated-file/i);
  assert.match(core, /Do not fix or claim PASS after a reviewer mutation/i);
  assert.doesNotMatch(core, /\b(second|2nd|two)\s+reviewers?\b/i);
});

test('shared prompts expose reviewer and fixer schemas', () => {
  const reviewer = read('shared/prompts/reviewer.md');
  const fixer = read('shared/prompts/fixer.md');

  assert.match(reviewer, /\bPASS\b/);
  assert.match(reviewer, /\bFAIL\b/);
  assert.match(reviewer, /why_it_matters/);

  for (const heading of ['Fixed:', 'Files changed:', 'Not fixed:', 'Residual risk:']) {
    assert.match(fixer, new RegExp(`^${heading}$`, 'm'));
  }
});

test('fixer prompt has no writable scope escape hatch', () => {
  const fixer = read('shared/prompts/fixer.md');

  assert.doesNotMatch(fixer, /unless explicitly instructed/i);
  assert.match(fixer, /may modify only the target document|modify only the target document/i);
  assert.match(fixer, /references? and other files remain read-only|reference documents.*read-only/i);
});

test('coordinator prompt contains complete reviewer context pack fields', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  for (const matcher of [
    /Target document:\s*<path>/i,
    /Reference documents:\s*<paths, read-only>/i,
    /Document type:\s*<SPEC\|PLAN\|DESIGN\|COMMON>/i,
    /Strictness:\s*<normal\|strict>/i,
    /Mode:\s*<review-and-fix\|read-only>/i,
    /Objective:/i,
    /Merged (review )?rule set:/i,
    /Accepted non-blocking low issues:/i,
    /Constraints:/i,
    /Output schema:/i
  ]) {
    assert.match(coordinator, matcher);
  }
});

test('coordinator prompt locks triage decisions and PASS blocking rules', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  for (const decision of ['accepted', 'merged', 'downgraded', 'rejected', 'deferred']) {
    assert.match(coordinator, new RegExp(`\\b${decision}\\b`, 'i'), decision);
  }
  assert.match(coordinator, /accepted high\/medium findings block PASS|accepted high and medium findings block PASS/i);
  assert.match(coordinator, /deferred high\/medium.*stopped-with-deferrals|deferred high and medium.*stopped-with-deferrals/i);
  assert.match(coordinator, /low findings block only in strict mode unless accepted non-blocking/i);
  assert.match(coordinator, /r2p[\s\S]{0,120}owner_stage/i);
  assert.match(coordinator, /owner_stage: raw_requirement \| requirement_brief \| risk_discovery \| design \| spec \| plan \| none/);
  assert.match(coordinator, /reason: <r2p-reopen repair wording or none>/);
  assert.match(coordinator, /required_action: <r2p-gap-open repair wording or none>/);
});

test('coordinator prompt requires diff review checks before full re-review', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(coordinator, /diff review/i);
  assert.match(coordinator, /issue mapping/i);
  assert.match(coordinator, /unrelated scope/i);
  assert.match(coordinator, /terminology/i);
  assert.match(coordinator, /placeholders/i);
  assert.match(coordinator, /readability/i);
  assert.match(coordinator, /structural coherence/i);
  assert.match(coordinator, /before full re-review/i);
});

test('coordinator prompt includes final response contract text', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(coordinator, /Final response:/i);
  assert.match(coordinator, /final status/i);
  assert.match(coordinator, /changes made/i);
  assert.match(coordinator, /files changed/i);
  assert.match(coordinator, /verification performed/i);
  assert.match(coordinator, /not fixed|deferrals|blockers|unsupported/i);
  assert.match(coordinator, /residual risk/i);
  assert.match(coordinator, /none identified/i);
  assert.match(coordinator, /deferrals?[^\n]*issue IDs[^\n]*reason[^\n]*owner[^\n]*next action/i);
});

test('reviewer and coordinator distinguish reference conflicts from coverage gaps', () => {
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(reviewer, /ref=.*consistency/i);
  assert.match(reviewer, /Do not fail/i);
  assert.match(reviewer, /Design Coverage Import/i);
  assert.match(reviewer, /SPEC-to-task mapping/i);
  assert.match(reviewer, /complete coverage claim/i);
  assert.match(reviewer, /reference conflict/i);

  assert.match(coordinator, /false blocker/i);
  assert.match(coordinator, /coverage table/i);
  assert.match(coordinator, /upstream mapping/i);
  assert.match(coordinator, /reclassify/i);
  assert.match(coordinator, /do not rewrite/i);
});

test('fixer prompt keeps writes target-only and issue-bounded', () => {
  const fixer = read('shared/prompts/fixer.md');

  assert.match(fixer, /may modify only the target document/i);
  assert.match(fixer, /coordinator-accepted issue IDs/i);
  assert.match(fixer, /Reference documents:\s*<paths, read-only>/i);
  assert.match(fixer, /references and other files remain read-only/i);
  assert.match(fixer, /Do not (?:add|invent) new background, requirements, or external facts/i);
  assert.match(fixer, /Do not (?:perform a )?broad rewrite unless an accepted structural issue/i);
});

test('reviewer prompt states reviewers are read-only and must emit why_it_matters', () => {
  const reviewer = read('shared/prompts/reviewer.md');

  assert.match(reviewer, /Mode: read-only/i);
  assert.match(reviewer, /Do not modify files/i);
  assert.match(reviewer, /why_it_matters/);
});

test('deferred issue metadata and final response next action are both documented', () => {
  const core = read('shared/core.md');
  const longTask = read('shared/long-task.md');
  const readme = read('README.md');

  assert.match(core, /deferred[^\n]*reason and owner/i);
  assert.match(longTask, /deferred[^\n]*reason and owner/i);
  assert.match(core, /stopped-with-deferrals[^\n]*internal workflow payload[^\n]*issue IDs[^\n]*reasons?[^\n]*owners?[^\n]*next action/i);
  assert.match(core, /Default user output[^\n]*Unfixed\/Next[^\n]*without internal issue IDs/i);
  assert.match(readme, /deferrals?[^\n]*reason[^\n]*owner[^\n]*next action/i);
});

// PLAN-TASK-010: coverage-incomplete is the partitioned-review aggregate deferral
// outcome. It must be documented consistently across shared/core.md's status-reason
// enum, the rendered generated CODE route per platform, the embedded CODE skill
// text per platform, and the committed fixtures.
test('coverage-incomplete is consistent across core.md, generated/embedded CODE routes, and fixtures', () => {
  const SNAPSHOT_VERSION = '0.0.0-snapshot';
  const core = read('shared/core.md');

  // shared/core.md status-reason enum carries coverage-incomplete.
  assert.match(
    core,
    /Status reasons include[^\n]*`deferred-findings`,\s*`coverage-incomplete`/,
    'shared/core.md status-reason enum must include coverage-incomplete'
  );

  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-code', { packageVersion: SNAPSHOT_VERSION });

    // Rendered CODE route carries coverage-incomplete in both the embedded core.md
    // enum and the route-contract note.
    assert.match(rendered, /coverage-incomplete/, `${platform} rendered review-fix-code must mention coverage-incomplete`);

    // Route-contract note (the generated shell, embedded content masked out).
    const shell = maskEmbeddedSharedContent(platform, rendered);
    assert.match(
      shell,
      /coverage-incomplete[^\n]*(never claims PASS|advisory-only and never claims PASS)/,
      `${platform} generated review-fix-code shell must carry the coverage-incomplete finalize note`
    );

    // Embedded/copied CODE shared text (the core.md expansion for non-Codex,
    // copied shared source files for Codex).
    const sharedProtocol = routeSharedProtocolText(platform, 'review-fix-code', rendered);
    assert.match(sharedProtocol, /coverage-incomplete/, `${platform} review-fix-code shared protocol must mention coverage-incomplete`);

    // Committed fixtures match the rendered output.
    assert.equal(
      shell,
      readSnapshot(platform, 'review-fix-code'),
      `${platform} review-fix-code generated fixture must carry coverage-incomplete`
    );
    assert.match(readSnapshot(platform, 'review-fix-code'), /coverage-incomplete/);
    if (platform === 'codex') {
      assert.match(codexCopiedSharedText('review-fix-code'), /coverage-incomplete/);
    } else {
      const embedded = extractEmbeddedSharedContent(platform, rendered);
      assert.equal(
        embedded,
        readEmbeddedSnapshot(platform, 'review-fix-code'),
        `${platform} review-fix-code embedded fixture must carry coverage-incomplete`
      );
      assert.match(readEmbeddedSnapshot(platform, 'review-fix-code'), /coverage-incomplete/);
    }
  }
});

test('manifest records reference paths without per-reference read-only flags', () => {
  const longTask = read('shared/long-task.md');

  assert.doesNotMatch(longTask, /Reference documents, marked read-only/i);
  assert.match(longTask, /manifest records reference paths/i);
  assert.match(longTask, /read-only role is preserved in context packs\/normalized references/i);
});

test('type rubrics contain required explicit coverage terms', () => {
  const spec = read('shared/rubrics/spec.md');
  const design = read('shared/rubrics/design.md');

  assert.match(spec, /implementation fit/i);
  assert.match(design, /implementation detail/i);
});

test('stage-aware rubrics use reference conformance without mandatory upstream chains', () => {
  const core = read('shared/core.md');
  const common = read('shared/rubrics/common.md');
  const design = read('shared/rubrics/design.md');
  const spec = read('shared/rubrics/spec.md');
  const plan = read('shared/rubrics/plan.md');
  const sharedText = [core, common, design, spec, plan].join('\n\n');
  const publicAndPromptText = [
    'README.md',
    'shared/prompts/reviewer.md',
    'shared/prompts/coordinator.md',
    'templates/codex-skill.md.tmpl',
    'templates/claude-command.md.tmpl',
    'templates/gemini-command.toml.tmpl',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ].map(read).join('\n\n');
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-plan', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-design', { packageVersion: '0.0.0-test' })
  ].join('\n\n');
  const allReviewText = [sharedText, publicAndPromptText, renderedRoutes].join('\n\n');

  assert.match(core, /Reference Conformance/);
  assert.match(core, /reference documents/i);
  assert.match(core, /consistency sources/i);
  assert.match(core, /not mandatory upstream chains/i);
  assert.match(core, /complete coverage claim/i);
  assert.match(core, /reference conflict/i);
  assert.match(core, /unsupported new requirement/i);

  assert.match(common, /document type fit/i);
  assert.match(common, /Reference Conformance/i);

  assert.match(design, /stage-aware/i);
  assert.match(design, /does not require downstream SPEC or PLAN handoff tables/i);
  assert.match(design, /reference documents/i);

  assert.match(spec, /A SPEC does not require a DESIGN reference/i);
  assert.match(spec, /Design Coverage Import is optional/i);
  assert.match(spec, /reference conflict/i);

  assert.match(plan, /A PLAN does not require a SPEC reference/i);
  assert.match(plan, /SPEC-to-task mapping is optional/i);
  assert.match(plan, /stop condition/i);

  for (const forbidden of [
    /Every PLAN task must reference at least one SPEC/i,
    /PLAN requires a SPEC reference/i,
    /SPEC requires a DESIGN reference/i,
    /SPEC must include Design Coverage Import/i,
    /Design Coverage Import is required/i,
    /SPEC-to-task mapping is required/i,
    /must include `?Design Coverage Import`?/i,
    /must include `?SPEC-to-task mapping`?/i
  ]) {
    assert.doesNotMatch(allReviewText, forbidden);
  }
});

test('all source skills exist with fixed document types', () => {
  const skills = {
    'skills/review-fix-spec/SKILL.md': 'SPEC',
    'skills/review-fix-plan/SKILL.md': 'PLAN',
    'skills/review-fix-design/SKILL.md': 'DESIGN',
    'skills/review-fix-doc/SKILL.md': 'COMMON'
  };

  for (const [relativePath, fixedType] of Object.entries(skills)) {
    const skill = read(relativePath);
    assert.match(skill, new RegExp(`fixed document type: ${fixedType}`, 'i'));
    assert.match(skill, /users must not pass type/i);
    assert.match(skill, /shared\/core\.md/);
    assert.match(skill, /shared\/long-task\.md/);
    assert.match(skill, /shared\/rubrics\/common\.md/);
    assert.match(skill, /shared\/prompts\/reviewer\.md/);
    assert.match(skill, /shared\/prompts\/fixer\.md/);
    assert.match(skill, /shared\/prompts\/coordinator\.md/);
  }
});

test('source skills templates generated routes and README avoid runtime memory continuity dependency', () => {
  const sourceText = [
    'README.md',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md',
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ].map(read).join('\n\n--- source boundary ---\n\n');

  assert.doesNotMatch(sourceText, /\bresume\s+(?:from|using|via)\s+(?:runtime objective state|session memory|platform memory|chat history)\b/i);
  assert.doesNotMatch(sourceText, /\bcontinuity\s+(?:from|using|via)\s+(?:runtime objective state|session memory|platform memory|chat history)\b/i);
  assert.doesNotMatch(sourceText, /\b(?:runtime objective state|session memory|platform memory|chat history)\s+(?:is|required|needed)\s+for\s+(?:resume|continuity)\b/i);
  assert.doesNotMatch(sourceText, /\bresume from chat history\b/i);
  assert.match(sourceText, /\.drfx\/targets\/<target-key>\//);
});

test('package file list excludes project-local state and ignored planning directories', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.deepEqual(packageJson.files, [
    'bin/',
    'lib/',
    'skills/',
    'shared/',
    'templates/',
    'README.md',
    'README.zh-CN.md'
  ]);
  assert.equal(packageJson.files.includes('README-zh.md'), false);
  assert.equal(packageJson.files.some((entry) => entry.includes('.drfx')), false);
  assert.equal(packageJson.files.some((entry) => entry === 'docs/' || entry.startsWith('docs/')), false);
  assert.equal(packageJson.files.some((entry) => entry === 'design/' || entry.startsWith('design/')), false);
  assert.equal(packageJson.files.includes('CONTINUITY.md'), false);
});

test('localized README is root-level without package lifecycle hooks', () => {
  const packageJson = JSON.parse(read('package.json'));

  assert.equal(packageJson.scripts.prepack, undefined);
  assert.equal(packageJson.scripts.postpack, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'pack-readme-zh.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'README.zh-CN.md')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'docs', 'README.zh-CN.md')), false);
  assert.match(read('README.md'), /\[简体中文\]\(README\.zh-CN\.md\)/);
  assert.match(read('README.zh-CN.md'), /\[English\]\(README\.md\)/);
});

test('localized README keeps public section structure aligned', () => {
  function sectionHeadings(filePath) {
    return read(filePath)
      .split(/\n/)
      .filter((line) => /^#{2,3} /.test(line))
      .map((line) => line.trim());
  }

  const zhReadme = read('README.zh-CN.md');
  assert.deepEqual(sectionHeadings('README.zh-CN.md'), sectionHeadings('README.md'));
  assert.match(zhReadme, /## Modes/);
  assert.match(zhReadme, /partially uninstalled: <platform>/);
});

test('usage examples prefer bare target paths while preserving target form and guard tokens', () => {
  const readme = read('README.md');
  const core = read('shared/core.md');
  const coordinator = read('shared/prompts/coordinator.md');
  const templates = renderedDocumentTemplates();

  assert.match(readme, /review-fix-spec docs\/spec\.md/);
  assert.match(readme, /bare path is shorthand for `target=<path>`/i);
  assert.match(readme, /`guard=git\|snapshot`/);
  assert.match(templates, /review-fix-spec <path> \[ref=<path>\.\.\.\]/);
  assert.match(templates, /full form/i);
  assert.match(templates, /target=<path>/);
  assert.match(templates, /guard=git\|snapshot/);
  assert.match(core, /bare path/i);
  assert.match(core, /`\$review-fix-spec docs\/spec\.md` on Codex/);
  assert.match(core, /`\/review-fix-spec docs\/spec\.md` on Claude Code, Gemini, and opencode/);
  assert.doesNotMatch(core, /for example `review-fix-spec docs\/spec\.md`/);
  assert.match(core, /guard=git\|snapshot/);
  assert.match(coordinator, /bare path/i);
});

test('public docs and route templates distinguish guard blocker wording', () => {
  const sourceText = [
    'README.md',
    'shared/core.md',
    'shared/prompts/coordinator.md',
    'templates/codex-skill.md.tmpl',
    'templates/claude-command.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ].map(read).join('\n\n');

  assert.match(sourceText, /`rollback-unavailable`[\s\S]{0,160}rollback anchor/i);
  assert.match(sourceText, /`target-only-guard-unavailable`[\s\S]{0,180}target-only guard/i);
  assert.match(sourceText, /`unexpected-worktree-change`[\s\S]{0,180}non-target worktree changes/i);

  const checklist = buildFinalResponseChecklist();
  assert.match(checklist, /`rollback-unavailable`[\s\S]{0,160}rollback anchor/i);
  assert.match(checklist, /`target-only-guard-unavailable`[\s\S]{0,180}target-only guard/i);
  assert.match(checklist, /`unexpected-worktree-change`[\s\S]{0,180}non-target worktree changes/i);
});

test('unknown markdown custom rules are warnings in normal mode docs', () => {
  const readme = read('README.md');
  const sharedText = [read('shared/core.md'), read('shared/prompts/coordinator.md')].join('\n\n');

  assert.match(readme, /Unknown Markdown files under `rules\/`/);
  assert.match(readme, /normal[^\n]*warning/i);
  assert.match(readme, /strict[^\n]*block/i);
  assert.match(sharedText, /unknown Markdown rule files/i);
  assert.match(sharedText, /normal[^\n]*warning/i);
});

test('platform route templates use shared runtime flags placeholder', () => {
  const sharedRuntimeFlags = read('shared/runtime-flags.md');
  const templatePaths = [
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/opencode-command.md.tmpl'
  ];

  for (const templatePath of templatePaths) {
    const template = read(templatePath);
    assert.match(template, /\{\{RUNTIME_FLAGS\}\}/, templatePath);
    assert.doesNotMatch(template, /Use the materialized `<selectedAssurance>` to choose runtime fields/, templatePath);
  }
  assert.match(sharedRuntimeFlags, /Use the materialized `<selectedAssurance>` to choose runtime fields/);

  for (const platform of ['claude', 'codex', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-spec', { packageVersion: '0.0.0-test' });
    assert.match(rendered, /Use the materialized `<selectedAssurance>` to choose runtime fields/, platform);
    assert.doesNotMatch(rendered, /\{\{RUNTIME_FLAGS\}\}/, platform);
    assert.doesNotMatch(rendered, /\{\{RUNTIME_PLATFORM\}\}/, platform);
  }
});

test('README stays usage-focused', () => {
  const readme = read('README.md');

  assert.match(readme, /## Quick Start/);
  assert.match(readme, /## Output/);
  assert.match(readme, /## Troubleshooting/);
  assert.doesNotMatch(readme, /## Manual (?:Route )?Smoke/);
  assert.doesNotMatch(readme, /## Manual V2 Smoke/);
  assert.doesNotMatch(readme, /## Runtime Capability Behavior/);
  assert.doesNotMatch(readme, /Manual smoke expectations/i);
  assert.doesNotMatch(readme, /Final response requirements/i);
});

test('README documents reference conformance and non-mandatory upstream chains', () => {
  const readme = read('README.md');

  assert.match(readme, /Reference Conformance/i);
  assert.match(readme, /ref=.*consistency/i);
  assert.match(readme, /SPEC does not require a DESIGN reference/i);
  assert.match(readme, /PLAN does not require a SPEC reference/i);
  assert.match(readme, /Design Coverage Import/i);
  assert.match(readme, /SPEC-to-task mapping/i);
});

test('generated route text contains v2 operational workflow commands', () => {
  const sourceText = [
    'templates/claude-command.md.tmpl',
    'templates/codex-skill.md.tmpl',
    'templates/gemini-command.toml.tmpl'
  ].map(read).join('\n\n');

  assert.match(sourceText, /DRFX_REVIEWER_READY/);
  assert.match(sourceText, /drfx workflow start/);
  assert.match(sourceText, /--runtime-stdin-handoff ready/);
  assert.match(sourceText, /workflow preflight --no-state/);
  assert.match(sourceText, /do not use shell pipes|must not use shell pipes|never use shell pipes/i);
  assert.match(sourceText, /heredocs?|herestrings?/i);
  assert.match(sourceText, /argv|environment variables|env vars|raw temp files/i);
  assert.doesNotMatch(sourceText, /\|\s*(?:npx\s+)?drfx\s+workflow/i);
  assert.doesNotMatch(sourceText, /<<\s*(?:EOF|['"]?DRFX)/i);
  assert.doesNotMatch(sourceText, /--(?:result|triage|fix-report|final-response)\s+(?!-stdin\b)(?:["'`{]|\S)/);
});

test('route templates bind each runtime platform explicitly', () => {
  const codexText = renderedDocumentRoute('codex');
  const claudeText = renderedDocumentRoute('claude');
  const geminiText = renderedDocumentRoute('gemini');

  assert.match(codexText, /--runtime-platform codex\b/);
  assert.match(claudeText, /--runtime-platform claude-code\b/);
  assert.match(geminiText, /--runtime-platform gemini\b/);
  assert.match(geminiText, /workflow preflight --no-state[\s\S]*--status-reason unsupported-runtime-capability/);
  assert.match(geminiText, /advisory-only/i);
  assert.match(geminiText, /must not edit|never edit|do not edit/i);
});

test('strict verified route proof uses same-flow check json only', () => {
  const codexText = renderedDocumentRoute('codex');
  const claudeText = renderedDocumentRoute('claude');
  const geminiText = read('templates/gemini-command.toml.tmpl');

  for (const [label, text, publicPlatform] of [
    ['codex', codexText, 'codex'],
    ['claude', claudeText, 'claude']
  ]) {
    assert.match(text, /assurance=strict-verified/);
    assert.match(text, new RegExp(`drfx doctor --platform ${publicPlatform} --json`));
    assert.match(text, /same-flow|same route flow|same invocation/i);
    assert.match(text, /runId/);
    assert.match(text, /descriptorPath/);
    assert.match(text, /descriptorDirectory/);
    assert.match(text, /--capability-descriptor/);
    assert.match(text, /--descriptor-directory/);
    assert.match(text, /--proof-run-id/);
    assert.match(
      text,
      /drfx workflow start[\s\S]{0,220}(?:<selectedMode>|<requestedMode>|read-only\|review-and-fix|review-and-fix)[\s\S]{0,140}--assurance strict-verified/i,
      label
    );
    assert.match(text, /do not scrape|must not scrape|never scrape/i, label);
    assert.match(text, /human-readable.*drfx doctor|drfx doctor.*human-readable/i, label);
    assert.match(text, /do not reuse|must not reuse|never reuse/i, label);
    assert.match(text, /cached descriptor|installer-default descriptor/i, label);
  }

  assert.match(geminiText, /advisory-only/i);
  assert.doesNotMatch(geminiText, /--assurance strict-verified[\s\S]{0,160}--runtime-platform gemini|--runtime-platform gemini[\s\S]{0,160}--assurance strict-verified/);
});

test('record-diff-review route handoff uses result stdin flag', () => {
  const sourceText = [
    renderedDocumentRoute('claude'),
    renderedDocumentRoute('codex')
  ].join('\n\n');

  assert.match(sourceText, /record-diff-review[\s\S]{0,120}--result-stdin/);
  assert.doesNotMatch(sourceText, /record-diff-review[\s\S]{0,120}--diff-review-stdin/);
});

test('help-style and invalid route path remains explain-only', () => {
  const sourceText = renderedDocumentRoute('codex');
  assert.match(sourceText, /Help-style or invalid invocations still explain usage only/i);
  assert.match(sourceText, /missing target, unknown usage, or explicit help/i);
  assert.doesNotMatch(sourceText, /Help-style or invalid invocations[\s\S]{0,180}drfx workflow start/i);
});

test('generated route text documents v3 platform defaults and advisory override', () => {
  const codexTemplate = renderedDocumentRoute('codex');
  const claudeTemplate = renderedDocumentRoute('claude');
  const geminiTemplate = renderedDocumentRoute('gemini');

  assert.match(codexTemplate, /missing mode selects `review-and-fix`/i);
  assert.match(codexTemplate, /missing assurance selects `practical`/i);
  assert.match(codexTemplate, /explicit `assurance=advisory` without mode selects `read-only`/i);
  assert.match(claudeTemplate, /missing mode selects `review-and-fix`/i);
  assert.match(claudeTemplate, /missing assurance selects `practical`/i);
  assert.match(claudeTemplate, /explicit `assurance=advisory` without mode selects `read-only`/i);
  assert.match(geminiTemplate, /missing mode selects read-only/i);
  assert.match(geminiTemplate, /missing assurance selects advisory/i);

  assert.doesNotMatch(codexTemplate, /without read-only or review-and-fix, explain usage only/i);
  assert.doesNotMatch(claudeTemplate, /without read-only or review-and-fix, explain usage only/i);
});

test('generated routes define concise default output and debug output', () => {
  const sources = [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl'),
    read('templates/gemini-command.toml.tmpl')
  ];

  for (const source of sources) {
    assert.match(source, /Default output is concise/i);
    assert.match(source, /must not print.*Goal \/ Now \/ Next \/ Open Questions/is);
    assert.match(source, /must not print.*14-line final-response machine block/is);
    assert.match(source, /Issues:/);
    assert.match(source, /Location:/);
    assert.match(source, /Problem:/);
    assert.match(source, /Clean:/);
    assert.match(source, /Unfixed:/);
    assert.match(source, /debug/i);
    assert.match(source, /must not print raw target body/i);
    assert.match(source, /must not print raw prompts/i);
  }

  for (const source of [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl')
  ]) {
    assert.match(source, /Fixed:/);
    assert.match(source, /Files changed: none/);
  }
});

test('generated routes surface archiveWarning in default output when finalization returns one', () => {
  const sources = [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl'),
    read('templates/gemini-command.toml.tmpl')
  ];

  for (const source of sources) {
    // Templates must document that archiveWarning requires a visible warning line in default output.
    assert.match(source, /archiveWarning/i, 'template must mention archiveWarning');
    assert.match(source, /archive warning/i, 'template must require an archive warning line in default output');
    assert.match(source, /repair|reset|rerun/i, 'template must include a next action for archive failure');
  }

  // The shared core.md must also require archiveWarning surfacing in default output.
  const core = read('shared/core.md');
  assert.match(core, /archiveWarning/i, 'shared/core.md must mention archiveWarning');
  assert.match(core, /archive warning/i, 'shared/core.md must require archive warning in concise default output');
  assert.match(core, /repair\/reset\/rerun|repair.reset.rerun|repair, reset, or rerun/i, 'shared/core.md must include repair/reset/rerun next action for archiveWarning');

  // Rendered routes must carry the archiveWarning output contract.
  for (const platform of ['codex', 'claude', 'gemini', 'opencode']) {
    const rendered = renderPlatformRoute(platform, 'review-fix-spec', { packageVersion: '0.0.0-test' });
    assert.match(rendered, /archiveWarning/i, `${platform} rendered route must mention archiveWarning`);
    assert.match(rendered, /archive warning/i, `${platform} rendered route must require archive warning line in default output`);
  }
});

test('generated routes require coordinator-quality semantic subagents without model pins', () => {
  const sources = [
    read('templates/codex-skill.md.tmpl'),
    read('templates/claude-command.md.tmpl')
  ];

  for (const source of sources) {
    assert.match(source, /readiness probes may use lower reasoning effort/i);
    assert.match(source, /semantic reviewer subagents inherit coordinator model quality/i);
    assert.match(source, /semantic fixer subagents inherit coordinator model quality/i);
    assert.doesNotMatch(source, /gpt-5\.5/i);
    assert.doesNotMatch(source, /gpt-5\.[345]/i);
  }
});

test('gemini route output stays advisory-only concise', () => {
  const geminiTemplate = read('templates/gemini-command.toml.tmpl');

  assert.match(geminiTemplate, /For read-only findings/i);
  assert.match(geminiTemplate, /For clean read-only runs/i);
  assert.match(geminiTemplate, /Unsupported:/);
  assert.match(geminiTemplate, /Blocked:/);
  assert.match(geminiTemplate, /apply fixes manually/i);
  assert.match(geminiTemplate, /Codex\/Claude Code\/opencode review-and-fix route/i);
  assert.match(geminiTemplate, /review-and-fix or strict-verified is unavailable on Gemini/i);
  assert.doesNotMatch(geminiTemplate, /Next: rerun with review-and-fix to apply fixes/i);
  assert.doesNotMatch(geminiTemplate, /For fixed findings/i);
  assert.doesNotMatch(geminiTemplate, /For successful review-and-fix/i);
  assert.doesNotMatch(geminiTemplate, /^Pass: <target> was updated\./m);
  assert.doesNotMatch(geminiTemplate, /^Fixed:\s*$/m);
  assert.doesNotMatch(geminiTemplate, /^Files changed: none$/m);
});

test('generated route text rejects explicit advisory review-and-fix user requests', () => {
  const codexTemplate = renderedDocumentRoute('codex');
  const claudeTemplate = renderedDocumentRoute('claude');

  for (const template of [codexTemplate, claudeTemplate]) {
    assert.match(template, /review-and-fix assurance=advisory/i);
    assert.match(template, /unsupported as a user request/i);
    assert.match(template, /modeNormalizedFrom: review-and-fix/i);
  }
});

test('generated route text materializes defaults before workflow commands', () => {
  const codexTemplate = renderedDocumentRoute('codex');
  const claudeTemplate = renderedDocumentRoute('claude');

  for (const template of [codexTemplate, claudeTemplate]) {
    assert.match(template, /materialize effective `<selectedMode>`, `<selectedAssurance>`, and `<selectedGuard>`/i);
    assert.match(template, /never pass omitted mode, assurance, or guard through to `drfx workflow`/i);
    assert.match(template, /compute `<selectedMode>` from explicit mode, defaults, and advisory override/i);
    assert.match(template, /compute `<selectedAssurance>` from explicit assurance or platform default/i);
    assert.match(template, /compute `<selectedGuard>` from explicit guard or default `git`/i);
    assert.doesNotMatch(template, /Let `<selectedMode>` be the user's explicit mode/i);
    assert.doesNotMatch(template, /pass the user's raw invocation to `drfx workflow`/i);
  }

  for (const rendered of [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ]) {
    assert.match(rendered, /generated route must materialize effective mode, assurance, and guard before workflow calls/i);
    assert.match(rendered, /never pass omitted values through to `drfx workflow`/i);
  }
});

test('opencode generated routes inject current slash-command arguments into the invocation gate', () => {
  for (const route of listRoutes()) {
    const rendered = renderPlatformRoute('opencode', route.routeName, { packageVersion: '0.0.0-test' });

    assert.match(rendered, /\$ARGUMENTS/, `opencode:${route.routeName} must include the opencode argument placeholder`);
    assert.match(
      rendered,
      /Current invocation arguments:[\s\S]{0,80}\$ARGUMENTS[\s\S]{0,240}Parse the current invocation arguments/i,
      `opencode:${route.routeName} must tell the invocation gate to parse the substituted slash-command arguments`
    );
  }
});

test('source skills and generated routes document reference conformance behavior', () => {
  const sourceSkills = [
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ];
  const platforms = ['codex', 'claude', 'gemini', 'opencode'];
  const routeNames = ['review-fix-spec', 'review-fix-plan', 'review-fix-design', 'review-fix-doc'];

  for (const sourceSkill of sourceSkills) {
    const sourceSkillText = read(sourceSkill);
    assert.match(sourceSkillText, /Reference Conformance/i, sourceSkill);
    assert.match(sourceSkillText, /ref=.*consistency source/i, sourceSkill);
    assert.match(sourceSkillText, /does not require/i, sourceSkill);
  }

  for (const platform of platforms) {
    for (const routeName of routeNames) {
      const routeText = renderPlatformRoute(platform, routeName, { packageVersion: '0.0.0-test' });
      assert.match(routeText, /Reference Conformance/i, `${platform}:${routeName}`);
      assert.match(routeText, /reference documents are consistency sources/i, `${platform}:${routeName}`);
      assert.match(routeText, /not mandatory upstream chains/i, `${platform}:${routeName}`);
    }
  }
});

test('generated route text separates advisory no-state read-only commands', () => {
  const cases = [
    [renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }), 'codex', 'review-fix-spec'],
    [renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }), 'claude-code', 'review-fix-spec']
  ];

  for (const [template, platform, routeName] of cases) {
    assert.match(template, /Advisory read-only no-state path/i);
    assert.match(template, /Do not use the practical\/strict-verified ready-probe commands for advisory read-only/i);
    assert.match(
      template,
      new RegExp(`drfx workflow context --no-state ${routeName} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform ${platform} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json=compact`)
    );
    assert.match(
      template,
      new RegExp(`drfx workflow record-review --no-state ${routeName} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform ${platform} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none`)
    );
    assert.match(template, /Practical read-only no-state path/i);
    assert.match(
      template,
      new RegExp(`read-only guard=<selectedGuard> --assurance <selectedAssurance> --runtime-platform ${platform} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none`)
    );
    assert.match(template, /Strict-verified read-only is state-backed/i);
  }
});

test('rendered route text omits stale missing-mode explain-only contract', () => {
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('opencode', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ].join('\n\n--- rendered route boundary ---\n\n');

  assert.doesNotMatch(renderedRoutes, /omits `?read-only`? and `?review-and-fix`?[^.]*explains usage only/i);
  assert.doesNotMatch(renderedRoutes, new RegExp('Without an explicit mode token' + ', explain usage only', 'i'));
  assert.match(renderedRoutes, /Codex, Claude Code, and opencode routes default a valid target invocation to `review-and-fix assurance=practical`/);
  assert.match(renderedRoutes, /For document\/PR\/CODE routes on Codex, Claude Code, and opencode, explicit `assurance=advisory` without mode selects `read-only`/);
  assert.match(renderedRoutes, /Gemini routes default a valid target invocation to `read-only assurance=advisory`/);
  assert.match(renderedRoutes, /Help-style or invalid invocations explain usage only and must not read target\/reference bodies, run workflow commands, run probes, create state, or declare a review result/);
});

test('rendered routes separate default output from internal final-response payload', () => {
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ].join('\n\n--- rendered route boundary ---\n\n');

  assert.match(renderedRoutes, /--final-response-stdin/);
  assert.match(renderedRoutes, /Internal workflow final-response payload/i);
  assert.match(renderedRoutes, /Default user output uses concise Route Output/i);
  assert.match(renderedRoutes, /debug[\s\S]{0,160}redacted final-response machine block|redacted final-response machine block[\s\S]{0,160}debug/i);
  assert.doesNotMatch(renderedRoutes, /Final responses must state:/i);
  assert.doesNotMatch(renderedRoutes, /Report changes made, including issue IDs when available/i);
  assert.doesNotMatch(renderedRoutes, /Report files changed and issue IDs fixed/i);
  assert.doesNotMatch(renderedRoutes, /Include exactly one machine block/i);
  assert.doesNotMatch(renderedRoutes, /Final response checklist: include/i);
  assert.doesNotMatch(renderedRoutes, /final response includes issue IDs/i);
});

test('rendered gemini route keeps advisory next actions reachable', () => {
  const geminiRoute = renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' });

  assert.match(geminiRoute, /apply fixes manually/i);
  assert.match(geminiRoute, /Codex\/Claude Code\/opencode review-and-fix route/i);
  assert.match(geminiRoute, /review-and-fix or strict-verified is unavailable on Gemini/i);
  assert.doesNotMatch(geminiRoute, /Next: rerun with review-and-fix to apply fixes/i);
  assert.doesNotMatch(geminiRoute, /rerun in `review-and-fix` mode/i);
});

test('codex and claude routes run write eligibility preflight before semantic review', () => {
  // The review-unit noun is route-aware (PLAN-TASK-009 Phase C3): a document route renders
  // "semantic document review"; a PR/CODE route renders "semantic file-set review". Assert
  // on the RENDERED routes so the route-aware substitution is covered, not the raw template.
  const documentRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ];
  for (const rendered of documentRoutes) {
    assert.match(rendered, /Review-And-Fix Write Eligibility Preflight/i);
    assert.match(rendered, /drfx workflow preflight/i);
    assert.match(rendered, /before runtime readiness probe, semantic reviewer dispatch, semantic document review, and target-local workflow state creation/i);
    assert.match(rendered, /cannot be auto-fixed because it lacks a clean rollback anchor/i);
  }

  const fileSetRoutes = [
    renderPlatformRoute('codex', 'review-fix-pr', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-code', { packageVersion: '0.0.0-test' })
  ];
  for (const rendered of fileSetRoutes) {
    assert.match(rendered, /before runtime readiness probe, semantic reviewer dispatch, semantic file-set review, and target-local workflow state creation/i);
    assert.doesNotMatch(rendered, /semantic document review/i);
  }

  const r2pRoutes = [
    { platform: 'codex', rendered: renderPlatformRoute('codex', 'review-fix-r2p', { packageVersion: '0.0.0-test' }) },
    { platform: 'claude', rendered: renderPlatformRoute('claude', 'review-fix-r2p', { packageVersion: '0.0.0-test' }) }
  ];
  for (const { platform, rendered } of r2pRoutes) {
    const shell = maskEmbeddedSharedContent(platform, rendered);
    assert.match(shell, /before runtime readiness probe, semantic reviewer dispatch, semantic document review, and target-local workflow state creation/i);
    assert.match(shell, /cannot run repair commands from the current run state/i);
    assert.doesNotMatch(shell, /clean rollback anchor|guard=snapshot when Git rollback is unavailable/i);
  }
});

test('generated route workflow commands pass the materialized guard token', () => {
  const renderedRoutes = [
    renderPlatformRoute('codex', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('claude', 'review-fix-spec', { packageVersion: '0.0.0-test' }),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ];

  for (const route of renderedRoutes) {
    assert.match(route, /<selectedGuard>/);
    const routedWorkflowCommands = route
      .split('\n')
      .filter((line) => /drfx workflow /.test(line))
      .filter((line) => /review-fix-spec target=<path>/.test(line));
    assert.ok(routedWorkflowCommands.length > 0);
    for (const command of routedWorkflowCommands) {
      assert.match(command, /guard=<selectedGuard>/, command);
    }
  }
});

test('coordinator prompt uses read-only-clean instead of read-only PASS', () => {
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(coordinator, /Terminal and pause states:[\s\S]*read-only-clean[\s\S]*read-only-findings/);
  assert.match(coordinator, /read-only clean status is `read-only-clean`|read-only-clean.*not `?pass`?/i);
  assert.doesNotMatch(coordinator, /mode is read-only[\s\S]{0,180}otherwise report PASS/i);
});

test('shared prompt sources include required v2 machine contracts', () => {
  const sharedText = [
    'shared/core.md',
    'shared/long-task.md',
    'shared/prompts/reviewer.md',
    'shared/prompts/fixer.md',
    'shared/prompts/coordinator.md'
  ].map(read).join('\n\n');

  assert.match(sharedText, /PASS[\s\S]*Summary:/);
  assert.match(sharedText, /FAIL[\s\S]*Findings:[\s\S]*- id: R001/);
  assert.match(sharedText, /Triage:[\s\S]*reviewer_id: R001/);
  assert.match(sharedText, /Fixed:[\s\S]*Files changed:[\s\S]*Not fixed:[\s\S]*Residual risk:/);
  assert.match(sharedText, /DIFF-OK[\s\S]*DIFF-FAIL/);
  assert.match(sharedText, /Final status:/);
  assert.match(sharedText, /redaction/i);
  assert.doesNotMatch(sharedText, /raw test fixture/i);
});

test('public docs no longer teach legacy RULE.md as supported configuration', () => {
  const readme = read('README.md');
  const longTask = read('shared/long-task.md');
  const sourceSkills = [
    read('skills/review-fix-spec/SKILL.md'),
    read('skills/review-fix-plan/SKILL.md'),
    read('skills/review-fix-design/SKILL.md'),
    read('skills/review-fix-doc/SKILL.md')
  ].join('\n');

  assert.doesNotMatch(
    readme,
    new RegExp(('Optional custom rule ' + 'files:') + '\\s*```text\\s*~\\/\\.drfx\\/RULE\\.md', 'is')
  );
  assert.doesNotMatch(readme, /Example `RULE\.md` shape/i);
  assert.doesNotMatch(longTask, /`?\.drfx\/RULE\.md`? is shared project configuration/i);
  assert.doesNotMatch(sourceSkills, new RegExp('Without an explicit mode token' + ', explain usage only', 'i'));

  assert.match(readme, /~\/\.drfx\/rules\/COMMON\.md/);
  assert.match(readme, /\.drfx\/rules\/SPEC\.md/);
  assert.match(readme, /Legacy `RULE\.md` is stale configuration/i);
  assert.match(sourceSkills, /missing mode selects `review-and-fix`/i);
});

test('README documents v3 invocation defaults and explain-only boundary', () => {
  const readme = read('README.md');

  assert.match(readme, /Codex, Claude Code, and opencode routes default missing mode to `review-and-fix` and missing assurance to `practical`/);
  assert.match(readme, /For document\/PR\/CODE routes on Codex, Claude Code, and opencode, explicit `assurance=advisory` without mode selects `read-only`/);
  assert.match(readme, /Gemini routes default missing mode to `read-only` and missing assurance to `advisory`/);
  assert.match(readme, /Help-style or invalid invocations[\s\S]*explain usage only[\s\S]*must not read files[\s\S]*run `drfx workflow`[\s\S]*create state[\s\S]*run probes[\s\S]*declare review results/);
});

test('README documents typed scoped custom rule reads', () => {
  const readme = read('README.md');

  assert.match(readme, /loader reads only `COMMON\.md` plus the current document type file/);
  assert.match(readme, /A `SPEC` review does not read `PLAN\.md` or `DESIGN\.md`/);
  assert.match(readme, /a `PLAN` review does not read `SPEC\.md` or `DESIGN\.md`/);
  assert.match(readme, /a `DESIGN` review does not read `SPEC\.md` or `PLAN\.md`/);
  assert.match(readme, /a COMMON document review reads only `COMMON\.md`/);
});

test('README documents unknown markdown rule file strictness behavior', () => {
  const readme = read('README.md');

  assert.match(readme, /Unknown Markdown files under `rules\/`/);
  assert.match(readme, /`SPEC-RULE\.md`/);
  assert.match(readme, /`REQUIREMENTS\.md`/);
  assert.match(readme, /normal[^\n]*warning/i);
  assert.match(readme, /strict[^\n]*block before target state is written/i);
});

test('README keeps PR/CODE auto-fix writes inside the resolved file set', () => {
  const readme = read('README.md');
  const localized = read('README.zh-CN.md');

  assert.match(readme, /Auto-fix modifies only the resolved file set/i);
  assert.match(readme, /report (?:the issue|it) as `Not fixed`/i);
  assert.doesNotMatch(readme, /may be edited only after it is declared/i);
  assert.doesNotMatch(readme, /added to the monitored, guarded set before its first write/i);

  assert.match(localized, /自动修复只改 resolved file set/);
  assert.match(localized, /`Not fixed`/);
  assert.doesNotMatch(localized, /只有在先声明/);
  assert.doesNotMatch(localized, /首次写入前纳入受监控且 guard 的集合/);
});

test('long-task keeps project-root rules outside target state', () => {
  const longTask = read('shared/long-task.md');

  assert.match(longTask, /Project-root `\.drfx\/rules\/` is shared project configuration, not target state/);
  assert.match(longTask, /Do not write target review state to project-root[\s\S]*`\.drfx\/rules\/`/);
});

test('source skills individually document v3 defaults and concise debug output', () => {
  const skills = [
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ];

  for (const relativePath of skills) {
    const skill = read(relativePath);

    assert.match(skill, /Valid target invocations may omit mode/, relativePath);
    assert.match(skill, /select `review-and-fix assurance=practical` by default when mode and assurance are omitted/, relativePath);
    assert.match(skill, /missing mode selects `review-and-fix` and missing assurance selects `practical`/, relativePath);
    assert.match(skill, /Explicit `assurance=advisory` without mode selects `read-only` on Codex, Claude Code, and opencode/, relativePath);
    assert.match(skill, /Gemini generated routes select `read-only assurance=advisory` by default/, relativePath);
    assert.match(skill, /Help-style or invalid invocations explain usage only and do not read files, run workflow commands, run probes, create state, or declare review results/, relativePath);
    assert.match(skill, /Pass `debug` to print redacted workflow audit details/, relativePath);
    assert.match(skill, /Default output is concise/, relativePath);
    assert.match(skill, /must not expose raw workflow JSON, prompt text, subagent transcripts, or internal issue IDs/, relativePath);
    assert.match(skill, /`Issues:`, `Fixed:`, or `Unfixed:` lists/, relativePath);
  }
});

test('public docs and source skills omit stale v2 rule and mode wording', () => {
  const publicText = [
    read('README.md'),
    read('shared/long-task.md'),
    read('skills/review-fix-spec/SKILL.md'),
    read('skills/review-fix-plan/SKILL.md'),
    read('skills/review-fix-design/SKILL.md'),
    read('skills/review-fix-doc/SKILL.md')
  ].join('\n\n');

  assert.doesNotMatch(publicText, /Rule heading restrictions are strict/i);
  assert.doesNotMatch(publicText, /`?\.drfx\/RULE\.md`? is shared project configuration/i);
  assert.doesNotMatch(publicText, /`?RULE\.md`? is shared project configuration/i);
  assert.doesNotMatch(publicText, /No mode token means explain only/i);
  assert.doesNotMatch(publicText, new RegExp('Without an explicit mode token' + ', explain usage only', 'i'));
  assert.doesNotMatch(publicText, /`read-only` or `review-and-fix` is required to start workflow/i);
  assert.doesNotMatch(publicText, /If no mode is provided, explain usage only/i);
});

test('diff review requires fix-effectiveness verification (no new machine fields)', () => {
  const core = read('shared/core.md');
  const coordinator = read('shared/prompts/coordinator.md');
  const fixer = read('shared/prompts/fixer.md');

  // G1: effectiveness is a prompt discipline folded into the existing DIFF-FAIL fields.
  assert.match(core, /resolves the original finding|actually resolve|does not resolve/i);
  assert.match(coordinator, /resolves the original finding|does not resolve/i);
  assert.match(fixer, /how (the|this) (change|fix) resolves|how it resolves the/i);

  // Must NOT introduce a machine field for it.
  assert.doesNotMatch(core, /^\s*resolves:\s*(yes|no|partial)/im);
});

test('common rubric defines severity anchors; reviewer states coverage in Summary (no machine line)', () => {
  const common = read('shared/rubrics/common.md');
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');

  assert.match(common, /^## Severity anchors$/m);
  assert.match(common, /high:.*blocks/i);
  assert.match(common, /medium:.*materially/i);
  assert.match(common, /low:.*clarity|low:.*does not block/i);

  // Coverage is stated inside the existing Summary line, NOT a new machine line.
  assert.match(reviewer, /state[^.]*coverage[^.]*Summary|within the Summary/i);
  assert.doesNotMatch(reviewer, /^Coverage:/m);
  // Coverage statement is limited to the PASS Summary; FAIL must not gain a Summary line.
  assert.match(reviewer, /On PASS|PASS Summary/);
  assert.match(reviewer, /FAIL report has no Summary|no Summary.*Findings:|do not add a Summary line/i);
  assert.match(coordinator, /coverage|exercised the required/i);
});

test('shared prompts use route-neutral target-context framing', () => {
  const promptText = [
    read('shared/prompts/reviewer.md'),
    read('shared/prompts/coordinator.md'),
    read('shared/prompts/fixer.md')
  ].join('\n\n');

  assert.doesNotMatch(promptText, /document-review-loop/);
  assert.doesNotMatch(promptText, /Review the full target document and decide whether it can PASS/);
  assert.doesNotMatch(promptText, /Objective: review the full document, fix confirmed blocking issues/);
  assert.doesNotMatch(promptText, /still review the whole document/i);
  assert.doesNotMatch(promptText, /rubric groups for the document type/);
  assert.doesNotMatch(promptText, /for this document type/);
  assert.doesNotMatch(promptText, /full-document (?:review|re-review)/i);
  assert.match(promptText, /target context/i);
  assert.match(promptText, /resolved file set/i);
  assert.match(promptText, /route\/rubric/i);
  assert.match(promptText, /whole target context/i);
  assert.match(promptText, /full target-context re-review/i);
});

test('shared core uses target-context framing for document and file-set routes', () => {
  const core = read('shared/core.md');

  assert.doesNotMatch(core, /whole target document through an isolated read-only reviewer task/i);
  assert.doesNotMatch(core, /full-document (?:review|re-review|review gate)/i);
  assert.doesNotMatch(core, /may modify only the target document for accepted issue IDs/i);
  assert.doesNotMatch(core, /^- Modify only the target document\.$/m);
  assert.match(core, /whole target context/i);
  assert.match(core, /target-context re-review/i);
  assert.match(core, /target document for document routes, or the resolved file set for PR\/CODE routes/i);
});

test('reviewer must not narrow the review when given changed-since-last-review', () => {
  const core = read('shared/core.md');
  const reviewer = read('shared/prompts/reviewer.md');
  const coordinator = read('shared/prompts/coordinator.md');
  assert.match(core, /Changed since last review|changed-since-last-review/i);
  assert.match(reviewer, /Changed since last review/i);
  assert.match(coordinator, /Changed since last review/i);
  assert.match(reviewer, /still review the (whole|full) (?:document|target context)|do not narrow/i);
  assert.match(coordinator, /still review the (whole|full) (?:document|target context)|(?:do|must) not narrow/i);
});

test('routes and prompts list stopped-no-progress as a terminal state', () => {
  const finalStatusLine = read('shared/core.md').match(/^Final status: (.+)$/m);
  assert.ok(finalStatusLine, 'shared/core.md must include the final-response status machine line');
  assert.match(finalStatusLine[1], /stopped-no-progress/);
  assert.match(buildFinalResponseChecklist(), /stopped-no-progress[\s\S]*no-progress-detected/);

  const renderedRouteText = [
    renderedDocumentRoute('claude'),
    renderedDocumentRoute('codex'),
    renderPlatformRoute('gemini', 'review-fix-spec', { packageVersion: '0.0.0-test' })
  ].join('\n\n');

  for (const rel of [
    'shared/core.md',
    'shared/prompts/coordinator.md',
    'skills/review-fix-spec/SKILL.md',
    'skills/review-fix-plan/SKILL.md',
    'skills/review-fix-design/SKILL.md',
    'skills/review-fix-doc/SKILL.md'
  ]) {
    assert.match(read(rel), /stopped-no-progress/, `${rel} must list stopped-no-progress`);
  }

  assert.match(renderedRouteText, /stopped-no-progress/, 'rendered route text must list stopped-no-progress');
});

test('coordinator defines a recurrence + fix-attempt-cap convergence rule', () => {
  const coordinator = read('shared/prompts/coordinator.md');
  assert.match(coordinator, /fix-attempt cap|recurr/i);
  assert.match(coordinator, /stopped-no-progress/);
});

// ---------------------------------------------------------------------------
// generatePlatformFiles must generate all SEVEN routes (document + pr + code + r2p)
// ---------------------------------------------------------------------------

test('generatePlatformFiles generates all seven routes (document + pr + code + r2p)', () => {
  const allRouteNames = listRoutes().map((r) => r.routeName);
  assert.deepEqual(allRouteNames, [
    'review-fix-spec',
    'review-fix-plan',
    'review-fix-design',
    'review-fix-doc',
    'review-fix-pr',
    'review-fix-code',
    'review-fix-r2p',
  ]);

  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const files = generatePlatformFiles(platform, { packageVersion: '0.0.0-test' });
    const generatedRouteNames = files.map((f) => f.routeName);
    assert.deepEqual(
      generatedRouteNames,
      allRouteNames,
      `${platform} must generate all seven routes`
    );
  }
});

test('all generated Claude routes disable implicit model invocation', () => {
  for (const route of listRoutes()) {
    const rendered = renderPlatformRoute('claude', route.routeName, { packageVersion: '0.0.0-test' });
    const frontmatter = rendered.match(/^---\n([\s\S]*?)\n---\n/);

    assert.ok(frontmatter, `claude:${route.routeName} must start with YAML frontmatter`);
    assert.match(
      frontmatter[1],
      new RegExp(`^description: Run /${route.routeName}\\b`, 'm'),
      `claude:${route.routeName} must have a route-specific description`
    );
    assert.match(
      frontmatter[1],
      /^disable-model-invocation: true$/m,
      `claude:${route.routeName} must disable implicit model invocation`
    );
  }
});

test('all generated Codex skills carry exact explicit-only agent policy metadata', () => {
  const metadataPath = path.join('agents', 'openai.yaml');
  const skills = generatePlatformFiles('codex', { packageVersion: '0.0.0-test' });

  for (const skill of skills) {
    const metadata = skill.files.find((file) => file.relativePath === metadataPath);
    const skillMarkdown = skill.files.find((file) => file.relativePath === 'SKILL.md');

    assert.ok(metadata, `codex:${skill.routeName} must generate ${metadataPath}`);
    assert.equal(
      metadata.content,
      CODEX_INVOCATION_POLICY,
      `codex:${skill.routeName} must disable implicit invocation`
    );
    assert.match(
      skillMarkdown.content,
      /^description: .*Explicit invocation only .*$/m,
      `codex:${skill.routeName} description must defensively mark the skill explicit-only`
    );
    assert.ok(
      skillMarkdown.content.includes(`\`$${skill.routeName}\``),
      `codex:${skill.routeName} description must name its explicit invocation`
    );
  }
});

// A YAML plain scalar cannot contain ": ", so a colon in a generated description
// would silently break the frontmatter that carries the invocation policy.
test('generated Claude and Codex frontmatter descriptions stay YAML-plain-scalar safe', () => {
  for (const platform of ['claude', 'codex']) {
    for (const route of listRoutes()) {
      const rendered = renderPlatformRoute(platform, route.routeName, { packageVersion: '0.0.0-test' });
      const description = rendered.match(/^description: (.*)$/m);
      assert.ok(description, `${platform}:${route.routeName} must declare a frontmatter description`);
      assert.doesNotMatch(
        description[1],
        /: /,
        `${platform}:${route.routeName} description must not contain ": " (breaks YAML plain scalars)`
      );
    }
  }
});

// skills/ descriptors ship in the npm package at the same layout Codex installs
// (`<skill>/agents/openai.yaml`), so a hand-copied descriptor must carry the same
// policy as a generated route rather than falling back to Codex's default.
test('source skill descriptors carry the same explicit-only policy as generated routes', () => {
  // The template is the source the other copies are compared against, so assert what it
  // MEANS (not its bytes) with the same reader the installer gates on.
  const template = parseYamlBlockMapping(CODEX_INVOCATION_POLICY);
  assert.ok(template, `${CODEX_INVOCATION_POLICY_PATH} must parse as a supported YAML block mapping`);
  const policy = template.get('policy');
  assert.equal(policy && policy.kind, 'mapping', `${CODEX_INVOCATION_POLICY_PATH} must declare a policy block`);
  assert.deepEqual(
    policy.value.get('allow_implicit_invocation'),
    { kind: 'scalar', style: 'plain', value: 'false' },
    `${CODEX_INVOCATION_POLICY_PATH} must disable implicit invocation`
  );

  for (const route of listRoutes()) {
    const skillDir = path.join('skills', route.routeName);
    assert.equal(
      read(path.join(skillDir, 'agents', 'openai.yaml')),
      CODEX_INVOCATION_POLICY,
      `${skillDir} must disable implicit invocation`
    );
    assert.match(
      read(path.join(skillDir, 'SKILL.md')),
      new RegExp(`^description: .*Explicit invocation only .*\`\\$${route.routeName}\``, 'm'),
      `${skillDir} description must name its explicit invocation`
    );
  }
});

// ---------------------------------------------------------------------------
// PR and CODE rubric content assertions
// ---------------------------------------------------------------------------

test('pr.md rubric covers all required PR categories', () => {
  const pr = read('shared/rubrics/pr.md');

  for (const category of ['correctness', 'regression', 'safety', 'tests', 'contracts', 'maintainability', 'platform']) {
    assert.match(pr, new RegExp(`\\b${category}\\b`, 'i'), `pr.md must cover category: ${category}`);
  }
});

test('code.md rubric covers all required CODE categories', () => {
  const code = read('shared/rubrics/code.md');

  for (const category of ['correctness', 'architecture', 'state-and-io', 'safety', 'tests', 'contracts', 'maintainability', 'platform']) {
    assert.match(code, new RegExp(category.replace('-', '[- ]'), 'i'), `code.md must cover category: ${category}`);
  }
});

test('pr.md and code.md encode the actionable-only triage boundary', () => {
  const pr = read('shared/rubrics/pr.md');
  const code = read('shared/rubrics/code.md');

  for (const [label, text] of [['pr.md', pr], ['code.md', code]]) {
    // Must say pure style preferences are NOT blocking
    assert.match(text, /pure style/i, `${label} must mention pure style as non-blocking`);
    // Must say no-risk refactors are NOT blocking
    assert.match(text, /no.risk refactor|no-risk refactor/i, `${label} must mention no-risk refactors as non-blocking`);
    // Must say over-abstraction is NOT blocking
    assert.match(text, /over.abstraction|over-abstraction/i, `${label} must mention over-abstraction as non-blocking`);
  }
});

test('code.md lists the required CODE priority-scan surfaces', () => {
  const code = read('shared/rubrics/code.md');

  const surfaces = [
    'entry point',
    'public api',
    'cli',
    'config',
    'schema',
    'template generation',
    'install',
    'uninstall',
    'state machine',
    'persistence',
    'test fixture',
    'cross-platform'
  ];

  for (const surface of surfaces) {
    assert.match(code, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `code.md must mention priority-scan surface: ${surface}`);
  }
});

// ---------------------------------------------------------------------------
// Generated CODE route (review-fix-pr / review-fix-code) behavior (PLAN-TASK-008 P3)
// ---------------------------------------------------------------------------

function generatedCodeRoutes() {
  const outputs = [];
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    for (const routeName of ['review-fix-pr', 'review-fix-code']) {
      outputs.push({
        platform,
        routeName,
        routeKind: routeName === 'review-fix-pr' ? 'pr' : 'code',
        body: renderPlatformRoute(platform, routeName, { packageVersion: '0.0.0-test' })
      });
    }
  }
  return outputs;
}

test('generated code routes use self-contained PR/CODE rubrics without embedding COMMON', () => {
  for (const output of generatedCodeRoutes()) {
    const sharedProtocol = routeSharedProtocolText(output.platform, output.routeName, output.body);
    assert.doesNotMatch(
      sharedProtocol,
      /<!-- shared\/rubrics\/common\.md -->/,
      `${output.platform}:${output.routeName} must not embed the COMMON rubric`
    );
    assert.match(
      sharedProtocol,
      new RegExp(`<!-- shared/rubrics/${output.routeKind}\\.md -->`),
      `${output.platform}:${output.routeName} must embed its route-kind rubric`
    );
  }

  const codexSkills = generatePlatformFiles('codex', { packageVersion: '0.0.0-test' });
  for (const routeName of ['review-fix-pr', 'review-fix-code']) {
    const skill = codexSkills.find((entry) => entry.routeName === routeName);
    const copiedPaths = skill.files.map((file) => file.relativePath);
    const rubricName = routeName === 'review-fix-pr' ? 'pr.md' : 'code.md';
    assert.equal(copiedPaths.includes(path.join('shared', 'rubrics', 'common.md')), false, routeName);
    assert.equal(copiedPaths.includes(path.join('shared', 'rubrics', rubricName)), true, routeName);
  }
});

test('generated code routes do not delegate to platform review commands', () => {
  for (const output of generatedCodeRoutes()) {
    // `(?!\w)` skips path/word continuations such as `shared/prompts/reviewer.md`;
    // `(?!-fix-)` exempts only drfx's own `/review-fix-*` routes, which the Claude
    // frontmatter names. A `/review` or `/review-<other>` delegation still fails.
    assert.doesNotMatch(output.body, /\/review(?!\w)(?!-fix-)/, `${output.platform}:${output.routeName} must not mention /review`);
  }
});

test('generated code routes use the route-kind target token and omit document-only tokens', () => {
  for (const output of generatedCodeRoutes()) {
    const requiredToken = output.routeKind === 'pr' ? /base=<branch>/ : /\[scope=<path>\.\.\.\]|<scopeTokens>/;
    assert.match(output.body, requiredToken, `${output.platform}:${output.routeName} must use its target token`);
    assert.doesNotMatch(
      output.body,
      /bare project-root invocation/i,
      `${output.platform}:${output.routeName} must not advertise an unsupported bare-root invocation`
    );
    // No fixed Document type semantics for code routes (check the route SHELL,
    // not the embedded coordinator prompt which legitimately mentions Document type).
    const shell = maskEmbeddedSharedContent(output.platform, output.body);
    assert.doesNotMatch(shell, /^Document type:/m, `${output.platform}:${output.routeName} must not declare a Document type`);
    // Invocation grammar must omit the document-only tokens.
    const grammar = output.body.match(/review-fix-(?:pr|code) (?:base=<branch>|\[scope=<path>\.\.\.\])[^\n`]*/);
    assert.ok(grammar, `${output.platform}:${output.routeName} must show an invocation grammar line`);
    assert.doesNotMatch(grammar[0], /\bref=/, 'code grammar omits ref=');
    assert.doesNotMatch(grammar[0], /\bassurance=/, 'code grammar omits assurance=');
    assert.doesNotMatch(grammar[0], /\bledger=/, 'code grammar omits ledger=');
    assert.doesNotMatch(grammar[0], /\[strict\|normal\]/, 'code grammar omits strict|normal');
  }
});

test('whole-root CODE cap wording stays bound to the target-context constants', () => {
  const { MAX_WHOLE_ROOT_FILES, MAX_WHOLE_ROOT_BYTES } = require('../lib/target-context');
  const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const files = String(MAX_WHOLE_ROOT_FILES);
  const bytes = withCommas(MAX_WHOLE_ROOT_BYTES);
  const enPhrase = `${files} files or ${bytes} bytes`;
  const zhPhrase = `${files} 个文件或 ${bytes} 字节`;

  // Every user-facing cap statement must derive from MAX_WHOLE_ROOT_*, so changing
  // a constant forces the wording to be updated everywhere (no silent doc drift).
  const enSurfaces = [
    ['README.md', read('README.md')],
    ['skills/review-fix-code/SKILL.md', read('skills/review-fix-code/SKILL.md')],
    ...['claude', 'codex', 'gemini', 'opencode'].map((platform) => [
      `generated:${platform}`,
      renderPlatformRoute(platform, 'review-fix-code', { packageVersion: '0.0.0-test' })
    ])
  ];
  for (const [label, text] of enSurfaces) {
    assert.ok(text.includes(enPhrase), `${label} must state the cap as "${enPhrase}" (from MAX_WHOLE_ROOT_* constants)`);
  }
  assert.ok(read('README.zh-CN.md').includes(zhPhrase), `README.zh-CN.md must state the cap as "${zhPhrase}"`);
});

test('generated review-fix-code route accepts omitted scope as whole project root', () => {
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const body = renderPlatformRoute(platform, 'review-fix-code', { packageVersion: '0.0.0-test' });
    const grammar = body.match(/review-fix-code \[scope=<path>\.\.\.\][^\n`]*/);
    assert.ok(grammar, `${platform}:review-fix-code grammar must make scope optional`);
    assert.match(body, /Omit `?scope=`? to review the whole project root/i);
    assert.match(
      body,
      /within the single-pass budget of 300 files or 1,500,000 bytes/i,
      `${platform}:review-fix-code must document the single-pass budget`
    );
    assert.match(
      body,
      /partitioned project review[\s\S]{0,160}narrow with `?scope=<path>`?/i,
      `${platform}:review-fix-code must explain partitioned review and how to keep it single-pass`
    );
    assert.match(body, /<scopeTokens>/, `${platform}:review-fix-code workflow commands must use materialized scope tokens`);
    assert.doesNotMatch(maskEmbeddedSharedContent(platform, body), /missing `scope=`|At least one `?scope=<path>`? is required/i);
  }
});

test('Claude and Codex code routes materialize practical assurance without exposing assurance=', () => {
  for (const platform of ['claude', 'codex', 'opencode']) {
    for (const routeName of ['review-fix-pr', 'review-fix-code']) {
      const body = renderPlatformRoute(platform, routeName, { packageVersion: '0.0.0-test' });
      // Internally materializes practical so auto-fix is not rejected.
      assert.match(body, /internally materializes `practical`/i, `${platform}:${routeName}`);
      assert.match(body, /advisory-review-and-fix-unsupported/i, `${platform}:${routeName}`);
      // The persistent review-and-fix start command carries practical assurance.
      assert.match(
        body,
        new RegExp(`drfx workflow start ${routeName} (?:base=<branch>|<scopeTokens>)[\\s\\S]{0,120}review-and-fix[\\s\\S]{0,120}--assurance practical`),
        `${platform}:${routeName} persistent start must pass --assurance practical`
      );
      // No user-facing assurance= token in the invocation grammar.
      const grammar = body.match(new RegExp(`${routeName} (?:base=<branch>|\\[scope=<path>\\.\\.\\.\\])[^\\n\`]*`));
      assert.doesNotMatch(grammar[0], /assurance=/, `${platform}:${routeName} grammar exposes no assurance=`);
    }
  }
});

test('generated Claude/Codex start commands materialize rounds token conditionally', () => {
  for (const platform of ['claude', 'codex', 'opencode']) {
    for (const route of listRoutes()) {
      const body = renderPlatformRoute(platform, route.routeName, { packageVersion: '0.0.0-test' });
      const startCommands = body
        .split('\n')
        .filter((line) => line.startsWith('drfx workflow start '))
        .join('\n');

      assert.match(startCommands, /rounds=<roundLimit>/, `${platform}:${route.routeName}`);
      assert.match(
        body,
        /When `rounds=<n>` is present,[^\n]+otherwise omit the token\./,
        `${platform}:${route.routeName}`
      );
    }
  }
});

test('Gemini code routes are advisory only', () => {
  for (const routeName of ['review-fix-pr', 'review-fix-code']) {
    const command = renderPlatformRoute('gemini', routeName, { packageVersion: '0.0.0-test' });
    assert.match(command, /advisory-only/i);
    assert.match(command, /review-and-fix[\s\S]{0,160}unsupported|unsupported[\s\S]{0,160}review-and-fix/i);
    assert.match(command, /workflow PASS[\s\S]{0,120}(?:unavailable|must not claim)|must not claim[\s\S]{0,120}workflow PASS/i);
    assert.doesNotMatch(command, /Pass:\s*<target>|workflow PASS\s+(?:is\s+)?(?:available|supported)|automatic fixes?\s+(?:available|supported|will run)/i);
    // Gemini code routes never silently default omitted mode to read-only; they
    // render the shared review-and-fix default as unsupported/advisory-only.
    assert.doesNotMatch(command, /missing mode selects `?read-only`?/i);
    // The displayed invocation grammar line must match the advisory-only gate body:
    // no review-and-fix, no rounds, no resume tokens advertised on Gemini code routes.
    const targetToken = routeName === 'review-fix-pr' ? 'base=<branch>' : '[scope=<path>...]';
    const grammar = command.match(new RegExp(`${routeName} ${targetToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`));
    assert.ok(grammar, `${routeName} gemini grammar line must be present`);
    assert.doesNotMatch(grammar[0], /review-and-fix|rounds=|resume/, `${routeName} gemini grammar must not advertise review-and-fix/rounds/resume`);
  }
});

test('document source skills document rounds=<n> loop-limit support', () => {
  for (const routeName of ['spec', 'plan', 'design', 'doc']) {
    const skill = read(`skills/review-fix-${routeName}/SKILL.md`);
    assert.match(skill, /\[rounds=<n>\]/, `review-fix-${routeName} grammar must include [rounds=<n>]`);
    assert.match(skill, /`rounds=<n>` sets the maximum repair-loop count/i, `review-fix-${routeName} must explain rounds=<n>`);
    assert.match(skill, /unsupported with `read-only`/i, `review-fix-${routeName} must note rounds is read-only-incompatible`);
  }
});

test('PR and CODE source skills exist with code-route contract guidance', () => {
  const pr = read('skills/review-fix-pr/SKILL.md');
  const code = read('skills/review-fix-code/SKILL.md');

  // PR skill
  assert.match(pr, /^name: review-fix-pr$/m);
  assert.match(pr, /base=<branch>/);
  assert.match(pr, /must not pass `target=`, `type`, `ref=`, `assurance=`, `strict`, `normal`, or `ledger=`/);
  assert.match(pr, /internally materializes `practical` assurance/i);
  assert.match(pr, /advisory-review-and-fix-unsupported/);
  assert.match(pr, /shared\/rubrics\/pr\.md/);
  assert.doesNotMatch(pr, /\/review\b/);
  assert.doesNotMatch(pr, /fixed document type/i);

  // CODE skill
  assert.match(code, /^name: review-fix-code$/m);
  assert.match(code, /scope=<path>/);
  assert.match(code, /review-fix-code \[scope=<path>\.\.\.\]/);
  assert.match(code, /Omit `scope=` to review the whole project root/i);
  assert.match(code, /a larger whole-root file set is reviewed as a partitioned project review/i);
  assert.doesNotMatch(code, /block as `file-set-too-large`/i);
  assert.doesNotMatch(code, /At least one `scope=<path>` is required/i);
  assert.match(code, /must not pass `target=`, `type`, `ref=`, `base=`, `assurance=`, `strict`, `normal`, or `ledger=`/);
  assert.match(code, /internally materializes `practical` assurance/i);
  assert.match(code, /advisory-review-and-fix-unsupported/);
  assert.match(code, /shared\/rubrics\/code\.md/);
  assert.doesNotMatch(code, /\/review\b/);
  assert.doesNotMatch(code, /fixed document type/i);

  // Both reference the shared sources every code route relies on. PR/CODE rubrics
  // are self-contained and must not list the document COMMON rubric.
  for (const skill of [pr, code]) {
    for (const ref of ['shared/core.md', 'shared/long-task.md', 'shared/prompts/reviewer.md', 'shared/prompts/fixer.md', 'shared/prompts/coordinator.md']) {
      assert.match(skill, new RegExp(ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    }
    assert.doesNotMatch(skill, /shared\/rubrics\/common\.md/);
  }
});

// ---------------------------------------------------------------------------
// PLAN-TASK-009 (Phase D): shared protocol text describes generalized route target
// contexts (document/PR/CODE) without leaking document-only claims. The Task-8
// document SHELL snapshot masks embedded content; these are the SEMANTIC assertions
// over the shared source and the embedded code-route content.
// ---------------------------------------------------------------------------

test('long-task.md describes route target contexts and file-set manifest identity', () => {
  const longTask = read('shared/long-task.md');
  assert.match(longTask, /Route Target Contexts/i);
  assert.match(longTask, /review-fix-pr/);
  assert.match(longTask, /review-fix-code/);
  // File-set manifest identity: the discriminator and the file-set fingerprint.
  assert.match(longTask, /Target context kind/i);
  assert.match(longTask, /file-set fingerprint/i);
  // File-set resume/stale rules are described (no silent reuse, stale refusal).
  assert.match(longTask, /[Rr]esume is never silent/);
  assert.match(longTask, /file-set fingerprint/i);
  // PR resolution is local and read-only (no fetch/push/ref mutation).
  assert.match(longTask, /never fetch, push, or mutate refs/i);
});

test('long-task.md does not leak document-only claims as universal target context truth', () => {
  const longTask = read('shared/long-task.md');
  // The old document-only target-key claim must no longer be stated as the only rule.
  assert.doesNotMatch(
    longTask,
    /^The target key is derived from the normalized target path relative to the document project root, not from content\.$/m
  );
  // The document content-sha fields must be presented under the document identity block,
  // not as a universal manifest requirement for every kind.
  assert.match(longTask, /Document target context identity/i);
  assert.match(longTask, /File-set \(PR\/CODE\) target context identity/i);
  assert.match(longTask, /Document type is `none`/);
});

test('generated PR/CODE route content carries generalized target-context text and no document-only leak', () => {
  for (const output of generatedCodeRoutes()) {
    const packageText = output.platform === 'codex'
      ? `${output.body}\n\n${codexCopiedSharedText(output.routeName)}`
      : output.body;
    // The embedded long-task content (route target contexts) reaches the generated route.
    assert.match(packageText, /Route Target Contexts/i, `${output.platform}:${output.routeName}`);
    assert.match(packageText, /Target context kind/i, `${output.platform}:${output.routeName}`);
    assert.match(packageText, /file-set fingerprint/i, `${output.platform}:${output.routeName}`);
    // Must NOT leak the document-only target-key derivation claim verbatim.
    assert.doesNotMatch(
      packageText,
      /target key is derived from the normalized target path relative to the document project root/i,
      `${output.platform}:${output.routeName} leaks document-only target-key claim`
    );
    // Must NOT present single-file sha/size-only state as the only manifest identity.
    assert.match(packageText, /File-set \(PR\/CODE\) target context identity/i, `${output.platform}:${output.routeName}`);
  }
});

test('fixer/coordinator prompts keep undeclared dependency files read-only and define optional Verification', () => {
  const fixer = read('shared/prompts/fixer.md');
  const coordinator = read('shared/prompts/coordinator.md');
  // PR/CODE routes cannot currently register new dependency files before begin-fix.
  assert.match(fixer, /only files inside the resolved target file set/i);
  assert.match(fixer, /cannot be made within the target context/i);
  assert.match(fixer, /Not fixed/i);
  assert.doesNotMatch(fixer, /declared with its path/i);
  assert.doesNotMatch(fixer, /plus any recorded necessary dependency file/i);
  assert.doesNotMatch(fixer, /present in the monitored file set before its first write/i);
  assert.doesNotMatch(coordinator, /recorded necessary dependency files for PR\/CODE routes/i);
  // Per-round verification recording.
  assert.match(fixer, /optional Verification section/i);
  assert.match(fixer, /omit this section/i);
  assert.match(coordinator, /optional `Verification:` section/i);
  assert.match(coordinator, /omit that section/i);
  // Never PASS from read-only/advisory/diff-review-only/unverified.
  assert.match(coordinator, /Never claim PASS from a read-only, advisory-only, diff-review-only, or otherwise unverified path/i);
});

test('embedded shared content equals golden snapshots (prompts/rubrics/core)', () => {
  const routeNames = listRoutes().map((route) => route.routeName);
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    for (const routeName of routeNames) {
      const rendered = renderPlatformRoute(platform, routeName, { packageVersion: '0.0.0-snapshot' });
      const embedded = extractEmbeddedSharedContent(platform, rendered);
      const golden = readEmbeddedSnapshot(platform, routeName);
      assert.equal(
        embedded,
        golden,
        `${platform}:${routeName} embedded shared content drifted from test/fixtures/embedded — regenerate intentionally after reviewing the diff`
      );
    }
  }
});

test('codex generated skills copy shared assets byte-for-byte from source', () => {
  const codexSkills = generatePlatformFiles('codex', { packageVersion: '0.0.0-snapshot' });
  const routesByName = new Map(listRoutes().map((route) => [route.routeName, route]));

  function expectedSharedPathsForRoute(route) {
    const paths = ['shared/core.md', 'shared/long-task.md'];
    // r2p layers COMMON like the document routes (it embeds COMMON + PLAN).
    if (route.routeKind === 'document' || route.routeKind === 'r2p') paths.push('shared/rubrics/common.md');
    if (route.rubric) paths.push(`shared/rubrics/${route.rubric}.md`);
    paths.push(
      'shared/prompts/reviewer.md',
      'shared/prompts/fixer.md',
      'shared/prompts/coordinator.md'
    );
    return paths.map((entry) => entry.split('/').join(path.sep)).sort();
  }

  for (const skill of codexSkills) {
    const route = routesByName.get(skill.routeName);
    const copiedFiles = skill.files.filter((entry) => entry.sourcePath);
    assert.deepEqual(
      copiedFiles.map((entry) => entry.relativePath).sort(),
      expectedSharedPathsForRoute(route),
      `${skill.routeName} copied shared asset path set drifted`
    );
    for (const file of copiedFiles) {
      assert.equal(
        file.content,
        read(file.sourcePath),
        `${skill.routeName}:${file.relativePath} copied shared asset drifted from source`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// PLAN-TASK-004: Partitioned rubric + route-contract text
// Positive-assertion gate: the rendered review-fix-code route (per platform)
// must carry the partitioned-review markers and all four discipline names so
// the section cannot silently vanish in a future regeneration.
// ---------------------------------------------------------------------------

test('rendered review-fix-code route carries partitioned-review markers on every platform', () => {
  for (const platform of ['claude', 'codex', 'gemini', 'opencode']) {
    const body = renderPlatformRoute(platform, 'review-fix-code', { packageVersion: '0.0.0-test' });
    const packageText = platform === 'codex' ? `${body}\n\n${codexCopiedSharedText('review-fix-code')}` : body;

    // Core partitioned-review markers (from rubric + route contract)
    assert.match(packageText, /partitioned project review/i, `${platform}:review-fix-code must mention partitioned project review`);
    assert.match(packageText, /unit PASS/i, `${platform}:review-fix-code must state unit PASS`);
    assert.match(packageText, /coverage-incomplete/i, `${platform}:review-fix-code must mention coverage-incomplete`);
    assert.match(packageText, /coverage_risk/i, `${platform}:review-fix-code must mention coverage_risk`);

    // Four locally-checkable disciplines (from rubric, embedded in generated route)
    assert.match(packageText, /redaction-at-write-boundary/i, `${platform}:review-fix-code must list discipline: redaction-at-write-boundary`);
    assert.match(packageText, /identity-field-coverage/i, `${platform}:review-fix-code must list discipline: identity-field-coverage`);
    assert.match(packageText, /allowlist-only-git/i, `${platform}:review-fix-code must list discipline: allowlist-only-git`);
    assert.match(packageText, /status\/phase legality/i, `${platform}:review-fix-code must list discipline: status/phase legality`);

    // PASS-is-earned reinforcement
    assert.match(packageText, /unit PASS is NOT a project PASS|unit PASS.*not.*project PASS/i, `${platform}:review-fix-code must assert unit PASS != project PASS`);

    if (platform === 'claude' || platform === 'codex' || platform === 'opencode') {
      assert.match(body, /Partitioned CODE Review Flow/, `${platform}:review-fix-code must include the executable partitioned flow`);
      assert.match(body, /--phase unit-review/, `${platform}:review-fix-code must instruct unit-review contexts`);
      assert.match(body, /--phase crosscutting/, `${platform}:review-fix-code must instruct crosscutting contexts`);
      assert.match(body, /workflow aggregate-review <targetStateDir>/, `${platform}:review-fix-code must instruct aggregate-review before PASS`);
      assert.match(body, /Do not run `--phase initial-review` to claim a project PASS/, `${platform}:review-fix-code must reject single-shot initial-review PASS`);
    } else {
      assert.doesNotMatch(body, /Partitioned CODE Review Flow/, `${platform}:review-fix-code must not advertise review-and-fix partitioned execution`);
    }

    // Route-contract: three-phase description + no single-shot PASS claim
    assert.match(body, /independently-mergeable|independently.usable/i, `${platform}:review-fix-code route contract must describe independently-mergeable phases`);
    assert.match(body, /never claims a single-shot full-project PASS|never claims.*workflow PASS/i, `${platform}:review-fix-code must assert partitioned run never claims single-shot PASS`);
  }
});
