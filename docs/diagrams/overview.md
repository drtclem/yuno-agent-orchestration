# System overview

_Last updated: 2026-10-20 - Show run-scoped deployment policy and the shared deployment mount._

```mermaid
flowchart LR
  subgraph ui["UI layer"]
    browser["React browser UI"]
  end
  subgraph integration["Runtime integration layer"]
    api["Fastify API"]
    subgraph domain["Domain"]
      engine["engine"]
      dispatcher["dispatcher"]
      guardrails["guardrails"]
      approvals["approvals"]
      scheduler["scheduler"]
      chat["chat"]
    end
    hub["EventHub / SSE"]
    runtime["AgentRuntime"]
    opencode["OpenCode container"]
    openai["OpenAI"]
    channel["ChannelAdapter"]
    slack["Slack"]
  end
  subgraph persistence["Persistence layer"]
    repos["db/repos"]
    sqlite[("SQLite WAL")]
    workspace["Shared workspaces"]
    deployments["Deployment files"]
    sessions["OpenCode session volume"]
  end
  preview["nginx preview container :8080"]
  browser -->|"REST"| api
  api --> engine & approvals & chat
  scheduler --> engine
  chat --> engine
  engine --> guardrails & approvals & runtime
  dispatcher --> engine
  engine --> hub
  dispatcher --> hub
  hub -->|"SSE"| browser
  api --> repos
  engine --> repos
  dispatcher --> repos
  approvals --> repos
  scheduler --> repos
  chat --> repos
  hub -->|"logs"| repos
  repos --> sqlite
  runtime --> opencode --> openai
  opencode --> workspace & sessions
  chat --> channel <--> slack
  runtime -->|"create run deployment directory"| deployments
  opencode -->|"canDeploy policy permits run directory"| deployments
  deployments --> preview --> browser
```

Fake mode substitutes a deterministic `AgentRuntime`; absent Slack credentials leave the channel unconfigured. The app serves the built web UI on port 3000. OpenCode has no published host port.

The app and OpenCode share `/deployments`; nginx serves the same files read-only. For agents with `canDeploy`, the adapter creates `/deployments/<runId>/` and configures an outside-workspace exception for that run directory. This depicts configured permissions, not a verified live deployment or operating-system sandbox.
