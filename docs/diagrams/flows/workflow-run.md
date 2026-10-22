# Development workflow run

_Last updated: 2026-10-20 - Show graph snapshot routing and the run-scoped deploy grant._

```mermaid
sequenceDiagram
  actor User
  participant API as Fastify API
  participant Engine as engine
  participant Queue as dispatcher / SQLite
  participant Runtime as AgentRuntime
  participant Approval as approvals
  User->>API: Start dev-pipeline with input
  API->>Engine: start workflow
  Engine->>Queue: Persist running run + graph snapshot + Coder message
  Note over Engine,Queue: Route workflow steps using the saved graph
  Queue->>Engine: Claim Coder message
  Engine->>Runtime: Coder turn after guardrails
  Runtime-->>Engine: Files + summary
  Engine-->>Queue: Completion callback: step + Reviewer message
  Note over Queue: Ack + completion writes in one transaction
  Queue->>Engine: Claim Reviewer message
  Engine->>Runtime: Reviewer turn
  Runtime-->>Engine: Feedback + VERDICT: REJECTED
  Engine-->>Queue: Ack + rejected edge to Coder
  Queue->>Engine: Claim Coder revision message
  Engine->>Runtime: Coder turn with feedback
  Runtime-->>Engine: Revision summary
  Engine-->>Queue: Ack + Reviewer message
  Queue->>Engine: Claim Reviewer message
  Engine->>Runtime: Reviewer turn with reused node session
  Runtime-->>Engine: VERDICT: APPROVED
  Engine-->>Queue: Ack + approved edge to Deployer
  Queue->>Engine: Claim Deployer message
  Engine-->>Queue: Park pending message + blocked step
  Engine->>Approval: Create step_gate, run waiting_approval
  User->>API: Approve gate
  API->>Approval: Resolve pending approval
  Approval->>Queue: Run running, message becomes claimable
  Queue->>Engine: Claim parked message, reuse blocked step
  Engine->>Runtime: Deployer turn with compiled canDeploy run directory
  Note over Runtime: Create /deployments/runId/ and configure scoped permission
  Runtime-->>Engine: Final reply or visible runtime error
  Engine-->>Queue: Atomic ack + terminal result on successful turn
```

Each node is bounded by `maxIterations` (template default 6). Edge order is first-match. Missing review verdict routes as rejected once, then fails if repeated. A rejected/expired human gate fails the run; it does not take the review rejection edge.

The template Deployer has `canDeploy: true`. Its compiled prompt and OpenCode policy permit `/deployments/<runId>/`; other outside directories remain denied by policy. The app and OpenCode share this deployment mount with the preview container. Fake runtime replies do not prove files were deployed, and the policy is not an operating-system sandbox.
