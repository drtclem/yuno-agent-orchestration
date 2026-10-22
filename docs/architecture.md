# Architecture

**Owner:** Taylor Clements · **Status:** Approved for build, 2026-10-19 · **Changes need owner approval.** If code must differ from this file, record it in `docs/questions.md` and keep building on the closest documented option.

## 1. Stack
| Layer | Choice | Decision |
|---|---|---|
| Language | TypeScript, `strict: true`, ESM, Node 24 | D2 |
| Monorepo | pnpm workspaces | D2 |
| Server | Fastify | D2 |
| Validation and shared types | zod in `packages/shared` | D2 |
| Database | SQLite (WAL) via Drizzle ORM + `better-sqlite3`; migrations with drizzle-kit | D2 |
| Realtime | SSE (`GET /api/events`) | D2 |
| Runtime | OpenCode (`opencode serve`) via `@opencode-ai/sdk`, exact version pinned | D1, D5 |
| Scheduler | `croner` | — |
| Channel | Slack `@slack/bolt`, Socket Mode | D3 |
| UI | React, Vite, React Router, TanStack Query, `@xyflow/react`, shadcn/ui, Tailwind | D2 |
| Tests | Vitest (server and web), Fastify `inject`; `@testing-library/react` for a few UI tests | D2 |
| Lint/format | ESLint (typescript-eslint, strict), Prettier | — |
| Containers | Docker Compose: `app`, `opencode`, `preview` | D9 |

Install the latest stable version of each package at T0; the lockfile pins them. Pin OpenCode to an exact version (T1).

## 2. Repo layout
```
apps/
  server/
    src/
      index.ts            # wiring only: build deps, start HTTP, dispatcher, scheduler, channels
      config.ts           # env parsing (zod); the only place process.env is read
      api/                # Fastify routes; validate with shared zod schemas; no SQL, no runtime calls
      domain/             # business logic, pure where possible
        compile.ts        # agent record -> CompiledAgent (system prompt, model, tools, permissions)
        protocol.ts       # parse VERDICT:/REMEMBER: lines from replies
        engine.ts         # workflow graph evaluation and run lifecycle
        dispatcher.ts     # claims queued messages, runs turns, retries, recovery
        guardrails.ts     # cost caps, rate limits, blocked actions
        approvals.ts      # approval inbox: create, resolve, timeout
        scheduler.ts      # croner jobs from the schedules table
        chat.ts           # channel conversations -> agent turns
      runtime/
        types.ts          # AgentRuntime interface (the seam)
        opencode/         # the only code that imports @opencode-ai/sdk
        fake/             # deterministic scripted runtime for tests and RUNTIME=fake
      channels/
        types.ts          # ChannelAdapter interface (the seam)
        slack/            # the only code that imports @slack/bolt
        fake/             # in-memory channel for tests
      db/
        schema.ts         # Drizzle schema
        client.ts         # opens SQLite, sets WAL + foreign keys, runs migrations
        repos/            # one repository module per aggregate; the only place SQL lives
      events/
        hub.ts            # in-process event bus -> SSE clients; also persists logs
    test/
  web/
    src/
      api/                # typed fetch client + SSE hook; the only place fetch/EventSource is used
      pages/              # Agents, AgentEditor, Workflows, WorkflowBuilder, Runs, RunDetail, Monitor, Approvals, Skills, Templates
      components/
packages/
  shared/src/             # zod schemas + inferred types used by server and web
templates/                # workflow templates as JSON (seeded and loadable)
docker/                   # Dockerfiles
data/                     # runtime data (gitignored): yuno.db, workspaces/, deployments/
docs/
scripts/
docker-compose.yml
Makefile
```

## 3. Rules (reviewer treats violations as Blocking)
1. **Layers:** `api/` calls `domain/` and `db/repos`; `domain/` uses `runtime/types.ts`, `channels/types.ts`, and repos; nothing outside `runtime/opencode/` imports the OpenCode SDK; nothing outside `channels/slack/` imports Bolt; SQL lives only in `db/repos/`. The web app talks to the server only through `apps/web/src/api/`.
2. **Every input is validated** with the shared zod schemas at the API boundary and on every channel message.
3. **Every external call has a timeout:** runtime turn (default 10 min, configurable per agent), Slack API (15 s), OpenCode health (5 s). A timeout produces a visible failed state, never a silent hang.
4. **Message state changes are transactional:** acking a message and creating the next one happen in one DB transaction. Every message has a unique idempotency key.
5. **Guardrails are checked before every turn** (cost cap, rate limit) and enforced during the turn (abort when the cost cap is crossed mid-turn). A blocked turn is logged with the reason and shown in the UI.
6. **Loops are bounded:** every run has `maxIterations` (default 6 agent turns per node). Exceeding it fails the run with reason `loop_limit`.
7. **Secrets:** read only in `config.ts` from env; listed in `.env.example`; never sent to the browser, logged, or written into prompts or workspaces. Never print `.env`.
8. **No `any`, `@ts-ignore`, `eslint-disable`, or non-null `!`** without a one-line reason on the same line.
9. **Tests never call real OpenAI or Slack** unless `LIVE_TESTS=1`; CI never sets it.
10. **Logs** record IDs, statuses, timings, token counts, and error codes. Full prompt and reply text goes into the `messages` and `run_steps` tables (needed for the trail), not into log lines.

## 4. Core interfaces (the seams)
```ts
// runtime/types.ts
export interface CompiledAgent {
  agentId: string;
  name: string;
  systemPrompt: string;                         // role + prompt + memory + skills + reply protocol
  model: { providerID: string; modelID: string };
  tools: Record<string, boolean>;               // e.g. { bash: true, edit: true, webfetch: false }
  permissions: { bash: Perm; edit: Perm; webfetch: Perm; denyBash: string[] };  // Perm = 'allow'|'ask'|'deny'
  turnTimeoutMs: number;
}
export interface TurnInput {
  agent: CompiledAgent;
  sessionKey: string;      // our key: `run:<runId>:node:<nodeId>` or `chat:<conversationId>`
  workspaceDir: string;    // absolute path, identical inside app and opencode containers
  prompt: string;
}
export type RuntimeEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'tool'; tool: string; status: 'started' | 'completed' | 'failed'; title?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }  // running totals for this turn
  | { type: 'permission_request'; permissionId: string; sessionId: string; tool: string; detail: string };
export interface TurnResult {
  text: string;            // final assistant text
  sessionId: string;       // runtime's session id (persisted for reuse)
  inputTokens: number; outputTokens: number; costUsd: number;
  toolCalls: { tool: string; status: 'completed' | 'failed' }[];
}
export interface AgentRuntime {
  health(): Promise<{ ok: boolean; version?: string }>;
  runTurn(input: TurnInput, onEvent: (e: RuntimeEvent) => void, signal: AbortSignal): Promise<TurnResult>;
  respondPermission(sessionId: string, permissionId: string, allow: boolean): Promise<void>;
}

// channels/types.ts
export interface InboundMessage {
  channel: 'slack';
  externalEventId: string;   // for dedupe
  conversationId: string;    // e.g. slack:<team>:<channel>:<thread_ts or dm>
  userId: string; userName?: string;
  text: string;
}
export interface ChannelAdapter {
  readonly type: 'slack';
  start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  /** Posts a placeholder and returns a handle so the reply can replace it. */
  postPlaceholder(conversationId: string, text: string): Promise<string>;
  updateMessage(conversationId: string, handle: string, text: string): Promise<void>;
  stop(): Promise<void>;
  status(): { connected: boolean; detail?: string };
}
```
The OpenCode adapter maps `sessionKey` to an OpenCode session (stored in `runtime_sessions`) so a conversation or a workflow node keeps its context across turns. Reviewers reuse their session within a run, so they remember earlier feedback.

## 5. Data model (Drizzle, SQLite)
All ids are text UUIDs; all times are integer epoch ms; JSON columns are text validated by zod.

| Table | Key columns |
|---|---|
| `agents` | id, name (unique), role, system_prompt, model, tools_json, permissions_json (bash/edit/webfetch: allow\|ask\|deny, deny_bash[], can_deploy: boolean, default false — D9), guardrails_json (daily_cost_cap_usd, run_cost_cap_usd, max_turns_per_hour, turn_timeout_ms), status (idle\|working\|waiting_approval\|error\|disabled), created_at, updated_at |
| `skills` | id, name (unique), description, steps_md, created_at |
| `agent_skills` | agent_id, skill_id |
| `memories` | id, agent_id, fact, source (ui\|agent), created_at |
| `schedules` | id, agent_id, kind (cron\|interval), expr (cron string or seconds), prompt, workflow_id (nullable: trigger a workflow instead of a single turn), enabled, last_run_at, next_run_at |
| `channel_bindings` | id, agent_id, type ('slack'), config_json (e.g. `{ "respondTo": "dm_and_mentions" }`), enabled. One Slack binding at most. |
| `workflows` | id, name, description, graph_json (WorkflowGraph), template_id (nullable), created_at, updated_at |
| `runs` | id, workflow_id (nullable for chat or schedule), graph_snapshot_json (the graph as it was at run start — D12), trigger (ui\|schedule\|chat), input, status (queued\|running\|waiting_approval\|completed\|failed\|cancelled), result, error, started_at, finished_at, total_cost_usd, total_tokens |
| `run_steps` | id, run_id, node_id, agent_id, iteration, status (running\|completed\|failed\|blocked), prompt, output, verdict, input_tokens, output_tokens, cost_usd, started_at, finished_at, error |
| `messages` | id, run_id (nullable), conversation_id (nullable), from_kind (agent\|human\|system), from_id, to_agent_id, channel (internal\|slack\|ui\|schedule), content, verdict, status (pending\|processing\|acked\|failed\|dead), attempts, next_attempt_at, idempotency_key (unique), error, created_at, updated_at |
| `approvals` | id, run_id, step_id, agent_id, kind (step_gate\|tool_permission), detail, runtime_session_id, runtime_permission_id, status (pending\|approved\|rejected\|expired), created_at, resolved_at |
| `runtime_sessions` | session_key (pk), runtime_session_id, agent_id, created_at |
| `conversations` | id (`slack:...`), agent_id, channel, external_ref, created_at |
| `processed_events` | external_event_id (pk), created_at (for Slack dedupe) |
| `logs` | id, ts, level, agent_id, run_id, event, data_json |

## 6. Workflow graph
```ts
type WorkflowGraph = {
  nodes: { id: string; agentId: string; label: string; instructions?: string; requiresApproval?: boolean; position: { x: number; y: number } }[];
  edges: { id: string; source: string; target: string; condition: 'always' | 'approved' | 'rejected' | { contains: string } }[];
  startNodeId: string;
  maxIterations: number;     // per node, default 6
};
```
Validation (on save and on run start): `startNodeId` exists; every edge endpoint exists; every `agentId` exists; each node has at most one `always` edge; at least one node with no outgoing edges (an end node) is reachable from the start.

**Run semantics (engine.ts):**
1. Start: create the `run` (status `running`, with `graph_snapshot_json` = the workflow graph at this moment; the engine and the run view use the snapshot, never the live workflow) and message #1 (`from_kind: human`, to the start node's agent, content = user input, idempotency key `run:<id>:start`).
2. The dispatcher claims a `pending` message whose `next_attempt_at` has passed (`UPDATE … SET status='processing' WHERE id=? AND status='pending'`). If the target node has `requiresApproval`, it creates an approval, sets the run to `waiting_approval`, and stops until the approval is resolved.
3. Guardrail check → build the prompt: node instructions + the incoming message (labelled with its sender) + "Workspace: <dir>". Run the turn; stream runtime events to the hub; write `run_steps`.
4. Parse the reply (`protocol.ts`): strip and save `REMEMBER:` lines; read `VERDICT:`.
5. In one transaction: ack the message; evaluate outgoing edges in order (first match wins: `approved`/`rejected` match the verdict, `contains` matches the reply text case-insensitively, `always` always matches); create the next message with idempotency key `run:<id>:step:<stepId>`. If there are no outgoing edges, set the run to `completed` with `result` = the reply. If edges exist but none match, fail the run with `no_matching_edge`.
6. Failure: on a runtime error or timeout, set the message to `failed` with `attempts+1` and `next_attempt_at = now + 2^attempts * 5s`; after 3 attempts set it to `dead` and fail the run.
7. Recovery on startup: messages left `processing` go back to `pending`; pending approvals keep waiting.
8. Concurrency: process one message per agent at a time, and up to 4 in total.

Cancelling a run aborts the in-flight turn (`AbortSignal`) and marks pending messages `dead`.

## 7. Reply protocol (appended to every system prompt by compile.ts)
```
When you finish, reply with your result for the next step.
If you are reviewing or deciding, end with exactly one line: VERDICT: APPROVED or VERDICT: REJECTED
(when rejecting, explain what to fix above that line).
To remember something for future sessions, add a line: REMEMBER: <fact>
Work only inside the workspace directory you are given.
```

## 8. Guardrails
- **Cost:** `run_cost_cap_usd` (per agent per run) and `daily_cost_cap_usd` (per agent, UTC day). Check before the turn; during the turn, `usage` events are compared to the remaining budget and the turn is aborted when it is exceeded. Defaults: $0.50 per run, $2.00 per day.
- **Rate:** `max_turns_per_hour` per agent (default 30), counted from `run_steps` plus chat turns.
- **Blocked actions:** `deny_bash` patterns go to OpenCode permissions; also, `tool` events matching a blocked pattern are logged as violations.
- **Model allowlist:** only `openai/gpt-5.4-mini` (default), `openai/gpt-5.4-nano`, `openai/gpt-5-mini` (2.5M/day pool) and `openai/gpt-5.4` (250K/day pool) can be chosen; the UI labels each with its pool; the server rejects others (D4, D12).
- **Deploy grant:** only an agent with `can_deploy` gets write access outside its workspace, and only to `/deployments/<runId>/` for the run it is working on (D9).

## 9. Channels and chat
`chat.ts`: an inbound message → dedupe on `processed_events` → find or create the `conversation` → persist a `messages` row (`from_kind: human`, channel `slack`, to the bound agent) → the hub emits it (it appears in the monitor) → guardrail check → post the placeholder → run a turn with session key `chat:<conversationId>` and workspace `data/workspaces/agents/<agentId>` → strip `REMEMBER:` → update the placeholder with the reply → persist the agent's reply as a message. If no Slack tokens are set, the Slack adapter is not started and the UI shows "Slack: not configured".

## 10. Events (SSE)
`GET /api/events` streams `{ type, ts, data }` events: `agent.status`, `run.updated`, `step.updated`, `message.created`, `message.updated`, `approval.created`, `approval.resolved`, `log`, `usage`, `channel.status`. Send a heartbeat comment every 15 s. Remove the client on disconnect. The web SSE hook invalidates the matching TanStack Query keys and appends logs to a capped in-memory list (last 500).

## 11. HTTP API (all JSON under `/api`)
| Method | Path | Purpose |
|---|---|---|
| GET | /health | server, db, runtime (version), slack status |
| GET/POST | /agents | list, create |
| GET/PUT/DELETE | /agents/:id | read, update, delete (deleting an agent used by a workflow returns 409 with the workflow names) |
| GET/POST/DELETE | /agents/:id/memories[/:memId] | memory facts |
| GET/POST/PUT/DELETE | /skills[/:id] | skill library |
| PUT | /agents/:id/skills | set attached skill ids |
| GET/POST/PUT/DELETE | /agents/:id/schedules[/:sid] | schedules |
| GET/PUT | /agents/:id/channels | channel binding |
| POST | /agents/:id/chat | test-chat with an agent from the UI (same path as Slack, channel `ui`) |
| GET/POST/PUT/DELETE | /workflows[/:id] | workflows (graph validated) |
| GET | /templates | list templates |
| POST | /templates/:id/load | create the template's missing agents (matched by name) and a new editable workflow; returns the workflow id |
| POST | /workflows/:id/runs | start a run `{ input }` |
| GET | /runs, /runs/:id | runs; detail includes steps, messages, approvals |
| POST | /runs/:id/cancel | cancel |
| GET | /approvals?status=pending | approval inbox |
| POST | /approvals/:id | `{ decision: 'approve' \| 'reject', note? }` |
| GET | /messages?runId=&conversationId= | message trail |
| GET | /usage?groupBy=agent\|run&since= | token and cost totals |
| GET | /events | SSE |
| GET | /models | allowed models with their pool labels |

## 12. Templates
JSON files in `templates/`, validated by the shared `TemplateSchema`: `{ id, name, description, agents: AgentInput[], graph }`, where the graph's nodes reference agents by `agentName`. Seeded templates:
- **dev-pipeline:** Coder → Reviewer; Reviewer `rejected` → Coder; Reviewer `approved` → Deployer (requires approval) → end.
- **research-pipeline:** Researcher (webfetch on) → Writer (writes `report.md`) → Editor; Editor `rejected` → Writer; `approved` → end.

Adding a template means adding one JSON file; it appears after a restart (documented in the README).

## 13. Docker and setup
- `docker-compose.yml`: `opencode` (Node 24 image with `opencode-ai@<pinned>` installed globally, runs `opencode serve --hostname 0.0.0.0 --port 4096`, gets `OPENAI_API_KEY`, mounts `./data/workspaces:/data/workspaces` and `./data/deployments:/deployments`; port not published); `app` (builds server + web; the server serves the built web app; port 3000; mounts `./data:/data`; `OPENCODE_URL=http://opencode:4096`); `preview` (nginx, serves `./data/deployments` on 8080).
- The workspace path is `/data/workspaces/...` in both containers so paths match.
- **One command:** `make up` creates `.env` from `.env.example` if it is missing, warns about empty keys, and runs `docker compose up --build`. With `RUNTIME=fake`, everything works without an API key (scripted agents) so the UI can be explored.
- Local dev without Docker: `pnpm dev` (server with `RUNTIME=fake` by default, Vite dev server proxying `/api`).

## 14. UI
Pages: **Monitor** (home), **Agents**, **Agent editor**, **Workflows**, **Workflow builder**, **Runs / Run detail**, **Approvals**, **Skills**, **Templates**. Left nav with an approvals badge and a runtime/Slack status pill.
- **Agent editor tabs:** Basics (name, role, system prompt, model) · Tools & permissions (allow/ask/deny per tool, blocked commands) · Channels (Slack binding + status) · Schedules · Memory · Skills · Guardrails (cost caps, rate, timeout) · Test chat. The header shows "N configurable dimensions" from one shared list in `packages/shared` (the brief's key metric), with the groups as a breakdown and how many are set on this agent (D12). Cron fields and next-run times are labelled UTC.
- **Workflow builder:** React Flow canvas; nodes show the agent name, role, model, and a "requires approval" badge; drag from a side panel of agents; an edge's condition is chosen in an inspector and shown as a colored label (approved = green, rejected = red); a max iterations field; validation errors listed inline; Save; "Run" opens an input box.
- **Run detail:** the same graph read-only with live node states (running pulses, done, failed), a chat-style message trail (sender → receiver, verdict chips, Slack messages marked), steps with tokens and cost, an approve/reject banner when waiting.
- **Monitor:** agent cards (status dot, channel icons, today's cost), the live log stream, recent inter-agent and channel messages, active runs with progress, totals for tokens and cost (labelled "estimated").
- Visual direction: a calm "control room": neutral surfaces, one accent color, monospace for IDs and logs, status colors only for state. Light and dark themes.
- Empty states always offer the next action ("Load a template").

## 15. Testing strategy
- **Server unit:** `compile.ts`, `protocol.ts`, graph validation, edge evaluation, guardrail math (fake clock).
- **Server integration (in-memory SQLite + fake runtime + fake channel):** agent CRUD API; a dev-pipeline run that is rejected once and then approved and completes; loop limit; no matching edge; retry then dead letter; crash recovery (a message left in `processing` is re-run exactly once); idempotency (a duplicate start creates no duplicate messages); approvals gate; cost cap blocks a turn; Slack dedupe, bot-message ignore, conversation-to-session mapping.
- **Web:** typecheck and build; a few component tests (agent form validation, edge condition picker).
- **Live (opt-in, `LIVE_TESTS=1`):** OpenCode adapter round trip; the full dev-pipeline on `gpt-5.4-mini`.

## 16. Known limitations
See the Known limitations table in `docs/decisions.md`.
