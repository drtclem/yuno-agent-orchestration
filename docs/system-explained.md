# How Yuno works

_Last updated: 2026-10-20 - T24 Slack names, normalized text, human reply recipients, and unfilled rejection edges._

## The big picture

Yuno owns orchestration: deciding who acts next, keeping messages, checking limits, and asking people for permission. OpenCode owns one agent turn: calling the model and using tools. A **turn** is one invocation of an agent; a **run** is the whole workflow or chat request. A **step** records a turn at a workflow node.

**Web UI.** `apps/web/src` is the React application. It edits agents and skills, builds workflows, starts runs, and displays messages, costs, approvals, and logs. It sends commands to the API and receives Server-Sent Events (**SSE**), a one-way stream of server updates. On reconnect it reloads API state; the stream does not replay missed events. The Monitor shows the graph captured when a workflow run started. Older runs without a snapshot show the current saved graph with an explicit notice.

**API.** `apps/server/src/api` registers Fastify HTTP routes. Shared zod schemas check incoming fields before repositories write them. Routes call configuration repositories or domain services; the browser never calls OpenCode directly. Failed requests return visible errors, including field errors for invalid input.

**Engine.** `createEngine` in `domain/engine.ts` starts runs and supplies the dispatcher's message processor. It finds the target node, obtains current agent configuration, checks approvals and limits, compiles instructions, calls the runtime, and decides the next edge. An **edge** connects workflow nodes and optionally tests a verdict or text. Only the first matching edge runs; there is no parallel graph fan-out.

**Dispatcher.** `createDispatcher` in `domain/dispatcher.ts` polls the database queue. It allows one active turn per agent and up to four across agents. It claims a message, calls the engine processor, and commits the result and acknowledgement together. An acknowledgement (`acked`) means processing committed, not that every external side effect happened exactly once.

**Guardrails.** `createGuardrails` in `domain/guardrails.ts` checks persisted spending and hourly turns. The engine also limits node iterations, applies a turn timeout, and checks usage updates while work runs. Tool denial belongs to OpenCode permission rules; observing a suspicious tool event only creates a warning log.

**Approvals.** `createApprovals` in `domain/approvals.ts` manages a shared inbox for node gates and OpenCode tool requests. A node gate parks its message without holding a dispatcher slot. A tool request pauses an active invocation. Approval decisions go to the database and, for tools, back to the runtime adapter.

**Scheduler.** `createScheduler` in `domain/scheduler.ts` uses Croner timers to start ordinary engine runs. It reloads saved schedules after edits, uses UTC for cron, and skips busy agents. Timers are process-local; missed times are not replayed after downtime.

**Chat.** `createChat` in `domain/chat.ts` connects a channel adapter to the same engine and dispatcher used by workflows. It accepts a conversation, arranges a Slack “thinking…” placeholder when dispatch begins, and updates it when the run ends. Replies persist before outbound delivery. The UI test-chat route uses the same engine without Slack.

**Event hub.** `createEventHub` in `events/hub.ts` validates events, persists log events, and broadcasts updates to subscribers. A broken subscriber is removed so it cannot interrupt others. Run and message state live in database tables; transient broadcast events are not a durable event queue.

**Database.** `openDatabase` in `db/client.ts` opens SQLite through Drizzle, enables foreign keys, and applies checked-in migrations. Disk databases use write-ahead logging (**WAL**), which lets readers keep working while changes are recorded. Repositories isolate persistence from orchestration. One application process owns this queue; startup recovery is not a lease for multiple servers.

**OpenCode adapter.** `createOpenCodeRuntime` in `runtime/opencode/index.ts` implements the runtime interface using pinned SDK 1.19.3. It writes workspace policy, creates or updates a session, subscribes to runtime events, submits the prompt, and reconciles usage against final message history. It persists the mapping from Yuno session key to OpenCode session ID. It rejects overlapping work in one session or workspace. For a workflow agent with `canDeploy`, it creates `/deployments/<runId>/` and grants that directory in the runtime policy. Compose mounts the same deployment files into the app and OpenCode containers; nginx serves them read-only.

**Slack adapter.** `createSlackChannel` in `channels/slack/index.ts` uses Bolt Socket Mode, an outbound WebSocket connection that needs no public webhook. `mapSlackEvent` accepts direct messages and mentions, ignores bots and message subtypes, and identifies a conversation by workspace, channel, and thread. Before acceptance, the adapter resolves sender and mention names with `users.info` and converts Slack text markup into readable text. Acceptance happens before Bolt acknowledges the event so Slack can retry a persistence failure.

Local startup reads environment variables through `config.ts`; `RUNTIME` defaults to `fake`. `index.ts` constructs the real adapter only for `opencode` and constructs a Slack adapter only when both Slack tokens are present. A binding still has to be enabled before chat starts that channel. The server code does not itself load a `.env` file; use the documented command or Compose environment setup. Runtime health and saved configuration are separate facts.

## Creating an agent

**What happens.** Saving an agent stores configuration. It does not start a model call or create an OpenCode session.

**Step by step.**

1. The agent form sends configuration to `POST /api/agents`.
2. `registerConfigurationRoutes` calls `AgentInputSchema.parse` to validate it.
3. `createConfigurationRepository.createAgent` supplies the ID and timestamps and saves the record.
4. The response returns the saved record. Separate configuration routes save memory, skills, schedules, and the Slack binding.
5. On a later turn, `compileAgent` combines role, prompt, memory, skills, node instructions, and `REPLY_PROTOCOL`. Disabled tools become denied permissions. `canDeploy` defaults to false; enabling it adds a deployment exception only for workflow runs, not standalone chat or scheduled turns.

**Worked example.** `apps/server/test/agent-api.test.ts`, “creates, reads, updates and deletes a persisted agent,” creates **Writer** with `Write carefully 🌍`, gets HTTP 201, and reads the same record from the repository. It then renames Writer to Editor. The ID is generated by the test run and is not a recorded constant. There is no message, token usage, or model cost in this configuration-only example.

The model picker offers `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`, and `openai/gpt-5-mini` with the “2.5M/day pool” label, plus `openai/gpt-5.4` with “250K/day pool”. These labels describe the owner's pool categories; Yuno does not meter remaining complimentary tokens. Old saved model names remain readable and show “unavailable — pick another”. The editor can save an approved replacement. Until repaired, the engine fails a turn visibly with `model_not_allowed` before invoking the runtime; `engine.test.ts` covers this with the old `openai/gpt-5-2025-08-07` value.

The editor shows configurable dimensions from `AGENT_DIMENSIONS` in `packages/shared/src/dimensions.ts`. Each editable leaf setting counts once; each collection, such as memory, counts once. The set count includes current field edits plus saved related settings. Enabled tools, non-deny permissions, nonempty values, and valid guardrails including defaults count as set. Loading or failed related reads show a status instead of a misleading count. `agents.test.tsx` verifies that adding the first memory increases the count by one. `scripts/readme-dimensions.mjs` keeps the README total aligned; lint checks it.

**What can go wrong.** Invalid fields or an unapproved model produce HTTP 400 with field messages. Duplicate names produce 409. Missing records produce 404. Deleting an agent used by a workflow reports the workflow names; retained history also prevents deletion. Related saves are separate requests, so a saved agent can have an unsaved related edit. A saved Slack binding does not prove Slack connected; connection health is displayed separately.

**Walkthrough angle.** Why keep configuration outside OpenCode? Yuno needs one editable source of truth for every channel and workflow. Compiling it at invocation time also makes configuration testable without a model. It means a later turn uses current configuration rather than a snapshot from run creation.

## A workflow run with a rejection loop

**What happens.** The engine sends each completed output to one next agent. Reviewer verdicts choose whether work returns for revision or proceeds.

**Step by step.**

1. `createEngine.startRun` loads and validates the saved graph.
2. `begin` commits a running run, a copy of its workflow graph, and its pending start message in one database transaction. Routing uses that saved graph; agent settings still come from current configuration.
3. `createDispatcher` claims that message; the engine locates its node and checks the per-node iteration limit.
4. The engine handles a gate, then calls `createGuardrails.check`, persists the running step, and calls `compileAgent` and `runtime.runTurn`. For a workflow run, the compiler receives the run UUID. A `canDeploy` agent gets the matching `/deployments/<runId>/` exception in its prompt and permissions. The adapter creates the folder and sends default-deny external-directory rules with that one path allowed.
5. Runtime usage updates adjust persisted totals by the difference from previously reported usage, avoiding double counting the final result.
6. `parseReply` reads `VERDICT:` and removes `REMEMBER:` lines from visible text. The last valid standalone verdict wins.
7. `nextEdge` selects the first matching outgoing edge. A missing verdict at a verdict-routing node counts as rejected once; a repeated missing verdict fails.
8. The completion callback saves the step, memory, run state, and next message. `createQueueRepository.complete` commits those writes with the incoming acknowledgement. No outgoing edges means completion.

**Worked example.** In `apps/server/test/engine.test.ts`, “rejects once, retries, approves and deploys,” node names **Coder**, **Reviewer**, and **Deployer** describe agents stored as Agent 1, Agent 2, and Agent 3. Their IDs end in `000000000001`, `000000000002`, and `000000000003`. Coder → Reviewer (rejected) → Coder → Reviewer (approved) → Deployer produces five completed steps and five `acked` messages. The actual test input is repeated `Build 🌍 使用`; it does not build a real tip calculator. Message UUIDs are generated, not captured constants. Their keys are `run:<run.id>:start` and `run:<run.id>:step:<predecessor.id>`.

The adjacent “persists correct per-step, per-run and per-agent usage totals” test runs that same graph with 10 input tokens, 5 output tokens, and USD 0.001 per turn. It asserts 75 total tokens and USD 0.005 for the run. These are deliberately fake usage figures, not a price prediction or a live deployment measurement.

**What can go wrong.** Invalid graphs fail validation. Unmatched outgoing conditions fail with `no_matching_edge`. Repeated malformed verdicts fail with `missing_verdict`. Revisiting a node beyond its cap fails with `loop_limit`. Runtime errors enter queue retry; cancellation aborts the turn and kills pending messages. Active workflows cannot be edited through the API. New runs retain their original graph after later edits; legacy runs with no snapshot fall back to the current graph and say so. `engine.test.ts` also bypasses the edit API to change the stored graph during execution and verifies that the original rejection loop still completes. `monitoring.test.tsx` verifies both snapshot display and legacy fallback. A fake Deployer reply proves routing, not copied files; the new grant still needs T20's live deployment check.

In the graph, rejected edges retain their red stroke but have no fill, including in dark mode. `MessageTrail.test.tsx` checks the matching stylesheet rules; this changes drawing only.

**Walkthrough angle.** Why ask for a text verdict? It is a small runtime-independent protocol, with explicit handling for malformed answers. The trade-off is reliance on model formatting. The engine, rather than the model, owns durable routing and loop limits.

## Message delivery, retry, and crash recovery

**What happens.** Queue records survive restarts. Database completion is atomic, while an external tool may run again after an interrupted attempt.

**Step by step.**

1. `createQueueRepository.enqueue` deduplicates by **idempotency key**, a unique name for the logical delivery.
2. `claim` selects the oldest eligible pending or failed message, excluding busy agents and pending approvals, then marks it `processing` in a transaction.
3. `createDispatcher.execute` awaits the engine processor.
4. On success, `complete` acknowledges the incoming message and commits its completion writes together. Events publish after commit.
5. On failure, `fail` increments attempts: the first retry waits 10 seconds, the next waits 20 seconds, and the third failed execution becomes `dead` and fails its run.
6. On shutdown, `stop` aborts active processors and waits for them. On startup, `recover` returns interrupted processing records to pending, except those with pending approvals.
7. The engine closes interrupted steps before retrying. `createApprovals.start` separately fails interrupted tool-approval runs; a pending node gate survives restart.

**Worked example.** `apps/server/test/dispatcher.test.ts`, “failed turn retries after 10s and 20s then becomes dead,” uses message `00000000-0000-4000-8000-000000000101`, key `test:1`, and a fake agent that throws `offline`. The observed status trail is `processing → failed → processing → failed → processing → dead`, ending with attempts 3 and `message_processing_failed`. Its recovery test starts that same message as processing, calls `start` twice, and asserts one processor call and `acked`. Those tests do not record usage or cost for failed invocations; no model billing claim follows from them.

**What can go wrong.** A database write failure stops dispatch and logs a sanitized error. Invalid completion events roll back both acknowledgement and next-message creation. Failure after commit does not rerun already committed work merely because event publication failed. A crash before commit can repeat runtime calls and tool side effects. There is no distributed ownership across multiple server processes and no automatic dead-letter replay action.

**Walkthrough angle.** Is delivery exactly once? Durable handoffs deduplicate and completion writes are atomic. External effects are at least once across a crash boundary: writing a file or running a shell command is outside the SQLite transaction. D6's informal “processed once” example must not be presented as exactly-once tool execution; Q-19 records this distinction.

## An approval

**What happens.** A person can gate a whole node or answer one tool permission request. Rejection or expiry fails the run visibly.

**Step by step.**

1. For a gated node, the engine returns a parking completion; `createQueueRepository.complete` returns the message to pending while atomically saving a blocked step and `createApprovals.gate` approval.
2. `createApprovals.create` marks the run `waiting_approval`. The dispatcher slot is released; claim excludes the parked request.
3. The inbox sends a decision to the approval API, which calls `createApprovals.resolve`.
4. For a tool request instead, the engine's event callback calls `createApprovals.tool`. Resolving it calls `runtime.respondPermission`, with a bounded reply timeout, before recording success.
5. Approval resumes the run. A node gate reuses its placeholder step and iteration; a tool permission allows once rather than changing future policy.
6. Reject, failed permission delivery, or 30-minute expiry resolves pending approvals, fails the run, stops messages and steps, and aborts active work. Startup rejects interrupted tool requests because the invocation cannot be reattached.

**Worked example.** `apps/server/test/guardrails-approvals.test.ts`, “restart preserves a pending gate and resumes the same step and iteration once,” uses **Worker**, ID `00000000-0000-4000-8000-000000000001`, on node `work`, input `Work 🌍`. It records a blocked step and pending approval, restarts, then approves and completes that same step at iteration 1. The run, step, message, and approval IDs are generated. The fake runtime default is 10 input tokens, 5 output tokens, and USD 0.001 per successful turn (`runtime/fake/index.ts`); this test checks gate recovery, not billing totals. While parked, the placeholder usage fields are zero and no invocation has begun.

**What can go wrong.** Duplicate or stale decisions return 409. Expired requests cannot be revived. A failed runtime permission reply fails closed with `permission_reply_failed`. A restart during tool approval fails with `approval_interrupted`; it does not replay the pending tool. Gate waits do not consume the hourly turn allowance. An active tool wait remains inside its turn timeout and can end before the inbox's 30-minute expiry.

**Walkthrough angle.** Why preserve node gates but fail interrupted tool approvals? A node gate is before external execution and safely resumable. A tool request belongs to an active remote invocation; approving a stale request after restart would pretend continuity the adapter cannot guarantee.

## A scheduled turn

**What happens.** A saved timer starts either its selected workflow or one standalone agent turn. It uses the same queue, approval handling, and guardrails as manual work.

**Step by step.**

1. Configuration routes validate schedule input and call `validateSchedule` for recurring UTC cron expressions. The editor labels the cron choice and expression as UTC, and displays saved last/next times as UTC ISO timestamps.
2. `createScheduler.reload` stops removed or disabled jobs and preserves deadlines for unchanged jobs.
3. `arm` sets a Croner timer and persists `nextRunAt`.
4. At the tick, it checks both schedule owner and workflow start agent through `agentBusy`.
5. If available, `createEngine.startScheduled` commits the run and start message, and the scheduler records `lastRunAt` as accepted creation time.
6. Busy ticks log `schedule_skipped`; failed starts log `schedule_failed`. The scheduler arms the next interval or saves the next cron time.

**Worked example.** `apps/server/test/scheduler.test.ts`, “loads enabled interval schedules on startup,” uses **Scheduled agent**, ID `00000000-0000-4000-8000-000000000001`, with task `Check 🌍 使用`. At the test clock's 2026-01-01 00:00:10 UTC it creates one run, then asserts a completed standalone step and an `acked` schedule message. `lastRunAt` is that tick and `nextRunAt` is 00:00:20 UTC. The message ID is generated. The fake runtime defaults to 10 input tokens, 5 output tokens, and USD 0.001; the schedule test verifies timing/status, not those usage totals.

**What can go wrong.** Invalid cron is rejected before saving. Busy or disabled agents skip ticks instead of building a backlog. Invalid stored schedules produce visible logs and no next deadline. Intervals restart one full period after startup or a relevant edit; missed ticks during downtime are lost. A queued standalone run remains recoverable even if its schedule is subsequently deleted.

**Walkthrough angle.** Why skip rather than queue every tick? This avoids overlap and catch-up storms on a single local process. It is suitable for periodic checks; it is not a guaranteed-delivery calendar service.

## A Slack conversation

**What happens.** A Slack direct message or mention becomes an ordinary engine run. The conversation keeps its own runtime session and a persisted human/agent trail.

**Step by step.**

1. `createSlackChannel.start` connects Socket Mode and obtains the bot's identity.
2. `DurableSlackApp.processEvent` calls `mapSlackEvent`; it filters bots/subtypes and constructs the conversation ID. It resolves sender and mention names concurrently, sharing cached lookup promises. Each lookup has a 15-second timeout and falls back to the ID. The cache holds at most 256 users, evicts the oldest insertion, and clears on stop.
3. `normalizeSlackText` changes labeled links to `label (URL)`, bare links to their URL, and mentions to `@name`; it then decodes `&amp;`, `&lt;`, and `&gt;`. `createChat.receive` forwards this normalized text to the engine.
4. `createEngine.startChat` and `begin` atomically accept the external event, verify conversation ownership, and save the run and inbound message before Slack acknowledgement. The message keeps the original sender ID plus nullable `fromName`; UI requests use `You (UI)`. The runtime receives normalized content, while its sender header still uses the original ID.
5. The engine applies guardrails. Once eligible for execution, `createChat` posts “thinking…” and remembers its Slack handle in memory.
6. The runtime uses `chat:<conversationId>` as its session key and `workspaces/agents/<agentId>` as its workspace. Sessions separate conversations; the filesystem is shared by that agent's conversations.
7. Completion strips and saves `REMEMBER:` facts, saves an `acked` agent reply, and commits before publishing completion.
8. `createChat.deliver` updates the Slack placeholder with the result or failure. Outbound delivery failure logs an error without rerunning the model.

**Worked example.** `apps/server/test/chat.test.ts` uses **Chat agent**, ID `00000000-0000-4000-8000-000000000001`, event `Ev1`, user `U1`, conversation `slack:T1:D1:dm`, and repeated `Hello 🌍 使用`. Its scripted output is `First reply.\nREMEMBER: Likes tea.`; both persisted messages are `acked`, Slack receives `First reply.`, and the fact is saved. `Ev2` with `Again` reuses the same session key and yields `Second reply.` Duplicate `Ev1` produces no second turn. Message UUIDs are generated. The fixture uses fake-runtime default usage of 10 input tokens, 5 output tokens, and USD 0.001 per successful turn; these chat assertions establish delivery and session reuse rather than a live Slack bill.

`slack-adapter.test.ts` also sends `Hi <@U2> <@U2> <https://x|site> &amp; <@U1>` in events `Ev-first` and `Ev-second`. Both arrive as `Hi @Alex @Alex site (https://x) & @Taylor Clements`, with only two name lookups across both events. Its timeout test advances the clock to 15 seconds and confirms delivery with IDs. `chat.test.ts` verifies that `Taylor Clements` is persisted and emitted in the message event. These tests do not call a live model.

`MessageTrail` shows human names with an ID fallback for historical null names. For conversation replies, it finds the human from the same run, then the latest preceding human in that conversation, and displays the agent → human with a channel badge. Monitor supplies full loaded history even when only recent messages are shown. Missing human history displays `Human`. The reply still stores its original agent destination; this is display logic only. `MessageTrail.test.tsx` covers named senders, recipients, history lookup, and old IDs; `database.test.ts` verifies migration leaves old names null.

**What can go wrong.** Name lookup failure appears in channel status as “user name lookup failed; using IDs” and does not prevent acceptance. Failed lookups stay cached until eviction or stop, so names can remain IDs until then. Cached successful names can also become stale. Missing tokens or connection failures appear in health/logs. Failed acceptance is not acknowledged, allowing Slack retry; duplicate event IDs are ignored after acceptance. A disconnected channel or failed placeholder prevents runtime execution. Guardrail rejection happens before a placeholder, so Slack can receive no new reply while the Monitor shows failure. Outbound updates have no durable outbox: a crash after database commit can leave a stale placeholder or lose final delivery. Shared per-agent files are not isolated by Slack thread.

**Walkthrough angle.** Does persisted chat mean guaranteed Slack delivery? No. Inbound acceptance is durable and deduplicated; reply history is durable. Placeholder handles are process-local, so outbound recovery needs a durable outbox. Q-31 records that limit. Fake-channel and mocked SDK tests are not evidence that the owner's Slack app is configured; T20 owns the live conversation.

## A guardrail blocking a turn

**What happens.** A preflight limit prevents model execution and records a blocked step with a failed run. Mid-turn cost checks can abort further work after reported usage crosses a cap.

**Step by step.**

1. The engine checks its node iteration cap and disabled status before creating an invocation.
2. After a gate is satisfied, `createGuardrails.check` reads persisted agent/run and UTC-day spending plus hourly invocations.
3. A depleted cap or hourly allowance returns `run_cost_cap`, `daily_cost_cap`, or `rate_limit`.
4. The engine commits a blocked step, a `guardrail_blocked` log, and a failed run without calling the runtime.
5. During an allowed turn, `recordUsage` updates persisted spending and aborts if reported usage exceeds the remaining budget. `AbortSignal` also carries cancellation and the turn timeout.
6. The OpenCode adapter enforces tool permissions and blocked bash patterns. Its default policy denies unknown tools and access outside the workspace. A workflow agent with `canDeploy` receives a narrow runtime-policy exception for its own run's deployment directory; other external directories remain denied. On abort it calls OpenCode's abort endpoint; a failed abort keeps that workspace quarantined in the adapter instance.

**Worked example.** `apps/server/test/guardrails-approvals.test.ts`, “blocks a turn at the … cap with a visible reason,” sets **Worker**'s run or daily cap to USD 0. The run fails, its step is `blocked`, `runTurn` is never called, and step input/output tokens and cost are 0. Generated message IDs are not fixed fixtures. In the scheduler equivalent (`scheduler.test.ts`), the same zero-cap policy produces `run_cost_cap` and a `guardrail_blocked` event for the scheduled task.

**What can go wrong.** Usage arrives after model/tool work has started, so cost caps can overshoot; they are not provider-side prepaid limits. Persisted failed-attempt usage counts toward limits when reported. Aborting HTTP alone does not prove remote work stopped, which is why the adapter also calls OpenCode abort and quarantines on failure. Bash pattern denial and workspace policy are permission controls, not an operating-system security sandbox. A warning after a suspicious tool event cannot undo its side effect.

**Walkthrough angle.** Are guardrails hard guarantees? Preflight gating is deterministic against recorded state. Runtime cost depends on reported usage and cancellation, so it bounds continued work rather than guaranteeing an exact spending ceiling. Tool enforcement depends on the pinned runtime's permission behavior, tested separately from orchestration.

## Evidence boundaries and documented differences

- `docs/spikes.md` records real OpenCode 1.19.3 file-writing and ask-permission probes. The file probe used 6206 input and 45 output tokens and USD 0.0056991; the bash approval probe used 6159 input and 47 output tokens and USD 0.00553785. The spike also separately lists reasoning and cache tokens. These are two manual runtime probes, not an end-to-end workflow or live Slack demo.
- D5's approved amendment matches the adapter: it omits the boolean prompt tool map, because the spike showed that it can override ask/deny rules. Workspace and replaced session permissions carry tool policy instead (Q-04/Q-17). The older numbered explanation below that amendment still describes sending the map; the amendment takes precedence.
- D6's once-only recovery wording is narrower than external execution behavior: side effects may repeat before completion commits (Q-19).
- T22 implements D9's deployment exception: `canDeploy` defaults to false, the dev-pipeline Deployer enables it, and the compiler validates the workflow run UUID before constructing the destination. `compile.test.ts` checks malformed IDs and the default denial. `opencode.test.ts` checks generated permission rules, directory creation, and revocation on session reuse using temporary test directories. These are mocked runtime checks, not evidence of real OpenCode enforcement. OpenCode permissions are not an operating-system sandbox; the OpenCode container is the operating-system boundary, and its shared deployment mount is writable. T20 must still demonstrate the approved output copied and served.
- T20 still owns a live rejection-loop workflow with a deployed page and a real Slack conversation. T21 owns the rehearsed demo. Existing fake tests establish orchestration behavior; they do not establish those deliverables.

Local commit hooks run lint-staged before commit and commitlint on the message. The GitLab merge-request pipeline independently checks commit messages as well as lint, types, tests, build, secret scanning, and Compose configuration. Its dependency audit remains advisory. The persistent project runner is `yuno-mac`; setup and enforcement of protected `main` are owner-managed GitLab settings, not properties this guide can establish from source alone.

## Glossary

- **AbortSignal:** a cancellation notification passed through asynchronous work.
- **Adapter:** code translating Yuno's small interface into a particular external service's API.
- **API:** the request/response interface one component offers another.
- **Backoff:** increasing the wait before retrying failed work.
- **Bolt:** Slack's application library used for events, connections, and messages.
- **Completion callback:** synchronous database work committed with the incoming message acknowledgement.
- **Cron:** a calendar pattern describing recurring times; Yuno interprets it in UTC.
- **Dead letter:** a message marked `dead` after exhausting retries or being stopped; it will not dispatch automatically.
- **Dispatcher:** the queue worker that claims messages and assigns execution slots.
- **Drizzle:** the TypeScript database library used to read and write SQLite.
- **Edge:** a workflow connection whose condition determines the next node.
- **Event hub:** the in-process broadcaster for validated state updates and persisted log events.
- **Fan-out:** sending one result to several next nodes; Yuno instead chooses one first matching edge.
- **Fastify:** the Node HTTP server framework that hosts the API.
- **Foreign key:** a database rule requiring a referenced record to exist.
- **Guardrail:** an enforced limit or permission controlling an agent's work.
- **HTTP:** the request/response protocol used by the browser API and OpenCode SDK.
- **Idempotency key:** a unique logical delivery identifier used to avoid creating duplicate queue records.
- **Lease:** time-limited ownership shared between workers; Yuno's queue has no distributed lease.
- **Migration:** a checked-in database structure change applied on startup.
- **Node:** one configured agent position in a workflow; one agent can occupy several nodes.
- **OpenCode session:** runtime conversation history associated with a saved runtime ID.
- **Outbox:** durable records of external messages still needing delivery; Slack outbound delivery has no outbox.
- **Permission:** an allow, ask, or deny rule interpreted by the runtime.
- **Quarantine:** refusing more adapter work in a workspace when remote cancellation could not be confirmed.
- **React:** the library rendering the browser interface.
- **React Flow:** the graph editor and viewer library used in workflow screens.
- **Repository:** a module that owns database reads and writes for a particular concern.
- **REST:** HTTP commands and resource reads used alongside the one-way event stream.
- **Run:** one workflow, scheduled request, or chat request and its retained history.
- **SDK:** a library providing typed calls to an external service.
- **Session key:** Yuno's stable name for finding a runtime session, such as `chat:<conversationId>`.
- **Socket Mode:** Slack events delivered over an outbound WebSocket connection.
- **SQLite:** the embedded SQL database storing configuration and execution state locally.
- **SSE:** Server-Sent Events, a one-way HTTP stream of server updates.
- **Step:** the saved record of one node invocation, including status and usage.
- **Token:** a unit of model input or output; recorded token totals are not a count of words.
- **Transaction:** database changes that all commit together or all roll back.
- **Turn:** one runtime invocation of an agent, potentially including multiple model/tool exchanges.
- **UTC:** the shared time reference used for cron and daily spending boundaries.
- **UUID:** a generated identifier used for agents, runs, steps, and messages.
- **Verdict:** the parsed `approved` or `rejected` decision used by graph conditions.
- **WAL:** write-ahead logging, SQLite's disk journal mode allowing concurrent readers.
- **WebSocket:** a persistent two-way connection; Slack Socket Mode uses it.
- **Workspace:** the filesystem directory supplied to an agent turn.
- **zod:** the schema library validating API data and runtime-facing records.
