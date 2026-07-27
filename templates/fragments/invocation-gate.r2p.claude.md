Full form: `{{ROUTE_INVOCATION}} workId=<WF-...> ...`. A bare `WF-...` token is accepted as shorthand for `workId=<WF-...>`. The target names an active r2p run under `<project>/.req-to-plan/WF-*`; there is no `ref=` or path form for this route.

This route accepts only a bare `WF-...` token or `workId=<WF-...>`, optional `read-only` or `review-and-fix`, optional `resume` or `reset`, optional `rounds=<n>`, optional `root=<project-root>`, and optional `debug`. `resume` and `reset` are mutually exclusive. It does not accept `target=`, `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, `base=`, or `guard=`.

If a valid `workId=<WF-...>` invocation omits mode, missing mode selects `review-and-fix`. This route has a fixed PLAN rubric: there is no user-facing `assurance=` token. For `review-and-fix`, the route internally materializes `practical` assurance (or `strict-verified` only via the same-flow strict proof path).

This route reviews the requirement plan (`07-plan.md`) against `03-06`, but `03-07` and `run.md` stay read-only. Repair means `r2p-reopen` or `r2p-gap-open` only. After repair the route checkpoints, tells the user to run `r2p-continue`, and requires a clean rerun before PASS.

Help-style or invalid invocations still explain usage only. Do not read run artifacts, run workflow commands, run probes, create state, or declare a review result for missing `workId=`, unknown usage, or explicit help.

Before any `drfx workflow` command, materialize effective `<selectedMode>` and `<selectedAssurance>`. Compute `<selectedMode>` from explicit mode or the default `review-and-fix`. Set `<selectedAssurance>` to `practical` for materialized `review-and-fix`, or `strict-verified` only on the same-flow strict proof path; for `read-only` use `practical`. The route exposes no `guard=` token; read-only drift detection is internal and always on. Always pass explicit materialized mode and assurance values to workflow commands; never pass omitted values through to `drfx workflow`.

`rounds=<n>` sets the maximum repair-loop count and is unsupported with `read-only`. When `rounds=<n>` is present, materialize `<roundLimit>` from it and include `rounds=<roundLimit>` on workflow start; otherwise omit the token.
