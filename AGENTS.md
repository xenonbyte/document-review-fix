# Repository Guidelines

## Project Structure & Module Organization

This repository is a Node.js 20 CommonJS package for installing document and code review-fix routes. This file covers commands and conventions; deep architecture (data flow, key design constraints) lives in `CLAUDE.md` — read it before changing install, capability, manifest, or workflow code.

- `bin/drfx.js` is the CLI entry point.
- `lib/` contains implementation modules: input parsing, install/uninstall, manifests, capabilities, locks, ledgers, receipts, redaction, rulebooks, route generation, and `yaml-block-mapping.js` (a deliberately narrow YAML block-mapping reader used only to gate the Codex invocation policy at install time).
- `lib/adapters/` contains platform capability adapters for Claude, Codex, Gemini, and opencode.
- `skills/` stores source skill descriptors. Each also carries `agents/openai.yaml`, byte-identical to `templates/codex-openai.yaml`, so a hand-copied descriptor behaves like an installed route.
- `shared/` stores reusable workflow text, prompts, rubrics, and long-task protocol content.
- `templates/` contains generated route templates for supported platforms. `*.tmpl` files go through `{{PLACEHOLDER}}` substitution; `codex-openai.yaml` is copied verbatim into every generated Codex skill instead.
- `scripts/` contains development utility scripts such as `syntaxcheck.js`.
- `test/` contains Node test files and fixtures.
- `.code-guidelines/` is maintained by the `/code-guidelines*` commands, not by hand; the pointer block at the end of this file and of `CLAUDE.md` is regenerated from it.

## Build, Test, and Development Commands

- `npm test` runs the full `node --test` suite.
- `node --test test/<file>.test.js` runs one test file; append `--test-name-pattern="<regex>"` to run a single test by name (e.g. `node --test --test-name-pattern="gate7 rerun-PASS only after clean re-review" test/r2p-route.test.js`).
- `npm run syntaxcheck` parse-checks (`node --check`) every `.js` file under `bin/`, `lib/`, and `test/` without executing it.
- `node bin/drfx.js doctor` runs local capability checks and validates advisory/pass capability reporting.
- `assurance=strict-verified` is unreachable today: all adapters report reviewer capabilities as `unverified`, so `drfx doctor` never emits a verified proof. Use `assurance=practical` for automatic fixes; strict-verified stays wired for when an adapter supplies verified proof.
- `node bin/drfx.js status` reports which generated routes are installed per platform.
- `node bin/drfx.js install [--platform claude,codex,gemini,opencode]` installs generated routes for local manual testing (`--platform` is optional; omit it for all platforms).
- `node bin/drfx.js uninstall [--platform claude,codex,gemini,opencode]` removes manifest-owned generated routes.
- `install` is a clean reinstall, not in-place overwrite: it uninstalls the previous manifest-owned install before writing the new plan (so renamed/dropped routes don't orphan), preflights every requested platform before touching any, and restores the prior install from the captured rollback if the reinstall fails (`lib/install.js`).
- `npm pack --dry-run` verifies package contents before publishing or release checks.

CI (`.github/workflows/ci.yml`) runs `npm run syntaxcheck` and `npm test` on Node 20, 22, and 24 for pushes to `main` and pull requests.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and keep files plain JavaScript. Follow the existing style: two-space indentation, semicolons, single quotes, small pure helpers, and explicit error codes such as `ERR_UNKNOWN_TOKEN`. Prefer narrow modules with clear boundaries. Keep generated-route text in `shared/` or `templates/`, not embedded in implementation code.

## Testing Guidelines

Tests use Node's built-in `node:test` and `assert`. Name test files as `*.test.js` under `test/`. Add focused tests beside the behavior being changed: parser changes in `input-parsing.test.js`, route registry and invocation syntax in `routes.test.js`, manifest/state changes in `target-state.test.js`, route text checks in `shared-assets.test.js`, install behavior and the Codex plan validators in `capability-check.test.js`, the invocation-policy YAML reader in `yaml-block-mapping.test.js`, shipped `skills/` descriptors in `source-skill-descriptors.test.js`, published package contents in `pack-contents.test.js`, file-set PR/CODE lifecycle in `workflow-fileset-lifecycle.test.js`, r2p route lifecycle in `r2p-route.test.js`, and CLI command behavior in `cli.test.js`.

Golden output under `test/fixtures/{generated,embedded}/<platform>/` has no regeneration script, but it must not be edited by hand either — it is asserted byte-for-byte. After changing `lib/generator.js`, `templates/`, or `shared/`, rewrite the affected fixtures by rendering through the same helper the tests use, then review the diff before keeping it:

```js
// node -e '<this>'  — writes only fixtures whose rendered output actually changed
const fs = require('node:fs');
const { renderPlatformRoute } = require('./lib/generator');
const { listRoutes } = require('./lib/routes');
const h = require('./test/helpers/route-shell-snapshot');
for (const p of ['claude', 'codex', 'gemini', 'opencode']) for (const r of listRoutes()) {
  const out = renderPlatformRoute(p, r.routeName, { packageVersion: '0.0.0-snapshot' });
  for (const [file, text] of [
    [h.snapshotPath(p, r.routeName), h.maskEmbeddedSharedContent(p, out)],
    [h.embeddedSnapshotPath(p, r.routeName), h.extractEmbeddedSharedContent(p, out)]
  ]) if (fs.readFileSync(file, 'utf8') !== text) { fs.writeFileSync(file, text); console.log('updated', file); }
}
```

A fixture that changes in a run you did not expect to touch generated text is a real regression, not drift to absorb. `test/shared-assets.test.js` also pins byte baselines (`GENERATED_SHELL_BASELINE_BYTES` as a growth budget, `CODEX_SHARED_DEDUP_EXPECTED_MEASUREMENT` as an exact measurement); the latter is recomputed from live code by the test itself, so a `deepEqual` failure there means the numbers in the file are stale, never that the measurement is wrong.

## Documentation Synchronization

When updating public README behavior, keep `README.md` and `README.zh-CN.md` structurally aligned. Preserve technical literals such as commands, paths, option names, payload fields, and status codes in English.

## Adding a Platform

A platform spans ~16 sync sites; missing one silently breaks install, the runtime trust gate, or the byte-snapshot fixtures. Update every site below and run `npm test` (snapshot tests catch most fixture drift, but the runtime allowlists and descriptor lists are only partly covered — see `test/workflow-args.test.js`).

- **Decide capability first**: a full review-and-fix platform (parity with Codex/Claude Code) or an advisory-only platform (parity with Gemini). This gates the `lib/workflow/index.js` write-eligibility allowlists.
- **CLI + adapter**: help text in `bin/drfx.js`; new `lib/adapters/<platform>.js`.
- **Capability/install/manifest**: `PLATFORMS` and the default platform list in `lib/capability.js`; `PLATFORMS`, `ADAPTERS`, and `normalizePlatformRoots` in `lib/install.js`; `PLATFORMS`, `defaultPlatformRoots`, and `platformAllowlist` in `lib/manifest.js`.
- **Routes/generator/templates**: `DEFAULT_PLATFORM_POLICY` and `SLASH_INVOCATION_PLATFORMS` in `lib/routes.js` (the latter decides `$` vs `/` in every user-facing invocation, and needs BOTH the install name and the runtime name when they differ, as `claude`/`claude-code` do — omitting it silently degrades every message to the "both syntaxes" fallback instead of failing); `PLATFORM_TEMPLATES`, `platformInvocationText`, and `codeRouteInvocationText` in `lib/generator.js`; a new `templates/<platform>-*.tmpl` plus the `templates/fragments/{invocation-gate,route-contract}.{document,pr,code,r2p}.<platform>.md` fragments (two fragment types × four route kinds per platform).
- **Runtime platform + state**: `RUNTIME_PLATFORMS` in `lib/workflow/index.js`, `lib/workflow-state.js`, `lib/semantic-parsers.js`, and `lib/no-state.js`. For a full platform, also add it to the three write-eligibility allowlists in `lib/workflow/index.js` (preflight, practical, strict-verified). For strict-verified support, add it to `DESCRIPTOR_PLATFORMS` and `PROOF_PATTERN` in `lib/workflow-state.js`.
- **Exclusions**: add the platform's home/config dir (e.g. `.opencode`) to the exclusion sets in `lib/snapshot-guard.js` and `lib/target-context.js`.
- **Tests + fixtures**: `EXTENSION_BY_PLATFORM` and the mask/extract branches in `test/helpers/route-shell-snapshot.js`; the platform loops in `test/shared-assets.test.js`, `test/cli.test.js`, and `test/capability-check.test.js`; regenerate `test/fixtures/{generated,embedded}/<platform>/*`.
- **Docs + metadata**: the `description` field in `package.json`; `README.md` and `README.zh-CN.md` (kept aligned); `CLAUDE.md`; and the platform list in this file.

## Releasing

`main` is linear — releases fast-forward, never merge-commit. The observed sequence is: land the work, then a separate `chore: release <version>` commit carrying the `package.json` bump and the new `CHANGELOG.md` section; then `npm publish`, an annotated `v<version>` tag whose message is just the version, and a GitHub release whose title is the tag and whose body is that CHANGELOG section with its `## <version> - <date>` heading removed.

Verify before publishing, since `npm publish` cannot be undone: `npm test`, `npm run syntaxcheck`, and `npm pack --dry-run` on `main` after the fast-forward; confirm the version is not already on the registry (`npm view @xenonbyte/drfx versions`).

## Commit & Pull Request Guidelines

The git history uses concise conventional-style prefixes, for example `feat:` and `chore:`. Keep commits scoped and imperative, such as `feat: add workflow parser`. Pull requests should include a short problem statement, implementation summary, tests run, and any installer, filesystem, or security implications.

## Security & Configuration Tips

Never store raw secrets, credentials, cookies, private keys, or raw logs in workflow state, tests, receipts, or generated prompts. Preserve manifest-backed install safety: uninstall must remove only package-owned files and must not delete user rule files or project `.drfx` state.

<!-- code-guidelines:begin -->
Maintained by /code-guidelines. Do not edit between these markers.
Progressive-disclosure rule pointers:
- Before any edits, read `.code-guidelines/project-conventions.md` (project conventions).
- Before editing `**/*`, read `.code-guidelines/guardrails-core.md`.
- Before editing `**/*.js`, `**/*.mjs`, `**/*.cjs`, read `.code-guidelines/javascript.md`.
- Before editing `**/.github/workflows/*.yml`, `**/.github/workflows/*.yaml`, read `.code-guidelines/github-actions.md`.
<!-- code-guidelines:end -->
