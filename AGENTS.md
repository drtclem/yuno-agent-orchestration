# Yuno — instructions for Codex

Yuno is an AI agent orchestration platform: users create agents, configure them, connect them into visual workflows, and chat with one over Slack. Agents run on OpenCode.

## Read first
- `docs/brief.md`: the original brief (never edit).
- `docs/decisions.md`: goals and decisions (never edit without the owner's approval).
- `docs/architecture.md`: how to build it. **Its Rules section (§3) is binding.**
- `docs/tasks.md`: ordered tasks with "Done when" criteria.
- `docs/requirements.md`: brief → decision → task → test matrix.
- `docs/spikes.md`: what OpenCode's API actually looks like (after T1). Trust it over memory.
- `docs/questions.md`: open questions you raised.

If the task, the code, and the docs disagree: record it in `docs/questions.md`, follow the docs, and continue.

## Commands
| Step | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` (use `pnpm install` only when you change dependencies) |
| Lint + format check | `pnpm lint` |
| Type check | `pnpm typecheck` |
| Tests | `pnpm test` |
| Build | `pnpm build` |
| Everything CI runs | `pnpm run ci` |
| Run (fake runtime, no keys) | `pnpm dev` |
| Run (full stack) | `make up` |

Until T0 is done, these do not exist yet.

## Day mode (active now; set by the owner 2026-10-20)
The owner is around but not watching every step. Make reasonable calls, record them in `docs/questions.md`, and keep going. Stop and ask before anything irreversible, or before spending more than ~300K OpenAI API tokens in one task.

To save time and usage:
- **Spawn only:** tester, verifier, and reviewer for every task. Add orchestration_auditor only for the step-8 paths, and design_critic only for a new decision.
- **Run diagrammer, explainer, and requirements_tracer once,** at the end of a task, and only if it changed something they cover.
- **Do not set `LIVE_TESTS=1`** unless the task says so.

**CI runner (D11):** a persistent project runner, `yuno-mac`, is already registered. Never register, remove, or reconfigure runners, and never change GitLab project settings. If a pipeline sits in "pending" for more than 10 minutes, stop and report it; the runner is probably off.

## For every task, in order
1. **One task** from `docs/tasks.md`. Read it, its R-## rows, and the architecture sections it touches. Read `docs/night-report.md` for what earlier tasks left behind.
2. **Branch:** `git status` must be clean. `git checkout main && git pull --ff-only && git checkout -b codex/T<n>-<slug>`.
3. **Design check** (only if the task needs a decision the docs don't cover, such as a new dependency category, an interface change, or a schema change beyond §5): spawn **design_critic**. On "Rethink", choose the simplest option that fits the docs and log it in `docs/questions.md`.
4. **Tests first:** spawn **tester** with the task's Done-when list. Confirm the new tests fail for the right reason.
5. **Implement** the smallest change that makes them pass, following existing patterns. Use the skills `incremental-implementation`, `test-driven-development`, and `source-driven-development` (check library and OpenCode APIs against official docs or `docs/spikes.md`, never memory). For UI tasks also use `frontend-ui-engineering`.
6. **Verify:** spawn **verifier**. If NOT VERIFIED, fix the cause and re-run.
7. **Review:** spawn **reviewer**. Fix every Blocking finding.
8. **Audit** (any change to `domain/dispatcher.ts`, `engine.ts`, `guardrails.ts`, `approvals.ts`, `scheduler.ts`, `chat.ts`, `runtime/`, `channels/`, or `events/`): spawn **orchestration_auditor**. Fix every Critical and High finding.
9. After fixes in 7–8, re-run verifier and the reviewer (and the auditor if it applied).
10. **Diagrams / explainer / tracer** (see Day mode for when): **diagrammer** if a component, boundary, message type, or flow changed; **explainer** if the engine, dispatcher, runtime adapter, channel, or guardrails changed; **requirements_tracer** always.
11. **Report:** append to `docs/night-report.md` on the task branch and commit it, so it merges with the task:
    ```
    ## T<n> — <title> — DONE | PARTIAL | BLOCKED
    - Changed: ...
    - Verifier: VERIFIED / NOT VERIFIED (why) · Reviewer: ... · Auditor: ...
    - MR: <link>
    - Deferred (Should fix / Medium / Low): ...
    - New dependencies: <name> — <one-line reason>
    - AI corrections: anything where a suggestion was wrong, an API was guessed, or you corrected yourself
    ```
    Mark DONE only if every item in "A task is NOT done until" will hold once the pipeline passes. If the pipeline then fails, fix it on the branch and update the entry before merging.
12. **Push and merge** (see Git). The task ends when the MR is merged and `main` contains the report entry.

## A task is NOT done until
- verifier says **VERIFIED**, and
- reviewer says **No blocking issues**, and
- for the paths in step 8, orchestration_auditor says **No Critical/High findings**, and
- the GitLab pipeline for the branch is **green** and the MR is merged.

## Hard rules (never cut)
- Never skip, disable, delete, or weaken tests, assertions, lint rules, CI jobs, or thresholds to get green. No new `any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, or non-null `!` without a one-line reason on the same line.
- Never edit `docs/brief.md`, `docs/decisions.md`, or `docs/architecture.md`. Propose changes in `docs/questions.md`.
- No features or abstractions outside the current task. No "for later" code.
- **Secrets:** only from env, read in `apps/server/src/config.ts`; every new variable goes in `.env.example` with a placeholder. Never `cat`, print, or echo `.env` or any key; check presence with `test -n "$VAR"`. No key ever reaches the browser, a log line, a prompt, a workspace file, or a commit.
- Every external call has a timeout and a visible failure state.
- Tests never call OpenAI or Slack unless `LIVE_TESTS=1`. CI never sets it. Live runs use `gpt-5.4-mini`.
- Every new dependency gets a one-line reason in the report. Prefer what is already installed.
- Do not touch `~/Projects` outside this repo.

## Git (the main agent commits and merges; subagents only read git)
- Conventional Commits, one logical step each: `feat(engine): route reviewer verdicts along edges`, `test(dispatcher): cover crash recovery`. Body includes `Task: T<n>`. Several small commits per task.
- End every commit message with: `Co-Authored-By: Codex <noreply@openai.com>`
- Never commit `.env*` (except `.env.example`), `data/`, keys, or a lockfile change without its manifest change.
- First push opens the MR:
  `git push -u origin <branch> -o merge_request.create -o merge_request.target=main -o merge_request.title="T<n>: <task title>" -o merge_request.remove_source_branch`
- Wait for the pipeline: `glab ci status --live` (or poll `glab ci status` every 60 s, at most 20 minutes). If it fails, read the job log with `glab ci trace <job>` (or `glab ci view`), fix, push, repeat.
- **Merge** when every "Done" item holds: `glab mr merge <MR> --auto-merge --remove-source-branch --yes`, then `git checkout main && git pull --ff-only` and confirm your commits are on `main`. If the branch is behind, rebase on `origin/main`, re-run the verifier, push with `--force-with-lease` (your branch only), and merge again.
- Never push to `main` directly (D11). If `glab` is unavailable or the pipeline cannot run, stop and report it.
- Never force-push `main`.
