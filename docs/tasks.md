# Tasks

Do tasks in order, one at a time, following `AGENTS.md`. Each task is done only when every **Done when** box holds, the verifier says VERIFIED, the reviewer reports no Blocking issues, and the GitLab pipeline is green.

## Conventions
- Commands (once T0 exists): `pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm run ci` (all of these in order). Single-package: `pnpm --filter @yuno/server test`.
- Blocking rules: `docs/architecture.md` §3.
- Tests use the fake runtime and fake channel; live tests only with `LIVE_TESTS=1`.
- Report in `docs/night-report.md` (append): task, result, commits/MR, deferred items, new dependencies with a one-line reason, and **any place an AI suggestion was wrong, an API was guessed, or you corrected yourself**.
- If blocked, write the question in `docs/questions.md`, take the option closest to the docs, and continue. Stop only for something irreversible.

---

## Phase A — foundation

### T0. Scaffold, tooling, CI
pnpm workspaces with `apps/server`, `apps/web`, `packages/shared`; TypeScript strict base config; ESLint (typescript-eslint strict) + Prettier; Vitest in each package; root scripts `lint`, `typecheck`, `test`, `build`, `ci`; `.gitlab-ci.yml` running install (frozen lockfile), lint, typecheck, test, build, and gitleaks; `.gitignore`; `.env.example`; a Fastify server with `GET /api/health`; a Vite React app that renders "Yuno"; one trivial test per package. Node version pinned in `.nvmrc` and `package.json#engines` (Node 24).
**Done when**
- [ ] `pnpm run ci` passes locally from a clean clone.
- [ ] The GitLab pipeline runs every job and is green on the MR.
- [ ] `GET /api/health` returns `{ ok: true }` (test).

### T1. Spike S1 — OpenCode (D5, D7)
Follow D5 "Spike S1" in `docs/decisions.md`. Install `opencode-ai` in a scratch folder (not a repo dependency yet), run `opencode serve`, read the live `/doc` OpenAPI spec, and answer each spike item. If `OPENAI_API_KEY` is set in `.env`, run items 4 (one file-writing prompt and one permission-ask prompt on `openai/gpt-5.4-mini`; keep it under ~200K tokens). Write `docs/spikes.md`: exact version, endpoint and field names, event names and sample payloads (secrets removed), the cost/token fields, whether per-directory `opencode.json` permissions work, the permission round trip, and the resulting adapter design. Do not change `docs/decisions.md`; put proposed changes in `docs/questions.md`.
**Done when**
- [ ] `docs/spikes.md` answers spike items 1–3, and item 4 or "not run: no key".
- [ ] The pinned version is recorded and used by later tasks.

### T2. Shared schemas (R-02)
zod schemas and inferred types in `packages/shared` for: Agent (+ AgentInput), Permissions, Guardrails, Skill, Memory, Schedule, ChannelBinding, WorkflowGraph (with the validation rules from architecture §6 as a function `validateGraph` returning a list of errors), Workflow, Run, RunStep, Message, Approval, Template, SSE event union, allowed models list (D4) with pool labels.
**Done when**
- [ ] Tests: valid and invalid examples for each schema; `validateGraph` catches each rule in §6.
- [ ] Defaults match architecture §8 (guardrails) and D4 (model).

### T3. Database (R-28)
Drizzle schema for every table in architecture §5, migrations, `db/client.ts` (WAL, foreign keys, runs migrations on start), repositories in `db/repos/`. Tests use a fresh in-memory DB.
**Done when**
- [ ] Migrations create every table; WAL and foreign keys are on (test).
- [ ] Repo round-trip tests for agents, workflows, messages (including the unique idempotency key).

### T4. Agents, skills, memory API (R-01, R-02, R-04, R-05, R-32)
Routes from architecture §11 for agents, memories, skills, agent skills, schedules (CRUD only), channel bindings, models. Deleting an agent used by a workflow returns 409.
**Done when**
- [ ] API tests: create → read → update → delete agent; validation errors return 400 with field messages; 409 on delete-in-use; memory and skills attach and detach; a disallowed model is rejected.

### T5. Event hub, SSE, logs (R-21, R-22, R-23, R-29)
`events/hub.ts` (publish/subscribe, persists `log` events), `GET /api/events` with 15 s heartbeat and cleanup on disconnect, agent status changes published as `agent.status`.
**Done when**
- [ ] Test: a published event reaches a connected SSE client; disconnect removes the client; logs are persisted.

### T6. Runtime seam, fake runtime, compiler, protocol (R-04, R-05, R-09)
`runtime/types.ts` exactly as architecture §4; `runtime/fake/` with scripted behavior per agent role (e.g. a "reviewer" rejects on the first iteration and approves on the second; configurable delays, failures, usage); `domain/compile.ts`; `domain/protocol.ts`.
**Done when**
- [ ] Tests: compiled system prompt contains the role, prompt, every memory fact, every attached skill, and the reply protocol; tool map and permissions follow the agent config; blocked commands appear in `denyBash`.
- [ ] Tests: protocol parses `VERDICT:` (case-insensitive, last one wins), extracts and strips `REMEMBER:` lines.

### T7. OpenCode adapter (R-26, R-09)
`runtime/opencode/` implementing `AgentRuntime` per `docs/spikes.md`: session reuse by `sessionKey` (persisted in `runtime_sessions`), writing workspace `opencode.json` permissions, sending system/model/tools, mapping OpenCode events to `RuntimeEvent`, usage totals, timeout and abort, `respondPermission`, `health`. Selected when `RUNTIME=opencode` (default in Docker); `RUNTIME=fake` otherwise.
**Done when**
- [ ] Unit tests with a mocked HTTP layer cover event mapping, timeout, and abort.
- [ ] Opt-in live test (`LIVE_TESTS=1`): a prompt writes a file in a temp workspace and returns usage > 0. Run it once if the key exists; record the result in the night report.

### T8. Message queue and dispatcher (R-14, R-16, R-17, R-32)
`domain/dispatcher.ts` per architecture §6 steps 2, 6, 7, 8: atomic claim, per-agent serialization, global concurrency 4, retry with backoff, dead letter, startup recovery, idempotent enqueue. Message events published to the hub.
**Done when**
- [ ] Tests (fake runtime, fake clock): failed turn retried with backoff then `dead` after 3 attempts; a message left `processing` is recovered and processed exactly once; enqueueing the same idempotency key twice creates one message; two messages for the same agent never run concurrently.

### T9. Workflow engine and run API (R-11, R-12, R-14, R-15, R-25, R-32)
`domain/engine.ts` per architecture §6; routes for workflows, runs, cancel, messages, usage. Step records with tokens and cost; run totals.
**Done when**
- [ ] Test: dev-pipeline graph with the fake runtime — Reviewer rejects once, Coder retries, Reviewer approves, Deployer runs, run `completed`; the message trail has every handoff in order with verdicts.
- [ ] Tests: loop limit fails the run with `loop_limit`; no matching edge fails with `no_matching_edge`; cancel aborts the in-flight turn; invalid graphs are rejected on save and on run.
- [ ] Usage totals per run and per agent are correct.

### T10. Guardrails and approvals (R-06, R-07, R-08, R-09)
`domain/guardrails.ts` and `domain/approvals.ts` per architecture §8 and D7: pre-turn cost and rate checks, mid-turn abort on cost, step gates, tool-permission approvals through `respondPermission`, 30-minute expiry, approval API.
**Done when**
- [ ] Tests: a turn over the run or daily cap is blocked with a visible reason; the rate limit blocks the 31st turn in an hour; a mid-turn usage event over budget aborts the turn; a `requiresApproval` node waits until approved, and rejection fails the run; a fake `permission_request` creates an approval and the decision is passed to `respondPermission`; expiry rejects.

### T11. Scheduler (R-03)
`domain/scheduler.ts` with croner: loads enabled schedules on start, reloads on change, runs a single-agent turn (or starts a workflow run), updates `last_run_at` / `next_run_at`, skips if the agent is busy.
**Done when**
- [ ] Tests (fake clock): interval and cron schedules fire; disabled ones don't; editing reschedules.

### T12. Templates (R-12, R-13)
`templates/dev-pipeline.json` and `templates/research-pipeline.json` per architecture §12, with good agent prompts (Coder writes a small static web app into the workspace; Reviewer inspects the files and gives specific feedback; Deployer copies to `/deployments/<runId>/`; Researcher uses webfetch and cites URLs; Writer writes `report.md`; Editor checks claims against citations). `GET /templates`, `POST /templates/:id/load`.
**Done when**
- [ ] Tests: both templates validate; loading creates missing agents and a new workflow; loading twice reuses agents by name and creates a second workflow; the loaded workflow runs to completion with the fake runtime.

### T13. Channel seam, chat, Slack adapter (R-18, R-19, R-23)
`channels/types.ts`, `channels/fake/`, `domain/chat.ts` per architecture §9, `channels/slack/` with Bolt Socket Mode (DMs and app mentions; ignore bot messages; placeholder then update; 15 s Slack API timeout), `POST /agents/:id/chat` for UI test chat. The Slack adapter starts only if both tokens are set and an agent has an enabled Slack binding.
**Done when**
- [ ] Tests with the fake channel: an inbound message yields a reply from the bound agent's turn; a duplicate `externalEventId` is ignored; bot messages are ignored; the same conversation reuses one session key; inbound and reply messages are persisted and published.
- [ ] Unit test of the Slack event-to-InboundMessage mapping with recorded payload fixtures (no network).

### T14. Docker and one-command setup (R-30)
`docker/` Dockerfiles, `docker-compose.yml` and `Makefile` per architecture §13 (`make up`, `make down`, `make logs`, `make reset` which deletes `data/` after a prompt). Server serves the built web app. Healthchecks for `app` and `opencode`.
**Done when**
- [ ] `make up` from a clean clone (no `.env`) starts all three containers; `/api/health` reports the runtime version, or fake mode when `RUNTIME=fake`.
- [ ] With `RUNTIME=fake`, loading the dev-pipeline template and running it completes inside Docker.

## Phase B — UI (follow architecture §14; use the frontend-ui-engineering skill)

### T15. Web shell (R-29)
Layout, nav with approvals badge and runtime/Slack status pill, routing, typed API client, SSE hook with reconnect and query invalidation, toasts, light/dark theme, empty-state component.
**Done when**
- [ ] Build passes; a test shows the SSE hook invalidates queries on a matching event.

### T16. Agents UI (R-01, R-02, R-03, R-04, R-05, R-20)
Agents list (cards with status, model, channel icons) and the agent editor with all tabs from §14, the configured-dimensions count, Skills library page, and the Test chat tab.
**Done when**
- [ ] Every agent field in the schema can be edited and saved; validation errors show next to fields (component test).
- [ ] Channel binding and Slack status are visible on the list and the editor.

### T17. Workflow builder and templates UI (R-10, R-11, R-12, R-13)
Workflows list, React Flow builder per §14 (add agent nodes, connect, edge condition inspector, requires-approval toggle, max iterations, inline validation, save), Templates gallery with "Load", Run dialog.
**Done when**
- [ ] From the UI: load the dev-pipeline template, change an edge condition, save, reload, and the change persists.
- [ ] A component test covers the edge condition picker.

### T18. Monitor, run detail, approvals (R-06, R-16, R-20, R-21, R-22, R-23, R-24, R-25)
Monitor page, run detail (live graph states, message trail with Slack messages marked, steps with tokens and cost, approval banner), approvals inbox.
**Done when**
- [ ] With `RUNTIME=fake`, starting a dev-pipeline run shows live node states, the trail, and cost updating without a page refresh.
- [ ] Approving from the inbox resumes the run.

## Phase C — wrap-up

### T19. Docs catch-up (night mode deferrals)
Run diagrammer (overview, data flow, run sequence, message lifecycle state diagram, chat flow), explainer (`docs/system-explained.md`), requirements-tracer (full pass), and draft `README.md` with every section R-33 lists (architecture diagram, setup, language and runtime justification from D1/D2, adding a template, adding a channel).
**Done when**
- [ ] Tracer reports the gap list; README has every R-33 section.

### T22. Owner review fixes and CI/CD hardening (do this before T20) (R-09, R-27, R-28, R-03, R-02)
Implements D9's amendment, D11, and D12 in `docs/decisions.md`. Day mode rules in `AGENTS.md` apply. One branch, several small commits, one MR.

1. **Deploy grant (D9).** Add `canDeploy: boolean` (default `false`) to the agent permissions schema and DB JSON. When it is true, `compile.ts` and the OpenCode adapter add a rule that lets that agent write to `/deployments/<runId>/` (create the folder if missing) for the run it is working on, and nowhere else outside the workspace. Every other agent keeps the outside-workspace denial. The dev-pipeline template's Deployer sets `canDeploy: true`, and its prompt copies the approved site into that folder. The agent editor's Tools & permissions tab gets a toggle: "Can deploy (write to this run's deployments folder)".
2. **Model list (Q-06).** The allowlist is exactly `openai/gpt-5.4-mini` (default), `openai/gpt-5.4-nano`, `openai/gpt-5-mini` (labelled "2.5M/day pool"), and `openai/gpt-5.4` (labelled "250K/day pool"). Remove `gpt-5-2025-08-07`. If an existing DB row uses a removed model, show it as "unavailable — pick another" in the UI, and fail its turns with `model_not_allowed`.
3. **Configurable dimensions (Q-36).** One exported list in `packages/shared` names every configurable per-agent setting, each with a group (e.g. name, role, system prompt, model, bash/edit/webfetch permission, blocked commands, can deploy, Slack binding, schedules, memory, skills, run cost cap, daily cost cap, max turns per hour, turn timeout). The agent editor header shows "N configurable dimensions", with a breakdown by group and "M set on this agent". The README states the same N, read from the list (no hard-coded number).
4. **Graph snapshot (Q-38).** Add `graph_snapshot_json` to `runs` (migration). Write it at run start; the engine routes using the snapshot, and the run detail view draws it. Runs created before the migration fall back to the current graph with the existing notice.
5. **UTC label (Q-27).** Every cron input and every next/last-run time in the UI says "UTC".
6. **Local hooks (CI/CD skill).** `pnpm add -D -w husky lint-staged @commitlint/cli @commitlint/config-conventional`, then `pnpm exec husky init`. Hooks: `pre-commit` → `pnpm exec lint-staged` (eslint --fix + prettier on staged files only); `commit-msg` → `pnpm exec commitlint --edit "$1"`; `pre-push` → `pnpm typecheck && pnpm test`. In the commitlint config, extend `@commitlint/config-conventional` and turn off `body-max-line-length` and `footer-max-line-length` (commit bodies hold URLs and the Co-Authored-By trailer). Set `HUSKY: "0"` in CI.
7. **CI additions (CI/CD skill).** Add these to `.gitlab-ci.yml` without changing the existing jobs:
   - `audit`: `pnpm audit --audit-level=high` with `allow_failure: true`.
   - `commitlint` (merge request pipelines only, `GIT_DEPTH: 0`): `pnpm exec commitlint --from "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --to HEAD`.
   - `compose`: image `docker:cli` (pin a current version), `cp .env.example .env && docker compose config -q`. Needs no Docker daemon.
8. **README:** a "Development workflow" section with the CI/CD skill's table (pre-commit, commit-msg, pre-push, CI jobs, how to read a failed pipeline), the escape hatches (`git commit --no-verify`, `HUSKY=0`), and the runner note from D11.

**Done when**
- [ ] Tests: `compile` adds the deploy rule only when `canDeploy` is true, and the path contains the current run id; an agent without it still gets the outside-workspace denial; the template's Deployer has `canDeploy: true`.
- [ ] Tests: the API rejects a model outside the four; the editor shows pool labels.
- [ ] Test: the dimension count in the UI equals the shared list's length, and the "set" count changes when a setting changes.
- [ ] Test: editing a workflow after a completed run leaves that run's detail graph unchanged; the engine uses the snapshot.
- [ ] `echo "bad message" | pnpm exec commitlint` fails; `echo "feat: ok" | pnpm exec commitlint` passes; the pre-commit hook runs lint-staged.
- [ ] The MR pipeline shows the new `audit`, `commitlint`, and `compose` jobs; everything except `audit` is green, and `audit`'s result is noted in the report.
- [ ] README has the Development workflow section.

### T23. Demo polish from the first live run (do this before T20's Slack part) (R-10, R-16, R-22, R-24, R-27)
Found by the owner and Claude in the first real run (2026-10-20). Day mode. One branch, small commits, one MR. UI-only changes need no orchestration_auditor, except item 5, which adds an endpoint.

1. **Approval card shows the agent name.** `components/ApprovalActions.tsx` shows `approval.agentId`. Show the agent's name, looked up from the agents query, falling back to the ID only if the agent no longer exists. The same applies anywhere else an agent ID is shown where a name exists (approvals inbox, run detail).
2. **Readable graph edges.** In both `WorkflowCanvas.tsx` and `RunGraph.tsx`, through one shared helper:
   - nodes get target handles on the left and source handles on the right (layout is left to right);
   - a forward edge (target to the right of the source) is a straight or smoothstep edge between those handles;
   - a backward edge (feedback loop, target to the left) leaves from a bottom handle and enters a bottom handle, drawn as a smoothstep edge that curves under the nodes, so it never overlaps the forward edge;
   - the label sits on a solid background, colored by condition (approved green, rejected red, always neutral, contains neutral with the text).
   On the dev-pipeline graph, the Coder→Reviewer "always" label and the Reviewer→Coder "rejected" label must both be readable, with no line looping around a node.
3. **Loading a template twice.** `POST /templates/:id/load` creates a new workflow each time, so the owner ended up with two "Development pipeline" workflows. On the Templates page, if a workflow with that `template_id` already exists, offer "Open existing" (primary) and "Load a copy". A copy is named "<name> (2)", "(3)", and so on, so names stay unique. The API stays as it is; add the name suffixing on the server.
4. **Blocked and failed runs are visible in message feeds.** In `MessageTrail` (Monitor's recent messages and run detail), when the step that consumed a message was blocked or failed, show a badge with the reason, e.g. "blocked · daily_cost_cap" or "failed · runtime_turn_failed", instead of just "acked".
5. **Live logs survive a reload.** Logs are already persisted (T5). Add `GET /api/logs?limit=` (default 200, max 500, newest last, validated) and have the Monitor seed the live log list from it on load, then append SSE events, de-duplicated by log id. Update the "Logs missed while disconnected are not replayed" note to say the last 200 persisted logs are loaded on open.
6. **Make the rejection loop show up in the demo.** The dev-pipeline Reviewer approved on the first pass, so the demo had no feedback loop. Add a short "house review checklist" to the Reviewer's system prompt in `templates/dev-pipeline.json`. These are standards the task does not mention: a visible Reset/Clear button, amounts formatted to two decimals with a currency symbol, a `<title>` and `<meta name="viewport">`, and a visible keyboard focus style. The Reviewer must reject with a specific list when any item is missing. Do **not** tell the Coder about the checklist; it learns it from the feedback. This is honest behavior (team standards) and makes the reject → fix → approve loop show up reliably. Keep the reviewer's other rules.

**Done when**
- [ ] Component tests: the approval card shows "Deployer", not an ID; the shared edge helper sends backward edges to the bottom handles and forward edges left to right, and labels carry their condition class; the message trail shows the blocked reason badge.
- [ ] API tests: `GET /api/logs` validates `limit` and returns persisted logs in order; loading a template twice yields names "X" and "X (2)".
- [ ] Template test: the dev-pipeline Reviewer prompt contains every checklist item, and the Coder prompt contains none of them.
- [ ] Manual check in the report: with `RUNTIME=fake`, the dev-pipeline graph renders with readable labels (describe what you saw, or write "not checked: no browser").
- [ ] No `LIVE_TESTS=1`. The owner runs the live check.

### T24. Slack display and graph fixes from the live Slack test (R-16, R-19, R-23, R-10)
Found in the live Slack test (2026-10-20). Day mode. One branch, small commits, one MR. Run orchestration_auditor because item 3 touches `channels/slack/`.

1. **Rejected edge renders as a filled shape.** In `apps/web/src/styles.css` (about lines 506–516), the dark-theme rule groups `.condition-rejected .react-flow__edge-text` and `.condition-rejected .react-flow__edge-path` and sets `fill` on both, so the rejected path is filled pink. Split the rule: the path gets `stroke` only, and every edge path keeps `fill: none`; the label text keeps its fill.
2. **Human sender names.** Inbound Slack messages show the raw user ID (`U0C18D79A2F`). Resolve the display name with Slack `users.info` (the `users:read` scope is granted), with the 15-second timeout, an in-memory cache per user, and a fallback to the ID on any error. Store it: add a nullable `from_name` column to `messages` (migration), set to the resolved name for Slack humans and "You (UI)" for UI chat. Show `from_name` wherever a human sender is shown.
3. **Slack markup in text.** Normalize inbound Slack text before it is stored or sent to the agent: `<https://x|label>` becomes `label (https://x)`, `<https://x>` becomes `https://x`, `<@U123>` becomes `@<resolved name>`, and `&amp;`, `&lt;`, `&gt;` are decoded. Pure function with unit tests, in `channels/slack/`.
4. **Reply direction.** Agent replies in a conversation show as "Yuno Assistant → Yuno Assistant". For a message with `fromKind: agent` and a `conversationId`, the trail shows the recipient as the conversation's human (their `from_name`, plus the channel badge), e.g. "Yuno Assistant → Taylor Clements · Slack". Display only; no change to how messages are stored or routed.

**Done when**
- [x] Unit tests: markup normalization (links with and without labels, mentions, entities, plain text unchanged); name resolution uses the cache, falls back to the ID on timeout or error, and never blocks reply delivery for longer than the timeout.
- [x] Component tests: the reply shows "→ <human name>"; a human message shows its `from_name`; the rejected edge path has computed `fill: none` in the dark theme (or a style assertion on the class).
- [x] Migration test: existing messages keep a null `from_name` and display the old ID as a fallback.
- [x] No `LIVE_TESTS=1`. The owner verifies in Slack.

### T20. Live integration (owner present)
With real keys: run the dev pipeline on OpenCode end to end; create the Slack app from `docs/slack-app-manifest.yaml`; chat with the Slack-bound agent, check it uses memory (tell it a fact, ask about it in a new thread). Fix what breaks.
**Done when**
- [x] A real dev-pipeline run completes with a rejection loop and a deployed page at `localhost:8080/<runId>/`.
- [x] A Slack conversation works and appears in the Monitor.

**Status:** ✅ Done 2026-10-20. Evidence: `docs/live-validation.md` (run `438e19f9…`, Slack transcript, guardrail and skill checks).

### T21. Demo and polish (owner present)
Demo script in `docs/demo-script.md`, record the demo, final README pass.

**Status:** ✅ Done 2026-10-20. Runbook: `docs/demo-runbook.md`. Recording: https://www.loom.com/share/60954e1934794390a3e5729f18cde015. README refreshed with live status, key metrics and the runtime trade-off.
