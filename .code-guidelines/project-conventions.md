---
name: project-conventions
description: Project-specific conventions distilled from this repository's own code; not general best practice.
source: distilled
---

# Project Conventions

## Guardrails

- MUST import Node core modules with the `node:` prefix (`require('node:fs')`), never the bare specifier. (Evidence: `lib/install.js`, `lib/generator.js`)
- MUST throw errors carrying a machine-readable `error.code` in `ERR_<UPPER_SNAKE>` form via the module's local `fail(code, message)` helper; MUST NOT throw a bare `new Error(message)` from `lib/`. (Evidence: `lib/manifest.js`, `lib/target-context.js`, `lib/routes.js`)
- MUST NOT throw to report a workflow outcome; return a result object carrying `status`, `blockingReason`, `statusReason`, and `nextAction` instead, and keep those reason values inside their declared enums. (Evidence: `lib/workflow/index.js`, `lib/workflow/finalize.js`)
- MUST write persisted state, manifests, and receipts through `lib/atomic-write.js` (staging path then rename), never in place over the live file. (Evidence: `lib/workflow-state.js`, `lib/manifest.js`, `lib/receipts.js`)
- MUST pass any value that reaches user-visible output, a receipt, or persisted state through `redactSensitive` before it is emitted. (Evidence: `lib/ledger.js`, `lib/workflow-state.js`, `lib/target-context.js`)
- MUST derive route names, kinds, and defaults from the `lib/routes.js` registry; MUST NOT re-list route names or their defaults in a consuming module. (Evidence: `lib/generator.js`, `lib/input.js`)
- MUST NOT add a runtime or dev dependency: this package ships zero of both and its tests run on `node --test` with the built-in `node:test`. (Evidence: `package.json`, `test/routes.test.js`, `test/input-parsing.test.js`)
- MUST regenerate the golden fixtures under `test/fixtures/` deliberately in the same change that alters generated route text; they are asserted byte-for-byte, so a drifted fixture is a failing test, not a warning. (Evidence: `test/shared-assets.test.js`, `test/helpers/route-shell-snapshot.js`)
