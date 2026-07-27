---
name: guardrails-core
description: Universal clean-code and anti-over-engineering guardrails that apply to every repository regardless of stack.
appliesTo: ["**/*"]
stacks: ["guardrails-core"]
source: original
---

# Guardrails Core

## Hard Constraints (MUST NOT)

- MUST NOT add speculative abstractions, plugin systems, or configuration knobs for a requirement that does not yet exist.
- MUST NOT swallow errors silently: no empty `catch`/`except` blocks, no discarding a return value that signals failure.
- MUST NOT leave dead code, commented-out blocks, or TODO placeholders as a substitute for a real implementation.
- MUST NOT duplicate logic that already exists elsewhere in the codebase; reuse or extract instead of copy-pasting.
- MUST NOT introduce a new dependency, framework, or architectural layer to solve a problem a few lines already solve.
- MUST NOT guess at missing configuration, requirements, or contracts; fail loudly or ask rather than inventing a silent default.
- MUST NOT mix unrelated changes (refactors, formatting, feature work) into a single change.
- MUST NOT hardcode values that vary by environment or product (endpoints, IDs, timeouts, secrets); derive them from configuration or named constants.
- MUST NOT add a fallback path that is unobservable; any fallback must be visible in logs, metrics, or errors.
- MUST NOT reformat or restructure unrelated code while making an unrelated change.
- MUST NOT acquire a resource (timer, listener, subscription, handle, connection, watcher) without a corresponding deterministic release or cleanup.

## Ecosystem Idioms & Conventions

- Prefer the smallest change that fully satisfies the requirement; do not gold-plate.
- Match existing project naming, structure, and conventions before introducing new patterns.
- Keep modules small and cohesive; split a file when it loses cohesion, not merely when it crosses a line-count threshold.
- Validate all external input (API payloads, CLI args, file contents, env vars) at the boundary before it flows deeper into the system.
- Make invariants explicit through types, assertions, or guards rather than through comments alone.
- Prefer composition over deep inheritance hierarchies.
- Write for the next reader: prefer clear, descriptive names over clever one-liners.
- When behavior changes, update the tests and documentation in the same change, not as follow-up work.
- Prefer removing complexity over adding a layer to work around it.
