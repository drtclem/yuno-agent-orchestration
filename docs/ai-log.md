# AI usage log

**How the work is split:** Claude (claude.ai) for planning, architecture, and decisions; Codex CLI (GPT) for building, testing, committing, and merging, with project subagents (`.codex/agents/`). The owner signs off on every decision.

**Entry template:** date · what I asked · what happened · worked / didn't · what I overrode and why.

---

### 2026-10-19 · Brief review and stack
- **Asked:** Claude to read the brief line by line, scope all deliverables, and propose the stack.
- **Happened:** Claude listed the deliverables and the implied requirements (enforced guardrails, an approval flow, the four impact metrics as design targets) and compared the three runtimes. It found that none of them orchestrates multiple agents, so the platform must own the workflow engine. It recommended OpenCode over its HTTP server and Telegram as the channel.
- **Overrode:** Chose Slack over Telegram. Claude listed the Slack-specific risks (manual app setup, DMs off by default, bot reply loops, event retries) and designed around them (Socket Mode, dedupe, placeholder-then-update).
- **Correction:** Claude's first summary of the brief came from the project description; it had not opened the PDF yet. It then read the PDF line by line, and the scope held with no changes.

### 2026-10-19 · Model choice from the complimentary token pools
- **Asked:** Pick an API model that fits OpenAI's complimentary daily tokens (screenshot of the data-sharing settings).
- **Happened:** Claude estimated agent-loop token use and showed that one dev-pipeline run (~500K tokens) would use twice the 250K large-model pool, so it chose `gpt-5.4-mini` from the 2.5M pool. It flagged that the free tokens require sharing prompts with OpenAI.
- **Worked:** yes.

### 2026-10-19 · Agent setup ported from Cursor to Codex
- **Asked:** Reuse the agents and skills from earlier projects.
- **Happened:** Claude ported the boostlingo Cursor agents to Codex TOML agents and replaced the realtime-auditor with an orchestration-auditor. It turned the workflow rule into `AGENTS.md` with a "night mode" so Codex builds unattended, and wrote `scripts/night-run.sh` (one fresh `codex exec` per task).
- **Live checks:** Codex docs show `--full-auto` was removed in 2026; the script uses `--sandbox danger-full-access --ask-for-approval never`. OpenCode has v1 and v2 config formats, so spike T1 pins a version before any adapter code.

### 2026-10-20 · Morning review of the night run
- **Happened:** Codex finished T0–T19 overnight (30 MRs, 279 tests, 30/34 requirements covered). Only T1 and T7 called the real OpenAI API (a few prompts, a few cents); everything else used the fake runtime.
- **Codex caught a design flaw in Claude's plan:** D5 sent per-prompt tool switches, but OpenCode 1.19.3 turns those into "allow" rules that silently override "ask", so approvals would not have been enforced. Codex found it in the spike, used permissions only, and proved it with live denial tests. Accepted as the D5 amendment.
- **Gap in the plan:** the GitLab project had no working CI runner. Codex registered and removed a temporary runner for every task (with design-critic sign-off, logged as Q-03 and repeats). Replaced with one persistent runner (D11). "Pipelines must succeed" was off on GitLab; turned on.
- **Owner/Claude review:** all 39 questions read; 4 changed (model list, UTC label, the dimension count for the key metric, the run graph snapshot), and the Deployer conflict (Q-29) resolved with a `canDeploy` grant. Bundled into T22 with the CI/CD skill's local hooks and extra CI jobs.
- **Also noticed:** a runner token was printed into a local night log (gitignored, runner already deleted); logs removed.

### 2026-10-20 · Live validation, metrics and the demo
- **Asked:** Claude to test the app live in the desktop browser, measure the brief's four impact metrics, refresh the README, and write a demo script an automated presenter (a Grok bot) could follow.
- **Happened:** Claude drove the real app: a full dev-pipeline run, API checks for agent CRUD and validation, a cost-guardrail block (0 tokens), and the Slack round trip with memory recalled in a separate session. It found UI bugs that unit tests had missed (the rejected edge drawn as a filled shape, agent IDs instead of names, raw Slack user IDs and link markup, the live log empty after a reload). These became T23 and T24, which Codex built and merged.
- **Worked:** the first live run had no feedback loop because the Reviewer approved on its first pass. A "house review checklist" in the Reviewer's prompt (T23), which the Coder is not told about, produced a real reject → fix → approve loop on the next run (`438e19f9…`, 2 min 11 s, $0.09).
- **Corrected:** the audit against the brief found that only one of the four impact metrics had been addressed. Claude measured the rest from live runs and added them to the README and `docs/live-validation.md`. Unsourced claims about OpenClaw and Goose were removed from the runtime comparison before publishing.
- **Delivery:** the narration went to a Google Doc; the click-by-click runbook (`docs/demo-runbook.md`) drove the recording. Recording: https://www.loom.com/share/60954e1934794390a3e5729f18cde015
- **Cost:** about $0.17 of OpenAI API usage for day two's live testing before the recording (session 1 about $0.06, session 2 $0.10, the skill test under $0.01), plus the recorded runs. All of it is inside the complimentary daily pool.
