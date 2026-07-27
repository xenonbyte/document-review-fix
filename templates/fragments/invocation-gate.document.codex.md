Full form: `{{ROUTE_INVOCATION}} target=<path> ...`. A bare path is shorthand for `target=<path>`. When `target=` is used, unlabeled paths are rejected.

If a valid target invocation omits both mode and assurance, missing mode selects `review-and-fix` and missing assurance selects `practical`.

Explicit `assurance=advisory` without mode selects `read-only`; advisory assurance cannot write targets. This is an explicit token override, not the pure platform default.

Help-style or invalid invocations still explain usage only. Do not read target/reference bodies, run workflow commands, run probes, create state, or declare a review result for missing target, unknown usage, or explicit help.

Before any `drfx workflow` command, materialize effective `<selectedMode>`, `<selectedAssurance>`, and `<selectedGuard>`. Compute `<selectedMode>` from explicit mode, defaults, and advisory override. Compute `<selectedAssurance>` from explicit assurance or platform default. Compute `<selectedGuard>` from explicit guard or default `git`. Always pass those explicit materialized values to workflow commands; never pass omitted mode, assurance, or guard through to `drfx workflow`.

`rounds=<n>` sets the maximum repair-loop count and is unsupported with `read-only`. When `rounds=<n>` is present, materialize `<roundLimit>` from it and include `rounds=<roundLimit>` on workflow start; otherwise omit the token.

`strict` and `normal` control review strictness only. `assurance=` controls runtime assurance. If `assurance=` is absent, Codex requests `practical`.

Explicit `review-and-fix assurance=advisory` is unsupported as a user request. Do not edit target files, and do not persist effective `Mode: review-and-fix` with `Assurance: advisory`. The only allowed `requestedMode: review-and-fix` plus `Assurance: advisory` path is a V2 runtime downgrade with effective `mode: read-only` and `modeNormalizedFrom: review-and-fix`.
