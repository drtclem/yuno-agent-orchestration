# Slack chat

_Last updated: 2026-10-20 - Show Slack name resolution and normalized inbound text before durable acceptance._

```mermaid
sequenceDiagram
  actor User
  participant Slack
  participant Channel as Slack ChannelAdapter
  participant Chat as chat
  participant Engine as engine
  participant DB as SQLite / dispatcher
  participant Runtime as AgentRuntime
  User->>Slack: DM or app mention
  Slack->>Channel: Socket Mode event
  Channel->>Channel: Validate, ignore bots/subtypes, map conversation
  Channel->>Slack: users.info for uncached sender and mentions (concurrent)
  Slack-->>Channel: Display names, or user IDs on failure
  Channel->>Channel: Normalize mentions, links, and entities
  Channel->>Chat: receive validated text + userName
  Chat->>Engine: startChat for bound agent
  Engine->>DB: Atomic event dedupe + conversation + run + inbound with fromName
  alt Duplicate externalEventId
    DB-->>Engine: Existing run
    Note over Engine,DB: No new turn queued
  else New event
    DB-->>Engine: New durable run
  end
  Channel-->>Slack: Bolt ACK after durable acceptance
  DB->>Engine: Claim queued chat message
  Engine->>Engine: Check guardrails
  Engine->>Chat: Request placeholder
  Chat->>Channel: postPlaceholder(thinking…)
  Channel->>Slack: chat.postMessage
  Slack-->>Chat: Message handle
  Engine->>Runtime: Turn, session chat:conversationId
  Runtime-->>Engine: Events + final reply
  Engine->>DB: Ack + stripped reply + memories + completed run
  Engine-->>Chat: Committed run.updated via EventHub
  Chat->>Channel: updateMessage(handle, reply)
  Channel->>Slack: chat.update
  Slack-->>User: Placeholder replaced by reply
```

Slack API calls have a 15-second timeout. Rejected inbound persistence is not ACKed so Slack may retry. UI test chat uses the same durable engine path without Slack delivery.

Name lookups share cached promises, capped at 256 users with FIFO eviction and cleared on stop. Lookup failures remain cached as user IDs until eviction or stop and appear in channel status. Normalized text reaches storage and the agent; `fromName` is display metadata, while `fromId` keeps the original user ID. UI test chat supplies `You (UI)` as the sender name.

Delivery handles live only in memory. A crash after persistence can leave a stale placeholder, and failed final delivery is logged without rerunning the model. Failed/cancelled runs replace a known placeholder with a visible failure. Missing credentials leave Slack unconfigured.
