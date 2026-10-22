# Demo runbook for an automated presenter

This is the step-by-step script for a bot (or a person) recording the Yuno demo video. Every step has four parts:

- **DO**: the exact action, using the exact on-screen labels.
- **WAIT UNTIL**: the visible signal that the step is finished, with a time limit.
- **SAY**: the narration for this step, spoken while doing it or just after.
- **IF NOT**: what to do if the signal does not appear in time.

Target length: about 7 minutes. Narration pace: calm, about 150 words per minute. Pause about 1 second between steps.

---

## Part A. Hard rules for the presenter

1. **Never open:** a terminal, any `.env` file, Docker Desktop, the Slack app settings at api.slack.com, or GitLab Settings or CI/CD variables. These can show secrets.
2. **Never click:** `Delete agent`, `Remove step`, `Load a copy`, `Cancel run`, `Reject`, or `Save workflow`. Never type `make reset`.
3. **Only edit what a step tells you to edit.** In the workflow builder, you may click things to show them, but never save changes.
4. **Only send the Slack messages written in this runbook,** to the DM with the Yuno bot. Do not post in any channel.
5. If something unexpected appears (an error toast, a login page, a permission prompt), stop narrating, take no action, and wait 10 seconds. If it is still there, follow the step's IF NOT, or skip to the next segment.
6. Read the SAY lines naturally. Bracketed text like `[the number]` means: read the value shown on screen.

## Part B. Setup the owner does before recording (not the bot)

- [ ] The docs merge request (`codex/docs-live-validation`) is merged, so the README on GitLab shows **Status**, **Key metrics** and **Runtime choice**.
- [ ] The app is running (`make up`). Open `http://localhost:3000`. The top bar shows **Runtime: ready · 1.19.3**, **Slack: connected**, **Live: connected**.
- [ ] **Do not reset the data.** The demo uses the existing agents (Coder, Reviewer, Deployer, Researcher, Writer, Editor, Yuno Assistant), Yuno Assistant's saved memory about Taylor, its attached skill "Web lookup with source", and the earlier rehearsal run `438e19f9…` as a backup.
- [ ] The **Approvals** badge in the left nav shows **0**. There are no active runs on the Monitor.
- [ ] Coder's **Daily cost cap (USD)** is **2** (Agents → Coder → Guardrails).
- [ ] macOS Do Not Disturb is on. Slack shows only the DM with the Yuno bot; no private channels are visible.
- [ ] Browser window about 1440×900, zoom 110%, bookmarks bar hidden, Yuno in dark theme.
- [ ] Open these tabs, left to right:
  1. **Yuno:** `http://localhost:3000/` (the Monitor)
  2. **Slack:** the DM with the Yuno bot (Apps → **Yuno - Taylor**, or **Yuno Agent** if the app was not renamed; Messages tab)
  3. **GitLab README:** `https://labs.gauntletai.com/taylorclements/yuno`
  4. **GitLab pipelines:** `https://labs.gauntletai.com/taylorclements/yuno/-/pipelines`
- [ ] Start the screen recording with the microphone or voice track on. Begin on tab 1.

Cost of one recording: about $0.10 in OpenAI usage, inside the free daily pool.

---

## Segment 1. Introduction (about 0:00–0:30)

**1.1**
- **DO:** Stay on the Yuno tab, Monitor page. Do nothing else.
- **WAIT UNTIL:** The page shows "Monitor" and the agent cards.
- **SAY:** "This is Yuno, a platform for building AI agents, configuring how they behave, connecting them into workflows, and talking to them from Slack. Every agent runs on OpenCode, a real agent runtime. They call real tools, write real files, and hand work to each other. The whole thing runs on one laptop with one command, `make up`."

**1.2**
- **DO:** Move the pointer over the three status pills at the top: **Runtime: ready · 1.19.3**, **Slack: connected**, **Live: connected**.
- **SAY:** "Up here you can see the runtime is connected, OpenCode version 1.19.3, Slack is connected, and the page is receiving live updates from the server."

---

## Segment 2. Templates: zero to a workflow (about 0:30–1:00)

**2.1**
- **DO:** In the left nav, click **Templates**.
- **WAIT UNTIL:** Two template cards appear: **Development pipeline** and **Research pipeline**. Limit: 5 seconds.
- **SAY:** "Getting to a working multi-agent workflow takes one click. There are two templates: a development pipeline and a research pipeline."

**2.2**
- **DO:** On the Development pipeline card, click **Open existing**.
- **WAIT UNTIL:** The page title says **Workflow builder** and a canvas shows three boxes: Coder, Reviewer, Deployer. Limit: 5 seconds.
- **SAY:** "Loading a template creates the agents and an editable workflow in about twenty milliseconds. I loaded it earlier, so I'll open it."
- **IF NOT:** Click **Workflows** in the left nav, then click **Development pipeline**.

---

## Segment 3. The workflow builder (about 1:00–1:40)

**3.1**
- **DO:** Move the pointer slowly along the canvas: Coder → (the "always" line) → Reviewer → (the green "approved" line) → Deployer. Then move it over the red "rejected" line that curves under the boxes, from Reviewer back to Coder.
- **SAY:** "The workflow is data, not code. The Coder hands its work to the Reviewer. If the Reviewer approves, it goes to the Deployer. If it rejects, the feedback goes back to the Coder, and that loop is capped at a maximum number of iterations."

**3.2**
- **DO:** Scroll down to the **Edges** section. Click the button **Reviewer → Coder · rejected**.
- **WAIT UNTIL:** An **Edge condition** dropdown appears showing **Rejected**.
- **SAY:** "Each connection has a condition: always, approved, rejected, or a text match. Conditions are checked in order, and the first match wins."
- **DO NOT** change the dropdown.

**3.3**
- **DO:** Scroll up to the **Steps** section. Click the button **Deployer**.
- **WAIT UNTIL:** A checked checkbox labelled **Requires approval** is visible.
- **SAY:** "The Deployer step requires a human approval before it runs. All of this is configurable here: the order, the conditions, the approval gates and the loop limit."

---

## Segment 4. Configuring an agent (about 1:40–2:40)

**4.1**
- **DO:** In the left nav, click **Agents**. Then click the **Reviewer** card.
- **WAIT UNTIL:** The page shows **Reviewer**, the line "**20 configurable dimensions** · [N] set on this agent", and the tabs Basics, Tools & permissions, Channels, Schedules, Memory, Skills, Guardrails, Test chat. Limit: 5 seconds.
- **SAY:** "Every agent has twenty configurable dimensions, from one shared list. The header counts how many are set on this agent."

**4.2**
- **DO:** Click the **Basics** tab. Scroll the **System prompt** box until you see the words "house review checklist".
- **SAY:** "Basics is the name, role, model and system prompt. This Reviewer has team standards in its prompt: a reset button, currency to two decimals, a page title and a visible focus style. The Coder is never told about them. It learns them from the Reviewer's feedback."

**4.3**
- **DO:** Click the **Tools & permissions** tab.
- **SAY:** "Each tool, bash, file edit and web fetch, can be allowed, denied, or set to ask, which sends every use to my approval inbox. There's also a list of blocked commands. These are enforced by the runtime, not just stored."

**4.4**
- **DO:** Click the **Guardrails** tab.
- **WAIT UNTIL:** Fields **Daily cost cap (USD)**, **Run cost cap (USD)**, **Max turns per hour** and **Turn timeout (ms)** are visible.
- **SAY:** "And every agent has hard limits on cost, rate and time, checked before every turn. I'll prove that in a minute."

**4.5**
- **DO:** Click **Agents** in the left nav, then click the **Deployer** card, then the **Tools & permissions** tab. Move the pointer over the checked box **Can deploy (write to this run's deployments folder)**.
- **SAY:** "Agents can only touch their own workspace. Deploying is an explicit grant: only the Deployer can write to the deployments folder, and only for its own run."

**4.6**
- **DO:** Click **Agents** in the left nav, then the **Yuno Assistant** card. Click the **Memory** tab. Then click the **Skills** tab.
- **SAY:** "Memory is facts the agent keeps across sessions. This one remembers who I am and what I'm building. Skills are reusable procedures. This one has a skill for looking things up on the web and citing the source. You'll see it in Slack."

---

## Segment 5. A real run, end to end (about 2:40–5:00)

**5.1**
- **DO:** Click **Workflows** in the left nav, then **Development pipeline**. Click the **Run** button at the top.
- **WAIT UNTIL:** A dialog titled **Run workflow** appears, with a **Run input** box.
- **DO:** Click the **Run input** box and type exactly:
  `Build a single-page tip calculator (index.html with inline CSS and JS): inputs for bill amount, tip percent, and number of people; show the total tip, the grand total, and the amount each person pays; validate that inputs are positive numbers.`
- **DO:** Click **Start run**.
- **WAIT UNTIL:** The page changes to **Run detail**, with status **running**. Limit: 5 seconds.
- **SAY:** "Now I'll give the team a real task: build a tip calculator. This runs on OpenCode with GPT-5.4 mini."

**5.2**
- **DO:** Click **Monitor** in the left nav. Scroll so the **Agents** cards and the **Live logs** section are both visible if possible.
- **WAIT UNTIL:** The Coder card shows **working**, and new lines appear in **Live logs** (for example `runtime_tool … apply_patch`). Limit: 30 seconds.
- **SAY:** "On the Monitor you can see each agent's status, the live logs, including every tool call, and every message between agents as it happens. The Coder is writing the file with its edit tool right now."
- **IF NOT:** Keep narrating the next line and continue; the logs appear when the first tool call starts.

**5.3** (fill while waiting; the Coder takes about 45 seconds)
- **DO:** Stay on the Monitor. Do nothing.
- **SAY:** "Every step is saved as it happens: the prompt, the output, tokens and cost. Messages between agents go through a durable queue, so if the server restarted right now, the run would pick up where it left off."

**5.4**
- **DO:** Click **Runs** in the left nav, then click the newest run (the top one, status **running**). Scroll to **Message trail**.
- **WAIT UNTIL:** The trail shows a message **Reviewer → Coder** with the badge **rejected**. Limit: 90 seconds from the start of the run.
- **SAY:** "Here's the loop. The Reviewer opened the actual file, checked it against its checklist, and rejected it." Then read the first sentence of the rejection message out loud. Then say: "That feedback went back to the Coder as a message."
- **IF NOT** (the trail shows **Reviewer → Deployer · approved** with no rejection): Say "This time the Coder passed on the first try. Here's an earlier run where it didn't." Then click **Runs**, click the run whose ID starts with `438e19f9`, scroll to **Message trail**, read the rejection message, and continue at 5.6 with the new run once it reaches the approval step.

**5.5**
- **DO:** Stay on the run page. Watch the **Steps** table.
- **WAIT UNTIL:** The steps show coder / 2 **completed** and reviewer / 2 **completed** with verdict **approved**, and the page shows a **Step approval** box with **Approve** and **Reject** buttons. Limit: 90 seconds.
- **SAY:** "Second pass: the Coder fixed what the Reviewer asked for, and the Reviewer approved. Before anything is deployed, a human has to sign off."

**5.6**
- **DO:** Click **Approvals** in the left nav (its badge shows **1**). In the pending approval for the Deployer, click **Approve**.
- **WAIT UNTIL:** The approval disappears and the badge shows **0**.
- **SAY:** "I'll approve it."
- **IF NOT:** Go back to the run page and click **Approve** in the **Step approval** box there.

**5.7**
- **DO:** Click **Runs**, then the newest run.
- **WAIT UNTIL:** The status shows **completed** and the result text includes "Preview URL: http://localhost:8080/…". Limit: 40 seconds.
- **SAY:** "The Deployer copied the approved site into the deployments folder and verified it. The whole run used [read the token total] tokens, about [read the estimated cost] dollars."

**5.8**
- **DO:** Open a new browser tab and go to the Preview URL from the result text (it looks like `http://localhost:8080/<run id>/`). In the page, click the bill field and type `80`, the tip field and type `20`, the people field and type `4`. If there is a **Calculate** button, click it.
- **WAIT UNTIL:** The page shows a total tip of $16.00, a grand total of $96.00, and $24.00 each.
- **SAY:** "And here's what the agents built. Eighty dollars, twenty percent, four people: sixteen dollars of tip, ninety-six total, twenty-four each."
- **DO:** Click the **Clear** (or **Reset**) button.
- **SAY:** "And the Clear button the Reviewer insisted on."
- **DO:** Close this tab and return to the Yuno tab.

---

## Segment 6. Talking to an agent in Slack (about 5:00–6:00)

**6.1**
- **DO:** Switch to the **Slack** tab (the DM with the Yuno bot).
- **SAY:** "One agent, Yuno Assistant, is connected to Slack. It's the same platform, with the same guardrails, plus its own personality and memory."

**6.2**
- **DO:** Click the message box, type exactly `What do you remember about me?` and press Enter.
- **WAIT UNTIL:** The bot replies (a "thinking…" message may appear first and then change). Limit: 30 seconds.
- **SAY:** "I told it about myself in an earlier conversation. It remembers, because memory is stored by the platform, not by the chat."
- **IF NOT:** Wait another 15 seconds. If there is still no reply, say "Slack is a little slow today" and skip to 6.4.

**6.3**
- **DO:** Type exactly `What is https://opencode.ai? Keep it short.` and press Enter.
- **WAIT UNTIL:** The bot replies with a sentence that ends with a line starting `Source: https://opencode.ai`. Limit: 40 seconds.
- **SAY:** "And it uses its tools. It fetched the real page, and it followed its skill: answer briefly and cite the source."

**6.4**
- **DO:** Switch to the **Yuno** tab. Click **Monitor**. Scroll to **Recent messages**.
- **WAIT UNTIL:** You see the two Slack messages, from **Taylor Clements**, with the **Slack** badge, and the agent's replies.
- **SAY:** "Every Slack message shows up in monitoring next to the agent-to-agent traffic, with the person's name and the channel. Each agent card shows which channel it's connected to."
- **DO:** Move the pointer over the **Yuno Assistant** card's line "Slack: enabled".

---

## Segment 7. Guardrails that are enforced (about 6:00–6:40)

**7.1**
- **DO:** Click **Agents**, then the **Coder** card, then the **Guardrails** tab. Click the **Daily cost cap (USD)** field, select all of its text, and type `0.01`. Click **Save agent**.
- **WAIT UNTIL:** A confirmation appears, or the field keeps the value `0.01` after saving. Limit: 5 seconds.
- **SAY:** "Limits are enforced, not decorative. The Coder has already spent more than one cent today, so I'll set its daily cap to one cent."

**7.2**
- **DO:** Click **Workflows**, then **Development pipeline**, then **Run**. In **Run input**, type exactly `Guardrail check: write hello.txt` and click **Start run**.
- **WAIT UNTIL:** The run detail shows status **failed**, and the steps table shows coder / 1 **blocked** with `daily_cost_cap`. Limit: 10 seconds.
- **SAY:** "The run was blocked before a single token was spent, and the reason is right there: daily cost cap."

**7.3** (required: restore the setting)
- **DO:** Click **Agents**, then **Coder**, then **Guardrails**. Set **Daily cost cap (USD)** back to `2`. Click **Save agent**.
- **WAIT UNTIL:** The field shows `2` after saving.
- **SAY:** "I'll set it back."

---

## Segment 8. Architecture and code (about 6:40–7:20)

**8.1**
- **DO:** Switch to the **GitLab README** tab. Scroll to the **Architecture** heading so the diagram is visible.
- **SAY:** "The code has three layers, as the brief asks: the React UI, the runtime and channel adapters, and persistence in SQLite. OpenCode and Slack each sit behind a small interface, so adding a channel or swapping the runtime is a contained change."

**8.2**
- **DO:** Scroll to the heading **Runtime choice: OpenCode, and the trade-off** so the comparison table is visible.
- **SAY:** "None of the three runtimes in the brief orchestrates a multi-agent workflow, so Yuno owns that part either way. I chose OpenCode for its clean API, per-message configuration and permission events. The trade-off is that I built the channels, scheduler and memory myself, which OpenClaw would have provided."

**8.3**
- **DO:** Scroll to the heading **Key metrics** so the table is visible.
- **SAY:** "The four metrics from the brief, measured: twenty configurable dimensions; one command and one click to a working workflow; every live run completed; and every message delivered, with no retries."

**8.4**
- **DO:** Switch to the **GitLab pipelines** tab. Move the pointer over the newest pipeline's green **passed** status.
- **SAY:** "There are over three hundred and forty automated tests on the critical paths: agent creation, workflow execution and message delivery. Every merge request has to pass lint, types, tests, the build, a secret scan and a commit check before it can merge."

**8.5**
- **DO:** Switch back to the **Yuno** tab, Monitor page.
- **SAY:** "That's Yuno. Thanks for watching."
- **DO:** Wait 2 seconds, then stop the recording.

---

## Part C. After recording (owner)

- [ ] Check that the Coder's **Daily cost cap (USD)** is back to **2**.
- [ ] Watch the video once. Check that no token, key or private Slack content is visible.
- [ ] Upload it and paste the link into the README, replacing "_link added after recording_".

## Timing reference (measured in the rehearsal)

| Step | Typical time |
|---|---|
| Coder, first pass | about 45 s |
| Reviewer | about 12 s |
| Coder, fix | about 20 s |
| Reviewer, second pass | about 11 s |
| Deployer, after approval | about 10 s |
| Slack reply | 4–8 s |
| Guardrail block | under 2 s |
