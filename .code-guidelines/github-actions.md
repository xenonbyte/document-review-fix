---
name: github-actions
description: Semantic GitHub Actions workflow guardrails for supply-chain safety and least-privilege execution.
appliesTo: ["**/.github/workflows/*.yml", "**/.github/workflows/*.yaml"]
stacks: ["github-actions"]
source: original
---

# GitHub Actions

## Hard Constraints (MUST NOT)

- MUST NOT reference a third-party action by a mutable tag (`@v3`) or a branch (`@main`); pin to a full commit SHA to prevent supply-chain tampering.
- MUST NOT grant the default `GITHUB_TOKEN` broader `permissions` than the job needs; set an explicit least-privilege `permissions:` block at the workflow or job level.
- MUST NOT print secrets to logs (`echo`, `cat`) or pass them as CLI arguments; pass secrets via environment variables consumed directly by the tool that needs them.
- MUST NOT check out and build untrusted fork code inside a `pull_request_target` job that also has access to repository secrets; this pattern enables secret exfiltration.
- MUST NOT auto-execute untrusted PR content (via `workflow_run` or `pull_request_target`) without an explicit approval gate before secrets or elevated tokens are in scope.
- MUST NOT authenticate to a cloud provider (AWS/Azure/GCP) with long-lived static access keys stored as secrets when OIDC federation is available; prefer OIDC for short-lived, workflow-scoped credentials.

## Ecosystem Idioms & Conventions

- Use `actions/checkout` with the narrowest `fetch-depth` needed (default shallow) unless full history is required.
- Cache dependencies (`actions/cache` or language-specific cache options) keyed by a lockfile hash to speed up repeat runs.
- Use reusable workflows (`workflow_call`) or composite actions to avoid duplicating job logic across files.
- Set a `concurrency` group per ref so superseded runs (e.g. new pushes to the same PR) are canceled automatically.
- Use environment protection rules and required reviewers for jobs that deploy to production.
