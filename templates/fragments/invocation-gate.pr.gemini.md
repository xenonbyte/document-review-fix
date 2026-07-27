Full form: {{ROUTE_INVOCATION}} base=<branch> ... . base=<branch> is required and names the merge base for the diff; HEAD is the other end. There is no bare-path or target= form for this route.

This route accepts only base=<branch>, optional read-only, optional guard=git|snapshot, optional root=<project-root>, and optional debug. It does not accept ref=, strict, normal, assurance=, ledger=, or rounds=. Explicit review-and-fix is unsupported on Gemini and must render the unsupported result instead of starting a fix loop.

This is a Gemini code route and is advisory-only. When no mode token is present, materialize read-only. When no assurance token is present, materialize advisory. Use Claude Code, Codex, or opencode for review-and-fix. workflow PASS is unavailable; Gemini must not claim workflow PASS and must not run automatic fixes.

Help-style or invalid invocations explain usage only. Do not read changed files, do not run workflow commands, do not run probes, do not create state, and do not declare a review result.

Before any drfx workflow command, materialize <selectedGuard> from explicit guard or default git, and pass guard=<selectedGuard> to the workflow command.
