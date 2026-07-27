Full form: {{ROUTE_INVOCATION}} workId=<WF-...> ... . A bare WF-... token is accepted as shorthand for workId=<WF-...>. The target names an active r2p run under <project>/.req-to-plan/WF-*. There is no ref= or path form for this route.

This route accepts only a bare WF-... token or workId=<WF-...>, optional read-only, optional root=<project-root>, and optional debug. It does not accept target=, ref=, strict, normal, assurance=, ledger=, scope=, base=, guard=, review-and-fix, resume, reset, or rounds=.

If a valid workId=<WF-...> invocation omits mode, missing mode selects read-only. Gemini is advisory-only: review-and-fix is unsupported, workflow PASS is unavailable, and Gemini must not edit 07-plan.md, the upstream docs (03-06), or run.md.

run.md is a read-only gate that is never written. This route reviews 07-plan.md against 03-06, but 03-07 and run.md remain read-only evidence.

Help-style or invalid invocations explain usage only. Do not read run artifacts, do not run workflow commands, do not run probes, do not create state, and do not declare a review result.

Before any drfx workflow command, materialize read-only mode. This route exposes no guard= token; drift detection is internal and always on.
