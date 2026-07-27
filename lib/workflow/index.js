'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateCurrentDescriptor } = require('../capability');
const { parseInvocation } = require('../input');
const { explicitRouteInvocation, getRouteDescriptor } = require('../routes');
const { readManifestAny } = require('../target-state');
const {
  isFileSetRoute,
  resolveR2pProjectRoot,
  resolveRouteTargetMetadata
} = require('./target-resolution');
const { redactSensitive } = require('../redaction');
const {
  atomicWriteFile,
  contextManifestPathFor,
  applyTriageDecisions,
  enrichTriageDecisions,
  formatLedger,
  nextReportPath,
  padRound,
  parseReviewerResult,
  parseTriageResult,
  persistentBase,
  producerForAssurance,
  readContextManifest,
  readLedgerIfPresent,
  readManifestReport,
  readReviewerReport,
  readWorkflowPayload,
  receiptFailureResult,
  resolveFileSetStateMetadata,
  resolveFileSetPersistentMetadata,
  stateCommandBase,
  statePathFromManifest,
  stateRelativePath,
  stateValidationResult,
  targetStatePathFromManifest,
  triageOutcome,
  updatePersistentManifest,
  writeContextManifest,
  writeReviewerReport,
  writeTriageReport
} = require('./helpers');
const {
  BLOCKING_REASONS,
  workflowJson
} = require('../workflow-state');
const { runFixLifecycleCommand } = require('./fix-lifecycle');
const { runRecordDiffReview } = require('./diff-review');
const {
  runPersistentFinalize,
  runPersistentResume
} = require('./finalize');
const { runNoStateWorkflowCommand, runWriteEligibilityPreflight } = require('./no-state');
const {
  runPersistentContext,
  runPersistentRecordReview,
  runPersistentRecordTriage
} = require('./persistent-context');
const {
  runFileSetContext,
  runFileSetRecordReview,
  runFileSetRecordTriage
} = require('./file-set-context');
const {
  runFileSetResume,
  runFileSetRecordDiffReview,
  runFileSetFinalize
} = require('./file-set-finalize');
const { runFileSetFixLifecycleCommand } = require('./file-set-fix');
const {
  buildRepairPlan,
  driftGuard,
  mapRepairMode,
  readRecordedRepairPlan,
  sameRepairPlan,
  probeJsonContract,
  readRunStatus,
  resolveR2pCommands,
  runRepairCommand,
  runStatusFromEntries,
  reserveReceipt,
  writeRecordedRepairPlan,
  writeReceipt
} = require('./r2p-repair');
const { runPersistentStart } = require('./start');
const {
  runPartitionedContext,
  runPartitionedRecordReview,
  runAggregateReview
} = require('./partitioned-review');
const { resolveR2pWorkIdTarget } = require('../target-context');

const WORKFLOW_SUBCOMMANDS = new Set([
  'start',
  'preflight',
  'context',
  'record-review',
  'record-triage',
  'record-r2p-repair-plan',
  'apply-r2p-repair',
  'begin-fix',
  'refresh-lock',
  'end-fix',
  'abort-fix',
  'record-diff-review',
  'finalize',
  'aggregate-review'
]);
const ASSURANCE_VALUES = new Set(['advisory', 'practical', 'strict-verified']);
const RUNTIME_PLATFORMS = new Set(['codex', 'claude-code', 'gemini', 'opencode', 'manual']);
const SUBAGENT_PROBES = new Set(['ready', 'unavailable', 'failed', 'not-required']);
const STDIN_HANDOFFS = new Set(['ready', 'unavailable', 'not-required']);
const NO_STATE_SUBCOMMANDS = new Set(['preflight', 'context', 'record-review', 'record-triage', 'finalize']);
const REVIEW_BACKED_NO_STATE_SUBCOMMANDS = new Set(['context', 'record-review', 'record-triage', 'finalize']);
const TARGET_STATE_SUBCOMMANDS = new Set(['begin-fix', 'refresh-lock', 'end-fix', 'abort-fix']);
const R2P_INVOCATION_PREFLIGHT_SUBCOMMANDS = new Set(['start', 'preflight', 'context', 'record-review', 'record-triage', 'finalize']);
const RETRYABLE_R2P_REPAIR_BLOCKERS = new Set(['r2p-command-failed']);
const TARGET_STATE_DIR_SUBCOMMANDS = new Set([
  ...TARGET_STATE_SUBCOMMANDS,
  'record-r2p-repair-plan',
  'apply-r2p-repair',
  'record-diff-review',
  // PLAN-TASK-007: aggregate-review takes exactly one target-state directory
  // (like record-diff-review). It is PERSISTENT-only — the no-state guard in the
  // shared TARGET_STATE_DIR_SUBCOMMANDS branch rejects --no-state cleanly.
  'aggregate-review'
]);
const PREFLIGHT_FORBIDDEN_FLAGS = Object.freeze([
  'stateToken',
  'reviewGuard',
  'result',
  'resultStdin',
  'triage',
  'triageStdin',
  'fixReport',
  'fixReportStdin',
  'finalResponse',
  'finalResponseStdin',
  'diffReview',
  'diffReviewStdin',
  'payload',
  'payloadFile',
  'payloadStdin'
]);
const DOWNGRADE_REASONS = new Set([
  'none',
  'subagent-delegation-unavailable',
  'reviewer-dispatch-failed',
  'reviewer-probe-invalid'
]);
const VALUE_FLAGS = new Set([
  'assurance',
  'runtime-platform',
  'runtime-subagent-probe',
  'runtime-stdin-handoff',
  'runtime-downgrade-reason',
  'capability-descriptor',
  'descriptor-directory',
  'proof-run-id',
  'terminal-status',
  'status',
  'reason',
  'next-action',
  'status-reason',
  'blocking-reason',
  'phase',
  'unit',
  'backstop',
  'state-token',
  'review-guard',
  'result',
  'triage',
  'final-response',
  'fix-report',
  'diff-review',
  'payload',
  'payload-file'
]);
const BOOLEAN_FLAGS = new Set([
  'json',
  'no-state',
  'result-stdin',
  'triage-stdin',
  'final-response-stdin',
  'fix-report-stdin',
  'diff-review-stdin',
  'payload-stdin'
]);
const JSON_MODES = new Set(['full', 'compact']);
const STATUS_COMPACT_FIELDS = [
  'ok',
  'status',
  'errorCode',
  'message',
  'nextAction',
  'blockingReason',
  'statusReason',
  'warnings'
];
const WORKFLOW_IDENTITY_COMPACT_FIELDS = [
  'targetStateDir',
  'targetKey',
  'manifestPath',
  'ledgerPath',
  'round',
  'documentType',
  'strictness',
  'requestedMode',
  'mode',
  'guardMode',
  'modeSource',
  'modeNormalizedFrom',
  'requestedAssurance',
  'assuranceSource',
  'assuranceNormalizedFrom',
  'assurance',
  'runtimePlatform',
  'descriptorPlatform',
  'assuranceProof',
  'strictProofError',
  'currentPhase'
];
const STATE_CONTEXT_FIELDS = ['contextManifestPath'];
const REVIEW_RECORD_FIELDS = ['contextManifestPath', 'reviewerReportPath'];
const FIX_LOCK_FIELDS = ['lockOwnerId', 'leaseId', 'leaseExpiresAt', 'refreshAfterSeconds', 'fixGuardReportPath'];
const FINALIZATION_STATUS_FIELDS = [
  'requiresUserDecision',
  'conflict',
  'continuityWarning',
  'originalBlockingReason'
];
const RESUME_STATUS_FIELDS = [
  'requiresFullReview',
  'requiresUserDecision',
  'conflict',
  'continuityWarning',
  'archivedStatePath',
  'archiveWarning'
];
const PARTITION_PLAN_FIELDS = [
  'reviewMode',
  'reviewPlanPath',
  'reason',
  'unitCount',
  'unitByteBudget',
  'oversize',
  'reviewCacheKey',
  'backstops',
  'forcedReread',
  'crosscuttingBackstops'
];
const PARTITION_UNIT_FIELDS = ['reused'];
// No-state (advisory) partitioned context has no manifest to persist the partition
// plan, so `units` and `projectReviewFingerprint` must travel in compact stdout for the
// route to drive per-unit review. State-backed partitioned context reads them from the
// manifest instead, so those fields stay debug-only there. These two fields are therefore
// allowlisted for the no-state:partitioned-context row ONLY (enforced by a matrix
// invariant test); never widen them into any other compact row.
const NO_STATE_PARTITION_PLAN_FIELDS = [
  ...PARTITION_PLAN_FIELDS,
  'units',
  'projectReviewFingerprint'
];
const NO_STATE_TOKEN_FIELDS = ['reviewGuard', 'stateToken'];
const FULL_WORKFLOW_EXTRA_FIELDS = [
  'lockOwnerId',
  'leaseId',
  'leaseExpiresAt',
  'refreshAfterSeconds',
  'fixGuardReportPath',
  'fixReportPath',
  'fixedIssueIds',
  'currentPhase',
  'diffReviewReportPath',
  'finalResponse',
  'requiresFullReview',
  'requiresUserDecision',
  'conflict',
  'continuityWarning',
  'receiptPath',
  'originalBlockingReason',
  'archivedStatePath',
  'archiveWarning',
  'userExcludes',
  'scopeIgnoreOverrides',
  // PLAN-TASK-007: partitioned project-review result fields.
  'reviewMode',
  'reviewPlanPath',
  'reason',
  'reviewerReportPath',
  'unitCount',
  'unitByteBudget',
  'units',
  'projectReviewFingerprint',
  'unitId',
  'oversize',
  'reused',
  'reviewCacheKey',
  'coverageRisk',
  'backstop',
  'backstops',
  'summaries',
  'verdict',
  'coverageProof',
  'forcedReread',
  'crosscuttingBackstops',
  'uncoveredUnitIds',
  'uncoveredBackstops',
  'aggregatePath'
];
const FULL_OUTPUT_FIELD_PURPOSES = new Map([
  ['ok', 'stdout required'],
  ['status', 'stdout required'],
  ['errorCode', 'user status'],
  ['message', 'user status'],
  ['targetStateDir', 'path readable'],
  ['targetKey', 'user status'],
  ['manifestPath', 'path readable'],
  ['ledgerPath', 'path readable'],
  ['round', 'user status'],
  ['documentType', 'user status'],
  ['strictness', 'user status'],
  ['requestedMode', 'user status'],
  ['mode', 'user status'],
  ['guardMode', 'user status'],
  ['modeSource', 'user status'],
  ['modeNormalizedFrom', 'user status'],
  ['requestedAssurance', 'user status'],
  ['assuranceSource', 'user status'],
  ['assuranceNormalizedFrom', 'user status'],
  ['assurance', 'user status'],
  ['runtimePlatform', 'user status'],
  ['descriptorPlatform', 'user status'],
  ['assuranceProof', 'user status'],
  ['strictProofError', 'user status'],
  ['runtimeCheck', 'debug only'],
  ['contextManifestPath', 'path readable'],
  ['contextPackSkeleton', 'stdout required'],
  ['reviewGuard', 'stdout required'],
  ['stateToken', 'stdout required'],
  ['nextAction', 'user status'],
  ['blockingReason', 'user status'],
  ['statusReason', 'user status'],
  ['warnings', 'user status'],
  ['lockOwnerId', 'stdout required'],
  ['leaseId', 'stdout required'],
  ['leaseExpiresAt', 'stdout required'],
  ['refreshAfterSeconds', 'stdout required'],
  ['fixGuardReportPath', 'path readable'],
  ['fixReportPath', 'path readable'],
  ['fixedIssueIds', 'user status'],
  ['currentPhase', 'user status'],
  ['diffReviewReportPath', 'path readable'],
  ['finalResponse', 'user status'],
  ['requiresFullReview', 'user status'],
  ['requiresUserDecision', 'user status'],
  ['conflict', 'user status'],
  ['continuityWarning', 'user status'],
  ['receiptPath', 'path readable'],
  ['originalBlockingReason', 'user status'],
  ['archivedStatePath', 'path readable'],
  ['archiveWarning', 'user status'],
  ['userExcludes', 'debug only'],
  ['scopeIgnoreOverrides', 'debug only'],
  ['reviewMode', 'user status'],
  ['reviewPlanPath', 'path readable'],
  ['reason', 'user status'],
  ['reviewerReportPath', 'path readable'],
  ['unitCount', 'user status'],
  ['unitByteBudget', 'user status'],
  ['units', 'stdout required'],
  ['projectReviewFingerprint', 'stdout required'],
  ['unitId', 'stdout required'],
  ['oversize', 'user status'],
  ['reused', 'user status'],
  ['reviewCacheKey', 'user status'],
  ['coverageRisk', 'user status'],
  ['backstop', 'stdout required'],
  ['backstops', 'user status'],
  ['summaries', 'stdout required'],
  ['verdict', 'user status'],
  ['coverageProof', 'debug only'],
  ['forcedReread', 'user status'],
  ['crosscuttingBackstops', 'user status'],
  ['uncoveredUnitIds', 'user status'],
  ['uncoveredBackstops', 'user status'],
  ['aggregatePath', 'path readable']
]);
const COMPACT_ALLOWLIST_MATRIX = Object.freeze([
  compactRow('state', 'preflight', [...STATUS_COMPACT_FIELDS, ...WORKFLOW_IDENTITY_COMPACT_FIELDS]),
  compactRow('state', 'start', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...RESUME_STATUS_FIELDS
  ]),
  compactRow('state', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...STATE_CONTEXT_FIELDS
  ]),
  compactRow('state', 'record-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...REVIEW_RECORD_FIELDS
  ]),
  compactRow('state', 'record-triage', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'ledgerPath'
  ]),
  compactRow('fix-lifecycle', 'begin-fix', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...FIX_LOCK_FIELDS
  ]),
  compactRow('fix-lifecycle', 'refresh-lock', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...FIX_LOCK_FIELDS
  ]),
  compactRow('fix-lifecycle', 'end-fix', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'fixReportPath',
    'fixedIssueIds',
    'reviewMode'
  ]),
  compactRow('fix-lifecycle', 'abort-fix', [...STATUS_COMPACT_FIELDS, ...WORKFLOW_IDENTITY_COMPACT_FIELDS]),
  compactRow('fix-lifecycle', 'record-diff-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'diffReviewReportPath',
    'requiresFullReview',
    'requiresUserDecision',
    'continuityWarning'
  ]),
  compactRow('fix-lifecycle', 'finalize', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'finalResponse',
    'fixedIssueIds',
    ...FINALIZATION_STATUS_FIELDS,
    'receiptPath',
    'archivedStatePath',
    'archiveWarning'
  ]),
  compactRow('r2p-repair', 'record-r2p-repair-plan', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'receiptPath'
  ]),
  compactRow('r2p-repair', 'apply-r2p-repair', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'receiptPath'
  ]),
  compactRow('file-set', 'start-or-resume', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...RESUME_STATUS_FIELDS,
    'reviewMode',
    'reviewPlanPath'
  ]),
  compactRow('file-set', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...STATE_CONTEXT_FIELDS,
    'reviewMode'
  ]),
  compactRow('file-set', 'record-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...REVIEW_RECORD_FIELDS,
    'reviewMode'
  ]),
  compactRow('file-set', 'record-triage', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'ledgerPath',
    'reviewMode'
  ]),
  compactRow('file-set', 'aggregate-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'verdict',
    'aggregatePath',
    'uncoveredUnitIds',
    'uncoveredBackstops'
  ]),
  compactRow('partitioned', 'plan', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...PARTITION_PLAN_FIELDS
  ]),
  compactRow('partitioned', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...PARTITION_PLAN_FIELDS,
    ...STATE_CONTEXT_FIELDS,
    'unitId',
    'backstop',
    'summaries'
  ]),
  compactRow('partitioned', 'unit-review', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'unitId',
    'coverageRisk',
    'reviewerReportPath',
    ...PARTITION_UNIT_FIELDS
  ]),
  compactRow('partitioned', 'crosscutting', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'backstop',
    'coverageRisk',
    'reviewerReportPath'
  ]),
  compactRow('partitioned', 'aggregate', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    'verdict',
    'reason',
    'reviewerReportPath',
    'aggregatePath',
    'uncoveredUnitIds',
    'uncoveredBackstops'
  ]),
  compactRow('no-state', 'partitioned-context', [
    ...STATUS_COMPACT_FIELDS,
    ...WORKFLOW_IDENTITY_COMPACT_FIELDS,
    ...NO_STATE_PARTITION_PLAN_FIELDS
  ]),
  compactRow('no-state', 'preflight', [...STATUS_COMPACT_FIELDS, ...NO_STATE_TOKEN_FIELDS]),
  compactRow('no-state', 'context', [
    ...STATUS_COMPACT_FIELDS,
    ...STATE_CONTEXT_FIELDS,
    'contextPackSkeleton',
    ...NO_STATE_TOKEN_FIELDS
  ]),
  compactRow('no-state', 'record-review', [
    ...STATUS_COMPACT_FIELDS,
    'reviewerReportPath',
    ...NO_STATE_TOKEN_FIELDS
  ]),
  compactRow('no-state', 'record-triage', [...STATUS_COMPACT_FIELDS, 'ledgerPath', ...NO_STATE_TOKEN_FIELDS]),
  compactRow('no-state', 'finalize', [
    ...STATUS_COMPACT_FIELDS,
    'finalResponse',
    'fixedIssueIds',
    ...NO_STATE_TOKEN_FIELDS
  ])
]);
const COMPACT_ALLOWLIST_BY_KEY = new Map(
  COMPACT_ALLOWLIST_MATRIX.map((row) => [`${row.scope}:${row.command}`, row])
);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function camelCase(flag) {
  return flag.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

// PLAN-TASK-007: only these two phase values divert context/record-review to the
// partitioned project-review lifecycle. Every other phase (and the absent default)
// keeps the existing file-set dispatch byte-identical.
function isPartitionedPhase(phase) {
  return phase === 'unit-review' || phase === 'crosscutting';
}

function descriptorPlatformFor(runtimePlatform) {
  if (runtimePlatform === 'claude-code') return 'claude';
  return runtimePlatform;
}

function readPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  return packageJson.version;
}

function parseFlagToken(token) {
  const flag = token.slice(2);
  const index = flag.indexOf('=');
  if (index === -1) return [flag, null];
  return [flag.slice(0, index), flag.slice(index + 1)];
}

function compactRow(scope, command, fields) {
  return {
    scope,
    command,
    fields: Object.freeze([...new Set(fields)])
  };
}

function parseWorkflowJsonMode(args) {
  let mode = null;
  for (const arg of args) {
    if (arg === '--json') {
      mode = mode || 'full';
      continue;
    }
    if (arg.startsWith('--json=')) {
      const value = arg.slice('--json='.length);
      if (!JSON_MODES.has(value)) fail('ERR_WORKFLOW_FLAG', `Invalid --json mode: ${value}`);
      mode = value;
    }
  }
  return mode || 'full';
}

function parseWorkflowArgs(subcommand, args) {
  if (!WORKFLOW_SUBCOMMANDS.has(subcommand)) fail('ERR_WORKFLOW_COMMAND', `Unknown workflow command: ${subcommand}`);

  const flags = {};
  const tokens = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      tokens.push(arg);
      continue;
    }

    const [flag, inlineValue] = parseFlagToken(arg);
    if (flag === 'json') {
      if (inlineValue !== null && !JSON_MODES.has(inlineValue)) {
        fail('ERR_WORKFLOW_FLAG', `Invalid --json mode: ${inlineValue}`);
      }
      flags.json = true;
      flags.jsonMode = inlineValue || flags.jsonMode || 'full';
      continue;
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== null) fail('ERR_WORKFLOW_FLAG', `--${flag} does not accept a value`);
      flags[camelCase(flag)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) fail('ERR_WORKFLOW_FLAG', `Unknown workflow option: --${flag}`);

    let value = inlineValue;
    if (value === null) {
      index += 1;
      if (index >= args.length) fail('ERR_WORKFLOW_FLAG_VALUE', `--${flag} requires a value`);
      value = args[index];
    }
    flags[camelCase(flag)] = value;
  }

  const persistentFinalize = subcommand === 'finalize' && !flags.noState && tokens.length === 1;
  if (TARGET_STATE_DIR_SUBCOMMANDS.has(subcommand) || persistentFinalize) {
    if (flags.noState) fail('ERR_NO_STATE_COMMAND', `no-state workflow does not support ${subcommand}`);
    if (tokens.length !== 1) {
      fail('ERR_TARGET_STATE_DIR', `${subcommand} requires exactly one target-state directory`);
    }
    return {
      subcommand,
      json: Boolean(flags.json),
      jsonMode: flags.jsonMode || 'full',
      noState: false,
      targetStateDir: path.resolve(tokens[0]),
      payloadFlags: flags
    };
  }

  if (tokens.length === 0) fail('ERR_WORKFLOW_ENTRY_SKILL', 'workflow command requires an entry skill');
  const [entrySkill, ...invocationTokens] = tokens;
  const flagAssurance = flags.assurance || null;
  if (flagAssurance && !ASSURANCE_VALUES.has(flagAssurance)) fail('ERR_ASSURANCE', `Invalid assurance: ${flagAssurance}`);
  const invocation = parseInvocation(entrySkill, invocationTokens, {
    defaultMode: 'read-only',
    defaultAssurance: flagAssurance,
    includeMetadata: true
  });
  if (
    flagAssurance &&
    invocation.assuranceSource === 'explicit' &&
    invocation.requestedAssurance !== flagAssurance
  ) {
    fail('ERR_CONFLICTING_ASSURANCE', 'assurance= token and --assurance must match');
  }

  const assurance = flagAssurance || invocation.requestedAssurance || 'advisory';
  if (!ASSURANCE_VALUES.has(assurance)) fail('ERR_ASSURANCE', `Invalid assurance: ${assurance}`);
  if (flags.runtimePlatform && !RUNTIME_PLATFORMS.has(flags.runtimePlatform)) {
    fail('ERR_RUNTIME_PLATFORM', `Invalid runtime platform: ${flags.runtimePlatform}`);
  }
  if (flags.runtimeSubagentProbe && !SUBAGENT_PROBES.has(flags.runtimeSubagentProbe)) {
    fail('ERR_RUNTIME_SUBAGENT_PROBE', `Invalid runtime subagent probe: ${flags.runtimeSubagentProbe}`);
  }
  if (flags.runtimeStdinHandoff && !STDIN_HANDOFFS.has(flags.runtimeStdinHandoff)) {
    fail('ERR_RUNTIME_STDIN_HANDOFF', `Invalid runtime stdin handoff: ${flags.runtimeStdinHandoff}`);
  }
  if (flags.runtimeDowngradeReason && !DOWNGRADE_REASONS.has(flags.runtimeDowngradeReason)) {
    fail('ERR_RUNTIME_DOWNGRADE_REASON', `Invalid runtime downgrade reason: ${flags.runtimeDowngradeReason}`);
  }

  const runtimeCheck = {
    platform: flags.runtimePlatform || null,
    subagentProbe: {
      status: flags.runtimeSubagentProbe || null,
      evidence: flags.runtimeSubagentProbe === 'ready' ? 'route-asserted-ready' : 'none'
    },
    stdinHandoff: {
      status: flags.runtimeStdinHandoff || null,
      evidence: flags.runtimeStdinHandoff === 'ready' ? 'route-asserted-ready' : 'none'
    },
    downgradeReason: flags.runtimeDowngradeReason || 'none'
  };

  validateRuntimeArgs({ subcommand, flags, assurance, runtimeCheck });
  validateNoStateArgs({ subcommand, flags, invocation, assurance });

  return {
    subcommand,
    json: Boolean(flags.json),
    jsonMode: flags.jsonMode || 'full',
    noState: Boolean(flags.noState),
    entrySkill,
    invocation,
    strictnessExplicit: invocationTokens.some((token) => token === 'strict' || token === 'normal'),
    assurance,
    runtimePlatform: flags.runtimePlatform || null,
    runtimeCheck,
    capabilityDescriptor: flags.capabilityDescriptor || null,
    descriptorDirectory: flags.descriptorDirectory || null,
    proofRunId: flags.proofRunId || null,
    terminalStatus: flags.terminalStatus || null,
    statusReason: flags.statusReason || null,
    blockingReason: flags.blockingReason || null,
    phase: flags.phase || null,
    unit: flags.unit || null,
    backstop: flags.backstop || null,
    stateToken: flags.stateToken || null,
    reviewGuard: flags.reviewGuard || null,
    payloadFlags: flags
  };
}

function validateRuntimeArgs({ subcommand, flags, assurance, runtimeCheck }) {
  if (subcommand === 'preflight' && !flags.noState) {
    if (
      !['codex', 'claude-code', 'opencode'].includes(flags.runtimePlatform) ||
      flags.runtimeSubagentProbe !== 'not-required' ||
      flags.runtimeStdinHandoff !== 'not-required'
    ) {
      fail(
        'ERR_PREFLIGHT_RUNTIME',
        'write eligibility preflight requires codex, claude-code, or opencode with not-required runtime checks'
      );
    }
    return;
  }

  if (assurance === 'practical') {
    if (
      !['codex', 'claude-code', 'opencode'].includes(flags.runtimePlatform) ||
      flags.runtimeSubagentProbe !== 'ready' ||
      flags.runtimeStdinHandoff !== 'ready'
    ) {
      fail(
        'ERR_PRACTICAL_RUNTIME',
        'practical assurance requires runtime platform codex, claude-code, or opencode with ready subagent and stdin handoff'
      );
    }
  }

  if (
    assurance === 'advisory' &&
    ['unavailable', 'failed'].includes(runtimeCheck.subagentProbe.status) &&
    !DOWNGRADE_REASONS.has(runtimeCheck.downgradeReason)
  ) {
    fail('ERR_RUNTIME_DOWNGRADE_REASON', 'advisory subagent downgrade requires an allowed downgrade reason');
  }
  if (
    assurance === 'advisory' &&
    ['unavailable', 'failed'].includes(runtimeCheck.subagentProbe.status) &&
    runtimeCheck.downgradeReason === 'none'
  ) {
    fail('ERR_RUNTIME_DOWNGRADE_REASON', 'advisory subagent downgrade requires a downgrade reason');
  }

  if (assurance === 'strict-verified') {
    if (subcommand !== 'start' || flags.noState) fail('ERR_STRICT_WORKFLOW', 'strict-verified assurance requires workflow start with state');
    if (flags.runtimePlatform === 'gemini') {
      if (flags.runtimeSubagentProbe !== 'not-required' || flags.runtimeStdinHandoff !== 'not-required') {
        fail('ERR_STRICT_GEMINI_RUNTIME', 'Gemini strict-verified unsupported path requires not-required runtime checks');
      }
      return;
    }
    if (!['codex', 'claude-code', 'opencode'].includes(flags.runtimePlatform)) {
      fail('ERR_STRICT_RUNTIME_PLATFORM', 'strict-verified assurance requires runtime platform codex, claude-code, or opencode');
    }
    if (flags.runtimeSubagentProbe !== 'ready' || flags.runtimeStdinHandoff !== 'ready') {
      fail('ERR_STRICT_RUNTIME_READY', 'strict-verified assurance requires ready subagent and stdin handoff');
    }
    if (!flags.capabilityDescriptor || !flags.proofRunId) {
      fail('ERR_STRICT_PROOF', 'strict-verified assurance requires capability descriptor and proof run id');
    }
  }
}

function validateNoStateArgs({ subcommand, flags, invocation, assurance }) {
  if (!flags.noState) return;
  if (!NO_STATE_SUBCOMMANDS.has(subcommand)) {
    fail('ERR_NO_STATE_COMMAND', `no-state workflow does not support ${subcommand}`);
  }
  if (assurance === 'strict-verified') {
    fail('ERR_NO_STATE_STRICT_VERIFIED', 'no-state workflow rejects strict-verified assurance');
  }
  if (!flags.runtimePlatform || !flags.runtimeSubagentProbe || !flags.runtimeStdinHandoff) {
    fail('ERR_NO_STATE_RUNTIME', 'no-state workflow requires runtime platform, subagent probe, and stdin handoff flags');
  }

  if (subcommand === 'preflight') {
    for (const flag of PREFLIGHT_FORBIDDEN_FLAGS) {
      if (Object.hasOwn(flags, flag)) {
        fail('ERR_NO_STATE_PREFLIGHT_SEMANTIC_INPUT', `no-state preflight rejects semantic or state input: ${flag}`);
      }
    }
    validatePreflightTerminalFlags(flags);
    return;
  }

  if (REVIEW_BACKED_NO_STATE_SUBCOMMANDS.has(subcommand)) {
    if (invocation.resume) fail('ERR_NO_STATE_RESUME', 'no-state review-backed commands reject resume');
    if (invocation.reset) fail('ERR_NO_STATE_RESET', 'no-state review-backed commands reject reset');
    if (invocation.ledger) fail('ERR_NO_STATE_LEDGER', 'no-state review-backed commands reject ledger=');
    if (invocation.mode !== 'read-only') {
      fail('ERR_NO_STATE_MODE', 'no-state review-backed commands require read-only mode');
    }
    const phase = flags.phase || 'initial-review';
    if (phase === 'full-re-review' || phase === 'fix') {
      fail('ERR_NO_STATE_PHASE', `no-state review-backed commands reject ${phase}`);
    }
    if (phase !== 'initial-review') {
      fail('ERR_NO_STATE_PHASE', 'no-state review-backed commands support only initial-review phase');
    }
    if (subcommand === 'context' && flags.runtimeStdinHandoff !== 'ready') {
      fail('ERR_NO_STATE_STDIN_HANDOFF', 'no-state context requires ready stdin handoff');
    }
  }
}

function validatePreflightTerminalFlags(flags) {
  if (!flags.terminalStatus) fail('ERR_NO_STATE_PREFLIGHT_STATUS', 'no-state preflight requires terminal status');
  if (!flags.blockingReason) fail('ERR_NO_STATE_PREFLIGHT_BLOCKER', 'no-state preflight requires blocking reason');
  if (!flags.statusReason) fail('ERR_NO_STATE_PREFLIGHT_REASON', 'no-state preflight requires status reason');
  if (flags.terminalStatus === 'unsupported') {
    if (flags.blockingReason !== 'none' || flags.statusReason !== 'unsupported-runtime-capability') {
      fail(
        'ERR_NO_STATE_PREFLIGHT_PAIRING',
        'unsupported no-state preflight requires blocking-reason none and status-reason unsupported-runtime-capability'
      );
    }
    return;
  }
  if (flags.terminalStatus === 'blocked') {
    if (
      flags.blockingReason === 'none' ||
      !BLOCKING_REASONS.includes(flags.blockingReason) ||
      flags.statusReason !== 'none'
    ) {
      fail('ERR_NO_STATE_PREFLIGHT_PAIRING', 'blocked no-state preflight requires allowed blocker and status-reason none');
    }
    return;
  }
  fail('ERR_NO_STATE_PREFLIGHT_STATUS', `unsupported no-state preflight terminal status: ${flags.terminalStatus}`);
}

function resolveTargetMetadata(parsed, options) {
  // Route-kind aware: document ⇒ single-file deriveTargetKey; PR/CODE ⇒ file-set
  // identity (never deriveTargetKey on the undefined single-file target).
  return resolveRouteTargetMetadata(parsed, options);
}

// Route-kind label for a degraded fallback base (used only when workflowBase itself
// throws, e.g. an unresolvable target during freshStartFailureAfterArchive). The
// authoritative routeKind is the descriptor's, NOT a binary pr/code collapse — so a
// third file-set kind (r2p) is labeled correctly instead of mislabeled 'code'.
function routeKindForFallbackBase(parsed) {
  try {
    return getRouteDescriptor(parsed.entrySkill).routeKind;
  } catch {
    return (parsed.invocation && parsed.invocation.routeKind) || 'document';
  }
}

function workflowBase(parsed, options = {}) {
  const targetMetadata = resolveTargetMetadata(parsed, options);
  const fileSet = isFileSetRoute(parsed);
  const descriptorPlatform = parsed.assurance === 'strict-verified' && parsed.proofRunId
    ? descriptorPlatformFor(parsed.runtimePlatform)
    : 'none';
  const assuranceProof = descriptorPlatform === 'none'
    ? 'none'
    : `capability-descriptor:${descriptorPlatform}:${parsed.proofRunId}`;
  return {
    ok: true,
    status: 'started',
    entrySkill: parsed.entrySkill,
    // File-set routes carry route-kind identity instead of a single-file target +
    // document type. `documentType` stays 'none' for pr/code so no document-only
    // claim leaks downstream; `routeKind`/`base`/`scopes` carry the file-set facts.
    routeKind: targetMetadata.routeKind,
    documentType: fileSet ? 'none' : parsed.invocation.documentType,
    target: fileSet ? null : parsed.invocation.target,
    base: fileSet ? (targetMetadata.base || null) : null,
    scopes: fileSet ? (targetMetadata.scopes || null) : null,
    targetKey: targetMetadata.targetKey,
    requestedMode: parsed.invocation.requestedMode,
    mode: parsed.invocation.mode,
    guardMode: parsed.invocation.guardMode || 'git',
    modeSource: parsed.invocation.modeSource,
    modeNormalizedFrom: parsed.invocation.modeNormalizedFrom,
    strictness: parsed.invocation.strictness,
    requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
    assurance: parsed.assurance,
    assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
    assuranceNormalizedFrom: null,
    descriptorPlatform,
    assuranceProof,
    runtimePlatform: parsed.runtimePlatform,
    runtimeCheck: parsed.runtimeCheck,
    blockingReason: parsed.blockingReason || 'none',
    statusReason: parsed.statusReason || 'none'
  };
}

function withReadOnlyMode(result) {
  if (result.mode === 'read-only') return result;
  return {
    ...result,
    mode: 'read-only',
    modeNormalizedFrom: result.mode
  };
}

function isRuntimeDowngrade(parsed) {
  return (
    parsed.assurance === 'advisory' &&
    ['unavailable', 'failed'].includes(parsed.runtimeCheck.subagentProbe.status) &&
    parsed.runtimeCheck.downgradeReason !== 'none'
  );
}

function unsupportedFrom(parsed, statusReason, strictProofError = null, options = {}) {
  return withReadOnlyMode({
    ...workflowBase(parsed, options),
    ok: false,
    status: 'unsupported',
    assurance: 'advisory',
    assuranceNormalizedFrom: parsed.assurance,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    statusReason,
    blockingReason: 'none',
    strictProofError,
    nextAction: statusReason === 'strict-proof-validation-failed'
      ? 'rerun with practical or provide current verified descriptor'
      : null
  });
}

function blockedFrom(parsed, blockingReason, options = {}) {
  return {
    ...workflowBase(parsed, options),
    ok: false,
    status: 'blocked',
    blockingReason,
    statusReason: 'none',
    nextAction: null
  };
}

function r2pPreflightBlockedResult(parsed, error) {
  const blockingReason = (error && error.blockingReason) || 'r2p-command-unavailable';
  const rerunInvocation = explicitRouteInvocation('review-fix-r2p', parsed.runtimePlatform);
  const defaultNextAction = blockingReason === 'r2p-json-contract-unavailable'
    ? `upgrade req-2-plan or repair the r2p JSON contract so R2P_JSON=1 emits valid JSON, then rerun ${rerunInvocation}`
    : `install req-2-plan and ensure r2p-status, r2p-reopen, r2p-gap-open, and r2p-continue are available, then rerun ${rerunInvocation}`;
  return {
    subcommand: parsed.subcommand,
    ok: false,
    status: 'blocked',
    errorCode: error && error.code ? error.code : 'ERR_R2P_PREFLIGHT',
    message: error && error.message ? error.message : null,
    blockingReason,
    statusReason: 'none',
    nextAction: (error && error.nextAction) || defaultNextAction
  };
}

async function runR2pInvocationPreflight(parsed, options = {}) {
  try {
    const paths = resolveR2pCommands({
      env: options.env,
      homeDir: options.homeDir
    });
    const probeCwd = resolveR2pProjectRoot(parsed, options);
    const statusProbe = await probeJsonContract(paths, {
      cwd: probeCwd,
      env: options.env,
      homeDir: options.homeDir
    });
    if (parsed.subcommand === 'start' || parsed.subcommand === 'preflight') {
      const targetMetadata = resolveRouteTargetMetadata(parsed, options);
      runStatusFromEntries(statusProbe.entries, targetMetadata.workId, {
        runtimePlatform: parsed.runtimePlatform
      });
    } else {
      runStatusFromEntries(statusProbe.entries, parsed.invocation.workId, {
        runtimePlatform: parsed.runtimePlatform
      });
    }
    return null;
  } catch (error) {
    return r2pPreflightBlockedResult(parsed, error);
  }
}

function r2pWriteForbiddenResult(metadata) {
  return {
    ...stateCommandBase(metadata, { status: 'blocked' }),
    ok: false,
    blockingReason: 'r2p-direct-artifact-write-forbidden',
    statusReason: 'none',
    nextAction: 'run record-r2p-repair-plan or apply-r2p-repair instead of direct artifact writes'
  };
}

function r2pRepairTextPart(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text && text.toLowerCase() !== 'none' ? text : '';
}

function firstR2pRepairText(parts) {
  for (const part of parts) {
    const text = r2pRepairTextPart(part);
    if (text) return text;
  }
  return '';
}

function r2pRepairReason(decision, finding) {
  return firstR2pRepairText([
    decision && decision.reason,
    finding && finding.reason,
    decision && decision.required_action,
    finding && finding.required_action,
    finding && finding.suggested_fix,
    finding && finding.issue
  ]);
}

function r2pRepairRequiredAction(decision, finding) {
  return firstR2pRepairText([
    decision && decision.required_action,
    finding && finding.required_action,
    decision && decision.reason,
    finding && finding.reason,
    finding && finding.suggested_fix,
    finding && finding.issue
  ]);
}

function enrichR2pTriageDecisions(decisions, reviewerReport) {
  const findings = reviewerReport && reviewerReport.normalized && Array.isArray(reviewerReport.normalized.findings)
    ? new Map(reviewerReport.normalized.findings.map((finding) => [finding.id, finding]))
    : new Map();
  return decisions.map((decision) => {
    const finding = findings.get(decision.reviewer_id) || {};
    const ownerStage = decision.owner_stage || finding.owner_stage || finding.ownerStage;
    return {
      ...decision,
      owner_stage: ownerStage || null,
      reason: r2pRepairReason(decision, finding) || null,
      required_action: r2pRepairRequiredAction(decision, finding) || null
    };
  });
}

function isR2pBlockingRepairDecision(decision) {
  return Boolean(
    decision &&
    decision.non_blocking !== true &&
    ['accepted', 'reopened', 'downgraded'].includes(decision.decision) &&
    ['high', 'medium'].includes(decision.severity)
  );
}

function isR2pBlockingRepairIssue(issue) {
  return Boolean(
    issue &&
    ['accepted', 'reopened'].includes(issue.status) &&
    ['high', 'medium'].includes(issue.severity)
  );
}

function acceptedR2pFindingsFromTriageReport(metadata) {
  const latestTriage = readManifestReport(metadata, metadata.manifest.lastTriageReportPath, 'Last triage report path');
  if (!latestTriage || !latestTriage.report || !latestTriage.report.normalized) return [];
  const decisions = Array.isArray(latestTriage.report.normalized.decisions)
    ? latestTriage.report.normalized.decisions
    : [];
  return decisions
    .filter(isR2pBlockingRepairDecision)
    .map((decision) => ({
      issue_id: String(decision.issue_id),
      owner_stage: decision.owner_stage ? String(decision.owner_stage) : null,
      reason: decision.reason ? String(decision.reason) : null,
      required_action: decision.required_action ? String(decision.required_action) : null
    }));
}

function r2pLedgerPath(metadata) {
  return statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
}

function acceptedR2pFindings(metadata) {
  const ledgerPath = r2pLedgerPath(metadata);
  const ledger = readLedgerIfPresent(ledgerPath);
  const openIssueIds = new Set((ledger.issues || [])
    .filter(isR2pBlockingRepairIssue)
    .map((issue) => String(issue.id || issue.issueId || '').trim())
    .filter(Boolean));
  const fromTriageReport = acceptedR2pFindingsFromTriageReport(metadata);
  if (fromTriageReport.length > 0) {
    return fromTriageReport.filter((finding) => openIssueIds.has(String(finding.issue_id || '').trim()));
  }
  return (ledger.issues || [])
    .filter(isR2pBlockingRepairIssue)
    .map((issue, index) => ({
      issue_id: String(issue.id || issue.issueId || `ISSUE-${String(index + 1).padStart(3, '0')}`),
      owner_stage: issue.owner_stage || issue.ownerStage || null,
      reason: issue.reason || null,
      required_action: issue.required_action || issue.requiredAction || null
    }));
}

function markR2pRepairIssuesFixed(metadata, issueIds, commandKind) {
  const ids = new Set((Array.isArray(issueIds) ? issueIds : [])
    .map((issueId) => String(issueId || '').trim())
    .filter(Boolean));
  if (ids.size === 0) return;
  const ledgerPath = r2pLedgerPath(metadata);
  const ledger = readLedgerIfPresent(ledgerPath);
  let changed = false;
  const resolution = commandKind === 'r2p-gap-open'
    ? 'Fixed by r2p-gap-open lifecycle repair; rerun after r2p regeneration'
    : 'Fixed by r2p-reopen lifecycle repair; rerun against the regenerated workId';
  const issues = (ledger.issues || []).map((issue) => {
    if (!issue || !ids.has(String(issue.id)) || !['accepted', 'reopened'].includes(issue.status)) {
      return issue;
    }
    changed = true;
    return {
      ...issue,
      status: 'fixed',
      resolution
    };
  });
  if (changed) {
    atomicWriteFile(ledgerPath, formatLedger({ ...ledger, issues }));
  }
}

function r2pRepairPlanAmbiguous(message) {
  const error = new Error(message);
  error.code = 'ERR_R2P_REPAIR_PLAN_AMBIGUOUS';
  error.blockingReason = 'r2p-repair-plan-ambiguous';
  error.nextAction = 'rerun review and triage with owner_stage on every accepted r2p finding';
  return error;
}

function requireR2pFindingOwnerStages(accepted) {
  for (const finding of accepted) {
    if (!finding || !finding.owner_stage) {
      throw r2pRepairPlanAmbiguous('accepted r2p finding is missing owner_stage');
    }
  }
}

function r2pWorkIdFromMetadata(metadata) {
  return String(metadata.manifest.workId || '');
}

function r2pRoundLimitTokenFromMetadata(metadata) {
  const roundLimit = metadata.manifest.roundLimit === null || metadata.manifest.roundLimit === undefined
    ? 'none'
    : String(metadata.manifest.roundLimit);
  return roundLimit === 'none' ? '' : ` rounds=${roundLimit}`;
}

function currentStageR2pRepairNextAction(metadata) {
  const workId = r2pWorkIdFromMetadata(metadata);
  const rerun = explicitRouteInvocation(
    'review-fix-r2p',
    metadata.manifest.runtimePlatform,
    `workId=${workId}${r2pRoundLimitTokenFromMetadata(metadata)} resume`
  );
  return `run r2p-continue for workId=${workId}, repair the current stage through r2p, then rerun ${rerun}`;
}

function r2pRepairPhaseBlockedResult(metadata) {
  return {
    ...stateCommandBase(metadata, { status: 'blocked' }),
    ok: false,
    blockingReason: 'state-validation-failed',
    statusReason: 'none',
    errorCode: 'ERR_R2P_REPAIR_PHASE_REQUIRED',
    message: 'apply-r2p-repair requires Status: fix and Current phase: fix',
    nextAction: `rerun ${explicitRouteInvocation(
      'review-fix-r2p',
      metadata.manifest.runtimePlatform
    )} until it reaches the r2p repair phase, or reset the stopped state before starting a new repair`
  };
}

function requireR2pRepairPhase(metadata) {
  if (metadata.manifest.status === 'fix' && metadata.manifest.currentPhase === 'fix') return true;
  return (
    metadata.manifest.status === 'blocked' &&
    metadata.manifest.currentPhase === 'fix' &&
    RETRYABLE_R2P_REPAIR_BLOCKERS.has(metadata.manifest.blockingReason)
  );
}

function r2pRecordedPlanDriftResult(metadata) {
  return {
    ...stateCommandBase(metadata, { status: 'blocked' }),
    ok: false,
    blockingReason: 'r2p-drift-detected',
    statusReason: 'none',
    nextAction: 'rerun record-r2p-repair-plan after refreshing the active r2p run'
  };
}

function r2pReviewerGuardBaseline(context) {
  return {
    kind: 'r2p-review-set',
    workId: String(context.workId),
    reviewSetFingerprint: String(context.fileSetFingerprint),
    runMdSha256: String(context.runMdSha256)
  };
}

function compareR2pReviewerGuardBaseline(expected, actual) {
  if (!expected || expected.kind !== 'r2p-review-set') return 'reviewer-mutated-file';
  if (String(expected.workId) !== String(actual.workId)) return 'reviewer-mutated-file';
  if (String(expected.reviewSetFingerprint) !== String(actual.reviewSetFingerprint)) return 'reviewer-mutated-file';
  if (String(expected.runMdSha256) !== String(actual.runMdSha256)) return 'reviewer-mutated-file';
  return null;
}

async function runR2pContextCommand(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  try {
    const targetMetadata = resolveRouteTargetMetadata(parsed, options);
    const liveContext = resolveR2pWorkIdTarget({
      projectRoot: targetMetadata.projectRoot,
      workId: targetMetadata.workId
    });
    const paths = resolveR2pCommands({ env: options.env, homeDir: options.homeDir });
    const liveStatus = await readRunStatus(paths, targetMetadata.workId, {
      cwd: targetMetadata.projectRoot,
      env: options.env,
      homeDir: options.homeDir,
      runtimePlatform: metadata.manifest.runtimePlatform
    });
    const contextPack = {
      routeKind: 'r2p',
      workId: targetMetadata.workId,
      runDir: targetMetadata.runDir,
      runLocation: targetMetadata.runLocation,
      reviewFiles: Array.isArray(targetMetadata.reviewFiles) ? targetMetadata.reviewFiles : [],
      protectedDependencies: ['run.md'],
      editableFiles: [],
      directArtifactWrites: 'forbidden',
      repairMode: mapRepairMode(liveStatus, liveStatus.currentStage, [], {
        runtimePlatform: metadata.manifest.runtimePlatform
      }),
      reviewerGuardBaseline: r2pReviewerGuardBaseline(liveContext)
    };
    const contextManifestPath = writeContextManifest({
      targetStateDir: metadata.targetStateDir,
      phase: parsed.phase || 'initial-review',
      contextPack
    });
    return persistentBase(parsed, metadata, {
      ok: true,
      status: 'context',
      contextManifestPath,
      contextPackSkeleton: contextPack,
      runtimeCheck: {
        ...parsed.runtimeCheck,
        fingerprintGuard: { status: 'passed' }
      }
    });
  } catch (error) {
    if (error && error.blockingReason) {
      const blockingReason = error.blockingReason;
      updatePersistentManifest(metadata, {
        status: 'blocked',
        blockingReason,
        statusReason: 'none',
        runtimeFingerprintGuard: 'not-run'
      });
      return {
        ...stateCommandBase(metadata, { status: 'blocked', blockingReason, statusReason: 'none' }),
        ok: false,
        blockingReason,
        statusReason: 'none',
        errorCode: error.code || 'ERR_R2P_CONTEXT_BLOCKED',
        message: error.message,
        nextAction: error.nextAction || 'repair the active r2p run state and rerun context'
      };
    }
    throw error;
  }
}

function runR2pRecordReviewCommand(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  let liveContext = null;
  try {
    const contextManifestPath = contextManifestPathFor(
      metadata.targetStateDir,
      parsed.phase || metadata.manifest.currentPhase || 'initial-review'
    );
    let contextPack = null;
    try {
      contextPack = readContextManifest(contextManifestPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      updatePersistentManifest(metadata, {
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        runtimeFingerprintGuard: 'not-run'
      });
      return {
        ...persistentBase(parsed, metadata, {
          ok: false,
          status: 'blocked',
          blockingReason: 'state-validation-failed',
          statusReason: 'none',
          errorCode: 'ERR_R2P_CONTEXT_REQUIRED',
          message: 'r2p record-review requires a matching context manifest before reviewer output is recorded',
          nextAction: 'run workflow context to establish the r2p reviewer guard baseline before record-review'
        })
      };
    }
    liveContext = resolveR2pWorkIdTarget({
      projectRoot: metadata.projectRoot,
      workId: metadata.manifest.workId
    });
    const mutation = compareR2pReviewerGuardBaseline(
      contextPack.reviewerGuardBaseline,
      r2pReviewerGuardBaseline(liveContext)
    );
    if (mutation) {
      updatePersistentManifest(metadata, {
        status: 'blocked',
        blockingReason: mutation,
        statusReason: 'none',
        runtimeFingerprintGuard: 'passed'
      });
      return {
        ...persistentBase(parsed, metadata, {
          ok: false,
          status: 'blocked',
          blockingReason: mutation,
          statusReason: 'none',
          nextAction: 'rerun workflow context to refresh reviewer inputs before recording review'
        })
      };
    }
  } catch (error) {
    const isR2pResolveError = error && typeof error.code === 'string' && error.code.startsWith('ERR_R2P_');
    if (isR2pResolveError) {
      const blockingReason = error.blockingReason || 'state-validation-failed';
      updatePersistentManifest(metadata, {
        status: 'blocked',
        blockingReason,
        statusReason: 'none',
        runtimeFingerprintGuard: 'not-run'
      });
      return {
        ...stateCommandBase(metadata, {
          ok: false,
          status: 'blocked',
          blockingReason,
          statusReason: 'none',
          errorCode: error.code,
          message: error.message,
          nextAction: error.nextAction || 'restore the active r2p run before recording review'
        })
      };
    }
    throw error;
  }
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'result',
    stdinFlag: 'resultStdin',
    label: 'review result',
    options
  });
  const reviewerResult = parseReviewerResult(payload);
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `reviewer-round-${padRound(round)}`);
  writeReviewerReport({
    reportPath,
    phase: parsed.phase || 'initial-review',
    round,
    producer: producerForAssurance(metadata.manifest.assurance),
    reviewerResult
  });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  const passStatus = metadata.manifest.mode === 'read-only' ? 'read-only-clean' : 'full-re-review';
  updatePersistentManifest(metadata, {
    status: reviewerResult.result === 'FAIL' ? 'triage' : passStatus,
    currentPhase: reviewerResult.result === 'FAIL'
      ? 'triage'
      : (passStatus === 'read-only-clean' ? 'final' : 'full-re-review'),
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastReviewerReportPath: relativeReportPath,
    reviewSetFingerprint: liveContext.fileSetFingerprint,
    runMdSha256: liveContext.runMdSha256
  });
  return persistentBase(parsed, metadata, {
    ok: true,
    status: 'recorded-review',
    reviewerReportPath: reportPath,
    normalized: reviewerResult
  });
}

function runR2pRecordTriageCommand(parsed, options) {
  const metadata = resolveFileSetPersistentMetadata(parsed, options);
  const round = Number(metadata.manifest.currentRound || 1);
  const ledgerPath = statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
  const reviewerReportPath = targetStatePathFromManifest(
    metadata.targetStateDir,
    metadata.manifest.lastReviewerReportPath,
    path.posix.join('reports', `reviewer-round-${padRound(round)}.md`),
    { allowedDirectories: ['reports'], label: 'Last reviewer report path' }
  );
  const reviewerReport = readReviewerReport(reviewerReportPath);
  const payload = readWorkflowPayload({
    parsed,
    metadata,
    valueFlag: 'triage',
    stdinFlag: 'triageStdin',
    label: 'triage result',
    options
  });
  const triage = parseTriageResult(payload);
  const decisions = enrichR2pTriageDecisions(enrichTriageDecisions(triage, reviewerReport), reviewerReport);
  const ledger = applyTriageDecisions(readLedgerIfPresent(ledgerPath), decisions);
  const reportPath = nextReportPath(metadata.targetStateDir, `triage-round-${padRound(round)}`);
  writeTriageReport({
    reportPath,
    phase: parsed.phase || 'initial-review',
    round,
    triage: { decisions, warnings: triage.warnings },
    ledger
  });
  const outcome = triageOutcome({
    decisions,
    mode: metadata.manifest.mode,
    strictness: metadata.manifest.strictness,
    roundLimit: metadata.manifest.roundLimit || 'none',
    roundsCompleted: Number(metadata.manifest.fixAttemptCount || 0)
  });
  atomicWriteFile(ledgerPath, formatLedger(ledger));
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);
  updatePersistentManifest(metadata, {
    status: outcome.status,
    currentPhase: outcome.currentPhase,
    blockingReason: 'none',
    statusReason: outcome.statusReason,
    currentReportPath: relativeReportPath,
    lastTriageReportPath: relativeReportPath
  });
  return persistentBase(parsed, metadata, {
    ok: true,
    status: 'recorded-triage',
    triageReportPath: reportPath,
    normalized: { decisions, warnings: triage.warnings }
  });
}

async function runRecordR2pRepairPlanCommand(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  if (metadata.routeKind !== 'r2p') {
    fail('ERR_WORKFLOW_COMMAND', 'record-r2p-repair-plan requires an r2p target-state directory');
  }
  try {
    const paths = resolveR2pCommands({ env: options.env, homeDir: options.homeDir });
    const workId = r2pWorkIdFromMetadata(metadata);
    const liveStatus = await readRunStatus(paths, workId, {
      cwd: metadata.projectRoot,
      env: options.env,
      homeDir: options.homeDir,
      runtimePlatform: metadata.manifest.runtimePlatform
    });
    const accepted = acceptedR2pFindings(metadata);
    requireR2pFindingOwnerStages(accepted);
    const repairMode = mapRepairMode(liveStatus, liveStatus.currentStage, accepted, {
      runtimePlatform: metadata.manifest.runtimePlatform
    });
    if (repairMode.kind === 'checkpoint') {
      updatePersistentManifest(metadata, {
        status: 'checkpoint',
        currentPhase: 'final',
        blockingReason: 'none',
        statusReason: repairMode.statusReason
      });
      return {
        ...stateCommandBase(metadata, { status: 'checkpoint', currentPhase: 'final', statusReason: repairMode.statusReason }),
        nextAction: currentStageR2pRepairNextAction(metadata)
      };
    }
    if (repairMode.kind === 'blocked') {
      return {
        ...stateCommandBase(metadata, { status: 'blocked' }),
        ok: false,
        blockingReason: repairMode.blockingReason,
        statusReason: 'none',
        nextAction: repairMode.nextAction ||
          `run r2p-continue or r2p-status to reach a repairable state, then rerun ${explicitRouteInvocation(
            'review-fix-r2p',
            metadata.manifest.runtimePlatform
          )}`
      };
    }
    const repairPlan = buildRepairPlan(accepted, repairMode, liveStatus.currentStage, {
      workId
    });
    let receipt;
    try {
      const round = Number(metadata.manifest.currentRound || 1);
      receipt = writeReceipt({
        projectRoot: metadata.projectRoot,
        targetKey: metadata.targetKey,
        round,
        kind: 'r2p-repair-plan',
        status: 'checkpoint',
        statusReason: 'none',
        command: repairPlan.command_kind,
        argv: [],
        exitCode: 0,
        stdout: JSON.stringify(repairPlan),
        stderr: '',
        workId,
        issueIds: repairPlan.issue_ids,
        nextAction: 'run apply-r2p-repair'
      });
      writeRecordedRepairPlan({
        projectRoot: metadata.projectRoot,
        targetKey: metadata.targetKey,
        round,
        plan: repairPlan,
        receiptId: receipt.receiptId || null,
        receiptPath: receipt.receiptPath
      });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
    return {
      ...stateCommandBase(metadata, { status: 'recorded-r2p-repair-plan' }),
      status: 'recorded-r2p-repair-plan',
      repairPlan,
      receiptPath: receipt.receiptPath
    };
  } catch (error) {
    if (error && error.blockingReason) {
      return {
        ...stateCommandBase(metadata, { status: 'blocked' }),
        ok: false,
        blockingReason: error.blockingReason,
        statusReason: 'none',
        nextAction: error.nextAction || 'repair the r2p state and rerun record-r2p-repair-plan'
      };
    }
    throw error;
  }
}

async function runApplyR2pRepairCommand(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }
  if (metadata.routeKind !== 'r2p') {
    fail('ERR_WORKFLOW_COMMAND', 'apply-r2p-repair requires an r2p target-state directory');
  }
  if (!requireR2pRepairPhase(metadata)) {
    return r2pRepairPhaseBlockedResult(metadata);
  }
  try {
    const paths = resolveR2pCommands({ env: options.env, homeDir: options.homeDir });
    const workId = r2pWorkIdFromMetadata(metadata);
    const currentRound = Number(metadata.manifest.currentRound || 1);
    let recorded;
    try {
      recorded = readRecordedRepairPlan({
        projectRoot: metadata.projectRoot,
        targetKey: metadata.targetKey,
        round: currentRound
      });
    } catch (error) {
      if (error && error.blockingReason) throw error;
      return receiptFailureResult(metadata, error);
    }
    const repairPlan = recorded.plan;
    const liveStatus = await readRunStatus(paths, workId, {
      cwd: metadata.projectRoot,
      env: options.env,
      homeDir: options.homeDir,
      runtimePlatform: metadata.manifest.runtimePlatform
    });
    let liveRepairPlan;
    try {
      const accepted = acceptedR2pFindings(metadata);
      requireR2pFindingOwnerStages(accepted);
      const repairMode = mapRepairMode(liveStatus, liveStatus.currentStage, accepted, {
        runtimePlatform: metadata.manifest.runtimePlatform
      });
      if (repairMode.kind !== 'command') return r2pRecordedPlanDriftResult(metadata);
      liveRepairPlan = buildRepairPlan(accepted, repairMode, liveStatus.currentStage, {
        workId
      });
    } catch (error) {
      if (error && error.blockingReason) return r2pRecordedPlanDriftResult(metadata);
      throw error;
    }
    if (!sameRepairPlan(repairPlan, liveRepairPlan)) {
      return r2pRecordedPlanDriftResult(metadata);
    }
    const guard = await driftGuard({
      cwd: metadata.projectRoot,
      env: options.env,
      homeDir: options.homeDir,
      workId,
      runDir: path.join(metadata.projectRoot, '.req-to-plan', workId),
      archiveRunDir: path.join(metadata.projectRoot, '.req-to-plan', 'archive', workId),
      reviewArtifacts: [
        '03-requirement-brief.md',
        '04-risk-discovery.md',
        '05-design.md',
        '06-spec.md',
        '07-plan.md'
      ],
      runMdSha256: metadata.manifest.runMdSha256,
      fileSetFingerprint: metadata.manifest.reviewSetFingerprint,
      command_kind: repairPlan.command_kind,
      runtimePlatform: metadata.manifest.runtimePlatform
    });
    if (!guard.ok) {
      return {
        ...stateCommandBase(metadata, { status: 'blocked' }),
        ok: false,
        blockingReason: guard.blockingReason,
        statusReason: 'none',
        nextAction: 'rerun context, review, and triage after refreshing the active r2p run'
      };
    }
    let reservedReceipt;
    try {
      reservedReceipt = reserveReceipt({
        projectRoot: metadata.projectRoot,
        targetKey: metadata.targetKey,
        round: currentRound,
        kind: 'r2p-repair',
        command: repairPlan.command_kind,
        argv: [],
        workId,
        issueIds: repairPlan.issue_ids,
        runtimePlatform: metadata.manifest.runtimePlatform
      });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
    let applied;
    try {
      applied = await runRepairCommand(guard.paths, repairPlan, {
        cwd: metadata.projectRoot,
        env: options.env,
        homeDir: options.homeDir,
        roundLimit: metadata.manifest.roundLimit || 'none',
        runtimePlatform: metadata.manifest.runtimePlatform
      });
    } catch (error) {
      let receipt;
      try {
        receipt = writeReceipt({
          projectRoot: metadata.projectRoot,
          targetKey: metadata.targetKey,
          round: currentRound,
          kind: 'r2p-repair',
          status: 'blocked',
          blockingReason: error && error.blockingReason ? error.blockingReason : 'r2p-command-failed',
          statusReason: 'none',
          command: repairPlan.command_kind,
          argv: error && Array.isArray(error.argv) ? error.argv : [],
          exitCode: error && error.exitCode !== undefined ? error.exitCode : null,
          stdout: error && error.stdout ? error.stdout : '',
          stderr: error && error.stderr ? error.stderr : '',
          workId,
          issueIds: repairPlan.issue_ids,
          runtimePlatform: metadata.manifest.runtimePlatform,
          verification: 'argv-array execFile shell:false R2P_JSON=1 failed',
          nextAction: error && error.nextAction
            ? error.nextAction
            : 'repair the r2p command failure and rerun apply-r2p-repair',
          reservedReceiptPath: reservedReceipt.receiptPath
        });
      } catch (receiptError) {
        return receiptFailureResult(metadata, receiptError);
      }
      updatePersistentManifest(metadata, {
        status: 'blocked',
        blockingReason: error && error.blockingReason ? error.blockingReason : 'r2p-command-failed',
        statusReason: 'none'
      });
      return {
        ...stateCommandBase(metadata, { status: 'blocked' }),
        ok: false,
        blockingReason: error && error.blockingReason ? error.blockingReason : 'r2p-command-failed',
        statusReason: 'none',
        receiptPath: receipt.receiptPath,
        errorCode: error && error.code ? error.code : 'ERR_R2P_COMMAND_FAILED',
        message: error && error.message ? error.message : String(error),
        nextAction: error && error.nextAction
          ? error.nextAction
          : 'repair the r2p command failure and rerun apply-r2p-repair'
      };
    }
    let receipt;
    try {
      receipt = writeReceipt({
        ...applied,
        projectRoot: metadata.projectRoot,
        targetKey: metadata.targetKey,
        round: currentRound,
        kind: 'r2p-repair',
        workId,
        runtimePlatform: metadata.manifest.runtimePlatform,
        reservedReceiptPath: reservedReceipt.receiptPath
      });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
    markR2pRepairIssuesFixed(metadata, applied.issueIds, repairPlan.command_kind);
    const fixAttemptCount = Number(metadata.manifest.fixAttemptCount || 0) + 1;
    updatePersistentManifest(metadata, {
      status: 'checkpoint',
      currentPhase: 'final',
      blockingReason: 'none',
      statusReason: applied.statusReason || 'r2p-repair-applied',
      fixAttemptCount
    });
    return {
      ...stateCommandBase(metadata, { status: 'checkpoint', currentPhase: 'final', statusReason: applied.statusReason }),
      statusReason: applied.statusReason,
      receiptPath: receipt.receiptPath,
      receiptId: receipt.receiptId || null,
      newWorkId: applied.newWorkId || null,
      routeId: applied.routeId || null,
      nextAction: applied.nextAction
    };
  } catch (error) {
    if (error && error.blockingReason) {
      return {
        ...stateCommandBase(metadata, { status: 'blocked' }),
        ok: false,
        blockingReason: error.blockingReason,
        statusReason: 'none',
        nextAction: error.nextAction || 'repair the r2p state and rerun apply-r2p-repair'
      };
    }
    throw error;
  }
}

// Residual catch-all for an invocation-based PR/CODE command/mode combination that has no
// wired persistent path (e.g. a read-only persistent start, which belongs on the no-state
// advisory path). It refuses cleanly: read-only, no PASS, no crash on the undefined
// single-file target. The wired persistent loop is review-and-fix start -> context ->
// record-review -> record-triage -> (state-dir) fix/diff/finalize; read-only uses no-state.
function fileSetLifecycleUnsupported(parsed, options) {
  return withReadOnlyMode({
    ...workflowBase(parsed, options),
    ok: false,
    status: 'unsupported',
    assurance: 'advisory',
    assuranceNormalizedFrom: parsed.assurance,
    descriptorPlatform: 'none',
    assuranceProof: 'none',
    blockingReason: 'none',
    statusReason: 'unsupported-runtime-capability',
    nextAction: 'use review-and-fix for the file-set persistent loop, or read-only for no-state advisory review'
  });
}

function freshStartFailureAfterArchive(parsed, options, error, archivedStatePath) {
  let base = {};
  try {
    base = workflowBase(parsed, options);
  } catch {
    base = {
      entrySkill: parsed.entrySkill,
      // Route-kind-aware label (not a binary pr/code collapse): derive from the descriptor
      // so r2p is labeled 'r2p', never mislabeled 'code'. Fall back to the parsed
      // invocation routeKind, then 'document', if the descriptor lookup fails.
      routeKind: routeKindForFallbackBase(parsed),
      documentType: isFileSetRoute(parsed) ? 'none' : parsed.invocation.documentType,
      target: isFileSetRoute(parsed) ? null : parsed.invocation.target,
      requestedMode: parsed.invocation.requestedMode,
      mode: parsed.invocation.mode,
      guardMode: parsed.invocation.guardMode || 'git',
      strictness: parsed.invocation.strictness,
      requestedAssurance: parsed.invocation.requestedAssurance || parsed.assurance,
      assurance: parsed.assurance,
      assuranceSource: parsed.payloadFlags.assurance ? 'explicit' : (parsed.invocation.assuranceSource || 'default'),
      runtimePlatform: parsed.runtimePlatform,
      runtimeCheck: parsed.runtimeCheck
    };
  }

  const unsupported = error && error.status === 'unsupported';
  return {
    ...base,
    ok: false,
    status: unsupported ? 'unsupported' : 'blocked',
    targetStateDir: null,
    manifestPath: null,
    ledgerPath: null,
    round: null,
    currentPhase: 'review',
    blockingReason: unsupported ? 'none' : 'state-validation-failed',
    statusReason: unsupported ? (error.statusReason || 'unsupported-runtime-capability') : 'none',
    errorCode: error && error.code ? error.code : 'ERR_WORKFLOW',
    message: error && error.message ? error.message : String(error),
    archivedStatePath: archivedStatePath || null,
    nextAction: 'repair fresh-start inputs, then start a fresh workflow without resume'
  };
}

function validateStrictProof(parsed, options) {
  const expectedPlatform = descriptorPlatformFor(parsed.runtimePlatform);
  const descriptorPath = parsed.capabilityDescriptor;
  const proofRunId = parsed.proofRunId;
  const descriptorDirectory = options.descriptorDirectory || parsed.descriptorDirectory;

  if (!descriptorDirectory) return { ok: false, reason: 'descriptorDirectory binding is required' };
  if (!path.isAbsolute(descriptorPath)) return { ok: false, reason: 'descriptor path must be absolute' };
  if (!path.isAbsolute(descriptorDirectory)) return { ok: false, reason: 'descriptorDirectory must be absolute' };
  if (path.basename(descriptorPath) !== `${expectedPlatform}.json`) {
    return { ok: false, reason: `descriptor basename must be ${expectedPlatform}.json` };
  }
  try {
    const descriptorReal = fs.realpathSync.native(descriptorPath);
    const directoryReal = fs.realpathSync.native(descriptorDirectory);
    const relative = path.relative(directoryReal, descriptorReal);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, reason: 'descriptor must be inside descriptorDirectory' };
    }
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  let descriptor;
  try {
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  const validation = validateCurrentDescriptor(descriptor, {
    packageVersion: options.packageVersion || readPackageVersion(),
    platform: expectedPlatform,
    runId: proofRunId,
    requireVerified: true
  });
  if (
    validation.valid !== true ||
    validation.trusted !== true ||
    validation.passCapable !== true ||
    validation.errors.length !== 0
  ) {
    return { ok: false, reason: validation.errors.join('; ') || validation.advisoryReason, validation };
  }

  return { ok: true, validation };
}

// PLAN-TASK-009 (Phase C2): peek at a target-state manifest's kind so the state-dir-based
// commands (begin-fix..finalize, record-diff-review) route file-set state to the file-set
// lifecycle and document state to the single-file lifecycle. A missing/unreadable manifest
// returns 'document' so the existing single-file path produces its normal state-validation
// failure rather than a new error surface.
function targetStateManifestKind(targetStateDir) {
  if (!targetStateDir) return 'document';
  try {
    const manifest = readManifestAny(path.join(targetStateDir, 'MANIFEST.md'));
    return manifest.targetContextKind || 'document';
  } catch {
    return 'document';
  }
}

async function runWorkflowCommand(subcommand, args, options = {}) {
  let parsed;
  try {
    parsed = parseWorkflowArgs(subcommand, args);
  } catch (error) {
    if (error && error.blockingReason === 'invalid-r2p-invocation') {
      return {
        subcommand,
        ok: false,
        status: 'blocked',
        blockingReason: error.blockingReason,
        statusReason: 'none',
        nextAction: error.nextAction ||
          `rerun explicitly as ${explicitRouteInvocation('review-fix-r2p', 'manual', 'workId=<WF-...>')}`
      };
    }
    throw error;
  }

  // PLAN-TASK-007: aggregate-review is a target-state-dir command (parsed via the
  // TARGET_STATE_DIR_SUBCOMMANDS branch; --no-state already rejected there). It
  // reads project-review/ summaries+findings and runs the pure Task 1 aggregate.
  if (parsed.subcommand === 'aggregate-review') {
    return runAggregateReview(parsed, options);
  }

  if (
    parsed.invocation &&
    parsed.invocation.routeKind === 'r2p' &&
    R2P_INVOCATION_PREFLIGHT_SUBCOMMANDS.has(parsed.subcommand)
  ) {
    const preflight = await runR2pInvocationPreflight(parsed, options);
    if (preflight) return preflight;
  }

  if (parsed.subcommand === 'record-r2p-repair-plan') {
    return runRecordR2pRepairPlanCommand(parsed, options);
  }
  if (parsed.subcommand === 'apply-r2p-repair') {
    return runApplyR2pRepairCommand(parsed, options);
  }

  if (TARGET_STATE_SUBCOMMANDS.has(parsed.subcommand)) {
    if (targetStateManifestKind(parsed.targetStateDir) !== 'document') {
      return runFileSetFixLifecycleCommand(parsed, options);
    }
    return runFixLifecycleCommand(parsed, options);
  }
  if (parsed.subcommand === 'record-diff-review') {
    if (targetStateManifestKind(parsed.targetStateDir) === 'r2p') {
      try {
        return r2pWriteForbiddenResult(resolveFileSetStateMetadata(parsed.targetStateDir));
      } catch (error) {
        return stateValidationResult(parsed.targetStateDir, error);
      }
    }
    if (targetStateManifestKind(parsed.targetStateDir) !== 'document') {
      return runFileSetRecordDiffReview(parsed, options);
    }
    return runRecordDiffReview(parsed, options);
  }
  if (parsed.subcommand === 'finalize' && !parsed.noState && parsed.targetStateDir) {
    if (targetStateManifestKind(parsed.targetStateDir) !== 'document') {
      return runFileSetFinalize(parsed, options);
    }
    return runPersistentFinalize(parsed, options);
  }

  if (parsed.subcommand === 'preflight' && !parsed.noState) {
    return runWriteEligibilityPreflight(parsed, options);
  }

  if (parsed.noState) {
    return runNoStateWorkflowCommand(parsed, options);
  }

  if (parsed.runtimeCheck.stdinHandoff.status === 'unavailable') {
    return blockedFrom(parsed, 'unsafe-handoff-file', options);
  }

  if (parsed.assurance === 'strict-verified' && parsed.runtimePlatform === 'gemini') {
    return unsupportedFrom(parsed, 'unsupported-runtime-capability', null, options);
  }

  if (parsed.assurance === 'strict-verified') {
    const proof = validateStrictProof(parsed, options);
    if (!proof.ok) {
      return unsupportedFrom(parsed, 'strict-proof-validation-failed', {
        reason: proof.reason,
        validation: proof.validation || null
      }, options);
    }
  }

  if (parsed.assurance === 'advisory' && parsed.invocation.mode === 'review-and-fix') {
    if (isRuntimeDowngrade(parsed)) return withReadOnlyMode(workflowBase(parsed, options));
    return unsupportedFrom(parsed, 'advisory-review-and-fix-unsupported', null, options);
  }

  // PLAN-TASK-009 (Phase C): the PR/CODE persistent review/triage lifecycle that consumes
  // the live file-set MANIFEST created by start. The invocation-based commands resolve the
  // file-set identity (route-kind base/scope) + the schema-2 file-set manifest, and build a
  // reviewer context-pack over the file SET. PR/CODE resume requires the explicit `resume`
  // token (no silent reuse) and refuses a stale identity (strict compare incl roundLimit;
  // CODE tolerates resolver default-exclusion drift only when the file set is unchanged).
  if (isFileSetRoute(parsed)) {
    if (parsed.subcommand === 'start' && parsed.invocation.resume) {
      const resumed = await runFileSetResume(parsed, options);
      if (resumed && resumed.freshStartRequested) {
        // Resume already archived the leftover state, so a throw here must still surface
        // archivedStatePath (the old state was moved). File-set start has no deterministic
        // post-archive throw — it returns structured errors, and its uncaught throwers are
        // shared with the resume that must succeed first — so this branch mirrors the
        // document path below; freshStartFailureAfterArchive is exercised by the document
        // throw-path test (a missing ref= makes document start throw).
        let started;
        try {
          started = await runPersistentStart(parsed, options);
        } catch (error) {
          return freshStartFailureAfterArchive(parsed, options, error, resumed.archivedStatePath);
        }
        return started && resumed.archivedStatePath
          ? { ...started, archivedStatePath: resumed.archivedStatePath }
          : started;
      }
      return resumed;
    }
    if (parsed.subcommand === 'start' && parsed.invocation.mode === 'review-and-fix') {
      return runPersistentStart(parsed, options);
    }
    if (parsed.invocation.routeKind === 'r2p') {
      if (parsed.subcommand === 'context') return runR2pContextCommand(parsed, options);
      if (parsed.subcommand === 'record-review') return runR2pRecordReviewCommand(parsed, options);
      if (parsed.subcommand === 'record-triage') return runR2pRecordTriageCommand(parsed, options);
    }
    // PLAN-TASK-007: partitioned project-review interception. A context/record-review
    // carrying --phase unit-review|crosscutting routes to the partitioned lifecycle;
    // any other phase (including the absent/initial-review default) dispatches EXACTLY
    // as before (byte-identical non-partitioned behavior).
    if (isPartitionedPhase(parsed.phase)) {
      if (parsed.subcommand === 'context') return runPartitionedContext(parsed, options);
      if (parsed.subcommand === 'record-review') return runPartitionedRecordReview(parsed, options);
    }
    if (parsed.subcommand === 'context') return runFileSetContext(parsed, options);
    if (parsed.subcommand === 'record-review') return runFileSetRecordReview(parsed, options);
    if (parsed.subcommand === 'record-triage') return runFileSetRecordTriage(parsed, options);
    // Any remaining file-set persistent command without a wired lifecycle path refuses
    // cleanly (never crashes on the undefined single-file target, never claims PASS).
    return fileSetLifecycleUnsupported(parsed, options);
  }
  if (parsed.subcommand === 'start' && parsed.invocation.resume) {
    const resumed = runPersistentResume(parsed, options);
    if (resumed && resumed.freshStartRequested) {
      // Document start CAN throw post-archive (e.g. a missing ref= validated only at
      // start), so this is the integration-tested throw path for the shared helper.
      let started;
      try {
        started = runPersistentStart(parsed, options);
      } catch (error) {
        return freshStartFailureAfterArchive(parsed, options, error, resumed.archivedStatePath);
      }
      return started && resumed.archivedStatePath
        ? { ...started, archivedStatePath: resumed.archivedStatePath }
        : started;
    }
    return resumed;
  }
  if (parsed.subcommand === 'start' && parsed.invocation.mode === 'review-and-fix') {
    return runPersistentStart(parsed, options);
  }
  if (parsed.subcommand === 'context') return runPersistentContext(parsed, options);
  if (parsed.subcommand === 'record-review') return runPersistentRecordReview(parsed, options);
  if (parsed.subcommand === 'record-triage') return runPersistentRecordTriage(parsed, options);

  if (parsed.subcommand === 'finalize' && !parsed.noState && !parsed.targetStateDir) {
    fail('ERR_WORKFLOW_COMMAND', 'finalize requires a target-state directory (or --no-state)');
  }

  return workflowBase(parsed, options);
}

let compactAllowlistValidated = false;

function fullWorkflowJson(result) {
  const base = workflowJson(result);
  const extra = {};
  for (const key of FULL_WORKFLOW_EXTRA_FIELDS) {
    if (Object.hasOwn(result || {}, key)) extra[key] = result[key];
  }
  return { ...base, ...extra };
}

function failCompactJson(message) {
  fail('ERR_WORKFLOW_JSON_COMPACT', message);
}

function validateCompactAllowlist() {
  if (compactAllowlistValidated) return;
  for (const row of COMPACT_ALLOWLIST_MATRIX) {
    if (!row || !row.scope || !row.command || !Array.isArray(row.fields) || row.fields.length === 0) {
      failCompactJson('Invalid compact workflow JSON allowlist row');
    }
    for (const field of row.fields) {
      const purpose = FULL_OUTPUT_FIELD_PURPOSES.get(field);
      if (!purpose) {
        failCompactJson(`Compact workflow JSON allowlist references unclassified field: ${field}`);
      }
      if (purpose === 'debug only') {
        failCompactJson(`Compact workflow JSON allowlist leaks debug-only field: ${field}`);
      }
    }
  }
  compactAllowlistValidated = true;
}

function validateFullWorkflowField(field, value) {
  const purpose = FULL_OUTPUT_FIELD_PURPOSES.get(field);
  if (!purpose) failCompactJson(`Unclassified full workflow JSON field: ${field}`);
  if (purpose === 'path readable' && value !== null && value !== undefined && typeof value !== 'string') {
    failCompactJson(`Compact workflow JSON path field must be a scalar path: ${field}`);
  }
}

function hasCompactValue(full, field) {
  return Object.hasOwn(full, field) && full[field] !== null && full[field] !== undefined;
}

function isNoStateCompactOutput(full, subcommand) {
  if (!NO_STATE_SUBCOMMANDS.has(subcommand)) return false;
  if (hasCompactValue(full, 'reviewGuard') || hasCompactValue(full, 'stateToken')) return true;
  if (subcommand === 'finalize' && !hasCompactValue(full, 'targetStateDir')) return true;
  if (subcommand !== 'preflight' && !hasCompactValue(full, 'targetStateDir')) return true;
  return false;
}

function partitionedCompactRowKey(full, subcommand) {
  if (full.reviewMode !== 'partitioned') return null;
  if (subcommand === 'aggregate-review') return 'partitioned:aggregate';
  if (subcommand === 'start') return 'partitioned:plan';
  if (subcommand === 'context') return 'partitioned:context';
  if (subcommand === 'record-review') {
    return hasCompactValue(full, 'backstop') ? 'partitioned:crosscutting' : 'partitioned:unit-review';
  }
  return null;
}

function noStatePartitionedCompactRowKey(full, subcommand) {
  if (subcommand !== 'context') return null;
  if (full.reviewMode !== 'partitioned') return null;
  if (!isNoStateCompactOutput(full, subcommand)) return null;
  return 'no-state:partitioned-context';
}

function compactRowKey(full, subcommand) {
  if (!subcommand || !WORKFLOW_SUBCOMMANDS.has(subcommand)) return null;
  const noStatePartitionedKey = noStatePartitionedCompactRowKey(full, subcommand);
  if (noStatePartitionedKey) return noStatePartitionedKey;
  const partitionedKey = partitionedCompactRowKey(full, subcommand);
  if (partitionedKey) return partitionedKey;
  if (isNoStateCompactOutput(full, subcommand)) return `no-state:${subcommand}`;
  if (TARGET_STATE_SUBCOMMANDS.has(subcommand)) return `fix-lifecycle:${subcommand}`;
  if (subcommand === 'record-diff-review' || subcommand === 'finalize') {
    return `fix-lifecycle:${subcommand}`;
  }
  if (subcommand === 'record-r2p-repair-plan' || subcommand === 'apply-r2p-repair') {
    return `r2p-repair:${subcommand}`;
  }
  if (subcommand === 'aggregate-review') {
    return 'file-set:aggregate-review';
  }
  if (subcommand === 'start') {
    return full.documentType === 'none' ? 'file-set:start-or-resume' : 'state:start';
  }
  if (subcommand === 'context') {
    return full.documentType === 'none' ? 'file-set:context' : 'state:context';
  }
  if (subcommand === 'record-review') {
    return full.documentType === 'none' ? 'file-set:record-review' : 'state:record-review';
  }
  if (subcommand === 'record-triage') {
    return full.documentType === 'none' ? 'file-set:record-triage' : 'state:record-triage';
  }
  if (subcommand === 'preflight') return 'state:preflight';
  failCompactJson(`Missing compact workflow JSON allowlist route for subcommand: ${subcommand}`);
}

function pathInsideDirectory(filePath, directoryPath) {
  const relative = path.relative(directoryPath, filePath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function readableFilePath(filePath, stateDir = null) {
  try {
    if (!fs.lstatSync(filePath).isFile()) return null;
    if (stateDir) {
      const realFilePath = fs.realpathSync.native(filePath);
      const realStateDir = fs.realpathSync.native(stateDir);
      if (!pathInsideDirectory(realFilePath, realStateDir)) return null;
    }
    return filePath;
  } catch {
    return null;
  }
}

function parseReceiptName(name) {
  const match = /^(\d+)-(.+)\.md$/.exec(name);
  if (!match) return null;
  const attemptMatch = /^(.+)-attempt-(\d+)$/.exec(match[2]);
  return {
    round: Number.parseInt(match[1], 10),
    kind: attemptMatch ? attemptMatch[1] : match[2],
    attempt: attemptMatch ? Number.parseInt(attemptMatch[2], 10) : 0
  };
}

function receiptKindFromName(name) {
  const parsed = parseReceiptName(name);
  return parsed ? parsed.kind : null;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareReceiptNames(left, right) {
  const leftReceipt = parseReceiptName(left);
  const rightReceipt = parseReceiptName(right);
  if (leftReceipt && rightReceipt) {
    return (leftReceipt.round - rightReceipt.round) ||
      compareText(leftReceipt.kind, rightReceipt.kind) ||
      (leftReceipt.attempt - rightReceipt.attempt) ||
      compareText(left, right);
  }
  if (leftReceipt) return 1;
  if (rightReceipt) return -1;
  return compareText(left, right);
}

function isGateDriftFinalizeResult(full) {
  return full && full.status === 'blocked' &&
    full.blockingReason === 'unexpected-worktree-change' &&
    full.nextAction === 'restore the run.md gate to its reviewed state before retrying finalize';
}

function finalReceiptKindsFor(full) {
  const kinds = [];
  const finalStatus = full && full.finalResponse && typeof full.finalResponse.finalStatus === 'string'
    ? full.finalResponse.finalStatus
    : null;
  if (finalStatus && finalStatus !== 'pass') kinds.push(`final-${finalStatus}`);
  if (!finalStatus && full && typeof full.status === 'string' && full.status !== 'pass') {
    kinds.push(`final-${full.status}`);
  }
  if (full && full.blockingReason === 'final-validation-failed') kinds.push('final-validation-failed');
  if (isGateDriftFinalizeResult(full)) kinds.push('gate-drift');
  return [...new Set(kinds)];
}

function latestReceiptPath(roundsDir, receiptNames, predicate, stateDir) {
  const matches = receiptNames.filter(predicate).sort(compareReceiptNames);
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = readableFilePath(path.join(roundsDir, matches[index]), stateDir);
    if (candidate) return candidate;
  }
  return null;
}

function latestReadableFinalArtifactPath(full) {
  const stateDir = full.archivedStatePath || full.targetStateDir;
  if (!stateDir || typeof stateDir !== 'string') return null;
  const summaryPath = readableFilePath(path.join(stateDir, 'SUMMARY.md'), stateDir);
  const roundsDir = path.join(stateDir, 'rounds');
  let receiptNames = [];
  try {
    receiptNames = fs.readdirSync(roundsDir).filter((name) => name.endsWith('.md'));
  } catch {
    receiptNames = [];
  }

  if (full.status === 'pass' && summaryPath) return summaryPath;

  const finalKinds = finalReceiptKindsFor(full);
  const matchingFinalReceipt = latestReceiptPath(roundsDir, receiptNames, (name) => {
    const kind = receiptKindFromName(name);
    return kind ? finalKinds.includes(kind) : false;
  }, stateDir);
  if (matchingFinalReceipt) return matchingFinalReceipt;

  if (summaryPath) return summaryPath;

  return latestReceiptPath(roundsDir, receiptNames, () => true, stateDir);
}

function compactFieldValue(full, field, subcommand) {
  if (hasCompactValue(full, field)) return full[field];
  if (field === 'receiptPath' && subcommand === 'finalize') {
    return latestReadableFinalArtifactPath(full);
  }
  return null;
}

function compactWorkflowJson(full, subcommand) {
  validateCompactAllowlist();
  for (const [field, value] of Object.entries(full)) validateFullWorkflowField(field, value);

  const key = compactRowKey(full, subcommand);
  if (!key) failCompactJson('Compact workflow JSON requires a recognized workflow subcommand');
  const row = COMPACT_ALLOWLIST_BY_KEY.get(key);
  if (!row) failCompactJson(`Missing compact workflow JSON allowlist entry: ${key}`);

  const compact = {};
  for (const field of row.fields) {
    const value = compactFieldValue(full, field, subcommand);
    if (value === null || value === undefined) continue;
    compact[field] = value;
  }
  return compact;
}

function formatWorkflowJson(result, { mode = 'full', subcommand = null } = {}) {
  if (!JSON_MODES.has(mode)) fail('ERR_WORKFLOW_FLAG', `Invalid workflow JSON mode: ${mode}`);
  const full = fullWorkflowJson(result);
  const output = mode === 'compact' ? compactWorkflowJson(full, subcommand) : full;
  return `${JSON.stringify(output)}\n`;
}

function formatWorkflowError(options = {}) {
  const {
    error,
    targetKey = null,
    targetStateDir = null,
    manifestPath = null,
    runtimeCheck = null,
    blockingReason = null,
    statusReason = null,
    status = 'blocked',
    nextAction = null
  } = options;
  const message = error && error.message ? error.message : String(error);
  const rawNextAction = Object.hasOwn(options, 'nextAction')
    ? nextAction
    : (error && Object.hasOwn(error, 'nextAction') ? error.nextAction : null);
  return {
    ok: false,
    status,
    errorCode: error && error.code ? error.code : 'ERR_WORKFLOW',
    message: redactSensitive(message),
    targetKey,
    targetStateDir,
    manifestPath,
    runtimeCheck,
    blockingReason: blockingReason ||
      (status === 'blocked' && error && error.blockingReason) ||
      (status === 'blocked' ? 'state-validation-failed' : 'none'),
    statusReason: statusReason || 'none',
    nextAction: rawNextAction ? redactSensitive(rawNextAction) : rawNextAction
  };
}

module.exports = {
  runWorkflowCommand,
  parseWorkflowArgs,
  parseWorkflowJsonMode,
  formatWorkflowJson,
  formatWorkflowError,
  // Exported for the compact-JSON contract tests: these are the production
  // source-of-truth field classification and per-subcommand compact allowlist.
  // The test file keeps an independent copy and asserts parity, so any drift
  // between production and the spec fixtures fails loudly instead of silently.
  FULL_OUTPUT_FIELD_PURPOSES,
  COMPACT_ALLOWLIST_MATRIX
};
