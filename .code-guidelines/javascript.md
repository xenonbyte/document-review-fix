---
name: javascript
description: Semantic correctness guardrails for JavaScript beyond what a linter/formatter enforces mechanically.
appliesTo: ["**/*.js", "**/*.mjs", "**/*.cjs"]
stacks: ["javascript"]
source: original
---

# JavaScript

## Hard Constraints (MUST NOT)

- MUST NOT rely on implicit globals; always declare bindings explicitly with `const`/`let`.
- MUST NOT mutate function parameters or shared objects as a way to return additional data to the caller.
- MUST NOT mix callback-based async code with unhandled promise rejections; unify on `async`/`await` or explicit `.catch`.
- MUST NOT compare objects or arrays with `===` and assume structural equality; use an explicit deep-equality check when structural comparison is intended.
- MUST NOT leave a fire-and-forget async call without an explicit rationale and error handling.

## Ecosystem Idioms & Conventions

- Prefer `const` by default and `let` only when reassignment is required; avoid `var`.
- Prefer pure transformations (`map`/`filter`/`reduce`) over manual loops with mutation when readability is not sacrificed.
- Use optional chaining (`?.`) and nullish coalescing (`??`) instead of manual null-guard chains.
- Prefer named exports for multi-symbol modules; reserve default exports for single-purpose modules.
- Keep side effects (network, filesystem, global state) isolated from pure logic.
- Prefer `Promise.all`/`Promise.allSettled` for independent concurrent operations over sequential `await`.
