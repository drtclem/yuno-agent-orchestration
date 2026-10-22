# Spike S1 — OpenCode

## 1. Version

Exact pin: `opencode-ai@1.19.3`, npm `latest` on 2026-10-19. The installed binary and `GET /global/health` report `1.19.3`. T7 must install matching SDK `1.19.3`; T14 must install this exact CLI version (no caret or latest). No OpenCode dependency is added to the repository in T1.

Installed in `/tmp/yuno-T1-spike`. npm postinstall initially failed because the default user config directory was inaccessible. Installed the matching `opencode-darwin-arm64@1.19.3` package and used its binary with isolated `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` below that scratch directory. Served only on `127.0.0.1`, ports 14096 (schema/config) and 14097 (live prompts). No user OpenCode configuration or credentials were imported.

Sources: [official server reference](https://opencode.ai/docs/server/), [permissions reference](https://opencode.ai/docs/permissions/), and the installed server's live `/doc`. The live spec takes precedence over the website's older permission endpoint example.

## 2. Live OpenAPI

Fetched `http://127.0.0.1:14096/doc` with a 5-second timeout. This is OpenAPI 3.1. Schema fingerprint (SHA-256): `eebb56042880e07c354e0ad0a31f70aab45f536adf5b40b6b1fd5abf4663417b`.

| Operation | Exact request / response |
|---|---|
| `GET /global/health` | `{ healthy: true, version: "1.19.3" }` (5-second health timeout) |
| `POST /session` | Optional `title`, `parentID`, `permission` ruleset; returns session with `id` |
| `POST /session/{sessionID}/message` | Required `parts`; optional `system`, `model`, `tools`, `agent`, `noReply`, `messageID`, `format`, `variant`; returns `{info: AssistantMessage, parts: Part[]}` |
| `GET /session/{sessionID}/message` | All messages, or pagination via `limit` and `before`; retain every assistant message belonging to the turn |
| `GET /event` | SSE; subscribe before submitting prompt |
| `POST /session/{sessionID}/abort` | Abort runtime work; dropping HTTP alone is insufficient |
| `GET /permission` | Pending requests; useful when reconnecting |
| `POST /permission/{requestID}/reply` | `{reply:"once"}` / `{reply:"reject"}`; also accepts `always`, optional `message`; returns boolean |
| `GET /config`, `PATCH /config` | Effective config / update config, scoped by directory |

Directory is an optional `directory` **query parameter** on session, prompt, permission, config and event operations. The `x-opencode-directory` header also worked experimentally. Use the same absolute workspace directory for every request, including SSE, permission reply, session read and abort. `workspace` is a separate optional query field; it is not needed for this design. SDK calls must use the matching generated API's query field; the SDK was not installed or exercised in T1.

Minimal prompt body (model fields are case sensitive):

```json
{
  "model": { "providerID": "openai", "modelID": "gpt-5.4-mini" },
  "system": "Do only the requested single action, no exploration.",
  "parts": [{ "type": "text", "text": "Create hello.txt in this workspace." }]
}
```

`tools` is a `Record<string, boolean>` but is **not safe to send as an enablement map**; see item 3. Session creation's `model` has a different shape (`id`, `providerID`), so do not reuse the prompt model object there.

Observed event names: `message.updated`, `message.part.updated`, `message.part.delta`, `permission.asked`, `permission.replied`, `session.status`, `session.idle`, `file.edited`. Live schema fields:

- `message.updated`: `{id,type,properties:{sessionID,info}}`; `info.role === "assistant"` carries usage and errors.
- `message.part.updated`: `{id,type,properties:{sessionID,part,time}}`. A tool part has `type:"tool"`, `tool`, `callID`, `messageID`, `sessionID`, and `state.status`: `pending`, `running`, `completed`, or `error`. Map `error` to Yuno `failed`. Editing can arrive as `apply_patch`, not just `edit` or `write`.
- `message.part.delta`: `properties:{sessionID,messageID,partID,field,delta}`.
- `permission.asked`: `properties:{id,sessionID,permission,patterns,metadata,always,tool?}`. `tool`, when present, contains `messageID`, `callID`.
- `permission.replied`: `properties:{sessionID,requestID,reply}`.

Observed permission payload, IDs shortened (no secrets):

```json
{
  "id": "evt_example",
  "type": "permission.asked",
  "properties": {
    "id": "per_example",
    "sessionID": "ses_example",
    "permission": "bash",
    "patterns": ["printf yuno-permission-check ."],
    "metadata": { "command": "printf yuno-permission-check ." },
    "always": ["printf *"],
    "tool": { "messageID": "msg_example", "callID": "call_example" }
  }
}
```

Usage is `info.cost` (USD), `info.tokens.input`, `.output`, `.reasoning`, `.cache.read`, `.cache.write`, optional `.total`. `message.updated.properties.info` has the same fields. These are **per assistant message**, not a turn total. A tool-using turn produced two assistant messages; the final POST response contained only the last one and no tool parts. Deduplicate updates by message ID, replace that message's latest counters, and sum assistant messages for this turn only. Do not sum repeated updates or old session history. Keep cache and reasoning counts separate; do not assume `total === input + output`. `step-finish` parts also carry usage: do not count both sources.

## 3. Per-directory permissions

Confirmed: separate workspace `opencode.json` files are honored. Workspace A:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": { "*": "ask", "rm *": "deny" },
    "edit": "allow",
    "webfetch": "deny"
  },
  "share": "disabled",
  "autoupdate": false
}
```

Workspace B used `bash:"deny", edit:"deny", webfetch:"allow"`. `GET /config?directory=...` returned the respective settings; a request with `x-opencode-directory` selecting B returned B's settings too. A's live bash prompt waited for `permission.asked`; allowing once completed that command. Thus config loading and ask enforcement are observed, not inferred from schema. No fallback to `PATCH /config` is required. Config hot reload within an already initialized directory was not tested: write config before first request; T7 must test any reuse with changed settings.

**Critical precedence finding:** a no-model-call probe created a fresh A session, posted a `noReply:true` message with `tools:{bash:true,edit:false}`, then read the session. Its `permission` became:

```json
[
  { "permission": "bash", "pattern": "*", "action": "allow" },
  { "permission": "edit", "pattern": "*", "action": "deny" }
]
```

This makes the boolean tool map unsafe for preserving ask/deny rules. Propose omitting prompt `tools` and expressing enabled/disabled tool policy entirely in permissions; record as Q-04 rather than editing D5. T7 must cover deny/ask precedence and tools such as `apply_patch` with actual enforcement tests. The spike does not prove a security sandbox: file/path and shell restrictions need explicit runtime enforcement checks.

## 4. Live prompts

Run on 2026-10-19 using the existing `.env` key inherited by the isolated OpenCode process (never printed or copied). Only `openai/gpt-5.4-mini`; two model turns, with 120-second prompt timeout, 180-second SSE read timeout and 5-second control-call timeout. These were manual spike probes, not CI tests. No OpenAI or Slack calls were added to tests.

1. Asked for a single file-writing action, no exploration: `hello.txt` containing `Yuno spike passed` and a newline. **PASS:** exact file contents checked by assertion; actual tool was `apply_patch`, completed. Two assistant messages. Aggregated tokens: input 6206, output 45, reasoning 89, cache read 5888; cost USD 0.0056991.
2. Asked for exactly `printf yuno-permission-check .` through bash. **PASS:** received `permission.asked` for bash with that pattern; `POST /permission/{requestID}/reply` with `{"reply":"once"}` returned `true`; received `permission.replied` and completed bash tool, then idle. Two assistant messages. Aggregated tokens: input 6159, output 47, reasoning 59, cache read 5888; cost USD 0.00553785.

Both turns together were far below the ~200K token budget (including cache reads). Final-response-only costs were 0.0006441 and 0.0006096, demonstrating why summing every assistant message matters. Permission rejection, changed-config reuse, abort during a tool, and cross-directory execution denial remain T7 tests, not claims established by this spike.

## Adapter design

Keep architecture §4's `AgentRuntime` seam. T7 implements it; T1 adds no adapter code.

- Write workspace permissions before its first request. Translate disabled tools to deny; preserve ask and blocked bash patterns. Omit prompt `tools` pending Q-04; validate effective rules on session reuse/config changes. Do not approve with `always`, which persists broader approval.
- Persist `sessionKey → sessionID` as planned. Pass `system`, prompt `model` and text `parts` per turn. Always carry directory. Reused sessions must not leak prior usage into current totals.
- Subscribe to directory SSE before posting; filter by session and the current turn's messages. Map tool states, permission events, and deduplicated usage into `RuntimeEvent`. Assemble final text from returned text parts; collect tools across all turn messages.
- Implement `respondPermission(sessionId, permissionId, allow)` by looking up the session's workspace and POSTing `/permission/{requestID}/reply` with `once` or `reject`. Session ID is for lookup/filtering; it is not part of this reply URL. Pending requests can be reconciled with `GET /permission` after reconnect.
- Use agent turn timeout and AbortSignal; on timeout/cancel call the abort endpoint with its own bounded timeout, clean up SSE, and return an explicit failure. Treat assistant `info.error` and `session.error` as failures even when HTTP succeeds. Health uses `/global/health`, bounded to 5 seconds. Clean up subscriptions on every exit path.
- Deny/ask and isolation tests are required before production use; a successful happy path is not evidence for untested failure paths. T7 uses this exact version; T14 pins it in Docker. No decisions or architecture files changed.
