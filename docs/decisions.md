# Decision log

Single source for every product and architecture choice. Codex: never edit this file without the owner's approval. New decisions found while building go in `docs/questions.md`; the owner moves them here.

## Goals
_Signed off by owner, 2026-10-19 (goals accepted with the stack discussion). Context: TypeScript monorepo; built by Codex CLI on the owner's Mac; deadline about 30 hours from 2026-10-19 19:00 CT._

| ID | Goal | Brief line |
|---|---|---|
| G1 | A real end-to-end demo: a 2+ agent workflow on OpenCode calls tools, exchanges messages, and reaches a conclusion, plus a live Slack chat with an agent | Evaluation 40%; "Working End-to-End Demo" |
| G2 | Clean layering (UI / runtime integration / persistence) behind small interfaces, with tests on agent creation, workflow execution, and message delivery | Evaluation 30%; "Code Quality Expectations" |
| G3 | Rich, clear configuration per agent, a visual workflow builder, and live monitoring | Evaluation 20%; Key metric "configurable dimensions per agent" |
| G4 | README covering the architecture diagram, setup, language and runtime justification, and how to add a template or a channel | Evaluation 10% |
| G5 | Fast from zero to a running workflow: one command, seeded templates, one click to run | Key metric "time from zero to a working multi-agent workflow" |
| G6 | Reliable: durable agent-to-agent messages, retries and timeouts, loop caps, clear failure states | Key metrics "task completion rate", "message reliability" |

## Decision agenda
| # | Decision | Status |
|---|---|---|
| D1 | Agent runtime | ✅ OpenCode, driven over its HTTP server |
| D2 | Language and stack | ✅ TypeScript monorepo: Fastify, React + Vite + React Flow, SQLite + Drizzle, SSE |
| D3 | External channel | ✅ Slack via Bolt in Socket Mode |
| D4 | Model and provider | ✅ OpenAI `gpt-5.4-mini` by default (complimentary 2.5M tokens/day pool) |
| D5 | How agent config reaches OpenCode | ✅ Per-workspace `opencode.json` + per-session permission rules each turn; system/model per prompt; no per-prompt tool switches (confirmed by S1 and T7) |
| D6 | How agents hand off to each other | ✅ Platform-owned durable message queue; output plus parsed `VERDICT:` line drive the graph |
| D7 | Interaction rules and approvals | ✅ Workflow step gates, plus OpenCode permission "ask" routed to an approval inbox (confirmed live in T7) |
| D8 | Memory and skills | ✅ Platform-owned, compiled into the agent's instructions; agents add memories with `REMEMBER:` lines |
| D9 | What "deploy" means | ✅ Copy approved output into `/deployments/<runId>/`, served by a static container; only agents with `canDeploy` may write there, and only for their own run |
| D10 | Build process | ✅ Codex CLI, one task per fresh `codex exec`, GitLab pipeline gate, auto-merge |
| D11 | CI runner and branch protection | ✅ One persistent project runner (`yuno-mac`, Docker on the owner's Mac); "pipelines must succeed" on; no direct pushes by Codex |
| D12 | Owner review of Codex's night-mode questions | ✅ All accepted except Q-06, Q-27, Q-36, Q-38, which get changes in T22 |

## Issues spotted in the brief
| Issue | Resolved by |
|---|---|
| None of the three runtimes provides multi-agent workflow orchestration (OpenClaw's "Agent Teams" is an RFC). The platform has to own the workflow engine, message bus, guardrails, and approvals. | ✅ D1, D6 |
| "Interaction rules" and "guardrails" are only meaningful if enforced at run time, and evaluators will probe that live. | ✅ D7, architecture Rules |
| OpenCode has v1 and v2 documentation with different config shapes (for example, MCP servers moved to `mcp.servers` in v2). Code built against the wrong one breaks. | ✅ D5 spike S1 pins one version |
| The complimentary OpenAI tokens apply only while inputs and outputs are shared with OpenAI. | ✅ D4 (no secrets in prompts) |

## Decisions

### D1. Agent runtime
**Status:** Decided (2026-10-19)
**In plain terms:** The runtime is the engine that actually runs one agent's turn: it calls the model, runs tools (shell, file edits, web fetch), and returns the result. Everything else (workflows, messages, limits, the UI) is ours.
**Options considered**
- **A. OpenCode** _(chosen)_: `opencode serve` is a headless HTTP server with an OpenAPI 3.1 spec, a typed JS SDK, an SSE event stream, per-message `system`/`model`/`tools` fields, cost on responses, and a permission-response endpoint.
- B. OpenClaw: brings channels, cron, and memory out of the box, but it is a personal-assistant gateway with its own SQLite state (two sources of truth) and needs a gateway restart to add agents, which fights creating agents from the UI.
- C. Goose: clean MCP extension model, but its REST server mainly backs the desktop app, and it is Rust, which splits the language story.
**Worked example:** The "Dev Environment" workflow. With OpenCode, the platform sends the Coder's prompt to a session whose workspace is `data/workspaces/run-42`; OpenCode writes `app.js` with its edit tool and returns text plus token and cost data. The platform then routes the output to the Reviewer. With OpenClaw, the same routing would have to go through the gateway's channel bindings, and the run state would live partly in OpenClaw's database.
**Decision:** OpenCode, version pinned exactly in Docker and `package.json` (pinned in spike S1).
**Why:** G1 (the coding example in the brief is OpenCode's strength), G2 (a clean adapter over HTTP), G3 (we build scheduler, memory, and channels, which are graded features anyway).
**Spike S1:** see D5.
**Known gap, for the writeup:** OpenCode is a coding agent; non-coding agents (researcher, Slack assistant) still run on it and use its web-fetch and file tools.

### D2. Language and stack
**Status:** Decided (2026-10-19)
**In plain terms:** One language end to end, so types are shared between server and UI, and one build agent works in one ecosystem.
**Decision:**
- TypeScript (strict) everywhere, pnpm workspaces monorepo.
- Server: Node 24 + Fastify. UI: React + Vite + TanStack Query + React Flow (`@xyflow/react`) + shadcn/ui + Tailwind.
- Persistence: SQLite (WAL mode) through Drizzle ORM and `better-sqlite3`. Validation: zod schemas in `packages/shared`.
- Realtime: SSE from server to browser; REST for commands.
- Tests: Vitest; Fastify `inject` for API tests.
- Packages: install the latest stable versions at T0; the lockfile pins them.
**Options considered**
- **A. TypeScript** _(chosen)_: matches the OpenCode SDK and shares types.
- B. Python backend + React UI: two languages and duplicated types.
- WebSocket instead of SSE: rejected because the browser only needs pushed updates; SSE is simpler and reconnects by itself.
- Postgres/Redis: rejected because they add services to the one-command setup with no benefit at this scale.
**Why:** G2, G5.
**Known gap, for the writeup:** SQLite means one server process; scaling out would need Postgres and a real queue.

### D3. External channel
**Status:** Decided (2026-10-19)
**Decision:** Slack, using `@slack/bolt` in Socket Mode (an outbound WebSocket, so no public URL or ngrok). The owner creates the app from `docs/slack-app-manifest.yaml` and supplies `SLACK_BOT_TOKEN` (`xoxb-`) and `SLACK_APP_TOKEN` (`xapp-`, scope `connections:write`). Behavior: ignore messages with a `bot_id` or from the bot itself; dedupe on Slack `event_id`; one runtime session per DM or thread; post "thinking…" immediately, then `chat.update` it with the answer.
**Options considered:** Telegram (simplest setup) and WhatsApp (needs Meta business setup) were the alternatives; the owner chose Slack.
**Why:** G1.
**Known gap, for the writeup:** Socket Mode suits local and single-instance deployments; a hosted deployment would use the HTTP Events API.

### D4. Model and provider
**Status:** Decided (2026-10-19)
**In plain terms:** The owner's OpenAI org shares traffic with OpenAI, which grants 250K tokens/day on the large models and 2.5M tokens/day on the mini/nano models. Agent loops resend their history and tool definitions every step, so a single coding turn can use 50–150K tokens.
**Worked example:** At about 100K tokens per agent turn and about 5 turns per dev-pipeline run, one run uses about 500K tokens, which is twice the whole large-model pool for a day. On `gpt-5.4-mini` the same run uses about 20% of the 2.5M pool.
**Decision:** Default model `openai/gpt-5.4-mini` for every agent. The model dropdown offers only models in the two complimentary pools, labeled by pool. Costs shown in the UI are labeled "estimated" (list prices, not the free allowance).
**Why:** G1 (room for many test and demo runs).
**Known gap, for the writeup:** The complimentary tokens require sharing prompts with OpenAI, so no secrets may appear in prompts or workspaces.

### D5. How agent config reaches OpenCode
**Status:** Decided (2026-10-19); amended 2026-10-20 after spike S1 and T7 (Q-04, Q-17).
**Amendment (2026-10-20):** S1 found that OpenCode 1.19.3 turns per-prompt tool booleans into session allow rules, which silently override "ask" (an agent with bash set to "ask" would run commands without approval). So per-prompt `tools` are not sent. Tool on/off is expressed as permissions only (off = deny; on = the configured allow/ask), written to the workspace `opencode.json` and replaced on every reused session with `session.update`. System prompt and model are still sent per prompt. Verified live in T7: changed-permission denial in the same session, bash ask then reject, blocked wildcard, outside-workspace edit denied. Upgrading OpenCode requires re-running the live test (`LIVE_TESTS=1`). These are OpenCode-level rules; the operating-system boundary is the `opencode` container.
**In plain terms:** Agents are created in our UI, but OpenCode normally reads agents from config files. We need a way to apply each agent's prompt, model, tools, and permissions per turn.
**Decision:** The agent compiler (`apps/server/src/domain/compile.ts`) turns an agent record into:
1. A system prompt made of the role, the system prompt, memory facts, attached skills, workflow instructions, and the reply protocol (D6).
2. The model as `{ providerID: "openai", modelID }`.
3. A tool map (for example `{ bash: true, edit: false, webfetch: true }`).
4. Permissions (`allow` / `ask` / `deny`, with deny patterns for blocked bash commands).

Items 1–3 are sent on each prompt (`POST /session/:id/message` accepts `system`, `model`, `tools`). Item 4 is written to `opencode.json` in that run's workspace directory, and requests carry the directory (the `x-opencode-directory` header or the SDK's `directory` option).
**Spike S1 (task T1):**
1. Pin the latest stable `opencode-ai` version; record it.
2. From the live `/doc` OpenAPI spec, confirm the message body fields, the directory option, the event names for message updates, tool calls, and permission requests, and where tokens and cost appear.
3. Confirm a workspace `opencode.json` with `permission` settings is honored per directory.
4. With a real key: one prompt on `openai/gpt-5.4-mini` that writes a file, and one that triggers a permission request.
Record the results in `docs/spikes.md`. If item 3 fails, fall back to `PATCH /config` before each turn, serialized per agent.

### D6. How agents hand off to each other
**Status:** Decided (2026-10-19)
**In plain terms:** When the Coder finishes, its output must reach the Reviewer reliably, and the Reviewer's verdict decides what happens next. The platform does this, not the runtime.
**Options considered**
- **A. Platform queue + reply protocol** _(chosen)_: Each agent turn ends with a final reply. The engine stores it as a message to the next agent, chosen by the workflow graph. Reviewers end their reply with `VERDICT: APPROVED` or `VERDICT: REJECTED`, which edge conditions read.
- B. Agents call a `send_message` MCP tool: more "agentic", but routing then depends on the model remembering to call a tool and on mapping MCP calls back to agents, which differs between OpenCode v1 and v2. Kept as a possible later addition.
**Worked example:** Run 42, task "Build a tip calculator page". The Coder writes `index.html`, then replies with a summary → message #1 (Coder → Reviewer, status `pending`). The dispatcher claims it (`processing`), and the Reviewer reads the file and replies "Missing input validation. VERDICT: REJECTED" → message #1 is `acked`, and message #2 (Reviewer → Coder, feedback) is created in the same transaction. The Coder fixes it → #3 → the Reviewer approves → #4 (Reviewer → Deployer) → the Deployer copies the files → there are no outgoing edges, so the run completes. If the server crashes while #3 is `processing`, recovery at startup returns it to `pending`, and it is processed once (idempotency key `run:42:step:5`).
**Decision:** A durable `messages` table is the queue: statuses `pending → processing → acked`, or `failed` (retried up to 3 times with backoff) → `dead`. Every handoff is persisted and shown in the UI trail. A missing or unreadable verdict counts as `REJECTED` once, then fails the step with a clear error.
**Why:** G6 (delivery does not depend on model behavior), G2 (fully testable with the fake runtime).

### D7. Interaction rules and approvals
**Status:** Decided (2026-10-19); part 2 confirmed live in T7 (2026-10-20). If the server restarts while a tool approval is pending, that run fails closed (Q-25).
**Decision:** Two levels, both feeding one approval inbox in the UI:
1. **Step gates:** a workflow node can be marked "requires approval". The run pauses before that agent acts (for example, before the Deployer deploys) until a human approves or rejects it.
2. **Tool-level rules:** each agent's tools are set to `allow`, `ask`, or `deny` (for example bash: ask). OpenCode asks, the adapter emits a `permission_request` event, the platform creates an approval, and the human's answer is sent back through the permission-response endpoint. If S1 shows this cannot work reliably, `ask` degrades to `deny` with a visible notice, and step gates remain.
3. **Blocked actions:** a list of denied bash patterns (for example `rm -rf *`, `git push*`, `curl*`), enforced through OpenCode deny permissions.

Approvals time out after 30 minutes and are then rejected.

### D8. Memory and skills
**Status:** Decided (2026-10-19)
**Decision:** Memory is a list of facts per agent (editable in the UI) and is included in every turn's system prompt. Agents add facts by writing lines such as `REMEMBER: Taylor prefers short answers`; the platform strips these lines from user-visible output and saves them, so this works the same in Slack and in workflows. Skills are reusable, named step-by-step procedures stored as their own records, attached to agents, and included in the system prompt.
**Why:** G3 (memory and skills are visible and editable), G2 (no dependency on runtime-specific memory).
**Known gap, for the writeup:** Memory is included in full on every turn; a long memory would need retrieval.

### D9. What "deploy" means
**Status:** Decided (2026-10-19); amended 2026-10-20 (Q-29).
**Decision:** The Deployer agent copies the approved files from the run workspace into `/deployments/<runId>/` with its tools. A `preview` container (static web server) serves them at `http://localhost:8080/<runId>/`. Nothing leaves the machine.
**Amendment (2026-10-20):** Agents are confined to their workspace (D5), which blocked the copy. Options: (a) a per-agent `canDeploy` permission that adds write access to `/deployments/<runId>/` for that run only; (b) deploy into a folder inside the workspace and serve workspaces. **Chose (a):** the demo stays real, every other agent stays confined, and the grant is explicit and visible in the agent editor. (b) was rejected because it makes "deploy" a move within the workspace and would expose all workspaces through the preview server.

### D10. Build process
**Status:** Decided (2026-10-19)
**Decision:** Claude writes the plan and docs; Codex CLI builds. `scripts/night-run.sh` runs one `codex exec` per task (fresh context each time), in order. Each task follows `AGENTS.md`: branch, tester, implement, verifier, reviewer, orchestration-auditor (for async code), commit, push, auto-merge once the GitLab pipeline is green. Night mode defers diagrammer, explainer, and requirements-tracer to task T19. Codex runs with `--sandbox danger-full-access --ask-for-approval never` so it can use the network and Docker.

### D11. CI runner and branch protection
**Status:** Decided (2026-10-20)
**In plain terms:** GitLab schedules pipelines but needs a runner to execute them. The project had none (the shared runner was not picking up jobs), so overnight Codex registered and removed a temporary runner for every task (about 5 minutes each).
**Decision:** One project runner, `yuno-mac` (GitLab Runner 19.5.0, Docker executor, `node:24` default image, untagged jobs), runs in Docker on the owner's Mac for the rest of the project. The `main` branch has force-push blocked and "pipelines must succeed" on (set 2026-10-20). Codex never registers, removes, or reconfigures runners or project settings, and never pushes directly to `main`.
**Known gap, for the writeup:** CI only runs while the Mac is on and Docker is open. A team setup would use a hosted or shared runner.

### D12. Owner review of Codex's night-mode questions
**Status:** Decided (2026-10-20)
**Decision:** Every question in `docs/questions.md` from the night run is accepted, except four that T22 changes:
- **Q-06:** the model list uses the current models from the owner's complimentary pools: `gpt-5.4-mini` (default), `gpt-5.4-nano`, `gpt-5-mini` (2.5M pool), and `gpt-5.4` (250K pool), not the dated `gpt-5-2025-08-07`.
- **Q-27:** cron schedules stay in UTC, and the UI says so next to every cron field and next-run time.
- **Q-36:** the brief's metric is configurable dimensions per agent. One shared list defines every configurable setting; the editor shows "N configurable dimensions" from that list (with the groups as a breakdown) and how many are set on this agent. The README quotes the same number.
- **Q-38:** a run stores a copy of its workflow graph when it starts, so run history stays accurate after the workflow is edited.

## Follow-ups
| From | Item |
|---|---|
| D5/D7 | ✅ Reviewed S1 spike results (2026-10-20) |
| D10 | ✅ Reviewed night report and questions (2026-10-20) |
| D11 | After grading: remove the `yuno-mac` runner (`docker rm -f yuno-runner && docker volume rm yuno-runner-config`, then delete it on the GitLab Runners page) |
| D4 | After grading: revoke the `yuno-local` OpenAI API key |
| D3 | After grading: uninstall the Slack app or revoke its tokens |
| T21 | ✅ Demo recorded and submitted 2026-10-20 |

## Known limitations
| From | Limitation |
|---|---|
| D1 | Non-coding agents run on a coding-agent runtime |
| D2 | Single process with SQLite; no horizontal scaling |
| D3 | Socket Mode is for single-instance deployments |
| D4 | Free-tier tokens require sharing prompts with OpenAI |
| D8 | Whole memory goes into every prompt |
| D5 | Tool rules are OpenCode permissions, not an OS sandbox; the container is the boundary |
| Q-19 | Delivery is durable, but a tool call can run twice if the server crashes mid-turn |
| Q-13 | The live log does not replay events missed while disconnected; the UI reloads state instead |
| Q-31 | A crash between saving a reply and posting it to Slack can leave a stale "thinking…" message |
| D11 | CI runs only while the owner's Mac and Docker are on |
