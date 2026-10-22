# Demo video plan and script

Target length: **6–7 minutes**. One take per segment; stitch afterwards. The voice-over is in first person and plain. Read it naturally rather than word for word.

The brief requires that the video shows (1) a multi-agent workflow running end to end on the real runtime, and (2) a live conversation with an agent in Slack. Everything else is there to score on configurability, architecture and the four impact metrics.

---

## Before recording (about 20 minutes, once)

**Stack and data**
- [ ] `git pull` on `main`, then `make down && make reset && make up`. Wait for `opencode server listening` and the app.
- [ ] Open `http://localhost:3000`. The status pills read **Runtime: ready · 1.19.3**, **Live: connected**.
- [ ] Load the **Development pipeline** template (Templates page). Load the **Research pipeline** too, so the Workflows list isn't empty.
- [ ] Recreate **Yuno Assistant** and bind it to Slack (see the appendix). The Slack pill reads **connected**.
- [ ] In Slack, DM the bot once: "Hi, I'm Taylor. I'm building Yuno for a Gauntlet project and I prefer short answers." This seeds a memory so the memory moment in segment 6 is quick.
- [ ] **Rehearsal run:** run the dev pipeline once with the task in segment 5. Confirm the Reviewer rejects at least once. Keep this run; it is your backup (see "If something goes wrong").

**Screen**
- [ ] Browser: a clean window, bookmarks bar hidden, zoom 110–125%, dark theme in Yuno. Tabs: Yuno (localhost:3000), Slack, GitLab pipelines page, README on GitLab.
- [ ] Turn on macOS **Do Not Disturb**. Close Slack channels with private content.
- [ ] Don't show `.env`, the terminal history with token prompts, or the Slack app settings page with tokens.
- [ ] Recorder: QuickTime (File → New Screen Recording) or Screen Studio, 1080p or higher, microphone on.

**Cost:** each full dev-pipeline run is about $0.05–0.10 on `gpt-5.4-mini`, inside the free daily pool. Budget 3 runs plus a few Slack messages.

---

## Segment 1: What this is (0:00–0:30)

**Screen:** Monitor page, idle.

> I'm Taylor Clements. This is Yuno, a platform for building AI agents, configuring how they behave, wiring them into workflows, and talking to them from Slack. Every agent runs on OpenCode, a real agent runtime. They call real tools, write real files, and hand work to each other. Everything runs on my laptop with one command.

---

## Segment 2: Zero to a workflow (0:30–1:00)

**Screen:** terminal with `make up` already running (show the last lines), then the Templates page.

> Setup is one command, `make up`. It starts three containers: the app, the OpenCode runtime, and a small preview server for anything the agents deploy.
>
> From here, a working multi-agent workflow is one click. I'll load the development pipeline template.

**Action:** click **Load** on Development pipeline. If it's already loaded, click **Open existing**. This lands in the workflow builder.

> That created three agents, a Coder, a Reviewer and a Deployer, and a workflow that connects them.

---

## Segment 3: Configuring an agent (1:00–2:00)

**Screen:** Agents → **Reviewer**.

> Each agent has twenty configurable dimensions. The header shows the count and how many are set on this agent.

**Action:** walk the tabs at a steady pace, about 5 seconds each:
1. **Basics.** Role, model (from the free-tier allowlist), and the system prompt. Scroll to the **house review checklist**.
   > The Reviewer has team standards in its prompt: a reset button, currency to two decimals, a page title, visible keyboard focus. The Coder isn't told about them. It learns them from feedback.
2. **Tools & permissions.** Bash, edit and web fetch, each with allow, ask or deny, plus blocked commands.
   > Tools are enforced by the runtime, not just stored. If I set bash to "ask", every command comes to my approval inbox.
3. **Memory, Skills, Schedules.** One sentence each.
   > Memory persists across sessions. Skills are reusable procedures. Schedules wake an agent on a cron or an interval.
4. **Guardrails.** The run cost cap, daily cost cap, turns per hour and turn timeout.
   > And every agent has hard limits on cost and rate, checked before every turn.

**Action:** open **Deployer → Tools & permissions** and point at **Can deploy**.

> Agents can only touch their own workspace. Deploying is an explicit grant: only the Deployer can write to the deployments folder, and only for its own run.

---

## Segment 4: The workflow builder (2:00–2:40)

**Screen:** Workflows → Development pipeline.

> The workflow is data, not code. Coder hands to Reviewer. If the Reviewer approves, it goes to the Deployer. If it rejects, the feedback goes back to the Coder. The Deployer step needs a human approval, and the loop is capped at six iterations.

**Action:** click the **rejected** edge to show the condition picker, then click the Deployer node to show the **Requires approval** toggle. Don't save changes.

> Any of this is configurable: conditions, order, approval gates, loop limits. Nothing is hardcoded.

---

## Segment 5: A real run, end to end (2:40–4:40)

**Screen:** builder → **Run**. Paste:

```
Build a single-page tip calculator (index.html with inline CSS and JS): inputs for bill amount, tip percent, and number of people; show the total tip, the grand total, and the amount each person pays; validate that inputs are positive numbers.
```

**Action:** start the run, then go to **Monitor** (live logs on screen) and then the run detail page.

> Now it's running on OpenCode with GPT-5.4 mini. On the Monitor you can see each agent's status, the live logs including tool calls, and every message between agents as it happens.

**While the Coder works (about 30 seconds):**
> The Coder is writing the file with its edit tool. Every step is saved, the prompt, the output, tokens and cost, so the run history survives a restart.

**When the Reviewer rejects:** open the message trail and read the first line or two of the feedback.
> The Reviewer opened the actual file, found what's missing against its checklist, and rejected it. That feedback is a message back to the Coder. Here's the loop.

**When the Coder fixes it and the Reviewer approves:**
> Second pass: the Coder addressed the feedback, and the Reviewer approved.

**When the run waits for approval:** open **Approvals** (the badge shows 1) and click **Approve**.
> Before anything is deployed, a human has to sign off.

**When the run completes:** show the steps table (tokens, cost), then click the preview link or open `localhost:8080/<runId>/` and try the calculator ($80, 20%, 4 people → tip $16.00, grand total $96.00, $24.00 each).
> The Deployer copied the approved site and verified it. Here it is, working. That whole run cost about [read the number] cents.

*Editing note:* cut the waits between turns, but keep one visible moment of each status change on the graph.

---

## Segment 6: Talking to an agent in Slack (4:40–5:40)

**Screen:** Slack, DM with **Yuno - Taylor**.

> One agent, Yuno Assistant, is connected to Slack. Same platform, same guardrails, its own personality and memory.

**Send:** `What do you remember about me?`
> It remembered what I told it earlier. Memory is stored by the platform. In live validation, it also recalled that fact in Test chat, a separate conversation and session.

**Send:** `Can you check https://opencode.ai and tell me in one sentence what it is?`
> And it uses its tools. This one is fetching a real web page.

**Switch to Yuno → Monitor.** Point at the Slack-tagged messages with your name and the `webfetch` tool log.
> Every Slack message shows up in monitoring next to the agent-to-agent traffic. The UI shows which channel each agent is connected to.

---

## Segment 7: Guardrails and reliability (5:40–6:20)

**Screen:** Agents → Coder → **Guardrails**. Set the daily cost cap to `0.01` and save. Start a run. It fails immediately.

> Limits are enforced, not decorative. I set the Coder's daily cap below what it has already spent, and the run is blocked before a single token is used.

**Action:** show the blocked reason in the run (`daily_cost_cap`), then set the cap back to `2` and save.

> Under the hood, agent-to-agent messages go through a durable queue in SQLite. Each handoff is saved before it's acted on, retried with backoff, de-duplicated, and recovered after a crash. Those paths are covered by tests.

---

## Segment 8: Architecture and code (6:20–7:00)

**Screen:** README on GitLab → architecture diagram. Then the GitLab pipelines page (green).

> The architecture has three layers that the brief asks to keep separate: the React UI, the runtime and channel adapters, and persistence. OpenCode and Slack each sit behind a small interface, so adding a channel or swapping the runtime is a contained change. The README has the reasoning for TypeScript and for OpenCode over OpenClaw and Goose, plus how to add a template or a channel.
>
> There are over 340 tests on the critical paths: agent creation, workflow execution, message delivery. Every merge request has to pass lint, types, tests, build, a secret scan and a commit check before it can merge.

**Close (5 seconds):**
> That's Yuno. Thanks for watching.

---

## If something goes wrong

| Problem | What to do |
|---|---|
| The Reviewer approves on the first pass (no loop) | Keep recording; say "this time it passed first try". Then open **Runs** and show the rehearsal run's trail with the rejection. Or re-run. |
| A run fails (`runtime_turn_failed`, timeout) | Show the failure state briefly ("failures are visible, not silent"), then start a new run. |
| Slack shows "thinking…" for more than 30 seconds | Check the Slack pill in Yuno. Run `docker compose up -d --force-recreate app` off camera and re-record segment 6. |
| The approval card doesn't appear | Check the Approvals page badge; refresh the page (the state reloads from the API). |
| You stumble over a line | Pause two seconds and repeat the sentence. Cut it in editing. |

---

## Appendix: recreate the Slack agent after `make reset`

Agents → **New agent**:
- **Name:** Yuno Assistant · **Role:** Friendly team assistant on Slack · **Model:** openai/gpt-5.4-mini
- **System prompt:** "You are Yuno Assistant, a warm, concise teammate who chats in Slack. Keep replies short (2–5 sentences) and friendly, use plain language. When someone shares a lasting fact or preference about themselves or the team, save it with a REMEMBER: line. Use what you remember naturally. You can fetch public web pages when asked to look something up: say which page you used. You can write short notes into your workspace when asked. Never ask for or repeat passwords, keys or tokens."
- **Tools:** bash off · edit on (allow) · webfetch on (allow)
- **Guardrails:** $1/day, $0.25/run, 30 turns/hour, 120 s timeout
- **Channels:** Slack, enabled
- Save, then check that the Slack pill reads **connected** (if not: `docker compose up -d --force-recreate app`).
