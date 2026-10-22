# Live validation, 2026-10-20

Evidence for the requirements that automated tests cannot prove on their own: real runtime execution, the real Slack round trip, and the measured impact metrics. Everything here ran on the owner's Mac with `make up` (OpenCode 1.19.3, model `openai/gpt-5.4-mini`, Slack Socket Mode). Observed through the Yuno UI and API by Claude in the desktop app's browser, with the owner sending the Slack messages.

The database was reset once at about 09:27 CT (to pick up the T23 template changes), so the session totals below cover the second session only. Session 1 results are listed separately.

## 1. Multi-agent workflow with a feedback loop (R-12, R-14, R-15, R-16, R-26, R-27)

Run `438e19f9-e831-498e-9f85-58b1b1a75aed`, Development pipeline, started 11:03:42 CT, completed 11:05:53 CT.

Task: "Build a single-page tip calculator (index.html with inline CSS and JS): inputs for bill amount, tip percent, and number of people; show the total tip, the grand total, and the amount each person pays; validate that inputs are positive numbers."

| Step | Result | Input tokens | Output tokens | Est. cost | Duration |
|---|---|---|---|---|---|
| Coder, iteration 1 | Wrote `site/index.html` | 12,113 | 4,109 | $0.0354 | 43 s |
| Reviewer, iteration 1 | **Rejected**: "`site/index.html:174-196` has no visible Reset or Clear control…" (the other checklist items passed) | 7,619 | 338 | $0.0122 | 12 s |
| Coder, iteration 2 | Added a Clear button that resets inputs, errors and totals | 14,094 | 1,229 | $0.0236 | 21 s |
| Reviewer, iteration 2 | **Approved** | 7,791 | 285 | $0.0107 | 11 s |
| Human approval gate | Approved in the approval inbox | — | — | — | about 7 s |
| Deployer | Copied the site to `/deployments/438e19f9-…/` and verified the checksum | 5,649 | 578 | $0.0100 | 10 s |
| **Total** | **completed** | **53,805 tokens** | | **$0.0919** | **2 min 11 s** (97 s of agent time) |

Deployed page check (`http://localhost:8080/438e19f9-…/`): with $80, 20% and 4 people it shows total tip $16.00, grand total $96.00, and $24.00 each. Clear resets the inputs and totals. The page has a `<title>` and `<meta name="viewport">`.

The message trail showed every handoff (UI → Coder → Reviewer → Coder → Reviewer → Deployer) with its status and verdict.

## 2. Slack conversation (R-18, R-19, R-20, R-23)

Agent **Yuno Assistant** (friendly, concise personality; `edit` and `webfetch` allowed, `bash` denied; $1/day cap), bound to Slack. Status bar: "Slack: connected".

| Time (CT) | Where | Message | Result |
|---|---|---|---|
| 09:36 | Slack DM | "Hi! I'm Taylor. I'm building Yuno … and I prefer short answers. Please remember that." | Reply in character in about 6 s. Memory saved by the agent: "Taylor is building Yuno, an agent orchestration platform, for a Gauntlet project, and prefers short answers." |
| 09:36 | Slack DM | "Can you check https://opencode.ai and tell me in one sentence what it is?" | Logs show `webfetch` started, then completed. The reply named the page it used. |
| 09:37 | Yuno Test chat (a **separate conversation and session**) | "What do you know about me?" | "I only know that you're Taylor, you're building Yuno, an agent orchestration platform for a Gauntlet project, and you prefer short answers…" — memory persisted across sessions and channels. |

All four Slack messages (two human messages and two agent replies) appeared in the Monitor, marked as Slack. Three chat turns cost $0.0113 in total.

## 3. Guardrails and validation (R-01, R-02, R-07, R-13, session 1)

| Check | Result |
|---|---|
| Daily cost cap: Coder's cap set to $0.01, below its spend that day, then a run started | Run **failed with `daily_cost_cap`, 0 tokens used**; the step was marked blocked. The cap was restored afterwards. |
| Create / update / delete an agent | 201 / 200 / 204; a read after delete returned 404 |
| Empty name, disallowed model (`openai/gpt-4o`), duplicate name | 400 with a field message, 400, 409 |
| Add a memory fact | 201, then listed |
| Load the research-pipeline template | 201; created Researcher, Writer and Editor |
| Save a graph with an edge to a missing node | 400 "Unknown edge target"; workflow unchanged |

Session 1 also ran the development pipeline end to end (run `13e3ce85-d483-40d1-9d23-ec79a63ed6bd`): the Reviewer approved on the first pass, the human approved the deploy, and the deployed calculator computed $100, 20%, 4 people as $5.00 tip and $30.00 total per person. That run is why the Reviewer now has a house checklist (T23): the first live run had no feedback loop.

## 4. Impact metrics

| Metric | Measured |
|---|---|
| Configurable dimensions per agent | 20 (shared list, shown in the editor) |
| Zero to a working workflow | `make up`; template load 21 ms (creates 3–4 agents and an editable workflow); measured feedback-loop run completed in 2 min 11 s including one rejection loop and a human approval |
| Completion rate | Workflow runs: 2 of 2 completed (sessions 1 and 2). Chat turns: 3 of 3. One additional run was blocked on purpose by the cost guardrail. |
| Message reliability (session 2) | 11 messages, 11 acknowledged (4 agent-to-agent, 4 Slack, 3 UI); 0 retries; 0 dead letters |
| Session 2 spend | 65,087 tokens, $0.1033 estimated |

## 5. Skill affecting a reply (R-05)

At 13:47 CT a skill, "Web lookup with source" (fetch the page with webfetch, answer in one or two sentences, end with `Source: <url>`), was created and attached to Yuno Assistant. In Test chat, "What is https://goose-docs.ai about?" returned a two-sentence answer ending `Source: https://goose-docs.ai`, as the skill's steps require.

## 6. Recorded walkthrough (R-34)

The owner recorded the demo on 2026-10-20 following `docs/demo-runbook.md`: https://www.loom.com/share/60954e1934794390a3e5729f18cde015

## Not yet observed live

These are covered by automated tests but were not exercised against the real runtime: scheduled turns, tool-level "ask" approval through the inbox, a blocked bash command, and the rate limit.
