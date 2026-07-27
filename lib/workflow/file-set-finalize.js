'use strict';

// PLAN-TASK-009 (Phase C): file-set (PR/CODE) resume + finalize.
//
// Resume requires the EXPLICIT `resume` token (enforced by the dispatcher) and REFUSES a
// stale identity: the stored manifest identity is compared against the live re-resolved
// identity via comparePrIdentity / compareCodeIdentity. PR remains strict on every
// field; CODE remains strict on roundLimit, guard, scopes, and file-set fingerprint,
// while tolerating default exclusion-list drift when the actual file set is unchanged.
// Unsafe drift ⇒ stale ⇒ refuse (never silent reuse). The resolvers are read-only (no
// git fetch/push/ref mutation).

const {
  ARCHIVE_ON_FINALIZE,
  archiveFailureNextAction,
  archiveTerminalStateBestEffort,
  atomicWriteFile,
  buildPrIdentity,
  buildCodeIdentity,
  comparePrIdentity,
  compareCodeIdentity,
  describeCodeBlock,
  formatLedger,
  nextReportPath,
  padRound,
  parseDiffReview,
  parseFinalResponseBlock,
  path,
  readLedgerIfPresent,
  readManifestReport,
  readStateCommandPayload,
  receiptFailureResult,
  resolveCodeTarget,
  resolveFileSetPersistentMetadata,
  resolveFileSetStateMetadata,
  resolveTargetContext,
  stateCommandBase,
  stateRelativePath,
  stateValidationResult,
  updatePersistentManifest,
  validateFinalResponse,
  withReadOnlyMode,
  workflowBase,
  writeFinalReceipt,
  writeWorkflowSummary,
  acceptedNonBlockingLowIssueIdsFromLedger,
  reportIssueIds,
  reportResult,
  statePathFromManifest
} = require('./helpers');
const { readRoundReceiptArtifacts } = require('../receipts');
const { explicitRouteInvocation } = require('../routes');
const { resolveCodeInventory, resolveR2pWorkIdTarget } = require('../target-context');
const { readUnitsPlan } = require('./file-set-unit-review');
const { readActivePartitionedPlan } = require('./file-set-partitioned-live');

const R2P_RESUME_REFRESH_REASONS = new Set([
  'r2p-repair-applied',
  'r2p-current-stage-repair-required'
]);

function fileSetBase(parsed, metadata, overrides = {}, options = {}) {
  const cwd = options.cwd || metadata.projectRoot;
  return {
    ...workflowBase(parsed, { cwd }),
    targetStateDir: metadata.targetStateDir,
    manifestPath: metadata.manifestPath,
    targetKey: metadata.targetKey,
    routeKind: metadata.routeKind,
    round: Number(metadata.manifest.currentRound || 1),
    ...overrides
  };
}

function manifestIdentityInput(metadata) {
  return {
    guardMode: metadata.manifest.guardMode || 'git',
    roundLimit: metadata.manifest.roundLimit === 'none' || metadata.manifest.roundLimit === undefined
      ? null
      : metadata.manifest.roundLimit
  };
}

function requestedIdentityInput(parsed) {
  return {
    guardMode: parsed.invocation.routeKind === 'r2p'
      ? 'snapshot'
      : (parsed.invocation.guardMode || 'git'),
    roundLimit: parsed.invocation.roundLimit
  };
}

async function liveIdentityFor(metadata, identityInput, options) {
  const guardMode = identityInput.guardMode;
  const roundLimit = identityInput.roundLimit;
  if (metadata.routeKind === 'pr') {
    const context = await resolveTargetContext({
      routeName: 'review-fix-pr',
      base: metadata.manifest.base,
      cwd: metadata.projectRoot,
      commandLog: options.commandLog
    });
    return buildPrIdentity({ context, guardMode, roundLimit });
  }
  if (metadata.routeKind === 'r2p') {
    const context = resolveR2pWorkIdTarget({
      projectRoot: metadata.projectRoot,
      workId: metadata.manifest.workId
    });
    return {
      workId: String(context.workId),
      reviewSetFingerprint: String(context.fileSetFingerprint),
      runMdSha256: String(context.runMdSha256),
      roundLimit: roundLimit === null || roundLimit === undefined ? 'none' : String(roundLimit)
    };
  }
  let partitionedPlan = null;
  try {
    partitionedPlan = readUnitsPlan(metadata.targetStateDir);
  } catch {
    partitionedPlan = null;
  }
  if (partitionedPlan) {
    const inventoryResult = await resolveCodeInventory({
      cwd: metadata.projectRoot,
      scopes: metadata.manifest.normalizedScopes || [],
      commandLog: options.commandLog
    });
    if (inventoryResult && inventoryResult.status === 'blocked') {
      const blocked = describeCodeBlock(inventoryResult);
      const error = new Error(blocked.message);
      error.code = 'ERR_FILE_SET_RESOLVE';
      error.nextAction = blocked.nextAction;
      throw error;
    }
    return {
      targetContextKind: 'code',
      normalizedScopes: Array.isArray(metadata.manifest.normalizedScopes) ? metadata.manifest.normalizedScopes : [],
      exclusions: Array.isArray(metadata.manifest.exclusions) ? metadata.manifest.exclusions : [],
      // RECOMPUTED live from disk (not echoed from the manifest), so a rule-only .drfxignore
      // change is compared against the stored start-time digests and surfaces as stale identity.
      userExcludes: Array.isArray(inventoryResult.userExcludes) ? inventoryResult.userExcludes : [],
      guardMode: String(guardMode),
      roundLimit: roundLimit === null || roundLimit === undefined ? 'none' : String(roundLimit),
      fileSetFingerprint: inventoryResult.projectReviewFingerprint
    };
  }
  const context = await resolveCodeTarget({
    cwd: metadata.projectRoot,
    scopes: metadata.manifest.normalizedScopes || []
  });
  if (context && context.status === 'blocked') {
    const blocked = describeCodeBlock(context);
    const error = new Error(blocked.message);
    error.code = 'ERR_FILE_SET_RESOLVE';
    error.nextAction = blocked.nextAction;
    throw error;
  }
  return buildCodeIdentity({ context, guardMode, roundLimit });
}

// Build the stored identity from the durable manifest, in the same shape buildPrIdentity /
// buildCodeIdentity produce, so the strict compare is field-for-field.
function storedIdentityFor(metadata) {
  const roundLimit = metadata.manifest.roundLimit === undefined ? 'none' : String(metadata.manifest.roundLimit);
  const guardMode = String(metadata.manifest.guardMode || 'git');
  if (metadata.routeKind === 'pr') {
    return {
      targetContextKind: 'pr',
      base: String(metadata.manifest.base),
      baseRevision: String(metadata.manifest.baseRevision),
      mergeBase: String(metadata.manifest.mergeBase),
      head: String(metadata.manifest.head),
      guardMode,
      roundLimit,
      fileSetFingerprint: String(metadata.manifest.fileSetFingerprint)
    };
  }
  if (metadata.routeKind === 'r2p') {
    return {
      workId: String(metadata.manifest.workId),
      reviewSetFingerprint: String(metadata.manifest.reviewSetFingerprint),
      runMdSha256: String(metadata.manifest.runMdSha256),
      roundLimit
    };
  }
  return {
    targetContextKind: 'code',
    normalizedScopes: Array.isArray(metadata.manifest.normalizedScopes) ? metadata.manifest.normalizedScopes : [],
    exclusions: Array.isArray(metadata.manifest.exclusions) ? metadata.manifest.exclusions : [],
    userExcludes: Array.isArray(metadata.manifest.userExcludes) ? metadata.manifest.userExcludes : [],
    guardMode,
    roundLimit,
    fileSetFingerprint: String(metadata.manifest.fileSetFingerprint)
  };
}

async function runFileSetResume(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetPersistentMetadata(parsed, options);
  } catch (error) {
    return stateValidationResult(
      path.join(error && error.targetStateDir ? error.targetStateDir : process.cwd(), '.drfx'),
      error
    );
  }

  // Completed-state anomaly: archive a live pass/read-only-clean and fresh-start, before
  // any stale-identity comparison. (Persistent file-set manifests only reach `pass`;
  // read-only is no-state. The shared set keeps the rule uniform.)
  if (ARCHIVE_ON_FINALIZE.has(metadata.manifest.status)) {
    const { archivedStatePath, archiveWarning } = archiveTerminalStateBestEffort({
      targetStateDir: metadata.targetStateDir,
      options
    });
    if (archiveWarning) {
      return fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        archiveWarning,
        nextAction: 'delete or reset the leftover passed file-set state directory, then retry'
      }, options);
    }
    return { freshStartRequested: true, archivedStatePath };
  }

  let liveIdentity;
  try {
    liveIdentity = await liveIdentityFor(metadata, requestedIdentityInput(parsed), options);
  } catch (error) {
    return {
      ...fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        errorCode: error && error.code ? error.code : 'ERR_FILE_SET_RESOLVE',
        message: error && error.message ? error.message : String(error),
        nextAction: (error && error.nextAction) || 'resolve a valid base/scope file set before resuming'
      }, options)
    };
  }

  const stored = storedIdentityFor(metadata);
  const comparison = compareFileSetIdentity(metadata.routeKind, stored, liveIdentity);

  if (!comparison.match) {
    if (r2pResumeCanRefresh(metadata, comparison)) {
      return r2pResumeRefreshState(parsed, metadata, liveIdentity, options);
    }
    // Stale identity: the live file set / base / scope / round limit drifted from the
    // recorded state. Refuse resume (never silent reuse, never PASS) and report the drift.
    return withReadOnlyMode({
      ...fileSetBase(parsed, metadata, {
        ok: false,
        status: 'blocked',
        blockingReason: 'state-validation-failed',
        statusReason: 'none',
        errorCode: 'ERR_FILE_SET_STALE_IDENTITY',
        message: `stale file-set identity; mismatched fields: ${comparison.mismatches.join(', ')}`,
        staleIdentityFields: comparison.mismatches,
        nextAction: 'pass reset to archive the stale state and start a fresh review for the changed file set'
      }, options)
    });
  }

  // Identity matches: resume to the manifest's current phase. The deterministic phase is the
  // persisted status/currentPhase; no single-file fingerprint replay is needed because the
  // file-set fingerprint already matched.
  const nextAction = manifestResumeNextAction(metadata.manifest, metadata.routeKind);
  const ok = !['blocked', 'unsupported', 'externally-changed', 'possible-target-replacement', 'checkpoint'].includes(
    metadata.manifest.status
  );
  // A partitioned project-review checkpoint stays a paused state (ok:false), but the
  // result advertises reviewMode:'partitioned' so the caller routes back into the unit
  // loop instead of the generic file-set loop.
  const partitionedCheckpoint = metadata.routeKind === 'code' &&
    metadata.manifest.status === 'checkpoint' &&
    metadata.manifest.currentPhase === 'review';
  return fileSetBase(parsed, metadata, {
    ok,
    status: metadata.manifest.status,
    currentPhase: metadata.manifest.currentPhase,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    blockingReason: metadata.manifest.blockingReason || 'none',
    statusReason: metadata.manifest.statusReason || 'none',
    fileSetFingerprint: metadata.routeKind === 'r2p'
      ? metadata.manifest.reviewSetFingerprint
      : metadata.manifest.fileSetFingerprint,
    ...(partitionedCheckpoint ? { reviewMode: 'partitioned' } : {}),
    nextAction
  }, options);
}

function manifestResumeNextAction(manifest, routeKind = null) {
  if (manifest.status === 'review') return 'run workflow context for review';
  // r2p forbids direct artifact writes: begin-fix is blocked, so a fix-phase
  // resume must point at the lifecycle repair commands instead.
  if (manifest.status === 'fix' && routeKind === 'r2p') {
    return 'run record-r2p-repair-plan, then apply-r2p-repair';
  }
  if (manifest.status === 'fix') return 'run begin-fix to continue the fix loop';
  if (manifest.status === 'diff-review') return 'run record-diff-review';
  if (manifest.status === 'full-re-review') return 'run full re-review';
  // A partitioned project-review checkpoint (the only checkpoint produced with
  // currentPhase 'review'; abort-fix checkpoints carry currentPhase 'fix') resumes into
  // the bounded unit-review loop, not the generic "continue from current phase".
  if (manifest.status === 'checkpoint' && manifest.currentPhase === 'review') {
    return 'run workflow context --phase unit-review to continue the partitioned project review';
  }
  return 'continue from manifest current phase';
}

function parseRoundReceiptField(text, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^- ${escaped}: ([^\\n]+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function r2pRepairReceiptAttempt(fileName) {
  const match = String(fileName || '').match(/^\d{3}-r2p-repair(?:-attempt-(\d{3}))?\.md$/);
  if (!match) return null;
  return match[1] ? Number(match[1]) : 0;
}

function parseR2pRepairReceipt(text) {
  if (parseRoundReceiptField(text, 'Kind') !== 'r2p-repair') return null;
  const nextActionMatch = text.match(/^## Next Action\n([\s\S]*?)\n?$/m);
  const targetMatch = text.match(/^- Target: workId=([^\n]+)$/m);
  const newWorkIdMatch = text.match(/^New work ID: ([^\n]+)$/m);
  return {
    status: parseRoundReceiptField(text, 'Status'),
    statusReason: parseRoundReceiptField(text, 'Status reason'),
    priorWorkId: targetMatch ? targetMatch[1].trim() : null,
    newWorkId: newWorkIdMatch ? newWorkIdMatch[1].trim() : null,
    nextAction: nextActionMatch ? nextActionMatch[1].trim() : null
  };
}

function currentRoundR2pRepairReceipt(metadata) {
  if (metadata.routeKind !== 'r2p') return null;
  const prefix = `${padRound(Number(metadata.manifest.currentRound || 1))}-`;
  const candidates = [];
  for (const receipt of readRoundReceiptArtifacts(metadata.targetStateDir, { fileNamePrefix: prefix })) {
    const attempt = r2pRepairReceiptAttempt(receipt.fileName);
    if (attempt === null) continue;
    const parsed = parseR2pRepairReceipt(receipt.text);
    if (!parsed) continue;
    if (parsed.status !== 'checkpoint' || parsed.statusReason !== 'r2p-repair-applied') continue;
    candidates.push({
      receiptPath: receipt.receiptPath,
      attempt,
      mtimeMs: receipt.mtimeMs || 0,
      ...parsed
    });
  }
  candidates.sort((left, right) =>
    right.attempt - left.attempt ||
    right.mtimeMs - left.mtimeMs ||
    String(right.receiptPath).localeCompare(String(left.receiptPath))
  );
  if (candidates.length === 0) return null;
  const { attempt, mtimeMs, ...selected } = candidates[0];
  return selected;
}

function r2pResumeCanRefresh(metadata, comparison) {
  return metadata.routeKind === 'r2p' &&
    R2P_RESUME_REFRESH_REASONS.has(metadata.manifest.statusReason) &&
    comparison.mismatches.length > 0 &&
    comparison.mismatches.every((field) =>
      field === 'reviewSetFingerprint' || field === 'runMdSha256'
    );
}

function latestR2pBlockingTriageIssueIds(metadata) {
  const latestTriage = readManifestReport(metadata, metadata.manifest.lastTriageReportPath, 'Last triage report path');
  if (!latestTriage || !latestTriage.report || !latestTriage.report.normalized) return [];
  const decisions = Array.isArray(latestTriage.report.normalized.decisions)
    ? latestTriage.report.normalized.decisions
    : [];
  return decisions
    .filter((decision) => decision && decision.non_blocking !== true)
    .filter((decision) => ['accepted', 'reopened', 'downgraded'].includes(decision.decision))
    .filter((decision) => ['high', 'medium'].includes(decision.severity))
    .map((decision) => String(decision.issue_id || '').trim())
    .filter(Boolean);
}

function ledgerPathForMetadata(metadata) {
  return metadata.ledgerPath || statePathFromManifest(
    metadata.projectRoot,
    metadata.targetStateDir,
    metadata.targetKey,
    metadata.manifest.ledgerPath,
    'ISSUES.md'
  );
}

function markR2pRefreshIssuesFixed(metadata, statusReason) {
  if (metadata.routeKind !== 'r2p') return;
  if (!R2P_RESUME_REFRESH_REASONS.has(statusReason)) return;
  const ids = new Set(latestR2pBlockingTriageIssueIds(metadata));
  if (ids.size === 0) return;
  const ledgerPath = ledgerPathForMetadata(metadata);
  const ledger = readLedgerIfPresent(ledgerPath);
  let changed = false;
  const resolution = statusReason === 'r2p-current-stage-repair-required'
    ? 'Fixed by current-stage r2p lifecycle repair; rerun against refreshed artifacts'
    : 'Fixed by r2p lifecycle repair; rerun against refreshed artifacts';
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

function r2pResumeRefreshState(parsed, metadata, liveIdentity, options) {
  const statusReason = R2P_RESUME_REFRESH_REASONS.has(metadata.manifest.statusReason)
    ? metadata.manifest.statusReason
    : 'r2p-repair-applied';
  markR2pRefreshIssuesFixed(metadata, statusReason);
  updatePersistentManifest(metadata, {
    status: 'review',
    currentPhase: 'review',
    blockingReason: 'none',
    statusReason,
    runMdSha256: liveIdentity.runMdSha256,
    reviewSetFingerprint: liveIdentity.reviewSetFingerprint
  });
  return fileSetBase(parsed, metadata, {
    ok: true,
    status: 'review',
    currentPhase: 'review',
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    blockingReason: 'none',
    statusReason,
    fileSetFingerprint: liveIdentity.reviewSetFingerprint,
    nextAction: 'run workflow context for refreshed r2p artifacts'
  }, options);
}

function finalizeAfterR2pRepairApplied(metadata) {
  const repairReceipt = currentRoundR2pRepairReceipt(metadata);
  const nextAction = (repairReceipt && repairReceipt.nextAction) ||
    `run r2p-continue until the active run regenerates artifacts, then rerun ${explicitRouteInvocation(
      'review-fix-r2p',
      metadata.manifest.runtimePlatform
    )}`;
  const finalResponse = {
    finalStatus: 'checkpoint',
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    mode: metadata.manifest.mode,
    target: 'none',
    filesChanged: 'none',
    fixedIssueIds: 'none',
    verificationPerformed: 'same-round finalization blocked pending regenerated-artifact re-review',
    deferralsOrBlockers: 'r2p repair already applied in this round',
    blockingReason: 'none',
    statusReason: 'r2p-repair-applied',
    residualRisk: 'rerun required after r2p regeneration',
    redactionStatement: 'no sensitive values persisted',
    coordinatorAgreement: 'none'
  };
  try {
    writeFinalReceipt(metadata, finalResponse, { nextAction });
  } catch (error) {
    return receiptFailureResult(metadata, error);
  }
  updatePersistentManifest(metadata, {
    status: 'checkpoint',
    currentPhase: 'final',
    blockingReason: 'none',
    statusReason: 'r2p-repair-applied'
  });
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // SUMMARY.md is optional.
  }
  return stateCommandBase(metadata, {
    ok: true,
    status: 'checkpoint',
    currentPhase: 'final',
    blockingReason: 'none',
    statusReason: 'r2p-repair-applied',
    finalResponse,
    fixedIssueIds: [],
    nextAction
  });
}

// ---------------------------------------------------------------------------
// File-set record-diff-review (mirrors diff-review.js for the file set).
// ---------------------------------------------------------------------------

function reopenDiffFailedIssues(metadata, diffReview) {
  const failedIds = new Set((diffReview.findings || []).map((finding) => finding.issue_id));
  if (failedIds.size === 0) return;
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const nextLedger = {
    issues: (ledger.issues || []).map((issue) => {
      if (!failedIds.has(issue.id) || issue.status !== 'fixed') return issue;
      const finding = (diffReview.findings || []).find((item) => item.issue_id === issue.id);
      return {
        ...issue,
        status: 'reopened',
        resolution: `Reopened by diff review: ${finding ? finding.problem : 'diff review failed'}`
      };
    })
  };
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
}

function roundLimitReached(metadata) {
  const rawLimit = metadata.manifest.roundLimit || 'none';
  if (rawLimit === 'none') return false;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return false;
  return Number(metadata.manifest.fixAttemptCount || 0) >= limit;
}

function deferRoundLimitedFindings(metadata) {
  const roundLimit = Number(metadata.manifest.roundLimit);
  const reason = `Round limit reached (rounds=${roundLimit}); deferred for manual follow-up`;
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const nextLedger = {
    issues: (ledger.issues || []).map((issue) => {
      const blocking = ['accepted', 'reopened'].includes(issue.status) &&
        ['high', 'medium'].includes(issue.severity);
      if (!blocking) return issue;
      return { ...issue, status: 'deferred', resolution: `Deferred: ${reason}; owner: none` };
    })
  };
  atomicWriteFile(metadata.ledgerPath, formatLedger(nextLedger));
}

function writeFileSetDiffReviewReport({ metadata, diffReview }) {
  const round = Number(metadata.manifest.currentRound || 1);
  const reportPath = nextReportPath(metadata.targetStateDir, `diff-review-round-${padRound(round)}`);
  const report = { round, normalized: diffReview };
  atomicWriteFile(reportPath, [
    '# Diff Review Report',
    '',
    `Round: ${round}`,
    `Result: ${diffReview.result}`,
    '',
    '```json',
    `${JSON.stringify(report, null, 2)}`,
    '```',
    ''
  ].join('\n'));
  return reportPath;
}

function runFileSetRecordDiffReview(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
    if (metadata.manifest.status !== 'diff-review' || metadata.manifest.currentPhase !== 'diff-review') {
      const error = new Error('state-validation-failed: record-diff-review requires Status: diff-review and Current phase: diff-review');
      error.code = 'ERR_STATE_VALIDATION_FAILED';
      throw error;
    }
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let diffReview;
  try {
    const payload = readStateCommandPayload({
      metadata,
      parsed,
      valueFlag: 'result',
      stdinFlag: 'resultStdin',
      label: 'diff review',
      aliasValueFlag: 'diffReview',
      aliasStdinFlag: 'diffReviewStdin',
      options
    });
    diffReview = parseDiffReview(payload);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  const reportPath = writeFileSetDiffReviewReport({ metadata, diffReview });
  const relativeReportPath = stateRelativePath(metadata.targetStateDir, reportPath);

  if (diffReview.result === 'DIFF-FAIL') {
    try {
      reopenDiffFailedIssues(metadata, diffReview);
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
    if (roundLimitReached(metadata)) {
      deferRoundLimitedFindings(metadata);
      updatePersistentManifest(metadata, {
        status: 'stopped-with-deferrals',
        currentPhase: 'final',
        blockingReason: 'none',
        statusReason: 'round-limit',
        currentReportPath: relativeReportPath,
        lastDiffReviewReportPath: relativeReportPath
      });
      return stateCommandBase(metadata, {
        ok: true,
        status: 'recorded-diff-review',
        currentPhase: 'final',
        diffReviewReportPath: reportPath,
        normalized: diffReview,
        stopReason: 'round-limit',
        roundLimit: Number(metadata.manifest.roundLimit),
        nextAction: 'round limit reached; review deferred findings manually'
      });
    }
    updatePersistentManifest(metadata, {
      status: 'fix',
      currentPhase: 'fix',
      currentRound: Number(metadata.manifest.currentRound || 1) + 1,
      blockingReason: 'none',
      statusReason: 'none',
      currentReportPath: relativeReportPath,
      lastDiffReviewReportPath: relativeReportPath
    });
    return stateCommandBase(metadata, {
      ok: true,
      status: 'recorded-diff-review',
      currentPhase: 'fix',
      diffReviewReportPath: reportPath,
      normalized: diffReview,
      nextAction: 'repair fix and rerun begin-fix'
    });
  }

  updatePersistentManifest(metadata, {
    status: 'full-re-review',
    currentPhase: 'full-re-review',
    blockingReason: 'none',
    statusReason: 'none',
    currentReportPath: relativeReportPath,
    lastDiffReviewReportPath: relativeReportPath
  });
  return stateCommandBase(metadata, {
    ok: true,
    status: 'recorded-diff-review',
    currentPhase: 'full-re-review',
    diffReviewReportPath: reportPath,
    normalized: diffReview,
    nextAction: 'run full re-review'
  });
}

// ---------------------------------------------------------------------------
// File-set finalize. PASS requires review-and-fix + practical/strict-verified, a completed
// diff review AND full re-review after the fix, and no unresolved/deferred blocking issues —
// never PASS from read-only / advisory / diff-review-only / unverified.
// ---------------------------------------------------------------------------

function unresolvedBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => ['accepted', 'reopened'].includes(issue.status) && ['high', 'medium'].includes(issue.severity))
    .map((issue) => issue.id)
    .sort();
}

function deferredBlockingIssues(ledger) {
  return (ledger.issues || [])
    .filter((issue) => issue.status === 'deferred' && ['high', 'medium'].includes(issue.severity))
    .map((issue) => issue.id)
    .sort();
}

function latestFullReviewComplete({ latestReviewer, round }) {
  if (!latestReviewer) return false;
  const report = latestReviewer.report || {};
  if (Number(report.round || 1) !== Number(round || 1)) return false;
  if (report.phase !== 'full-re-review') return false;
  return (report.normalized || {}).result === 'PASS';
}

function latestReviewerPassCurrentRound({ latestReviewer, round }) {
  if (!latestReviewer) return false;
  const report = latestReviewer.report || {};
  if (Number(report.round || 1) !== Number(round || 1)) return false;
  return (report.normalized || {}).result === 'PASS';
}

function compareFileSetIdentity(routeKind, stored, requested) {
  if (routeKind === 'pr') return comparePrIdentity({ stored, requested });
  if (routeKind === 'r2p') {
    const mismatches = [];
    if (String(stored && stored.workId) !== String(requested && requested.workId)) mismatches.push('workId');
    if (String(stored && stored.reviewSetFingerprint) !== String(requested && requested.reviewSetFingerprint)) {
      mismatches.push('reviewSetFingerprint');
    }
    if (String(stored && stored.runMdSha256) !== String(requested && requested.runMdSha256)) {
      mismatches.push('runMdSha256');
    }
    if (String(stored && stored.roundLimit) !== String(requested && requested.roundLimit)) {
      mismatches.push('roundLimit');
    }
    return { match: mismatches.length === 0, mismatches };
  }
  return compareCodeIdentity({ stored, requested });
}

function assertLiveFileSetFreshForPass(metadata, liveIdentity) {
  const stored = storedIdentityFor(metadata);
  const comparison = compareFileSetIdentity(metadata.routeKind, stored, liveIdentity);
  if (comparison.match) return;
  const error = new Error(`stale file-set identity before final pass; mismatched fields: ${comparison.mismatches.join(', ')}`);
  error.code = 'ERR_FINAL_FILE_SET_STALE_IDENTITY';
  throw error;
}

function buildFileSetFinalValidationState(metadata) {
  const round = Number(metadata.manifest.currentRound || 1);
  const ledger = readLedgerIfPresent(metadata.ledgerPath);
  const fixReport = readManifestReport(metadata, metadata.manifest.lastFixReportPath, 'Last fix report path');
  const diffReport = readManifestReport(metadata, metadata.manifest.lastDiffReviewReportPath, 'Last diff review report path');
  const latestReviewer = readManifestReport(metadata, metadata.manifest.lastReviewerReportPath, 'Last reviewer report path');
  const hasFixRound = Boolean(fixReport);
  const fixRoundCurrent = !hasFixRound || Number(fixReport.report.round || 1) === round;
  const unresolvedIds = unresolvedBlockingIssues(ledger);
  const deferredIds = deferredBlockingIssues(ledger);
  const changedFiles = hasFixRound
    ? ((fixReport.report.normalized && Array.isArray(fixReport.report.normalized.filesChanged))
      ? fixReport.report.normalized.filesChanged.join(', ')
      : 'none')
    : 'none';
  return {
    persistent: true,
    fileSet: true,
    target: 'none',
    routeKind: metadata.routeKind,
    mode: metadata.manifest.mode,
    assurance: metadata.manifest.assurance,
    runtimePlatform: metadata.manifest.runtimePlatform,
    strictness: metadata.manifest.strictness,
    filesChanged: changedFiles,
    fixedIssueIds: hasFixRound ? reportIssueIds(fixReport.report) : [],
    unresolvedBlockingIssues: unresolvedIds,
    readOnlyBlockingIssueIds: unresolvedIds,
    readOnlyFindingsIssueIds: unresolvedIds,
    deferredBlockingIssueIds: deferredIds,
    acceptedNonBlockingLowIssueIds: acceptedNonBlockingLowIssueIdsFromLedger(ledger),
    // Partitioned fix rounds run unit-review -> aggregate -> full-re-review and have
    // NO diff-review; the aggregate full-re-review PASS (requiredFullReReviewComplete
    // below) is the equivalent coverage proof. A partitioned active target therefore
    // skips the diff-review requirement. Non-partitioned fix rounds are unchanged.
    requiredDiffReviewComplete: metadata.routeKind === 'r2p'
      ? true
      : (!hasFixRound
      ? true
      : (Boolean(readActivePartitionedPlan(metadata))
        ? true
        : Boolean(
          fixRoundCurrent &&
          diffReport &&
          Number(diffReport.report.round || 1) === round &&
          reportResult(diffReport.report) === 'DIFF-OK'
        ))),
    requiredFullReReviewComplete: metadata.routeKind === 'r2p'
      ? Boolean(fixRoundCurrent && latestReviewerPassCurrentRound({ latestReviewer, round }))
      : Boolean(
        fixRoundCurrent && latestFullReviewComplete({ latestReviewer, round })
      ),
    // File-set routes (review-fix-pr/code) never accept a strict|normal token, so the
    // manifest strictness is always 'normal' and validatePass's strict-only check is never
    // consulted; the value is fixed true rather than computed. If file-set routes ever gain
    // strict mode, compute this against the latest full-re-review context like the doc path.
    strictAcceptedLowIncludedInLatestFullReview: true
  };
}

function finalizationRequiresReceipt(status) {
  return [
    'blocked', 'checkpoint', 'stopped-with-deferrals', 'stopped-no-progress',
    'read-only-findings', 'read-only-clean', 'unsupported', 'externally-changed',
    'possible-target-replacement'
  ].includes(status);
}

async function runFileSetFinalize(parsed, options) {
  let metadata;
  try {
    metadata = resolveFileSetStateMetadata(parsed.targetStateDir);
  } catch (error) {
    return stateValidationResult(parsed.targetStateDir, error);
  }

  let finalResponse;
  let validation;
  try {
    const payload = readStateCommandPayload({
      metadata,
      parsed,
      valueFlag: 'finalResponse',
      stdinFlag: 'finalResponseStdin',
      label: 'final response',
      options
    });
    finalResponse = parseFinalResponseBlock(payload, { allowFileSet: true });
    if (finalResponse.finalStatus === 'pass') {
      if (metadata.routeKind === 'r2p' && metadata.manifest.statusReason === 'r2p-repair-applied') {
        return finalizeAfterR2pRepairApplied(metadata);
      }
      assertLiveFileSetFreshForPass(metadata, await liveIdentityFor(metadata, manifestIdentityInput(metadata), options));
    }
    validation = validateFinalResponse({
      finalResponse,
      state: buildFileSetFinalValidationState(metadata)
    });
  } catch (error) {
    try {
      writeFinalReceipt(metadata, {
        finalStatus: 'blocked',
        fixedIssueIds: 'none',
        filesChanged: 'none',
        verificationPerformed: 'final response validation',
        deferralsOrBlockers: 'final validation failed',
        blockingReason: 'final-validation-failed',
        statusReason: 'none'
      }, { kind: 'final-validation-failed', nextAction: 'repair final response or workflow state before retrying finalize' });
    } catch (receiptError) {
      return receiptFailureResult(metadata, receiptError);
    }
    updatePersistentManifest(metadata, {
      status: 'blocked',
      currentPhase: 'final',
      blockingReason: 'final-validation-failed',
      statusReason: 'none'
    });
    return stateCommandBase(metadata, {
      ok: false,
      status: 'blocked',
      currentPhase: 'final',
      blockingReason: 'final-validation-failed',
      statusReason: 'none',
      errorCode: error && error.code ? error.code : 'ERR_FINAL_VALIDATION_FAILED',
      message: error && error.message ? error.message : String(error),
      nextAction: 'repair final response or workflow state before retrying finalize'
    });
  }

  let nextAction = finalResponse.finalStatus === 'pass' ? 'none' : (finalResponse.deferralsOrBlockers || 'none');
  if (finalizationRequiresReceipt(finalResponse.finalStatus)) {
    try {
      writeFinalReceipt(metadata, finalResponse, { nextAction });
    } catch (error) {
      return receiptFailureResult(metadata, error);
    }
  }

  updatePersistentManifest(metadata, {
    status: finalResponse.finalStatus,
    currentPhase: 'final',
    blockingReason: finalResponse.blockingReason,
    statusReason: finalResponse.statusReason
  });
  try {
    writeWorkflowSummary(metadata, nextAction);
  } catch {
    // SUMMARY.md is command-owned and optional; final status has already been validated and persisted.
  }

  let archiveResult = { archivedStatePath: null, archiveWarning: null };
  if (ARCHIVE_ON_FINALIZE.has(finalResponse.finalStatus)) {
    archiveResult = archiveTerminalStateBestEffort({ targetStateDir: metadata.targetStateDir, options });
    if (archiveResult.archiveWarning) {
      nextAction = archiveFailureNextAction({ fileSet: true });
      try {
        writeWorkflowSummary(metadata, nextAction);
      } catch {
        // SUMMARY.md is command-owned and optional; final status has already been validated and persisted.
      }
    }
  }

  return stateCommandBase(metadata, {
    ok: true,
    status: validation.status,
    currentPhase: 'final',
    finalResponse,
    fixedIssueIds: validation.fixedIssueIds,
    nextAction,
    ...(archiveResult.archivedStatePath ? { archivedStatePath: archiveResult.archivedStatePath } : {}),
    ...(archiveResult.archiveWarning ? { archiveWarning: archiveResult.archiveWarning } : {})
  });
}

module.exports = {
  buildFileSetFinalValidationState,
  runFileSetResume,
  runFileSetRecordDiffReview,
  runFileSetFinalize,
  storedIdentityFor,
  liveIdentityFor
};
