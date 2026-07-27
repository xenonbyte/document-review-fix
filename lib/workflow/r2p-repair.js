'use strict';

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { atomicWriteFile } = require('../atomic-write');
const { computeFileSetFingerprint } = require('../target-context');
const { validateTargetStateOwnedPath } = require('../target-state');
const { writeRoundReceipt, writeExistingRoundReceipt, roundReceiptId } = require('../receipts');
const { redactSensitive } = require('../redaction');
const { explicitRouteInvocation } = require('../routes');

const REQUIRED_CMDS = Object.freeze(['r2p-status', 'r2p-reopen', 'r2p-gap-open', 'r2p-continue']);
const MUTATING_ALLOWLIST = new Set(['r2p-reopen', 'r2p-gap-open']);
const STAGE_ORDER = Object.freeze([
  'raw_requirement',
  'requirement_brief',
  'risk_discovery',
  'design',
  'spec',
  'plan'
]);
const OPEN_RUN_STATUSES = new Set([
  'open',
  'active_stage_draft',
  'entry_gate_failed',
  'quality_gate_failed',
  'ready_for_checkpoint_review',
  'checkpoint_review',
  'checkpoint_changes_requested',
  'upstream_gap_routing',
  'checkpoint_approved',
  'next_stage'
]);
// r2p only allows UPSTREAM_GAP_ROUTING from the subset of open statuses whose
// ALLOWED_TRANSITIONS include it (models.py). `next_stage` is an open run but is
// NOT gap-routable — r2p rejects gap-open from it ("resolve the current step
// first"), so an upstream finding there falls through to r2p-run-status-unsupported
// rather than emitting a command r2p would refuse. `open` is the contract/test
// generic for an active gap-routable run.
const GAP_ROUTABLE_STATUSES = new Set([...OPEN_RUN_STATUSES].filter((status) => status !== 'next_stage'));
const VALID_STAGES = new Set(STAGE_ORDER);
// r2p's Stage enum also has CLOSED ("closed"), which is the current_stage of a
// closed/executing/archived run. It is a valid contract value for current_stage
// (reopen runs report it) but never a repairable owner stage.
const CONTRACT_STAGES = new Set([...STAGE_ORDER, 'closed']);
const REVIEW_ARTIFACTS = Object.freeze([
  '03-requirement-brief.md',
  '04-risk-discovery.md',
  '05-design.md',
  '06-spec.md',
  '07-plan.md'
]);
const UNSAFE_TEXT_PATTERN = /[`]|(?:\$\()|(?:&&)|(?:\|\|)|[|;<>]/;
const INSTRUCTION_REDACTION = '[REDACTED:instruction]';
const JSON_INSTRUCTION_FIELD_PATTERN = /((?:"(?:raw\s+)?required[_\-\s]?action"|"reason")\s*:\s*)(?:"(?:\\.|[^"\\])*"|[^,}\]]*)/gi;
const REQUIRED_ACTION_PATTERN = /((?:\braw\s+)?required[_-]?action\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[\s\S]*?)(?=(?:\s+\breason\s*[:=])|(?:\s+(?:\braw\s+)?required[_-]?action\s*[:=])|(?:\s+\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=])|[|;]|$)/gi;
const REASON_PATTERN = /(\breason\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[\s\S]*?)(?=(?:\s+(?:\braw\s+)?required[_-]?action\s*[:=])|(?:\s+\breason\s*[:=])|(?:\s+\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=])|[|;]|$)/gi;
const SECRET_FIELD_PATTERN = /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*[^\s|,;]+/g;

function makeError(code, blockingReason, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.blockingReason = blockingReason;
  Object.assign(error, extra);
  return error;
}

function singleLine(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, ' ').trim();
}

function isInstructionKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'reason' || normalized === 'required_action' || normalized === 'raw_required_action';
}

function redactInstructionJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactInstructionJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isInstructionKey(key) ? INSTRUCTION_REDACTION : redactInstructionJsonValue(item);
  }
  return redacted;
}

function redactInstructionJsonText(value) {
  const text = String(value || '').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return text;
  try {
    return JSON.stringify(redactInstructionJsonValue(JSON.parse(text)));
  } catch {
    return text;
  }
}

function redactReceiptValue(value) {
  return String(redactSensitive(redactInstructionJsonText(singleLine(value))))
    .replace(SECRET_FIELD_PATTERN, '[REDACTED:secret-field]')
    .replace(JSON_INSTRUCTION_FIELD_PATTERN, `$1"${INSTRUCTION_REDACTION}"`)
    .replace(REQUIRED_ACTION_PATTERN, INSTRUCTION_REDACTION)
    .replace(REASON_PATTERN, `$1${INSTRUCTION_REDACTION}`);
}

function assertSafeText(value, label) {
  const text = singleLine(value);
  if (!text) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} must be non-empty`);
  }
  if (text.includes('\0')) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} must not contain NUL`);
  }
  if (text.length > 240) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} exceeds 240 characters`);
  }
  if (UNSAFE_TEXT_PATTERN.test(text)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} contains shell-like syntax`);
  }
  return text;
}

function stageIndex(stage) {
  return STAGE_ORDER.indexOf(stage);
}

function ensureStage(stage, label = 'owner stage') {
  if (!VALID_STAGES.has(stage)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `invalid ${label}: ${stage || 'none'}`);
  }
  return stage;
}

function ensureContractStage(stage, label, allowed = VALID_STAGES) {
  if (!allowed.has(stage)) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `r2p-status JSON exposed invalid ${label}: ${stage || 'none'}`
    );
  }
  return stage;
}

function isOpenRunStatus(status) {
  return OPEN_RUN_STATUSES.has(status);
}

function findExecutable(name, options = {}) {
  const envPath = options.env && typeof options.env.PATH === 'string'
    ? options.env.PATH
    : process.env.PATH;
  const candidates = [];
  if (envPath) {
    for (const entry of envPath.split(path.delimiter)) {
      if (!entry) continue;
      candidates.push(path.resolve(entry, name));
    }
  }
  const homeDir = options.homeDir || os.homedir();
  candidates.push(path.join(homeDir, '.req-to-plan', 'bin', name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stats = fs.statSync(candidate);
      if (!stats.isFile()) continue;
      return fs.realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function resolveR2pCommands(options = {}) {
  const resolved = {};
  for (const name of REQUIRED_CMDS) {
    const commandPath = findExecutable(name, options);
    if (!commandPath) {
      throw makeError(
        'ERR_R2P_COMMAND_UNAVAILABLE',
        'r2p-command-unavailable',
        `required r2p command is unavailable: ${name}`
      );
    }
    resolved[name] = commandPath;
  }
  return resolved;
}

function execFileJson(filePath, argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      filePath,
      argv,
      {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          ...(options.env || {}),
          R2P_JSON: '1'
        },
        shell: false
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({
          stdout: stdout || '',
          stderr: stderr || ''
        });
      }
    );
  });
}

// Find the index just past one complete top-level JSON value (object or array)
// starting at `start`, tracking brace/bracket depth and string escapes. Returns
// -1 if the value is unterminated.
function scanJsonValueEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// r2p-status --all prints one pretty-printed JSON object PER run, back to back
// (not a single array). Parse the whole stream into a list of top-level values.
function parseConcatenatedJson(stdout) {
  const text = String(stdout || '').trim();
  const fail = (suffix) => {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `r2p-status did not emit valid JSON${suffix ? `: ${suffix}` : ''}`
    );
  };
  if (!text) fail('');
  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (index >= text.length) break;
    if (text[index] !== '{' && text[index] !== '[') fail('unexpected non-JSON output');
    const end = scanJsonValueEnd(text, index);
    if (end === -1) fail('unterminated JSON value');
    try {
      values.push(JSON.parse(text.slice(index, end)));
    } catch (error) {
      fail(error.message);
    }
    index = end;
  }
  if (values.length === 0) fail('');
  return values;
}

function parseStatusPayload(stdout) {
  const values = parseConcatenatedJson(stdout);
  // A single top-level array (some callers/fakes emit one) is the entry list;
  // otherwise each concatenated value is one run entry.
  const rawEntries = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
  const entries = rawEntries.map((entry) => normalizeStatusEntryContract(entry));
  return { parsed: values, entries };
}

async function probeJsonContract(paths, options = {}) {
  const result = await execFileJson(paths['r2p-status'], ['--all'], options);
  const payload = parseStatusPayload(result.stdout);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    entries: payload.entries
  };
}

function normalizeOpenRoutesDetail(detail) {
  if (!Array.isArray(detail)) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      'r2p-status JSON did not expose open_routes_detail[]'
    );
  }
  return detail.map((route) => {
    if (!route || typeof route !== 'object' || !Object.prototype.hasOwnProperty.call(route, 'owner_stage')) {
      throw makeError(
        'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
        'r2p-json-contract-unavailable',
        'r2p-status JSON did not expose open route owner stage'
      );
    }
    return {
      routeId: route.route_id ? String(route.route_id) : null,
      ownerStage: ensureContractStage(String(route.owner_stage), 'open route owner stage'),
      requiredAction: route.required_action ? singleLine(route.required_action) : ''
    };
  });
}

function normalizeStatusEntryContract(entry) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.work_id !== 'string' ||
    typeof entry.status !== 'string' ||
    typeof entry.current_stage !== 'string'
  ) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      'r2p-status JSON did not expose work_id/status/current_stage'
    );
  }
  const currentStage = ensureContractStage(String(entry.current_stage), 'current stage', CONTRACT_STAGES);
  const openRoutesDetail = normalizeOpenRoutesDetail(entry.open_routes_detail);
  return {
    ...entry,
    currentStage,
    openRoutesDetail,
    openRouteOwnerStages: openRoutesDetail
      .map((route) => route.ownerStage)
      .filter(Boolean)
  };
}

function runStatusFromEntries(entries, workId, options = {}) {
  const matches = entries.filter((candidate) => candidate && candidate.work_id === workId);
  if (matches.length === 0) {
    throw makeError(
      'ERR_R2P_STATUS_NOT_FOUND',
      'r2p-run-not-found',
      `r2p-status did not include work_id ${workId}`,
      {
        nextAction: `rerun explicitly as ${explicitRouteInvocation(
          'review-fix-r2p',
          options.runtimePlatform,
          'workId=<existing-active-WF-...>'
        )}`
      }
    );
  }
  // r2p reports one entry per run; more than one match for a single workId means the
  // status contract is malformed. Fail closed rather than silently taking the first.
  if (matches.length > 1) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `r2p-status returned ${matches.length} entries for work_id ${workId}`
    );
  }
  const entry = matches[0];
  return {
    workId,
    status: entry.status,
    currentStage: entry.currentStage,
    openRoutesDetail: entry.openRoutesDetail,
    openRouteOwnerStages: entry.openRouteOwnerStages
  };
}

async function readRunStatus(paths, workId, options = {}) {
  const { entries } = await probeJsonContract(paths, options);
  return runStatusFromEntries(entries, workId, options);
}

function findingOwnerStage(finding) {
  if (!finding || typeof finding !== 'object') return null;
  if (finding.owner_stage) return ensureStage(String(finding.owner_stage));
  if (finding.ownerStage) return ensureStage(String(finding.ownerStage));
  return null;
}

function normalizeFindings(findings) {
  return (Array.isArray(findings) ? findings : []).map((finding, index) => {
    const issueId = finding && (finding.issue_id || finding.issueId)
      ? String(finding.issue_id || finding.issueId)
      : `ISSUE-${String(index + 1).padStart(3, '0')}`;
    const ownerStage = findingOwnerStage(finding);
    const reason = finding && (finding.reason || finding.rationale)
      ? String(finding.reason || finding.rationale)
      : '';
    const requiredAction = finding && (finding.required_action || finding.requiredAction)
      ? String(finding.required_action || finding.requiredAction)
      : '';
    return {
      issueId,
      ownerStage,
      reason,
      requiredAction
    };
  });
}

function mapRepairMode(statusOrState, currentStage, findings, options = {}) {
  const state = typeof statusOrState === 'object' && statusOrState
    ? statusOrState
    : { status: statusOrState, currentStage };
  const liveStatus = String(state.status || '');
  // A closed/executing run reports current_stage 'closed' (r2p Stage.CLOSED), which is
  // not a pipeline stage. reopen does not need a pipeline current_stage; only the
  // open-run (gap-open / current-stage) branch does, so validate it there.
  const rawStage = String(state.currentStage || currentStage || '');
  const normalizedFindings = normalizeFindings(findings);
  const ownerStages = normalizedFindings.length > 0
    ? normalizedFindings.map((finding) => finding.ownerStage).filter(Boolean)
    : (Array.isArray(state.openRouteOwnerStages) ? state.openRouteOwnerStages : []);

  if (liveStatus === 'closed_at_plan_checkpoint' || liveStatus === 'executing') {
    return {
      kind: 'command',
      command_kind: 'r2p-reopen',
      current_stage: rawStage
    };
  }
  if (isOpenRunStatus(liveStatus)) {
    const stage = ensureStage(rawStage, 'current stage');
    const currentIndex = stageIndex(stage);
    const upstream = ownerStages.some((ownerStage) => stageIndex(ownerStage) !== -1 && stageIndex(ownerStage) < currentIndex);
    if (upstream) {
      // r2p enforces one open route per run: gap-open is refused while any route
      // is open (cli.py). Block with actionable guidance instead of emitting a
      // command r2p would reject as a cryptic command failure.
      const existingOpenRoutes = Array.isArray(state.openRoutesDetail) ? state.openRoutesDetail : [];
      if (existingOpenRoutes.length > 0) {
        return {
          kind: 'blocked',
          status: 'blocked',
          blockingReason: 'r2p-existing-route-open',
          current_stage: stage,
          nextAction: `resolve the open r2p route with r2p-continue (or r2p-gap-resolve), then rerun ${explicitRouteInvocation(
            'review-fix-r2p',
            options.runtimePlatform
          )}`
        };
      }
      // Only gap-route from a status r2p actually allows it from (e.g. not next_stage).
      if (GAP_ROUTABLE_STATUSES.has(liveStatus)) {
        return {
          kind: 'command',
          command_kind: 'r2p-gap-open',
          current_stage: stage
        };
      }
      // Non-gap-routable open status: fall through to r2p-run-status-unsupported.
    }
    const sameStage = ownerStages.some((ownerStage) => ownerStage === stage);
    if (sameStage) {
      return {
        kind: 'checkpoint',
        status: 'checkpoint',
        statusReason: 'r2p-current-stage-repair-required',
        current_stage: stage
      };
    }
  }
  return {
    kind: 'blocked',
    status: 'blocked',
    blockingReason: 'r2p-run-status-unsupported',
    current_stage: rawStage
  };
}

function earliestOwnerStage(findings) {
  let earliest = null;
  for (const finding of findings) {
    const ownerStage = ensureStage(finding.ownerStage);
    if (!earliest || stageIndex(ownerStage) < stageIndex(earliest)) earliest = ownerStage;
  }
  if (!earliest) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'accepted findings did not map to an owner stage');
  }
  return earliest;
}

function synthesizeReason(commandKind, ownerStage, issueIds) {
  const joinedIds = issueIds.join(', ');
  if (commandKind === 'r2p-gap-open') {
    return `Address accepted findings ${joinedIds} at ${ownerStage}.`;
  }
  return `Reopen ${ownerStage} for accepted findings ${joinedIds}.`;
}

function buildRepairPlan(accepted, mode, currentStage, options = {}) {
  if (!mode || typeof mode !== 'object') {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'repair mode is required');
  }
  if (mode.kind === 'checkpoint') return mode;
  if (mode.kind === 'blocked') {
    throw makeError('ERR_R2P_RUN_STATUS_UNSUPPORTED', mode.blockingReason || 'r2p-run-status-unsupported', 'run status cannot be repaired automatically');
  }
  const normalized = normalizeFindings(accepted);
  if (normalized.length === 0) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'accepted findings are required');
  }
  const ownerStage = earliestOwnerStage(normalized);
  const issueIds = normalized.map((finding) => finding.issueId);
  // reopen does not need a pipeline current_stage (a closed run reports 'closed');
  // only gap-open requires the strictly-upstream owner check against current_stage.
  const rawStage = String(currentStage || mode.current_stage || '');
  if (mode.command_kind === 'r2p-gap-open') {
    const stage = ensureStage(rawStage, 'current stage');
    if (stageIndex(ownerStage) >= stageIndex(stage)) {
      throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'gap-open owner stage must be strictly upstream');
    }
  }
  const firstWithText = normalized.find((finding) => finding.ownerStage === ownerStage && (finding.reason || finding.requiredAction)) || normalized[0];
  const rawText = mode.command_kind === 'r2p-gap-open'
    ? (firstWithText.requiredAction || synthesizeReason(mode.command_kind, ownerStage, issueIds))
    : (firstWithText.reason || synthesizeReason(mode.command_kind, ownerStage, issueIds));
  const safeText = assertSafeText(rawText, mode.command_kind === 'r2p-gap-open' ? 'required_action' : 'reason');
  return {
    command_kind: mode.command_kind,
    owner_stage: ownerStage,
    issue_ids: issueIds,
    current_stage: rawStage,
    workId: options.workId || mode.workId || null,
    reason: mode.command_kind === 'r2p-reopen' ? safeText : null,
    required_action: mode.command_kind === 'r2p-gap-open' ? safeText : null
  };
}

function paddedRound(round) {
  return String(Number(round || 1)).padStart(3, '0');
}

function repairPlanArtifactPath(options) {
  const projectRoot = options && options.projectRoot;
  const targetKey = options && options.targetKey;
  const targetStateDir = path.join(projectRoot, '.drfx', 'targets', String(targetKey || ''));
  return validateTargetStateOwnedPath({
    targetStateDir,
    relativePath: path.posix.join('rounds', `${paddedRound(options && options.round)}-r2p-repair-plan.json`),
    allowedDirectories: ['rounds'],
    label: 'R2P repair plan path'
  });
}

function targetStateRelativePath(projectRoot, targetKey, filePath) {
  const targetStateDir = path.join(projectRoot, '.drfx', 'targets', String(targetKey || ''));
  return path.relative(targetStateDir, filePath).split(path.sep).join('/');
}

function requirePlanArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} must be a non-empty array`);
  }
  const normalized = value.map((item) => String(item || '').trim()).filter(Boolean);
  if (normalized.length !== value.length || normalized.length === 0) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', `${label} contains an empty value`);
  }
  return normalized;
}

function normalizeRepairPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'repair plan is missing');
  }
  const commandKind = String(plan.command_kind || '');
  if (!MUTATING_ALLOWLIST.has(commandKind)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'repair plan command_kind is invalid');
  }
  const ownerStage = ensureStage(String(plan.owner_stage || ''));
  const issueIds = requirePlanArray(plan.issue_ids, 'issue_ids');
  const workId = assertSafeText(plan.workId || plan.work_id, 'workId');
  const currentStage = String(plan.current_stage || '');
  if (commandKind === 'r2p-gap-open') ensureStage(currentStage, 'current stage');
  const reason = commandKind === 'r2p-reopen'
    ? assertSafeText(plan.reason, 'reason')
    : null;
  const requiredAction = commandKind === 'r2p-gap-open'
    ? assertSafeText(plan.required_action, 'required_action')
    : null;
  return {
    command_kind: commandKind,
    owner_stage: ownerStage,
    issue_ids: issueIds,
    current_stage: currentStage,
    workId,
    reason,
    required_action: requiredAction
  };
}

function sameRepairPlan(left, right) {
  try {
    return JSON.stringify(normalizeRepairPlan(left)) === JSON.stringify(normalizeRepairPlan(right));
  } catch {
    return false;
  }
}

function writeRecordedRepairPlan(options = {}) {
  const planPath = repairPlanArtifactPath(options);
  const receiptPath = options.receiptPath || null;
  const plan = normalizeRepairPlan(options.plan);
  const payload = {
    schema: 'drfx-r2p-repair-plan-v1',
    recordedAt: new Date().toISOString(),
    receiptId: options.receiptId || null,
    receiptPath: receiptPath
      ? targetStateRelativePath(options.projectRoot, options.targetKey, receiptPath)
      : null,
    plan
  };
  atomicWriteFile(planPath, `${JSON.stringify(payload, null, 2)}\n`);
  return planPath;
}

function readRecordedRepairPlan(options = {}) {
  const planPath = repairPlanArtifactPath(options);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (error) {
    throw makeError(
      'ERR_R2P_REPAIR_PLAN_AMBIGUOUS',
      'r2p-repair-plan-ambiguous',
      error && error.code === 'ENOENT'
        ? 'recorded r2p repair plan is missing'
        : 'recorded r2p repair plan is unreadable',
      { nextAction: 'run record-r2p-repair-plan before apply-r2p-repair' }
    );
  }
  if (!parsed || parsed.schema !== 'drfx-r2p-repair-plan-v1') {
    throw makeError(
      'ERR_R2P_REPAIR_PLAN_AMBIGUOUS',
      'r2p-repair-plan-ambiguous',
      'recorded r2p repair plan has an invalid schema',
      { nextAction: 'rerun record-r2p-repair-plan before apply-r2p-repair' }
    );
  }
  return {
    planPath,
    receiptId: parsed.receiptId || null,
    receiptPath: parsed.receiptPath || null,
    plan: normalizeRepairPlan(parsed.plan)
  };
}

function requiredArtifactError(relativePath, unsafe = false) {
  return makeError(
    unsafe ? 'ERR_R2P_ARTIFACT_UNSAFE' : 'ERR_R2P_ARTIFACT_MISSING',
    'r2p-artifact-missing-or-unsafe',
    unsafe
      ? `required r2p artifact must be a regular non-symlink file: ${relativePath}`
      : `required r2p artifact is missing: ${relativePath}`
  );
}

function readRequiredArtifactSha256(filePath, relativePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw requiredArtifactError(relativePath);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw requiredArtifactError(relativePath, true);
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    throw requiredArtifactError(relativePath);
  }
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fingerprintRun(runDir, artifactNames = REVIEW_ARTIFACTS) {
  const runMdSha256 = readRequiredArtifactSha256(path.join(runDir, 'run.md'), 'run.md');
  const fileSetFingerprint = computeFileSetFingerprint(artifactNames.map((artifact) => ({
    path: artifact,
    status: 'modified',
    contentId: readRequiredArtifactSha256(path.join(runDir, artifact), artifact)
  })));
  return {
    runMdSha256,
    fileSetFingerprint
  };
}

function statusMatchesCommandKind(commandKind, liveStatus) {
  if (commandKind === 'r2p-reopen') {
    return liveStatus === 'closed_at_plan_checkpoint' || liveStatus === 'executing';
  }
  if (commandKind === 'r2p-gap-open') {
    return GAP_ROUTABLE_STATUSES.has(liveStatus);
  }
  return false;
}

function realDirectoryDrift(directoryPath, summary) {
  try {
    const stats = fs.lstatSync(directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return { ok: false, blockingReason: 'r2p-drift-detected', summary };
    }
  } catch {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary };
  }
  return null;
}

async function driftGuard(state) {
  const paths = resolveR2pCommands(state);
  const workspaceDir = state.workspaceDir || path.dirname(state.runDir);
  const workspaceDrift = realDirectoryDrift(workspaceDir, 'r2p workspace is missing or unsafe');
  if (workspaceDrift) return workspaceDrift;
  const activeDrift = realDirectoryDrift(state.runDir, 'active run directory is missing or unsafe');
  if (activeDrift) return activeDrift;
  if (state.archiveRunDir && fs.existsSync(state.archiveRunDir)) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'run moved to archive after review' };
  }
  let liveFingerprint;
  try {
    liveFingerprint = fingerprintRun(state.runDir, state.reviewArtifacts || REVIEW_ARTIFACTS);
  } catch (error) {
    if (error && error.blockingReason) {
      return { ok: false, blockingReason: error.blockingReason, summary: error.message };
    }
    throw error;
  }
  if (state.runMdSha256 && liveFingerprint.runMdSha256 !== state.runMdSha256) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'run.md changed after review' };
  }
  if (state.fileSetFingerprint && liveFingerprint.fileSetFingerprint !== state.fileSetFingerprint) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'review artifacts changed after review' };
  }
  const liveStatus = await readRunStatus(paths, state.workId, state);
  if (!statusMatchesCommandKind(state.command_kind, liveStatus.status)) {
    return { ok: false, blockingReason: 'r2p-drift-detected', summary: 'live run status no longer matches the repair plan' };
  }
  return {
    ok: true,
    paths,
    liveStatus,
    fingerprint: liveFingerprint
  };
}

function buildArgv(plan) {
  if (plan.command_kind === 'r2p-gap-open') {
    return ['--work-id', plan.workId, '--owner-stage', plan.owner_stage, '--required-action', plan.required_action, '--confirm'];
  }
  return ['--from', plan.workId, '--stage', plan.owner_stage, '--reason', plan.reason];
}

function parseCommandOutput(commandKind, stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch (error) {
    throw makeError(
      'ERR_R2P_JSON_CONTRACT_UNAVAILABLE',
      'r2p-json-contract-unavailable',
      `${commandKind} did not emit valid JSON: ${error.message}`
    );
  }
  if (commandKind === 'r2p-reopen') {
    if (!parsed || typeof parsed.new_work_id !== 'string') {
      throw makeError('ERR_R2P_JSON_CONTRACT_UNAVAILABLE', 'r2p-json-contract-unavailable', 'r2p-reopen JSON did not expose new_work_id');
    }
  } else if (!parsed || typeof parsed.route_id !== 'string') {
    throw makeError('ERR_R2P_JSON_CONTRACT_UNAVAILABLE', 'r2p-json-contract-unavailable', 'r2p-gap-open JSON did not expose route_id');
  }
  return parsed;
}

// rerunWorkId is already the post-repair workId the caller must rerun against:
// the new forked workId after r2p-reopen, or the unchanged workId after r2p-gap-open.
function buildNextAction(rerunWorkId, options = {}) {
  const roundLimit = options.roundLimit === null || options.roundLimit === undefined
    ? 'none'
    : String(options.roundLimit);
  const roundsToken = roundLimit === 'none' ? '' : ` rounds=${roundLimit}`;
  const resumeToken = options.resume ? ' resume' : '';
  const rerun = explicitRouteInvocation(
    'review-fix-r2p',
    options.runtimePlatform,
    `workId=${rerunWorkId}${roundsToken}${resumeToken}`
  );
  return `Run r2p-continue for workId=${rerunWorkId}, then rerun ${rerun}.`;
}

async function runRepairCommand(paths, plan, options = {}) {
  if (!plan || !MUTATING_ALLOWLIST.has(plan.command_kind)) {
    throw makeError('ERR_R2P_REPAIR_PLAN_AMBIGUOUS', 'r2p-repair-plan-ambiguous', 'repair plan command_kind is invalid');
  }
  const bin = paths[plan.command_kind];
  if (!bin || !path.isAbsolute(bin)) {
    throw makeError('ERR_R2P_COMMAND_UNAVAILABLE', 'r2p-command-unavailable', `resolved command path is missing for ${plan.command_kind}`);
  }
  const argv = buildArgv(plan);
  let execution;
  try {
    execution = await execFileJson(bin, argv, options);
  } catch (error) {
    throw makeError(
      'ERR_R2P_COMMAND_FAILED',
      'r2p-command-failed',
      `${plan.command_kind} failed with exit code ${typeof error.code === 'number' ? error.code : 'unknown'}`,
      {
        command: plan.command_kind,
        argv,
        exitCode: typeof error.code === 'number' ? error.code : null,
        stdout: error.stdout || '',
        stderr: error.stderr || ''
      }
    );
  }
  const parsed = parseCommandOutput(plan.command_kind, execution.stdout);
  const newWorkId = plan.command_kind === 'r2p-reopen' ? parsed.new_work_id : null;
  const routeId = plan.command_kind === 'r2p-gap-open' ? parsed.route_id : null;
  const staledStages = plan.command_kind === 'r2p-gap-open' && Array.isArray(parsed.staled_stages)
    ? parsed.staled_stages.map((stage) => String(stage))
    : [];
  const rerunWorkId = newWorkId || plan.workId;
  const sameWorkIdRerun = !newWorkId;
  return {
    command: plan.command_kind,
    argv,
    exitCode: 0,
    stdout: execution.stdout,
    stderr: execution.stderr,
    parsed,
    workId: plan.workId,
    newWorkId,
    routeId,
    staledStages,
    nextAction: buildNextAction(rerunWorkId, {
      resume: sameWorkIdRerun,
      roundLimit: options.roundLimit,
      runtimePlatform: options.runtimePlatform
    }),
    status: 'checkpoint',
    statusReason: 'r2p-repair-applied',
    issueIds: plan.issue_ids || []
  };
}

function redactedArgv(argv) {
  const reduced = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    reduced.push(item);
    if ((item === '--reason' || item === '--required-action') && index + 1 < argv.length) {
      reduced.push('[REDACTED]');
      index += 1;
    }
  }
  return reduced;
}

function formatReceiptText(result) {
  const summaryLines = [
    `Command: ${result.command || 'none'}`,
    `Argv: ${(redactedArgv(result.argv || [])).join(' ') || 'none'}`,
    `Exit code: ${result.exitCode === null || result.exitCode === undefined ? 'none' : String(result.exitCode)}`,
    `Stdout: ${redactReceiptValue(result.stdout || 'none')}`,
    `Stderr: ${redactReceiptValue(result.stderr || 'none')}`
  ];
  if (result.newWorkId) summaryLines.push(`New work ID: ${redactReceiptValue(result.newWorkId)}`);
  if (result.routeId) summaryLines.push(`Route ID: ${redactReceiptValue(result.routeId)}`);
  if (Array.isArray(result.staledStages) && result.staledStages.length > 0) {
    summaryLines.push(`Staled stages: ${result.staledStages.map((stage) => redactReceiptValue(stage)).join(', ')}`);
  }
  return summaryLines.join('\n');
}

function roundReceiptOptions(result, summary) {
  return {
    projectRoot: result.projectRoot,
    targetKey: result.targetKey,
    round: result.round,
    kind: result.kind || 'r2p-repair',
    status: result.status || 'checkpoint',
    stopReason: 'checkpoint',
    target: `workId=${result.workId || 'none'}`,
    issueIds: result.issueIds || [],
    filesChanged: 'none',
    verification: result.verification || 'argv-array execFile shell:false R2P_JSON=1',
    blockingReason: result.blockingReason || 'none',
    statusReason: result.statusReason || 'r2p-repair-applied',
    summary,
    nextAction: result.nextAction ||
      `run r2p-continue and rerun ${explicitRouteInvocation('review-fix-r2p', result.runtimePlatform)}`
  };
}

function readReceipt(receiptPath, targetKey) {
  return {
    receiptPath,
    receiptId: roundReceiptId({ targetKey }, receiptPath),
    receiptText: fs.readFileSync(receiptPath, 'utf8')
  };
}

function reserveReceipt(result) {
  const reserved = formatReceiptText({
    command: result.command,
    argv: result.argv || [],
    exitCode: null,
    stdout: 'receipt reserved before mutating r2p command',
    stderr: '',
    workId: result.workId,
    issueIds: result.issueIds
  });
  const receiptPath = writeRoundReceipt(roundReceiptOptions({
    ...result,
    status: 'checkpoint',
    statusReason: 'r2p-repair-receipt-reserved',
    verification: 'receipt path reserved before mutating r2p command',
    nextAction: 'execute r2p repair command and update this receipt'
  }, reserved));
  return readReceipt(receiptPath, result.targetKey);
}

function writeReceipt(result) {
  const text = formatReceiptText(result);
  if (result && result.projectRoot && result.targetKey && result.round) {
    const options = roundReceiptOptions(result, text);
    const receiptPath = result.reservedReceiptPath
      ? writeExistingRoundReceipt(options, result.reservedReceiptPath)
      : writeRoundReceipt(options);
    return readReceipt(receiptPath, result.targetKey);
  }
  const receiptText = redactReceiptValue(text);
  if (result && result.receiptPath) {
    fs.mkdirSync(path.dirname(result.receiptPath), { recursive: true });
    fs.writeFileSync(result.receiptPath, `${receiptText}\n`, 'utf8');
  }
  return {
    receiptPath: result && result.receiptPath ? result.receiptPath : null,
    receiptText
  };
}

module.exports = {
  resolveR2pCommands,
  probeJsonContract,
  readRunStatus,
  runStatusFromEntries,
  mapRepairMode,
  buildRepairPlan,
  normalizeRepairPlan,
  sameRepairPlan,
  statusMatchesCommandKind,
  writeRecordedRepairPlan,
  readRecordedRepairPlan,
  driftGuard,
  runRepairCommand,
  reserveReceipt,
  writeReceipt
};
