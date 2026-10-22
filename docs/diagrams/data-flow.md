# Data flow

_Last updated: 2026-10-20 - Show normalized Slack text and persisted sender display metadata._

```mermaid
flowchart LR
  browser["Browser UI"]
  api["Fastify API"]
  repos["db/repos"]
  db[("SQLite")]
  engine["engine"]
  compiler["compileAgent"]
  dispatcher["dispatcher"]
  runtime["AgentRuntime / OpenCode"]
  hub["EventHub"]
  sse["GET /api/events"]
  slack["Slack"]
  channel["ChannelAdapter"]
  chat["chat"]
  browser -->|"agent config / graph / input / decisions"| api
  api -->|"validated configuration"| repos
  browser -->|"GET /api/logs: Monitor initial history"| api
  repos -->|"persisted logs: newest last"| api
  api -->|"log history merged with SSE by log id"| browser
  repos <-->|"rows"| db
  api -->|"workflow run request"| engine
  api -->|"UI test-chat request"| chat
  engine -->|"run + graph snapshot + initial message rows"| repos
  repos -->|"due message claim"| dispatcher
  dispatcher -->|"message + AbortSignal"| engine
  repos -->|"agent / memories / skills"| compiler
  compiler -->|"compiled prompt / tools / run-scoped permissions"| engine
  engine -->|"TurnInput / sessionKey / workspaceDir"| runtime
  runtime -->|"runtime events / TurnResult"| engine
  engine -->|"transaction: step, memories, run, next message"| repos
  dispatcher -->|"transaction: ack + completion writes"| repos
  engine -->|"usage / state events"| hub
  dispatcher -->|"committed message and completion events"| hub
  hub -->|"log rows only"| repos
  hub -->|"SSE events"| sse -->|"query invalidation / live logs"| browser
  slack -->|"Slack events / user profiles"| channel -->|"validated normalized text + userName"| chat
  chat -->|"deduplicated durable chat acceptance"| engine
  chat -->|"placeholder / final update"| channel -->|"Slack API calls"| slack
```

Runtime session IDs persist in `runtime_sessions`; OpenCode's own sessions persist in its volume. Full prompts and replies are stored in message/step rows, not logs. SSE has no replay or durable outbox: reconnect refreshes authoritative REST queries. Slack delivery handles are process-local, so persistence and delivery are separate guarantees.

Human message rows retain `fromId` and optional `fromName` display metadata. MessageTrail uses these names and agent configuration names for sender/recipient labels; a chat reply's human recipient is inferred for display from the same run and conversation, falling back to the latest prior human message in that conversation.

On open, Monitor loads the last 200 persisted logs through `GET /api/logs` (validated limit, maximum 500). It merges history with SSE logs by log ID, sorts oldest first, and displays up to 500 entries.

Workflow runs persist their graph at start; the engine routes and the run detail UI draws from that snapshot. Older runs without a snapshot fall back to the current workflow graph, with a notice in the run view. `compileAgent` receives the run ID and includes the deployment directory only when `canDeploy` is enabled.
