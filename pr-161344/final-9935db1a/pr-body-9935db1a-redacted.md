Fixes #90909.
Related: #76101, #78736 and #91028.

## What Problem This Solves

Embedded Lobster LLM stages otherwise require a separate Gateway URL and credential. Saved embedded answers must not bypass current host authorization, and a checkpointed answer must not be disclosed or consumed on resume by a caller who no longer holds the authority that produced it.

## User Impact

Opt in with `llm.invoke --provider embedded`. Inference runs as the calling agent through `api.runtime.subagent.complete`, without tools or workflow credentials. An omitted model uses the calling agent's configured primary and fallbacks. An explicit model requires override permission and is pinned without fallback.

Existing `openclaw`, `pi` and `http` routes remain remote routes. Provider selection uses the final merged workflow and step environment. An omitted provider with no configured route is refused rather than silently becoming embedded.

## Why This Change Was Made

The tool factory supplies the calling agent. Embedded stages force refresh, disable persistent cache writes and clear the state key at command execution, so workflow settings and `--refresh false` cannot restore saved-answer reuse. Other routes retain caching, but returning a saved answer requires a current Gateway request with a host authority checker. Revocation, missing authority and cancellation refuse disclosure.

A completed embedded stage persists its output at an approval or input checkpoint, and a resume feeds that output to the remaining stages or returns it without running the stage again. The plugin records the producing caller's agent and authority beside the checkpoint when it hands it out, and re-authorizes before a resume discloses or consumes it: the request must still carry the gateway scope, its admitted grant is rechecked, and an embedded answer is only returned to the same agent holding at least the authority that produced it. A later checkpoint of the same run carries that provenance forward, and a checkpoint this plugin has no record of is treated as carrying a saved answer. Cancelling a checkpoint discloses nothing and is allowed.

The documentation now states that the embedded route runs the calling agent's own completion under its model policy, including that a named model is an override the host may refuse (commit e94df915a1d).

This uses the existing plugin SDK request-scope callbacks; it adds no Gateway API. Those callbacks check admitted Gateway authority, including applicable auth-policy and role/access changes. They do not contact a remote provider to revalidate its credentials or model permissions.

## Risks and Limitations

- Re-executed embedded stages spend another completion, including after an approval checkpoint.
- Background completion returns text only: Lobster does not report the selected model or token usage, and this route does not expose per-stage sampling or output-token controls.
- Remote-provider caches retain their existing trust model. A Gateway authority check is not remote-provider reauthorization.
- A checkpoint whose provenance record is missing is refused rather than served, so a checkpoint created before this change cannot be resumed without a current Gateway request scope; it can still be cancelled.

## Evidence

### Head 9935db1aad1: build, routing and checkpoint behaviour

Revision 9935db1aad19c2da254801c96d2f1116ccc91498, transferred by local Git bundle (prerequisite 4be8534dec36cc8824fb17fb8403499022311df2) into a fresh clone, with HEAD asserted before building. This head is 4be8534dec36cc8824fb17fb8403499022311df2 plus the shared `isRecord` import (f61bb808cd1), the gateway-scope mock fix (56d5b508751), and a merge of upstream/main 2e76e316c286b32d14581e7ad3480e1ec49253d7 (9935db1aad1). Disposable 4-vCPU Linux x86_64 VM, Node v24.19.0, pnpm 12.4.0. No live Gateway was changed.

Build: pnpm install --frozen-lockfile (exit 0); node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime (exit 0). The build marker was done and dist/entry.js (2026-10-04 04:44:48.418473617 +0000) was newer than the build-start marker before node dist/entry.js gateway was invoked. This runtime profile omits declaration generation.

UTC request windows: routing 2026-10-04T05:36:04.708Z to 2026-10-04T05:36:29.516Z; checkpoint 2026-10-04T05:35:08.298Z to 2026-10-04T05:35:38.867Z.

Setup and measurement: one scratch trusted-proxy Gateway on 127.0.0.1:19000 and one logging model stub per run, with fresh empty Lobster cache and state directories. Scenarios run sequentially against http://127.0.0.1:19000/tools/invoke. The caller model is stub/primary-broken with fallback stub/backup; primary-broken and pinned-broken deliberately return HTTP 500. The stub listens at http://127.0.0.1:44081/v1. Writer scopes are explicitly operator.read,operator.write; administrator scopes additionally include operator.admin. Gateway readiness is checked before the first request. The routing run and the checkpoint run each start their own Gateway and stub, so their counts are separate.

Host counts are cumulative [model-fetch] response lines in the Gateway log, with transport diagnostics enabled. Stub counts are cumulative requests in its independent model log. Both are read before and after each HTTP call; they count failed provider attempts as well as successful ones, and the two totals agree at every step. State listings cover the Lobster cache and run-state directories.

Routing, fallback and refusal scenarios (on 9935db1aad19):

| Scenario | Environment | HTTP | Host before/after | Stub before/after | Result |
| --- | --- | --- | --- | --- | --- |
| Omitted model falls back (writer) | writer | 200 | 0/2 | 0/2 | Served |
| Repeat with --refresh false (writer) | writer | 200 | 2/4 | 2/4 | Served |
| Explicit override refused (writer) | writer | 500 | 4/4 | 4/4 | Refused |
| Explicit override allowed (administrator) | administrator | 200 | 4/5 | 4/5 | Served |
| Pinned failing model, no fallback (administrator) | administrator | 500 | 5/6 | 5/6 | Refused |
| Omitted provider with no route (administrator) | administrator | 500 | 6/6 | 6/6 | Refused |

Checkpoint re-authorization scenarios (on 9935db1aad19):

| Scenario | Environment | HTTP | Host before/after | Stub before/after | Result |
| --- | --- | --- | --- | --- | --- |
| Administrator embedded override, then approval checkpoint | admin | 200 | 0/1 | 0/1 | needs_approval |
| Writer resumes with an equivalent token (refused) | writer | 500 | 1/1 | 1/1 | Refused |
| Writer resumes the original token (refused, control) | writer | 500 | 1/1 | 1/1 | Refused |
| Administrator resumes its own embedded checkpoint (allowed) | admin | 200 | 1/1 | 1/1 | ok |
| Administrator plain checkpoint creation | admin | 200 | 1/1 | 1/1 | needs_approval |
| Second administrator embedded override, then approval checkpoint | admin | 200 | 1/2 | 1/2 | needs_approval |
| Writer supplies a plain token plus the administrator approval ID (refused) | writer | 500 | 2/2 | 2/2 | Refused |
| Administrator resumes its second embedded checkpoint (allowed) | admin | 200 | 2/2 | 2/2 | ok |

Refusal reasons, read from the Gateway log rather than inferred from the status code:

- Equivalent-token resume: "lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output"
- Original-token resume: "lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output"
- Conflicting-handle resume: "resume accepts either token or approvalId, not both: the approval ID takes precedence, so the two can select different checkpoints"
- Explicit override refused (writer): "llm.invoke request failed: provider/model override is not authorized for this plugin subagent run."
- pinned failing model: "llm.invoke request failed: Isolated completion failed with stop reason error."
- omitted provider with no route: "llm.invoke could not resolve a provider. Set --provider or LOBSTER_LLM_PROVIDER"

Limits: these are stub-model scenarios, so they show routing, refusal and what is or is not served, not provider auth. "Revocation during a pending resume" is shown as the producer-authority refusal of an equivalent token (the writer never held operator.admin); an in-flight completion cancelled when authority is withdrawn mid-request is not exercised. Legacy-checkpoint and remote-cache upgrade compatibility is not covered. HTTP 500 alone is not an authorization verdict; the Gateway log supplies the refusal reason. The real-provider credential, revocation and billing evidence below is the run on the earlier revision 134946619f2c, because this head changes only plugin authorization and the shared helper import, not provider auth; a real-provider rerun on this head would need a freshly minted provider key and was not performed.

<details>
<summary>Routing on 9935db1aad19: Omitted model falls back (writer)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt auth-default --state-key a1"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"backup\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"backup\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T05:36:27.394Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"backup\"}","data":{"answeredBy":"backup"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:36:27.394Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:36:26.169+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:36:26.179+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:36:26.350+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T05:36:26.352+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=3 queueSize=0
2026-10-04T05:36:26.644+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=primary-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:36:26.720+00:00 [scheduler] running startup:maintenance
2026-10-04T05:36:26.721+00:00 [scheduler] running startup:post-ready-work
2026-10-04T05:36:26.842+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:27.002+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=primary-broken status=500 elapsedMs=358 dispatcher=new contentType=application/json
2026-10-04T05:36:27.154+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=backup method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:36:27.190+00:00 [scheduler] running delivery:session-recovery
2026-10-04T05:36:27.235+00:00 [scheduler] running update.check
2026-10-04T05:36:27.236+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T05:36:27.308+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:27.327+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=backup status=200 elapsedMs=174 dispatcher=reused contentType=text/event-stream
2026-10-04T05:36:27.392+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=1039 active=0 queued=0
2026-10-04T05:36:27.120+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/primary-broken candidate=stub/primary-broken reason=server_error next=stub/backup detail=Isolated completion failed with stop reason error.
2026-10-04T05:36:27.368+00:00 [model-fallback/decision] model fallback decision: decision=candidate_succeeded requested=stub/primary-broken candidate=stub/backup reason=unknown next=none
~~~

Counts before

~~~json
{"host":0,"stub":0}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing on 9935db1aad19: Repeat with --refresh false (writer)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt auth-default --state-key a1 --refresh false"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"backup\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"backup\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T05:36:28.638Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"backup\"}","data":{"answeredBy":"backup"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:36:28.638Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:36:27.507+00:00 [hooks] running gateway_start (1 handlers)
2026-10-04T05:36:27.586+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:28.136+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:28.330+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:36:28.335+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:36:28.340+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T05:36:28.342+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T05:36:28.376+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=primary-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:36:28.502+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=primary-broken status=500 elapsedMs=123 dispatcher=reused contentType=application/json
2026-10-04T05:36:28.582+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=backup method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:36:28.589+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:28.604+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=backup status=200 elapsedMs=24 dispatcher=reused contentType=text/event-stream
2026-10-04T05:36:28.637+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=291 active=0 queued=0
2026-10-04T05:36:28.534+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/primary-broken candidate=stub/primary-broken reason=server_error next=stub/backup detail=Isolated completion failed with stop reason error.
2026-10-04T05:36:28.626+00:00 [model-fallback/decision] model fallback decision: decision=candidate_succeeded requested=stub/primary-broken candidate=stub/backup reason=unknown next=none
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":4,"stub":4}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing on 9935db1aad19: Explicit override refused (writer)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt auth-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:36:28.820+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:36:28.830+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:36:28.839+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
~~~

Counts before

~~~json
{"host":4,"stub":4}
~~~

Counts after

~~~json
{"host":4,"stub":4}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing on 9935db1aad19: Explicit override allowed (administrator)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt auth-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"8bc6980b56ec914506dfd83818c523727bdd86a9153af60e36f8c9f1ed07ab7b\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T05:36:29.228Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"8bc6980b56ec914506dfd83818c523727bdd86a9153af60e36f8c9f1ed07ab7b","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:36:29.228Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:36:28.869+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:29.112+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:36:29.119+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:36:29.136+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T05:36:29.138+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=7 queueSize=0
2026-10-04T05:36:29.205+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:36:29.214+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:29.218+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=15 dispatcher=reused contentType=text/event-stream
2026-10-04T05:36:29.228+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=89 active=0 queued=0
~~~

Counts before

~~~json
{"host":4,"stub":4}
~~~

Counts after

~~~json
{"host":5,"stub":5}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing on 9935db1aad19: Pinned failing model, no fallback (administrator)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/pinned-broken --prompt auth-pinned"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:36:29.325+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:36:29.328+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:36:29.332+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T05:36:29.333+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T05:36:29.362+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=pinned-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:36:29.371+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=pinned-broken status=500 elapsedMs=8 dispatcher=reused contentType=application/json
2026-10-04T05:36:29.392+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/pinned-broken candidate=stub/pinned-broken reason=server_error next=none detail=Isolated completion failed with stop reason error.
2026-10-04T05:36:29.404+00:00 [diagnostic] lane task error: lane=background:plugin:lobster durationMs=61 error="Isolated completion failed with stop reason error. | output-rejected | {\"status\":500,\"code\":\"500\",\"errorType\":\"server_error\",\"message\":\"500 stub: pinned-broken is down\",\"provider\":\"stub\",\"details\":[\"{\\\"message\\\":\\\"stub: pinned-broken is down\\\",\\\"type\\\":\\\"server_error\\\"}\",\"stub: pinned-broken is down\",\"server_error\"]}" errorName=FailoverError
2026-10-04T05:36:29.411+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: Isolated completion failed with stop reason error.
~~~

Counts before

~~~json
{"host":5,"stub":5}
~~~

Counts after

~~~json
{"host":6,"stub":6}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing on 9935db1aad19: Omitted provider with no route (administrator)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --prompt auth-omitted"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:36:29.491+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:36:29.497+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:36:29.501+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:36:29.499+00:00 [tools-invoke] tool execution failed: Error: llm.invoke could not resolve a provider. Set --provider or LOBSTER_LLM_PROVIDER
~~~

Counts before

~~~json
{"host":6,"stub":6}
~~~

Counts after

~~~json
{"host":6,"stub":6}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Administrator embedded override, then approval checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt fix2-a | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n          \"data\": {\n            \"answeredBy\": \"other\"\n          }\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T05:35:34.739Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9mZWRhNzc1Ny02Nzk3LTRkZTktYWM0OC02MTRmZTJmNDU1YzgifQ\",\n    \"approvalId\": \"4913cffd\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:35:34.739Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"resumeToken":"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9mZWRhNzc1Ny02Nzk3LTRkZTktYWM0OC02MTRmZTJmNDU1YzgifQ","approvalId":"4913cffd"}}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:33.732+00:00 [heartbeat] started
2026-10-04T05:35:34.036+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:34.045+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:34.397+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T05:35:34.400+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=3 queueSize=0
2026-10-04T05:35:34.616+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:35:34.687+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=71 dispatcher=new contentType=text/event-stream
2026-10-04T05:35:34.738+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=335 active=0 queued=0
2026-10-04T05:35:34.898+00:00 [scheduler] running startup:maintenance
2026-10-04T05:35:34.984+00:00 [scheduler] running delivery:session-recovery
~~~

Counts before

~~~json
{"host":0,"stub":0}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text

~~~

State after

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/486c4e09d831a72302a3a6866bc2f025f27e40d793313dbe9a6a130b37408d9f.json 163 bytes
lobster-state/pipeline_resume_feda7757-6797-4de9-ac48-614fe2f455c8.json 1299 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Writer resumes with an equivalent token (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "<resume-token>"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:35.154+00:00 [scheduler] running startup:post-ready-work
2026-10-04T05:35:35.334+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:35.419+00:00 [scheduler] running update.check
2026-10-04T05:35:35.420+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T05:35:35.431+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:35.509+00:00 [hooks] running gateway_start (1 handlers)
2026-10-04T05:35:35.684+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:35.948+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:36.058+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:36.061+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:36.097+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
2026-10-04T05:35:36.246+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/486c4e09d831a72302a3a6866bc2f025f27e40d793313dbe9a6a130b37408d9f.json 163 bytes
lobster-state/pipeline_resume_feda7757-6797-4de9-ac48-614fe2f455c8.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/486c4e09d831a72302a3a6866bc2f025f27e40d793313dbe9a6a130b37408d9f.json 163 bytes
lobster-state/pipeline_resume_feda7757-6797-4de9-ac48-614fe2f455c8.json 1299 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Writer resumes the original token (refused, control)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9mZWRhNzc1Ny02Nzk3LTRkZTktYWM0OC02MTRmZTJmNDU1YzgifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:36.498+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:36.588+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:36.593+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:36.597+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
2026-10-04T05:35:36.750+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/486c4e09d831a72302a3a6866bc2f025f27e40d793313dbe9a6a130b37408d9f.json 163 bytes
lobster-state/pipeline_resume_feda7757-6797-4de9-ac48-614fe2f455c8.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/486c4e09d831a72302a3a6866bc2f025f27e40d793313dbe9a6a130b37408d9f.json 163 bytes
lobster-state/pipeline_resume_feda7757-6797-4de9-ac48-614fe2f455c8.json 1299 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Administrator resumes its own embedded checkpoint (allowed)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9mZWRhNzc1Ny02Nzk3LTRkZTktYWM0OC02MTRmZTJmNDU1YzgifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T05:35:34.739Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:35:34.739Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:36.967+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:36.970+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:37.002+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:37.253+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/486c4e09d831a72302a3a6866bc2f025f27e40d793313dbe9a6a130b37408d9f.json 163 bytes
lobster-state/pipeline_resume_feda7757-6797-4de9-ac48-614fe2f455c8.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Administrator plain checkpoint creation</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "approve --emit --prompt fix2-plain"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"fix2-plain\",\n    \"items\": [],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9lZmE3ZmU2My1hMzJiLTQzOTAtODA3NC0xZTViOGE4MDNmMGEifQ\",\n    \"approvalId\": \"579bb35c\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"fix2-plain","items":[],"resumeToken":"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9lZmE3ZmU2My1hMzJiLTQzOTAtODA3NC0xZTViOGE4MDNmMGEifQ","approvalId":"579bb35c"}}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:37.356+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:37.358+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:37.505+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
~~~

State after

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Second administrator embedded override, then approval checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt fix2-c | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n          \"data\": {\n            \"answeredBy\": \"other\"\n          }\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T05:35:37.798Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8zNzA0ZWM4Zi05MDc1LTQzMzAtYTFmOC1iYjRmOTg3NmFlM2QifQ\",\n    \"approvalId\": \"3ab2438f\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:35:37.798Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"resumeToken":"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8zNzA0ZWM4Zi05MDc1LTQzMzAtYTFmOC1iYjRmOTg3NmFlM2QifQ","approvalId":"3ab2438f"}}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:37.753+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:37.755+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:37.759+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T05:35:37.760+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T05:35:37.781+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T05:35:37.785+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:37.790+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=8 dispatcher=reused contentType=text/event-stream
2026-10-04T05:35:37.798+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=37 active=0 queued=0
2026-10-04T05:35:38.036+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

State after

~~~text
lobster-state/approval_3ab2438f.json 107 bytes
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/6923db1d3089fa358a7a398e1dc0ce2f8530072872f3bc45350157192db1784b.json 163 bytes
lobster-state/openclaw-llm-checkpoints/c410566958593996dd0bef058c2f5b9ee3e5d9770294fb99a528731724c7431b.json 163 bytes
lobster-state/pipeline_resume_3704ec8f-9075-4330-a1f8-bb4f9876ae3d.json 1299 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Writer supplies a plain token plus the administrator approval ID (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9lZmE3ZmU2My1hMzJiLTQzOTAtODA3NC0xZTViOGE4MDNmMGEifQ",
    "approvalId": "3ab2438f"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:38.176+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:38.180+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:38.183+00:00 [tools-invoke] tool execution failed: Error: resume accepts either token or approvalId, not both: the approval ID takes precedence, so the two can select different checkpoints
2026-10-04T05:35:38.288+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_3ab2438f.json 107 bytes
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/6923db1d3089fa358a7a398e1dc0ce2f8530072872f3bc45350157192db1784b.json 163 bytes
lobster-state/openclaw-llm-checkpoints/c410566958593996dd0bef058c2f5b9ee3e5d9770294fb99a528731724c7431b.json 163 bytes
lobster-state/pipeline_resume_3704ec8f-9075-4330-a1f8-bb4f9876ae3d.json 1299 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

State after

~~~text
lobster-state/approval_3ab2438f.json 107 bytes
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/6923db1d3089fa358a7a398e1dc0ce2f8530072872f3bc45350157192db1784b.json 163 bytes
lobster-state/openclaw-llm-checkpoints/c410566958593996dd0bef058c2f5b9ee3e5d9770294fb99a528731724c7431b.json 163 bytes
lobster-state/pipeline_resume_3704ec8f-9075-4330-a1f8-bb4f9876ae3d.json 1299 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

</details>

<details>
<summary>Checkpoint on 9935db1aad19: Administrator resumes its second embedded checkpoint (allowed)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8zNzA0ZWM4Zi05MDc1LTQzMzAtYTFmOC1iYjRmOTg3NmFlM2QifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T05:35:37.798Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T05:35:37.798Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T05:35:38.534+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T05:35:38.537+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T05:35:38.540+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T05:35:38.791+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_3ab2438f.json 107 bytes
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/6923db1d3089fa358a7a398e1dc0ce2f8530072872f3bc45350157192db1784b.json 163 bytes
lobster-state/openclaw-llm-checkpoints/c410566958593996dd0bef058c2f5b9ee3e5d9770294fb99a528731724c7431b.json 163 bytes
lobster-state/pipeline_resume_3704ec8f-9075-4330-a1f8-bb4f9876ae3d.json 1299 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

State after

~~~text
lobster-state/approval_3ab2438f.json 107 bytes
lobster-state/approval_4913cffd.json 107 bytes
lobster-state/approval_579bb35c.json 107 bytes
lobster-state/openclaw-llm-checkpoints/17abfd88ba5dd8f7731b6f3171873a6ebb825a27b0fec887cd6579c9c69738e5.json 25 bytes
lobster-state/openclaw-llm-checkpoints/18b34c8daa9395d7dd63b3b314fd7d0e5a78d31108333b435e8ca89451264c03.json 163 bytes
lobster-state/openclaw-llm-checkpoints/42b440f405d90f10c6f363518320bf532d6514a68cdfd358cbe4616ad10d2c2a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/c410566958593996dd0bef058c2f5b9ee3e5d9770294fb99a528731724c7431b.json 163 bytes
lobster-state/pipeline_resume_efa7fe63-a32b-4390-8074-1e5b8a803f0a.json 381 bytes
~~~

</details>



### Earlier revision 134946619f2c: identity and build

Revision 134946619f2c3ff75affd20ff88c11aff7a91ac9, transferred by local Git bundle into a fresh detached worktree, with HEAD asserted before building. Disposable 4-vCPU Linux x86_64 VM, Node v24.19.0, pnpm v12.4.0. No live Gateway was changed.

Build: pnpm install --frozen-lockfile (exit 0); node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime (exit 0). The build marker was done and dist/entry.js was newer than the build-start marker before invoking node dist/entry.js gateway. This runtime profile omits declaration generation. The routing scenarios and the checkpoint scenarios below ran on this same build.

UTC request window: 2026-10-04T00:58:07.286Z to 2026-10-04T00:58:31.911Z.

### Earlier revision 134946619f2c: setup and measurement

One scratch trusted-proxy Gateway per run, one logging model stub, and fresh empty Lobster cache/state directories. Scenarios run sequentially against http://127.0.0.1:19000/tools/invoke. The caller model is stub/primary-broken with fallback stub/backup; primary-broken and pinned-broken deliberately return HTTP 500. The stub listens at http://127.0.0.1:44081/v1; no endpoint is pointed at a closed port. Writer scopes are explicitly operator.read,operator.write; administrator scopes additionally include operator.admin. Gateway readiness is checked before the first request. The routing run and the checkpoint run each start their own Gateway and stub, so their counts are separate.

Host counts are cumulative [model-fetch] response lines in the Gateway log, with transport diagnostics enabled. Stub counts are cumulative requests in its independent model log. Both are read before and after each HTTP call; they count failed provider attempts as well as successful ones. The two totals agree at every step. State listings cover both Lobster cache and run-state directories; empty fenced blocks mean no files.

Routing, fallback and refusal scenarios:

| Scenario | Environment | HTTP | Host before/after | Stub before/after | Result |
| --- | --- | --- | --- | --- | --- |
| Omitted model falls back (writer) | writer | 200 | 0/2 | 0/2 | Served |
| Repeat with --refresh false (writer) | writer | 200 | 2/4 | 2/4 | Served |
| Explicit override refused (writer) | writer | 500 | 4/4 | 4/4 | Refused |
| Explicit override allowed (administrator) | administrator | 200 | 4/5 | 4/5 | Served |
| Pinned failing model, no fallback (administrator) | administrator | 500 | 5/6 | 5/6 | Refused |
| Omitted provider with no route (administrator) | administrator | 500 | 6/6 | 6/6 | Refused |

Checkpoint re-authorization scenarios:

| Scenario | Environment | HTTP | Host before/after | Stub before/after | Result |
| --- | --- | --- | --- | --- | --- |
| Administrator embedded override, then approval checkpoint | admin | 200 | 0/1 | 0/1 | needs_approval |
| Administrator resumes its own checkpoint (allowed) | admin | 200 | 1/1 | 1/1 | ok |
| Second administrator embedded override, then approval checkpoint | admin | 200 | 1/2 | 1/2 | needs_approval |
| Writer resumes the administrator checkpoint (refused) | writer | 500 | 2/2 | 2/2 | Refused |
| Writer fresh explicit override (refused, control) | writer | 500 | 2/2 | 2/2 | Refused |
| Main agent default-model embedded run, then approval checkpoint | admin | 200 | 2/4 | 2/4 | needs_approval |
| Other agent resumes the main agent checkpoint (refused) | admin, agent other | 500 | 4/4 | 4/4 | Refused |
| Administrator workflow embedded run, then approval checkpoint | admin | 200 | 4/5 | 4/5 | needs_approval |
| Writer resumes the workflow checkpoint (refused) | writer | 500 | 5/5 | 5/5 | Refused |

A refusal is a deliberate rejection, read from the Gateway log rather than inferred from the status code:

- Writer resumes the administrator checkpoint (refused): tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
- Writer fresh explicit override (refused, control): tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
- Other agent resumes the main agent checkpoint (refused): tool execution failed: Error: lobster checkpoint refused: its embedded LLM output was produced for another agent
- Writer resumes the workflow checkpoint (refused): tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
- Explicit override refused (writer): tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
- Pinned failing model, no fallback (administrator): tool execution failed: Error: llm.invoke request failed: Isolated completion failed with stop reason error.
- Omitted provider with no route (administrator): tool execution failed: Error: lobster llm.invoke has no route: the embedded provider is opt-in, so pass --provider embedded or set LOBSTER_LLM_PROVIDER=embedded

### Real provider: credentials, checkpoints, revocation and billing

A second run repeats this revision against the real model provider. The stub runs above establish routing, fallback, refusal and checkpoint mechanics; this run establishes that a real credential is used, that a checkpointed answer is refused to a caller who lost the authority that produced it, that a revoked credential is refused at the provider, and that the provider bills exactly the calls that succeeded.

Identity: revision 134946619f2c3ff75affd20ff88c11aff7a91ac9, with the same dist/entry.js built at 00:48:41Z as the stub runs above. Node v24.19.0. Only the model provider differs: openai-paid, api openai-responses, model gpt-5.4-nano, no fallback configured.

Credential: a project API key minted for this run inside a throwaway workspace project, held only by the scratch Gateway process. It was deleted at 01:11:56Z, after which the last scenario ran against a restarted Gateway. No live Gateway and no household credential took part. The temporary admin credential that created and deleted that project key was revoked when the run ended.

UTC window: 2026-10-04 01:11:37Z to 01:12:21Z; project key created 01:11:14Z, deleted 01:11:56Z.

Counting is independent of our own accounting: provider attempts are cumulative [model-fetch] response lines in the Gateway log with transport diagnostics enabled, and the billed totals come from the provider organization usage and costs endpoints for that project, read at 01:16:29Z.

| Scenario | Environment | HTTP | Provider attempts | Result |
| --- | --- | --- | --- | --- |
| Omitted model | administrator | 200 | +1 | Fresh answer from the configured primary |
| Repeat with --refresh false | administrator | 200 | +1 | Fresh provider call, not a saved answer |
| Explicit override | writer | 500 | +0 | Refused before any provider call |
| Explicit override | administrator | 200 | +1 | Fresh override answer |
| Embedded override, then approval checkpoint | administrator | 200 | +1 | needs_approval |
| Writer resumes that checkpoint | writer | 500 | +0 | Refused, no provider call |
| Omitted model, then approval checkpoint | administrator | 200 | +1 | needs_approval |
| Administrator resumes its own checkpoint | administrator | 200 | +0 | Served from the saved answer, no provider call |
| Same pipeline after key deletion | administrator | 500 | +1 rejected | Provider 401 invalid_api_key |

Each refusal reason is read from the Gateway log rather than inferred from the status code:

- Writer resumes the administrator checkpoint: "lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output"
- Writer explicit override: "llm.invoke request failed: provider/model override is not authorized for this plugin subagent run."
- After key deletion: "status=401 code=token_invalidated message=401 Your API key has been invalidated."

Revocation is established twice: the provider confirmed the deletion ("deleted": true), and a direct call with the same key returned 401 before the last scenario ran. The last scenario still shows one provider attempt, because the request reached the provider and was rejected there, which is the behaviour under test.

Billing, from the provider organization records for that project: usage reports 5 requests, 424 input tokens and 25 output tokens on gpt-5.4-nano-2026-03-17 with 0 cached input tokens; costs report input $0.0000848, output $0.00003125 and cached input $0, totalling $0.00011605. That is 5 billed requests for the 5 accepted calls, at the published rates of $0.20 per million input tokens and $1.25 per million output tokens, and it shows the rejected attempt was not billed.
### Misleading metadata and limits

cached: true on a fresh embedded answer does not establish replay. In the installed Lobster normalizeResult, cached is calculated by excluding source names remote, openclaw, clawd, pi and http; openclaw-embedded is not excluded. Independent provider counts and empty state listings establish fresh execution here.

The repeat changes only the refresh flag and reuses the prompt/state key, not a pre-planted cache file. This proves fresh execution of that repeated embedded stage, not every resume path. The refused writer override proves current request authorization. Pinned failure proves no fallback request reached this stub. Missing-route refusal proves no implicit embedded route in this configuration. HTTP 500 alone is not an authorization verdict: the Gateway log supplies the refusal reason.

Not covered here: live Gateway policy revocation as a mid-request event, HTTP cache replay through this disposable endpoint, or the full repository test suite. The checkpoint scenarios prove the decision at the resume boundary from the recorded provenance and the request scope; they do not prove that an in-flight completion is cancelled when authority is withdrawn. The real-provider run deletes the key and restarts the Gateway before repeating the scenario, so it proves a deleted credential is refused at the provider.

<details>
<summary>Routing: Omitted model falls back (writer)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt auth-default --state-key a1"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"backup\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"backup\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T00:59:14.763Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"backup\"}","data":{"answeredBy":"backup"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T00:59:14.763Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T00:59:14.099+00:00 [heartbeat] started
2026-10-04T00:59:14.315+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:59:14.326+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:59:14.467+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:59:14.468+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=3 queueSize=0
2026-10-04T00:59:14.597+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=primary-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:59:14.641+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=primary-broken status=500 elapsedMs=44 dispatcher=new contentType=application/json
2026-10-04T00:59:14.717+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=backup method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:59:14.730+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=backup status=200 elapsedMs=13 dispatcher=reused contentType=text/event-stream
2026-10-04T00:59:14.761+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=291 active=0 queued=0
2026-10-04T00:59:14.696+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/primary-broken candidate=stub/primary-broken reason=server_error next=stub/backup detail=Isolated completion failed with stop reason error.
2026-10-04T00:59:14.750+00:00 [model-fallback/decision] model fallback decision: decision=candidate_succeeded requested=stub/primary-broken candidate=stub/backup reason=unknown next=none
~~~

Model stub log during call

~~~text
2026-10-04T00:59:14.631Z model=primary-broken status=500
2026-10-04T00:59:14.727Z model=backup status=200
~~~

Counts before

~~~json
{"host":0,"stub":0}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing: Repeat with --refresh false (writer)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt auth-default --state-key a1 --refresh false"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"backup\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"backup\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T00:59:14.916Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"92ec35c0039fdfa010310e8e6fb1b059691bea106b384ee11ca0212a35e994df","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"backup\"}","data":{"answeredBy":"backup"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T00:59:14.916Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T00:59:14.823+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:59:14.825+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:59:14.829+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:59:14.830+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=2 queueSize=0
2026-10-04T00:59:14.852+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=primary-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:59:14.859+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=primary-broken status=500 elapsedMs=7 dispatcher=reused contentType=application/json
2026-10-04T00:59:14.898+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=backup method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:59:14.901+00:00 [scheduler] running startup:maintenance
2026-10-04T00:59:14.904+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=backup status=200 elapsedMs=6 dispatcher=reused contentType=text/event-stream
2026-10-04T00:59:14.915+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=85 active=0 queued=0
2026-10-04T00:59:14.875+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/primary-broken candidate=stub/primary-broken reason=server_error next=stub/backup detail=Isolated completion failed with stop reason error.
2026-10-04T00:59:14.911+00:00 [model-fallback/decision] model fallback decision: decision=candidate_succeeded requested=stub/primary-broken candidate=stub/backup reason=unknown next=none
~~~

Model stub log during call

~~~text
2026-10-04T00:59:14.856Z model=primary-broken status=500
2026-10-04T00:59:14.900Z model=backup status=200
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":4,"stub":4}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing: Explicit override refused (writer)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt auth-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:59:14.961+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:59:14.963+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:59:14.967+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":4,"stub":4}
~~~

Counts after

~~~json
{"host":4,"stub":4}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing: Explicit override allowed (administrator)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt auth-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"8bc6980b56ec914506dfd83818c523727bdd86a9153af60e36f8c9f1ed07ab7b\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T00:59:15.066Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"8bc6980b56ec914506dfd83818c523727bdd86a9153af60e36f8c9f1ed07ab7b","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T00:59:15.066Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T00:59:15.018+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:59:15.021+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:59:15.023+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:59:15.024+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T00:59:15.044+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:59:15.059+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=15 dispatcher=reused contentType=text/event-stream
2026-10-04T00:59:15.066+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=41 active=0 queued=0
~~~

Model stub log during call

~~~text
2026-10-04T00:59:15.056Z model=other status=200
~~~

Counts before

~~~json
{"host":4,"stub":4}
~~~

Counts after

~~~json
{"host":5,"stub":5}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing: Pinned failing model, no fallback (administrator)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/pinned-broken --prompt auth-pinned"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:59:15.109+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:59:15.111+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:59:15.114+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:59:15.115+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T00:59:15.135+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=pinned-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:59:15.139+00:00 [scheduler] running startup:post-ready-work
2026-10-04T00:59:15.169+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=pinned-broken status=500 elapsedMs=34 dispatcher=reused contentType=application/json
2026-10-04T00:59:15.180+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/pinned-broken candidate=stub/pinned-broken reason=server_error next=none detail=Isolated completion failed with stop reason error.
2026-10-04T00:59:15.184+00:00 [diagnostic] lane task error: lane=background:plugin:lobster durationMs=66 error="Isolated completion failed with stop reason error. | output-rejected | {\"status\":500,\"code\":\"500\",\"errorType\":\"server_error\",\"message\":\"500 stub: pinned-broken is down\",\"provider\":\"stub\",\"details\":[\"{\\\"message\\\":\\\"stub: pinned-broken is down\\\",\\\"type\\\":\\\"server_error\\\"}\",\"stub: pinned-broken is down\",\"server_error\"]}" errorName=FailoverError
2026-10-04T00:59:15.187+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: Isolated completion failed with stop reason error.
~~~

Model stub log during call

~~~text
2026-10-04T00:59:15.138Z model=pinned-broken status=500
~~~

Counts before

~~~json
{"host":5,"stub":5}
~~~

Counts after

~~~json
{"host":6,"stub":6}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Routing: Omitted provider with no route (administrator)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --prompt auth-omitted"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:59:15.268+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:59:15.334+00:00 [scheduler] running update.check
2026-10-04T00:59:15.334+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T00:59:15.358+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:59:15.359+00:00 [scheduler] running delivery:session-recovery
2026-10-04T00:59:15.432+00:00 [hooks] running gateway_start (1 handlers)
2026-10-04T00:59:15.606+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:59:15.609+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:59:15.614+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:59:15.612+00:00 [tools-invoke] tool execution failed: Error: lobster llm.invoke has no route: the embedded provider is opt-in, so pass --provider embedded or set LOBSTER_LLM_PROVIDER=embedded
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":6,"stub":6}
~~~

Counts after

~~~json
{"host":6,"stub":6}
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Checkpoint: Administrator embedded override, then approval checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt p1-override | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"0b14534be0c676ac0c57cb6036234417664cb0fcfeaec7fb394b6297c06b7d72\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n          \"data\": {\n            \"answeredBy\": \"other\"\n          }\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T00:58:27.466Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8yY2FhZDY1Yy0yMzE0LTRkMzUtODU1My0wMTlkMjI5OTRmOWMifQ\",\n    \"approvalId\": \"b30d32c2\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"0b14534be0c676ac0c57cb6036234417664cb0fcfeaec7fb394b6297c06b7d7
[truncated]
~~~

Gateway log during call

~~~text
2026-10-04T00:58:27.068+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:27.079+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:27.240+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:58:27.242+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=2 queueSize=0
2026-10-04T00:58:27.382+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:58:27.413+00:00 [scheduler] running startup:maintenance
2026-10-04T00:58:27.435+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=54 dispatcher=new contentType=text/event-stream
2026-10-04T00:58:27.465+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=222 active=0 queued=0
2026-10-04T00:58:27.500+00:00 [scheduler] running startup:post-ready-work
2026-10-04T00:58:27.604+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:27.657+00:00 [scheduler] running update.check
2026-10-04T00:58:27.659+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T00:58:27.670+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:27.729+00:00 [hooks] running gateway_start (1 handlers)
2026-10-04T00:58:27.923+00:00 [scheduler] running startup:handler-prewarm
~~~

Model stub log during call

~~~text
2026-10-04T00:58:27.426Z model=other status=200
~~~

Counts before

~~~json
{"host":0,"stub":0}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/977e7eae0367bd29004c16ff5326841bea20fbe611c4f6d4d3a47d5e4bdfe222.json 163 bytes
lobster-state/pipeline_resume_2caad65c-2314-4d35-8553-019d22994f9c.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Administrator resumes its own checkpoint (allowed)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8yY2FhZDY1Yy0yMzE0LTRkMzUtODU1My0wMTlkMjI5OTRmOWMifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"0b14534be0c676ac0c57cb6036234417664cb0fcfeaec7fb394b6297c06b7d72\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T00:58:27.466Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"0b14534be0c676ac0c57cb6036234417664cb0fcfeaec7fb394b6297c06b7d72","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T00:58:27.466Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T00:58:28.091+00:00 [scheduler] running delivery:session-recovery
2026-10-04T00:58:28.191+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:28.193+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:28.195+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:28.505+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:28.756+00:00 [scheduler] running startup:handler-prewarm
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/977e7eae0367bd29004c16ff5326841bea20fbe611c4f6d4d3a47d5e4bdfe222.json 163 bytes
lobster-state/pipeline_resume_2caad65c-2314-4d35-8553-019d22994f9c.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Second administrator embedded override, then approval checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt p1-override | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"0b14534be0c676ac0c57cb6036234417664cb0fcfeaec7fb394b6297c06b7d72\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n          \"data\": {\n            \"answeredBy\": \"other\"\n          }\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T00:58:28.925Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9hNzRjZmFlYy04Y2QyLTRiNjctOTQ3Mi1kOTlmN2FhOGVkNmEifQ\",\n    \"approvalId\": \"49a8c3fd\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"0b14534be0c676ac0c57cb6036234417664cb0fcfeaec7fb394b6297c06b7d7
[truncated]
~~~

Gateway log during call

~~~text
2026-10-04T00:58:28.862+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:28.865+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:28.868+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:58:28.869+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T00:58:28.896+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:58:28.913+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=17 dispatcher=reused contentType=text/event-stream
2026-10-04T00:58:28.924+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=54 active=0 queued=0
2026-10-04T00:58:29.007+00:00 [scheduler] running startup:handler-prewarm
~~~

Model stub log during call

~~~text
2026-10-04T00:58:28.909Z model=other status=200
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Writer resumes the administrator checkpoint (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9hNzRjZmFlYy04Y2QyLTRiNjctOTQ3Mi1kOTlmN2FhOGVkNmEifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:58:29.258+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.313+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:29.317+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:29.346+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
2026-10-04T00:58:29.509+00:00 [scheduler] running startup:handler-prewarm
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Writer fresh explicit override (refused, control)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model stub/other --prompt p1-override | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:58:29.692+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:29.695+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:29.698+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
2026-10-04T00:58:29.760+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.786+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.845+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.923+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.946+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.959+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:29.966+00:00 [scheduler] running startup:handler-prewarm
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Main agent default-model embedded run, then approval checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt p1-agent | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"45a73856d5ded33d644d31e3054d3eed32eb2fc09f268b7ebd86e27bd48a18db\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{\\\"answeredBy\\\":\\\"backup\\\"}\",\n          \"data\": {\n            \"answeredBy\": \"backup\"\n          }\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T00:58:30.390Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV80Y2Y0YWEzYS1mNTdiLTQwNjYtOTcyNy05OGVjYWRkMzBmYTAifQ\",\n    \"approvalId\": \"2e8b3053\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"45a73856d5ded33d644d31e3054d3eed32eb2fc09f268b7ebd86e27bd48a1
[truncated]
~~~

Gateway log during call

~~~text
2026-10-04T00:58:30.124+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:30.201+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:30.205+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:30.208+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:58:30.208+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T00:58:30.232+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=primary-broken method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:58:30.305+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=primary-broken status=500 elapsedMs=73 dispatcher=reused contentType=application/json
2026-10-04T00:58:30.369+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=backup method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:58:30.376+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=backup status=200 elapsedMs=7 dispatcher=reused contentType=text/event-stream
2026-10-04T00:58:30.390+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=179 active=0 queued=0
2026-10-04T00:58:30.352+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=stub/primary-broken candidate=stub/primary-broken reason=server_error next=stub/backup detail=Isolated completion failed with stop reason error.
2026-10-04T00:58:30.384+00:00 [model-fallback/decision] model fallback decision: decision=candidate_succeeded requested=stub/primary-broken candidate=stub/backup reason=unknown next=none
~~~

Model stub log during call

~~~text
2026-10-04T00:58:30.235Z model=primary-broken status=500
2026-10-04T00:58:30.373Z model=backup status=200
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":4,"stub":4}
~~~

State before

~~~text
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Other agent resumes the main agent checkpoint (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV80Y2Y0YWEzYS1mNTdiLTQwNjYtOTcyNy05OGVjYWRkMzBmYTAifQ"
  },
  "sessionKey": "main",
  "agentId": "other"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:58:30.792+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.other.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:30.795+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:30.810+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: its embedded LLM output was produced for another agent
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":4,"stub":4}
~~~

Counts after

~~~json
{"host":4,"stub":4}
~~~

State before

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Administrator workflow embedded run, then approval checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "flows/p1.lobster.json"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"Use the answer?\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"3c30e272e783ed50ad7863f1d7e9160fcb25f1c40b6a5d8153b8a6ec5a7624d2\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n          \"data\": {\n            \"answeredBy\": \"other\"\n          }\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T00:58:31.211Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJ3b3JrZmxvdy1maWxlIiwic3RhdGVLZXkiOiJ3b3JrZmxvd19yZXN1bWVfODE2MWY4NjItNzBiYi00ZGI3LWEyMzMtOWYwNTc4YWYxMTlkIn0\",\n    \"approvalId\": \"e26b046b\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"Use the answer?","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"3c30e272e783ed50ad7863f1d7e9160fcb25f1c40b6a5d8153b8a6ec
[truncated]
~~~

Gateway log during call

~~~text
2026-10-04T00:58:31.150+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:31.154+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:31.165+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T00:58:31.165+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T00:58:31.193+00:00 [provider-transport-fetch] [model-fetch] start provider=stub api=openai-responses model=other method=POST url=http://127.0.0.1:44081/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T00:58:31.200+00:00 [provider-transport-fetch] [model-fetch] response provider=stub api=openai-responses model=other status=200 elapsedMs=7 dispatcher=reused contentType=text/event-stream
2026-10-04T00:58:31.210+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=44 active=0 queued=0
~~~

Model stub log during call

~~~text
2026-10-04T00:58:31.197Z model=other status=200
~~~

Counts before

~~~json
{"host":4,"stub":4}
~~~

Counts after

~~~json
{"host":5,"stub":5}
~~~

State before

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/approval_e26b046b.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/14fb7c8853d465cd0311010f01f461b2cf565556ed8fdb428bcaaec6da3712c8.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/287cbd56ea9d8e163913a10a442711c8900e2ed97721d1466f3618aba47cd31f.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
lobster-state/workflow_resume_8161f862-70bb-4db7-a233-9f0578af119d.json 1578 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Checkpoint: Writer resumes the workflow checkpoint (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJ3b3JrZmxvdy1maWxlIiwic3RhdGVLZXkiOiJ3b3JrZmxvd19yZXN1bWVfODE2MWY4NjItNzBiYi00ZGI3LWEyMzMtOWYwNTc4YWYxMTlkIn0"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T00:58:31.596+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T00:58:31.600+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T00:58:31.606+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
2026-10-04T00:58:31.762+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T00:58:31.771+00:00 [scheduler] running startup:handler-prewarm
~~~

Model stub log during call

~~~text

~~~

Counts before

~~~json
{"host":5,"stub":5}
~~~

Counts after

~~~json
{"host":5,"stub":5}
~~~

State before

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/approval_e26b046b.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/14fb7c8853d465cd0311010f01f461b2cf565556ed8fdb428bcaaec6da3712c8.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/287cbd56ea9d8e163913a10a442711c8900e2ed97721d1466f3618aba47cd31f.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
lobster-state/workflow_resume_8161f862-70bb-4db7-a233-9f0578af119d.json 1578 bytes
work/flows/p1.lobster.json 332 bytes
~~~

State after

~~~text
lobster-state/approval_2e8b3053.json 107 bytes
lobster-state/approval_49a8c3fd.json 107 bytes
lobster-state/approval_b30d32c2.json 107 bytes
lobster-state/approval_e26b046b.json 107 bytes
lobster-state/openclaw-llm-checkpoints/08e8b474e108a19b1273ce2f935eb5601fac74828cad5cccdd79621099ca01cf.json 163 bytes
lobster-state/openclaw-llm-checkpoints/14fb7c8853d465cd0311010f01f461b2cf565556ed8fdb428bcaaec6da3712c8.json 163 bytes
lobster-state/openclaw-llm-checkpoints/19fadccaceac1c9ff7cbf8a02a0c2dfe8cfe2bc33e572a81366b3aca14618cb0.json 163 bytes
lobster-state/openclaw-llm-checkpoints/287cbd56ea9d8e163913a10a442711c8900e2ed97721d1466f3618aba47cd31f.json 163 bytes
lobster-state/openclaw-llm-checkpoints/6131c2ceb6561d0744cc0f17ad589ea95d123dfeeddff7c50c0b5cfa5475b755.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b2b3f42552a14373105550f6f4d365053c03e8b5a305c0dbf7de451a0462cc51.json 163 bytes
lobster-state/openclaw-llm-checkpoints/b8be9cde6603ff3b2b703ab1b609141ce1f1736e46e028c06e7939ddd8ab903f.json 163 bytes
lobster-state/pipeline_resume_4cf4aa3a-f57b-4066-9727-98ecadd30fa0.json 1255 bytes
lobster-state/pipeline_resume_a74cfaec-8cd2-4b67-9472-d99f7aa8ed6a.json 1309 bytes
lobster-state/workflow_resume_8161f862-70bb-4db7-a233-9f0578af119d.json 1578 bytes
work/flows/p1.lobster.json 332 bytes
~~~

</details>

<details>
<summary>Real provider (82d31219aa8debde1c0b8f5905d4d58b1c1195c9): Omitted model, writer</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-final-default --state-key f1"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"a1c16c667ba364ad42de79a9567cccb83916e6c156c6c8baf1a728b74be170d1\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-03T05:36:28.779Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"a1c16c667ba364ad42de79a9567cccb83916e6c156c6c8baf1a728b74be170d1","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-03T05:36:28.779Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-03T05:36:24.994+00:00 [heartbeat] started
2026-10-03T05:36:25.396+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-03T05:36:25.407+00:00 [plugins] lobster plugin runtime=2026.9.7
2026-10-03T05:36:25.903+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-03T05:36:25.908+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=6 queueSize=0
2026-10-03T05:36:26.251+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-03T05:36:26.278+00:00 [scheduler] running startup:maintenance
2026-10-03T05:36:26.281+00:00 [scheduler] running startup:post-ready-work
2026-10-03T05:36:26.285+00:00 [scheduler] running delivery:session-recovery
2026-10-03T05:36:26.814+00:00 [hooks] running gateway_start (1 handlers)
2026-10-03T05:36:26.853+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:26.958+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:26.960+00:00 [scheduler] running update.check
2026-10-03T05:36:26.961+00:00 [scheduler] running update.remote-model-catalog
2026-10-03T05:36:27.227+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:27.482+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:28.144+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:28.407+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:28.511+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=2261 dispatcher=new contentType=text/event-stream; charset=utf-8
2026-10-03T05:36:28.660+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:28.774+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=2861 active=0 queued=0
2026-10-03T05:36:28.911+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:29.164+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:29.420+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:29.678+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:29.930+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:30.181+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:30.432+00:00 [scheduler] running startup:handler-prewarm
~~~

</details>

<details>
<summary>Real provider (82d31219aa8debde1c0b8f5905d4d58b1c1195c9): Repeat with --refresh false, writer</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-final-default --state-key f1 --refresh false"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"a1c16c667ba364ad42de79a9567cccb83916e6c156c6c8baf1a728b74be170d1\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-03T05:36:31.477Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"a1c16c667ba364ad42de79a9567cccb83916e6c156c6c8baf1a728b74be170d1","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-03T05:36:31.477Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-03T05:36:30.687+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-03T05:36:30.692+00:00 [plugins] lobster plugin runtime=2026.9.7
2026-10-03T05:36:30.697+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-03T05:36:30.699+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=2 queueSize=0
2026-10-03T05:36:30.747+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-03T05:36:30.752+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:31.003+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:31.255+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:31.324+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=578 dispatcher=reused contentType=text/event-stream; charset=utf-8
2026-10-03T05:36:31.476+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=777 active=0 queued=0
2026-10-03T05:36:31.507+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:31.759+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:32.010+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:32.261+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:32.511+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:32.763+00:00 [scheduler] running startup:handler-prewarm
~~~

</details>

<details>
<summary>Real provider (82d31219aa8debde1c0b8f5905d4d58b1c1195c9): Explicit override, writer</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-final-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-03T05:36:33.032+00:00 [agents/tool-policy] tool policy removed 35 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-03T05:36:33.035+00:00 [plugins] lobster plugin runtime=2026.9.7
2026-10-03T05:36:33.043+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:33.040+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
2026-10-03T05:36:33.295+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:33.546+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:33.798+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:34.049+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:34.302+00:00 [scheduler] running startup:handler-prewarm
~~~

</details>

<details>
<summary>Real provider (82d31219aa8debde1c0b8f5905d4d58b1c1195c9): Explicit override, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-final-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"c3e878d87dff3c5a3d41109ed359dcca6a3553ac2ea0aa86029e1f422096b2b2\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-03T05:36:35.725Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"c3e878d87dff3c5a3d41109ed359dcca6a3553ac2ea0aa86029e1f422096b2b2","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-03T05:36:35.725Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-03T05:36:34.553+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:34.600+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-03T05:36:34.603+00:00 [plugins] lobster plugin runtime=2026.9.7
2026-10-03T05:36:34.605+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-03T05:36:34.606+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=2 queueSize=0
2026-10-03T05:36:34.638+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-03T05:36:34.805+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:35.056+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:35.306+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:35.540+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=903 dispatcher=reused contentType=text/event-stream; charset=utf-8
2026-10-03T05:36:35.559+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:35.725+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=1118 active=0 queued=0
2026-10-03T05:36:35.810+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:36.061+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:36.313+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:36.565+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:36.816+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:36:37.067+00:00 [scheduler] running startup:handler-prewarm
~~~

</details>

<details>
<summary>Real provider (82d31219aa8debde1c0b8f5905d4d58b1c1195c9): Same pipeline after key deletion, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-final-revoked"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-03T05:37:04.833+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-03T05:37:04.862+00:00 [plugins] lobster plugin runtime=2026.9.7
2026-10-03T05:37:05.294+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-03T05:37:05.296+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=3 queueSize=0
2026-10-03T05:37:05.585+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-03T05:37:05.613+00:00 [scheduler] running startup:maintenance
2026-10-03T05:37:05.624+00:00 [scheduler] running startup:post-ready-work
2026-10-03T05:37:05.625+00:00 [scheduler] running delivery:session-recovery
2026-10-03T05:37:06.027+00:00 [hooks] running gateway_start (1 handlers)
2026-10-03T05:37:06.058+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:37:06.198+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:37:06.199+00:00 [scheduler] running update.check
2026-10-03T05:37:06.200+00:00 [scheduler] running update.remote-model-catalog
2026-10-03T05:37:06.331+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=401 elapsedMs=737 dispatcher=new contentType=text/plain
2026-10-03T05:37:06.427+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=openai-paid/gpt-5.4-nano candidate=openai-paid/gpt-5.4-nano reason=auth next=none detail=Isolated completion failed with stop reason error.
2026-10-03T05:37:06.437+00:00 [diagnostic] lane task error: lane=background:plugin:lobster durationMs=1132 error="Isolated completion failed with stop reason error. | output-rejected | {\"status\":401,\"code\":\"token_invalidated\",\"message\":\"401 Your API key has been invalidated.\",\"provider\":\"openai-paid\",\"details\":[\"{\\\"code\\\":\\\"token_invalidated\\\",\\\"message\\\":\\\"Your API key has been invalidated.\\\",\\\"param\\\":null,\\\"type\\\":null}\",\"Your API key has been invalidated.\",\"token_invalidated\"]}" errorName=FailoverError
2026-10-03T05:37:06.440+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: Isolated completion failed with stop reason error.
2026-10-03T05:37:06.453+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:37:07.437+00:00 [scheduler] running startup:handler-prewarm
2026-10-03T05:37:07.736+00:00 [scheduler] running startup:handler-prewarm
~~~

</details>

<details>
<summary>Real provider (82d31219aa8debde1c0b8f5905d4d58b1c1195c9): revocation, billing and cleanup records</summary>

All calls go to https://api.openai.com/v1. The deletion, probe and billing reads carry the temporary admin key; the dead-key probe carries the deleted project key instead.

Request: delete project key

~~~text
DELETE /organization/projects/<project-id>/api_keys/<key-id>
~~~

Response

~~~json
{
  "status": 200,
  "body": {
    "id": "<key-id>",
    "object": "organization.project.api_key.deleted",
    "deleted": true
  }
}
~~~

Dead-key probe

~~~text
GET /models
~~~

Response

~~~json
{
  "at": "2026-10-03T05:36:45.429Z",
  "status": 401,
  "body": {
    "error": {
      "message": "Incorrect API key provided: <redacted-service-key>. You can find your API key at https://platform.openai.com/account/api-keys.",
      "type": "invalid_request_error",
      "param": null,
      "code": "invalid_api_key"
    }
  }
}
~~~

Usage

~~~json
{
  "at": "2026-10-03T06:50:23.353Z",
  "status": 200,
  "body": {
    "object": "page",
    "data": [
      {
        "object": "bucket",
        "end_time": 1791005700,
        "end_time_iso": "2026-10-03T05:35:00+00:00",
        "results": [],
        "start_time": 1791005640,
        "start_time_iso": "2026-10-03T05:34:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791005760,
        "end_time_iso": "2026-10-03T05:36:00+00:00",
        "results": [],
        "start_time": 1791005700,
        "start_time_iso": "2026-10-03T05:35:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791005820,
        "end_time_iso": "2026-10-03T05:37:00+00:00",
        "results": [
          {
            "object": "organization.usage.completions.result",
            "project_id": null,
            "num_model_requests": 3,
            "user_id": null,
            "api_key_id": null,
            "model": "gpt-5.4-nano-2026-03-17",
            "batch": null,
            "service_tier": null,
            "input_tokens": 250,
            "output_tokens": 15,
            "input_cached_tokens": 0,
            "input_cache_write_tokens": 0,
            "input_cache_write_12h_tokens": 0,
            "input_uncached_tokens": 250,
            "input_text_tokens": 250,
            "output_text_tokens": 15,
            "input_cached_text_tokens": 0,
            "input_audio_tokens": 0,
            "input_cached_audio_tokens": 0,
            "output_audio_tokens": 0,
            "input_image_tokens": 0,
            "input_cached_image_tokens": 0,
            "output_image_tokens": 0,
            "api_source": null
          }
        ],
        "start_time": 1791005760,
        "start_time_iso": "2026-10-03T05:36:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791005880,
        "end_time_iso": "2026-10-03T05:38:00+00:00",
        "results": [],
        "start_time": 1791005820,
        "start_time_iso": "2026-10-03T05:37:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791005940,
        "end_time_iso": "2026-10-03T05:39:00+00:00",
        "results": [],
        "start_time": 1791005880,
        "start_time_iso": "2026-10-03T05:38:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006000,
        "end_time_iso": "2026-10-03T05:40:00+00:00",
        "results": [],
        "start_time": 1791005940,
        "start_time_iso": "2026-10-03T05:39:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006060,
        "end_time_iso": "2026-10-03T05:41:00+00:00",
        "results": [],
        "start_time": 1791006000,
        "start_time_iso": "2026-10-03T05:40:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006120,
        "end_time_iso": "2026-10-03T05:42:00+00:00",
        "results": [],
        "start_time": 1791006060,
        "start_time_iso": "2026-10-03T05:41:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006180,
        "end_time_iso": "2026-10-03T05:43:00+00:00",
        "results": [],
        "start_time": 1791006120,
        "start_time_iso": "2026-10-03T05:42:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006240,
        "end_time_iso": "2026-10-03T05:44:00+00:00",
        "results": [],
        "start_time": 1791006180,
        "start_time_iso": "2026-10-03T05:43:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006300,
        "end_time_iso": "2026-10-03T05:45:00+00:00",
        "results": [],
        "start_time": 1791006240,
        "start_time_iso": "2026-10-03T05:44:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006360,
        "end_time_iso": "2026-10-03T05:46:00+00:00",
        "results": [],
        "start_time": 1791006300,
        "start_time_iso": "2026-10-03T05:45:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006420,
        "end_time_iso": "2026-10-03T05:47:00+00:00",
        "results": [],
        "start_time": 1791006360,
        "start_time_iso": "2026-10-03T05:46:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006480,
        "end_time_iso": "2026-10-03T05:48:00+00:00",
        "results": [],
        "start_time": 1791006420,
        "start_time_iso": "2026-10-03T05:47:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006540,
        "end_time_iso": "2026-10-03T05:49:00+00:00",
        "results": [],
        "start_time": 1791006480,
        "start_time_iso": "2026-10-03T05:48:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006600,
        "end_time_iso": "2026-10-03T05:50:00+00:00",
        "results": [],
        "start_time": 1791006540,
        "start_time_iso": "2026-10-03T05:49:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006660,
        "end_time_iso": "2026-10-03T05:51:00+00:00",
        "results": [],
        "start_time": 1791006600,
        "start_time_iso": "2026-10-03T05:50:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006720,
        "end_time_iso": "2026-10-03T05:52:00+00:00",
        "results": [],
        "start_time": 1791006660,
        "start_time_iso": "2026-10-03T05:51:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006780,
        "end_time_iso": "2026-10-03T05:53:00+00:00",
        "results": [],
        "start_time": 1791006720,
        "start_time_iso": "2026-10-03T05:52:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006840,
        "end_time_iso": "2026-10-03T05:54:00+00:00",
        "results": [],
        "start_time": 1791006780,
        "start_time_iso": "2026-10-03T05:53:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006900,
        "end_time_iso": "2026-10-03T05:55:00+00:00",
        "results": [],
        "start_time": 1791006840,
        "start_time_iso": "2026-10-03T05:54:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791006960,
        "end_time_iso": "2026-10-03T05:56:00+00:00",
        "results": [],
        "start_time": 1791006900,
        "start_time_iso": "2026-10-03T05:55:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007020,
        "end_time_iso": "2026-10-03T05:57:00+00:00",
        "results": [],
        "start_time": 1791006960,
        "start_time_iso": "2026-10-03T05:56:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007080,
        "end_time_iso": "2026-10-03T05:58:00+00:00",
        "results": [],
        "start_time": 1791007020,
        "start_time_iso": "2026-10-03T05:57:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007140,
        "end_time_iso": "2026-10-03T05:59:00+00:00",
        "results": [],
        "start_time": 1791007080,
        "start_time_iso": "2026-10-03T05:58:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007200,
        "end_time_iso": "2026-10-03T06:00:00+00:00",
        "results": [],
        "start_time": 1791007140,
        "start_time_iso": "2026-10-03T05:59:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007260,
        "end_time_iso": "2026-10-03T06:01:00+00:00",
        "results": [],
        "start_time": 1791007200,
        "start_time_iso": "2026-10-03T06:00:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007320,
        "end_time_iso": "2026-10-03T06:02:00+00:00",
        "results": [],
        "start_time": 1791007260,
        "start_time_iso": "2026-10-03T06:01:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007380,
        "end_time_iso": "2026-10-03T06:03:00+00:00",
        "results": [],
        "start_time": 1791007320,
        "start_time_iso": "2026-10-03T06:02:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007440,
        "end_time_iso": "2026-10-03T06:04:00+00:00",
        "results": [],
        "start_time": 1791007380,
        "start_time_iso": "2026-10-03T06:03:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007500,
        "end_time_iso": "2026-10-03T06:05:00+00:00",
        "results": [],
        "start_time": 1791007440,
        "start_time_iso": "2026-10-03T06:04:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007560,
        "end_time_iso": "2026-10-03T06:06:00+00:00",
        "results": [],
        "start_time": 1791007500,
        "start_time_iso": "2026-10-03T06:05:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007620,
        "end_time_iso": "2026-10-03T06:07:00+00:00",
        "results": [],
        "start_time": 1791007560,
        "start_time_iso": "2026-10-03T06:06:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007680,
        "end_time_iso": "2026-10-03T06:08:00+00:00",
        "results": [],
        "start_time": 1791007620,
        "start_time_iso": "2026-10-03T06:07:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007740,
        "end_time_iso": "2026-10-03T06:09:00+00:00",
        "results": [],
        "start_time": 1791007680,
        "start_time_iso": "2026-10-03T06:08:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007800,
        "end_time_iso": "2026-10-03T06:10:00+00:00",
        "results": [],
        "start_time": 1791007740,
        "start_time_iso": "2026-10-03T06:09:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007860,
        "end_time_iso": "2026-10-03T06:11:00+00:00",
        "results": [],
        "start_time": 1791007800,
        "start_time_iso": "2026-10-03T06:10:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007920,
        "end_time_iso": "2026-10-03T06:12:00+00:00",
        "results": [],
        "start_time": 1791007860,
        "start_time_iso": "2026-10-03T06:11:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791007980,
        "end_time_iso": "2026-10-03T06:13:00+00:00",
        "results": [],
        "start_time": 1791007920,
        "start_time_iso": "2026-10-03T06:12:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008040,
        "end_time_iso": "2026-10-03T06:14:00+00:00",
        "results": [],
        "start_time": 1791007980,
        "start_time_iso": "2026-10-03T06:13:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008100,
        "end_time_iso": "2026-10-03T06:15:00+00:00",
        "results": [],
        "start_time": 1791008040,
        "start_time_iso": "2026-10-03T06:14:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008160,
        "end_time_iso": "2026-10-03T06:16:00+00:00",
        "results": [],
        "start_time": 1791008100,
        "start_time_iso": "2026-10-03T06:15:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008220,
        "end_time_iso": "2026-10-03T06:17:00+00:00",
        "results": [],
        "start_time": 1791008160,
        "start_time_iso": "2026-10-03T06:16:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008280,
        "end_time_iso": "2026-10-03T06:18:00+00:00",
        "results": [],
        "start_time": 1791008220,
        "start_time_iso": "2026-10-03T06:17:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008340,
        "end_time_iso": "2026-10-03T06:19:00+00:00",
        "results": [],
        "start_time": 1791008280,
        "start_time_iso": "2026-10-03T06:18:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008400,
        "end_time_iso": "2026-10-03T06:20:00+00:00",
        "results": [],
        "start_time": 1791008340,
        "start_time_iso": "2026-10-03T06:19:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008460,
        "end_time_iso": "2026-10-03T06:21:00+00:00",
        "results": [],
        "start_time": 1791008400,
        "start_time_iso": "2026-10-03T06:20:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008520,
        "end_time_iso": "2026-10-03T06:22:00+00:00",
        "results": [],
        "start_time": 1791008460,
        "start_time_iso": "2026-10-03T06:21:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008580,
        "end_time_iso": "2026-10-03T06:23:00+00:00",
        "results": [],
        "start_time": 1791008520,
        "start_time_iso": "2026-10-03T06:22:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008640,
        "end_time_iso": "2026-10-03T06:24:00+00:00",
        "results": [],
        "start_time": 1791008580,
        "start_time_iso": "2026-10-03T06:23:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008700,
        "end_time_iso": "2026-10-03T06:25:00+00:00",
        "results": [],
        "start_time": 1791008640,
        "start_time_iso": "2026-10-03T06:24:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008760,
        "end_time_iso": "2026-10-03T06:26:00+00:00",
        "results": [],
        "start_time": 1791008700,
        "start_time_iso": "2026-10-03T06:25:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008820,
        "end_time_iso": "2026-10-03T06:27:00+00:00",
        "results": [],
        "start_time": 1791008760,
        "start_time_iso": "2026-10-03T06:26:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008880,
        "end_time_iso": "2026-10-03T06:28:00+00:00",
        "results": [],
        "start_time": 1791008820,
        "start_time_iso": "2026-10-03T06:27:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791008940,
        "end_time_iso": "2026-10-03T06:29:00+00:00",
        "results": [],
        "start_time": 1791008880,
        "start_time_iso": "2026-10-03T06:28:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009000,
        "end_time_iso": "2026-10-03T06:30:00+00:00",
        "results": [],
        "start_time": 1791008940,
        "start_time_iso": "2026-10-03T06:29:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009060,
        "end_time_iso": "2026-10-03T06:31:00+00:00",
        "results": [],
        "start_time": 1791009000,
        "start_time_iso": "2026-10-03T06:30:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009120,
        "end_time_iso": "2026-10-03T06:32:00+00:00",
        "results": [],
        "start_time": 1791009060,
        "start_time_iso": "2026-10-03T06:31:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009180,
        "end_time_iso": "2026-10-03T06:33:00+00:00",
        "results": [],
        "start_time": 1791009120,
        "start_time_iso": "2026-10-03T06:32:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009240,
        "end_time_iso": "2026-10-03T06:34:00+00:00",
        "results": [],
        "start_time": 1791009180,
        "start_time_iso": "2026-10-03T06:33:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009300,
        "end_time_iso": "2026-10-03T06:35:00+00:00",
        "results": [],
        "start_time": 1791009240,
        "start_time_iso": "2026-10-03T06:34:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009360,
        "end_time_iso": "2026-10-03T06:36:00+00:00",
        "results": [],
        "start_time": 1791009300,
        "start_time_iso": "2026-10-03T06:35:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009420,
        "end_time_iso": "2026-10-03T06:37:00+00:00",
        "results": [],
        "start_time": 1791009360,
        "start_time_iso": "2026-10-03T06:36:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009480,
        "end_time_iso": "2026-10-03T06:38:00+00:00",
        "results": [],
        "start_time": 1791009420,
        "start_time_iso": "2026-10-03T06:37:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009540,
        "end_time_iso": "2026-10-03T06:39:00+00:00",
        "results": [],
        "start_time": 1791009480,
        "start_time_iso": "2026-10-03T06:38:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009600,
        "end_time_iso": "2026-10-03T06:40:00+00:00",
        "results": [],
        "start_time": 1791009540,
        "start_time_iso": "2026-10-03T06:39:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009660,
        "end_time_iso": "2026-10-03T06:41:00+00:00",
        "results": [],
        "start_time": 1791009600,
        "start_time_iso": "2026-10-03T06:40:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009720,
        "end_time_iso": "2026-10-03T06:42:00+00:00",
        "results": [],
        "start_time": 1791009660,
        "start_time_iso": "2026-10-03T06:41:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009780,
        "end_time_iso": "2026-10-03T06:43:00+00:00",
        "results": [],
        "start_time": 1791009720,
        "start_time_iso": "2026-10-03T06:42:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009840,
        "end_time_iso": "2026-10-03T06:44:00+00:00",
        "results": [],
        "start_time": 1791009780,
        "start_time_iso": "2026-10-03T06:43:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009900,
        "end_time_iso": "2026-10-03T06:45:00+00:00",
        "results": [],
        "start_time": 1791009840,
        "start_time_iso": "2026-10-03T06:44:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791009960,
        "end_time_iso": "2026-10-03T06:46:00+00:00",
        "results": [],
        "start_time": 1791009900,
        "start_time_iso": "2026-10-03T06:45:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791010020,
        "end_time_iso": "2026-10-03T06:47:00+00:00",
        "results": [],
        "start_time": 1791009960,
        "start_time_iso": "2026-10-03T06:46:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791010080,
        "end_time_iso": "2026-10-03T06:48:00+00:00",
        "results": [],
        "start_time": 1791010020,
        "start_time_iso": "2026-10-03T06:47:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791010140,
        "end_time_iso": "2026-10-03T06:49:00+00:00",
        "results": [],
        "start_time": 1791010080,
        "start_time_iso": "2026-10-03T06:48:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791010200,
        "end_time_iso": "2026-10-03T06:50:00+00:00",
        "results": [],
        "start_time": 1791010140,
        "start_time_iso": "2026-10-03T06:49:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791010260,
        "end_time_iso": "2026-10-03T06:51:00+00:00",
        "results": [],
        "start_time": 1791010200,
        "start_time_iso": "2026-10-03T06:50:00+00:00"
      }
    ],
    "has_more": false,
    "next_page": null
  }
}
~~~

Costs

~~~json
{
  "at": "2026-10-03T06:50:23.353Z",
  "status": 200,
  "body": {
    "object": "page",
    "data": [
      {
        "object": "bucket",
        "end_time": 1791072000,
        "end_time_iso": "2026-10-04T00:00:00",
        "results": [
          {
            "object": "organization.costs.result",
            "amount": {
              "currency": "usd",
              "value": 0
            },
            "api_key_id": null,
            "api_source": null,
            "line_item": "gpt-5.4-nano-2026-03-17, cached input",
            "organization_id": "<organization-id>",
            "organization_name": "<organization-name>",
            "project_id": "<project-id>",
            "project_name": "pr161344-final-proof",
            "quantity": 0,
            "quantity_unit": "tokens",
            "user_email": null,
            "user_id": null
          },
          {
            "object": "organization.costs.result",
            "amount": {
              "currency": "usd",
              "value": 0.00005
            },
            "api_key_id": null,
            "api_source": null,
            "line_item": "gpt-5.4-nano-2026-03-17, input",
            "organization_id": "<organization-id>",
            "organization_name": "<organization-name>",
            "project_id": "<project-id>",
            "project_name": "pr161344-final-proof",
            "quantity": 250,
            "quantity_unit": "tokens",
            "user_email": null,
            "user_id": null
          },
          {
            "object": "organization.costs.result",
            "amount": {
              "currency": "usd",
              "value": 0.00001875
            },
            "api_key_id": null,
            "api_source": null,
            "line_item": "gpt-5.4-nano-2026-03-17, output",
            "organization_id": "<organization-id>",
            "organization_name": "<organization-name>",
            "project_id": "<project-id>",
            "project_name": "pr161344-final-proof",
            "quantity": 15,
            "quantity_unit": "tokens",
            "user_email": null,
            "user_id": null
          }
        ],
        "start_time": 1790985600,
        "start_time_iso": "2026-10-03T00:00:00"
      }
    ],
    "has_more": false,
    "next_page": null
  }
}
~~~

Archive project

~~~json
{
  "status": 200,
  "body": {
    "id": "<project-id>",
    "object": "organization.project",
    "created_at": 1791005764,
    "status": "archived",
    "archived_at": 1791010283,
    "name": "pr161344-final-proof",
    "residency": "GLOBAL"
  }
}
~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Omitted model, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-default --state-key r1"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"498dadfd0eadc31d77ab83743f62286793538fdfec082dab7adaf1a57f8f405f\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T01:11:39.682Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"498dadfd0eadc31d77ab83743f62286793538fdfec082dab7adaf1a57f8f405f","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T01:11:39.682Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T01:11:37.487+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:37.497+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:37.724+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T01:11:37.727+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=3 queueSize=0
2026-10-04T01:11:37.875+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T01:11:37.881+00:00 [scheduler] running startup:maintenance
2026-10-04T01:11:37.883+00:00 [scheduler] running startup:post-ready-work
2026-10-04T01:11:38.033+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:38.096+00:00 [scheduler] running update.check
2026-10-04T01:11:38.097+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T01:11:38.105+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:38.177+00:00 [hooks] running gateway_start (1 handlers)
2026-10-04T01:11:38.371+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:38.469+00:00 [scheduler] running delivery:session-recovery
2026-10-04T01:11:38.735+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:38.986+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:39.242+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:39.470+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=1595 dispatcher=new contentType=text/event-stream; charset=utf-8
2026-10-04T01:11:39.510+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:39.681+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=1953 active=0 queued=0
2026-10-04T01:11:39.761+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.014+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.267+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.295+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.347+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.424+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.447+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.463+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.471+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:40.622+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Repeat with --refresh false, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-default --state-key r1 --refresh false"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"498dadfd0eadc31d77ab83743f62286793538fdfec082dab7adaf1a57f8f405f\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T01:11:41.917Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"498dadfd0eadc31d77ab83743f62286793538fdfec082dab7adaf1a57f8f405f","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T01:11:41.917Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T01:11:40.933+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:40.935+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:40.939+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T01:11:40.941+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T01:11:40.969+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T01:11:41.736+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=767 dispatcher=reused contentType=text/event-stream; charset=utf-8
2026-10-04T01:11:41.917+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=975 active=0 queued=0
2026-10-04T01:11:42.120+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:11:42.137+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Explicit override, writer</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-rk-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T01:11:43.180+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:43.183+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:43.188+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: provider/model override is not authorized for this plugin subagent run.
2026-10-04T01:11:43.994+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Explicit override, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-rk-override"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"a9f91be0dc68247315cfe7d3986c4cf8d9d6387dcdce1d43bbda1b6c2246c73f\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T01:11:45.484Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"a9f91be0dc68247315cfe7d3986c4cf8d9d6387dcdce1d43bbda1b6c2246c73f","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T01:11:45.484Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T01:11:44.543+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:44.546+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:44.549+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T01:11:44.550+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T01:11:44.581+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T01:11:45.192+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=610 dispatcher=reused contentType=text/event-stream; charset=utf-8
2026-10-04T01:11:45.484+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=933 active=0 queued=0
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text

~~~

State after

~~~text

~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Embedded override then approval checkpoint, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-rk-checkpoint | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"0cc8c3a6a58c55e76fadca2d39888b8d82d8b33c8ce9941ee28c34961fcd1cd5\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{}\",\n          \"data\": {}\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T01:11:47.564Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV85OTczZWQ3OC0yNjJkLTQxNDYtODhkNi1iNmVkNDExMmI0YmQifQ\",\n    \"approvalId\": \"a23ec23a\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,
~~~

Gateway log during call

~~~text
2026-10-04T01:11:46.730+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:46.733+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:46.736+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T01:11:46.737+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T01:11:46.759+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T01:11:47.426+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=667 dispatcher=reused contentType=text/event-stream; charset=utf-8
2026-10-04T01:11:47.563+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=826 active=0 queued=0
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text

~~~

State after

~~~text
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Writer resumes that checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV85OTczZWQ3OC0yNjJkLTQxNDYtODhkNi1iNmVkNDExMmI0YmQifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T01:11:48.842+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:48.845+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:48.852+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

State after

~~~text
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Omitted model then approval checkpoint, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-checkpoint2 | approve --emit --prompt use-answer"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"needs_approval\",\n  \"output\": [],\n  \"requiresApproval\": {\n    \"type\": \"approval_request\",\n    \"prompt\": \"use-answer\",\n    \"items\": [\n      {\n        \"kind\": \"llm.invoke\",\n        \"runId\": null,\n        \"prompt\": null,\n        \"model\": null,\n        \"schemaVersion\": \"v1\",\n        \"status\": \"completed\",\n        \"cacheKey\": \"2243d13b338d745edd3fe14bdfb75a804a72c2a5b18dda098adf613182de6b28\",\n        \"artifactHashes\": [],\n        \"output\": {\n          \"format\": \"json\",\n          \"text\": \"{}\",\n          \"data\": {}\n        },\n        \"usage\": null,\n        \"metadata\": null,\n        \"warnings\": null,\n        \"diagnostics\": null,\n        \"createdAt\": \"2026-10-04T01:11:51.472Z\",\n        \"source\": \"openclaw-embedded\",\n        \"cached\": true,\n        \"attemptCount\": 1\n      }\n    ],\n    \"resumeToken\": \"eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9iZmM5OTlkNC0wNjYxLTQ0NTktOTA5Ny1kYmQ1MjA0YjA2YzQifQ\",\n    \"approvalId\": \"a129aef7\"\n  }\n}"}],"details":{"ok":true,"status":"needs_approval","output":[],"requiresApproval":{"type":"approval_request","prompt":"use-answer","items":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,
~~~

Gateway log during call

~~~text
2026-10-04T01:11:50.094+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:50.097+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:11:50.101+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T01:11:50.102+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=1 queueSize=0
2026-10-04T01:11:50.123+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T01:11:50.888+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=200 elapsedMs=764 dispatcher=reused contentType=text/event-stream; charset=utf-8
2026-10-04T01:11:51.472+00:00 [diagnostic] lane task done: lane=background:plugin:lobster durationMs=1369 active=0 queued=0
2026-10-04T01:11:52.219+00:00 [scheduler] running sessions:upstream-initial-probe
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

State after

~~~text
lobster-state/approval_a129aef7.json 107 bytes
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/648fdf29e1c597550cdc5d7984d406419d0d6eb3652d15e68c0c97b76476f9e6.json 163 bytes
lobster-state/openclaw-llm-checkpoints/91fc7b666ef0576f8c8e6102d595aea2b06dff8eafeaeab9fecbd2ff56788715.json 163 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
lobster-state/pipeline_resume_bfc999d4-0661-4459-9097-dbd5204b06c4.json 1218 bytes
~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Administrator resumes its own checkpoint</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9iZmM5OTlkNC0wNjYxLTQ0NTktOTA5Ny1kYmQ1MjA0YjA2YzQifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"2243d13b338d745edd3fe14bdfb75a804a72c2a5b18dda098adf613182de6b28\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{}\",\n        \"data\": {}\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T01:11:51.472Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"2243d13b338d745edd3fe14bdfb75a804a72c2a5b18dda098adf613182de6b28","artifactHashes":[],"output":{"format":"json","text":"{}","data":{}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T01:11:51.472Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during call

~~~text
2026-10-04T01:11:52.739+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:11:52.741+00:00 [plugins] lobster plugin runtime=2026.9.8
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text
lobster-state/approval_a129aef7.json 107 bytes
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/648fdf29e1c597550cdc5d7984d406419d0d6eb3652d15e68c0c97b76476f9e6.json 163 bytes
lobster-state/openclaw-llm-checkpoints/91fc7b666ef0576f8c8e6102d595aea2b06dff8eafeaeab9fecbd2ff56788715.json 163 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
lobster-state/pipeline_resume_bfc999d4-0661-4459-9097-dbd5204b06c4.json 1218 bytes
~~~

State after

~~~text
lobster-state/approval_a129aef7.json 107 bytes
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/648fdf29e1c597550cdc5d7984d406419d0d6eb3652d15e68c0c97b76476f9e6.json 163 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

</details>

<details>
<summary>Real provider on 134946619f2c: Same pipeline after key deletion, administrator</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "action": "run",
    "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-revoked"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during call

~~~text
2026-10-04T01:12:17.561+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T01:12:17.574+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T01:12:17.712+00:00 [diagnostic] lane enqueue: lane=background:plugin:lobster queueSize=1
2026-10-04T01:12:17.713+00:00 [diagnostic] lane dequeue: lane=background:plugin:lobster waitMs=2 queueSize=0
2026-10-04T01:12:17.847+00:00 [provider-transport-fetch] [model-fetch] start provider=openai-paid api=openai-responses model=gpt-5.4-nano method=POST url=https://api.openai.com/v1/responses timeoutMs=undefined proxy=none policy=custom
2026-10-04T01:12:17.852+00:00 [scheduler] running startup:post-ready-work
2026-10-04T01:12:17.919+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:12:17.982+00:00 [scheduler] running update.check
2026-10-04T01:12:17.983+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T01:12:17.993+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:12:18.140+00:00 [provider-transport-fetch] [model-fetch] response provider=openai-paid api=openai-responses model=gpt-5.4-nano status=401 elapsedMs=291 dispatcher=new contentType=text/plain
2026-10-04T01:12:18.325+00:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=openai-paid/gpt-5.4-nano candidate=openai-paid/gpt-5.4-nano reason=auth next=none detail=Isolated completion failed with stop reason error.
2026-10-04T01:12:18.330+00:00 [diagnostic] lane task error: lane=background:plugin:lobster durationMs=613 error="Isolated completion failed with stop reason error. | output-rejected | {\"status\":401,\"code\":\"token_invalidated\",\"message\":\"401 Your API key has been invalidated.\",\"provider\":\"openai-paid\",\"details\":[\"{\\\"code\\\":\\\"token_invalidated\\\",\\\"message\\\":\\\"Your API key has been invalidated.\\\",\\\"param\\\":null,\\\"type\\\":null}\",\"Your API key has been invalidated.\",\"token_invalidated\"]}" errorName=FailoverError
2026-10-04T01:12:18.332+00:00 [tools-invoke] tool execution failed: Error: llm.invoke request failed: Isolated completion failed with stop reason error.
2026-10-04T01:12:18.339+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:12:18.340+00:00 [scheduler] running delivery:session-recovery
2026-10-04T01:12:18.446+00:00 [hooks] running gateway_start (1 handlers)
2026-10-04T01:12:18.590+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:12:18.853+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:12:19.104+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T01:12:19.355+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
(missing)
~~~

Counts after

~~~json
(missing)
~~~

State before

~~~text
lobster-state/approval_a129aef7.json 107 bytes
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/648fdf29e1c597550cdc5d7984d406419d0d6eb3652d15e68c0c97b76476f9e6.json 163 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

State after

~~~text
lobster-state/approval_a129aef7.json 107 bytes
lobster-state/approval_a23ec23a.json 107 bytes
lobster-state/openclaw-llm-checkpoints/648fdf29e1c597550cdc5d7984d406419d0d6eb3652d15e68c0c97b76476f9e6.json 163 bytes
lobster-state/openclaw-llm-checkpoints/bbe72916ba0c4686732781f43fdf12afa5915a9ebb04c67478c1c40232c9c42d.json 163 bytes
lobster-state/openclaw-llm-checkpoints/facc08976659b5911e65d3d6f86f499350f50558c9e78468bcf1aad92d770675.json 163 bytes
lobster-state/pipeline_resume_9973ed78-262d-4146-88d6-b6ed4112b4bd.json 1294 bytes
~~~

</details>

<details>
<summary>Real provider on 134946619f2c: revocation, billing and cleanup records</summary>

All calls go to https://api.openai.com/v1. The deletion, probe and billing reads carry the temporary admin credential; the dead-key probe carries the deleted project key instead.

Request, as the run script issued it

~~~text
DELETE /organization/projects/<project-id>/api_keys/<key-id>
~~~

Response

~~~json
{
  "status": 200,
  "body": {
    "id": "<key-id>",
    "object": "organization.project.api_key.deleted",
    "deleted": true
  }
}
~~~

Request, as the run script issued it

~~~text
GET /models
~~~

Response

~~~json
{
  "at": "2026-10-04T01:11:56.363Z",
  "status": 401,
  "body": {
    "error": {
      "message": "Incorrect API key provided: <redacted-service-key>. You can find your API key at https://platform.openai.com/account/api-keys.",
      "type": "invalid_request_error",
      "param": null,
      "code": "invalid_api_key"
    }
  }
}
~~~

Request, as the run script issued it

~~~text
GET /organization/usage/completions?start_time=...&bucket_width=1m&limit=1440&project_ids=<project-id>&group_by=model
~~~

Response

~~~json
{
  "at": "2026-10-04T01:16:29.067Z",
  "status": 200,
  "body": {
    "object": "page",
    "data": [
      {
        "object": "bucket",
        "end_time": 1791076200,
        "end_time_iso": "2026-10-04T01:10:00+00:00",
        "results": [],
        "start_time": 1791076140,
        "start_time_iso": "2026-10-04T01:09:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076260,
        "end_time_iso": "2026-10-04T01:11:00+00:00",
        "results": [],
        "start_time": 1791076200,
        "start_time_iso": "2026-10-04T01:10:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076320,
        "end_time_iso": "2026-10-04T01:12:00+00:00",
        "results": [
          {
            "object": "organization.usage.completions.result",
            "project_id": null,
            "num_model_requests": 5,
            "user_id": null,
            "api_key_id": null,
            "model": "gpt-5.4-nano-2026-03-17",
            "batch": null,
            "service_tier": null,
            "input_tokens": 424,
            "output_tokens": 25,
            "input_cached_tokens": 0,
            "input_cache_write_tokens": 0,
            "input_cache_write_12h_tokens": 0,
            "input_uncached_tokens": 424,
            "input_text_tokens": 424,
            "output_text_tokens": 25,
            "input_cached_text_tokens": 0,
            "input_audio_tokens": 0,
            "input_cached_audio_tokens": 0,
            "output_audio_tokens": 0,
            "input_image_tokens": 0,
            "input_cached_image_tokens": 0,
            "output_image_tokens": 0,
            "api_source": null
          }
        ],
        "start_time": 1791076260,
        "start_time_iso": "2026-10-04T01:11:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076380,
        "end_time_iso": "2026-10-04T01:13:00+00:00",
        "results": [],
        "start_time": 1791076320,
        "start_time_iso": "2026-10-04T01:12:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076440,
        "end_time_iso": "2026-10-04T01:14:00+00:00",
        "results": [],
        "start_time": 1791076380,
        "start_time_iso": "2026-10-04T01:13:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076500,
        "end_time_iso": "2026-10-04T01:15:00+00:00",
        "results": [],
        "start_time": 1791076440,
        "start_time_iso": "2026-10-04T01:14:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076560,
        "end_time_iso": "2026-10-04T01:16:00+00:00",
        "results": [],
        "start_time": 1791076500,
        "start_time_iso": "2026-10-04T01:15:00+00:00"
      },
      {
        "object": "bucket",
        "end_time": 1791076620,
        "end_time_iso": "2026-10-04T01:17:00+00:00",
        "results": [],
        "start_time": 1791076560,
        "start_time_iso": "2026-10-04T01:16:00+00:00"
      }
    ],
    "has_more": false,
    "next_page": null
  }
}
~~~

Request, as the run script issued it

~~~text
GET /organization/costs?start_time=...&bucket_width=1d&limit=2&project_ids=<project-id>&group_by=line_item
~~~

Response

~~~json
{
  "at": "2026-10-04T01:16:29.068Z",
  "status": 200,
  "body": {
    "object": "page",
    "data": [
      {
        "object": "bucket",
        "end_time": 1791158400,
        "end_time_iso": "2026-10-05T00:00:00",
        "results": [
          {
            "object": "organization.costs.result",
            "amount": {
              "currency": "usd",
              "value": 0
            },
            "api_key_id": null,
            "api_source": null,
            "line_item": "gpt-5.4-nano-2026-03-17, cached input",
            "organization_id": "<organization-id>",
            "organization_name": "<organization-name>",
            "project_id": "<project-id>",
            "project_name": "pr161344-checkpoint-proof",
            "quantity": 0,
            "quantity_unit": "tokens",
            "user_email": null,
            "user_id": null
          },
          {
            "object": "organization.costs.result",
            "amount": {
              "currency": "usd",
              "value": 0.0000848
            },
            "api_key_id": null,
            "api_source": null,
            "line_item": "gpt-5.4-nano-2026-03-17, input",
            "organization_id": "<organization-id>",
            "organization_name": "<organization-name>",
            "project_id": "<project-id>",
            "project_name": "pr161344-checkpoint-proof",
            "quantity": 424,
            "quantity_unit": "tokens",
            "user_email": null,
            "user_id": null
          },
          {
            "object": "organization.costs.result",
            "amount": {
              "currency": "usd",
              "value": 0.00003125
            },
            "api_key_id": null,
            "api_source": null,
            "line_item": "gpt-5.4-nano-2026-03-17, output",
            "organization_id": "<organization-id>",
            "organization_name": "<organization-name>",
            "project_id": "<project-id>",
            "project_name": "pr161344-checkpoint-proof",
            "quantity": 25,
            "quantity_unit": "tokens",
            "user_email": null,
            "user_id": null
          }
        ],
        "start_time": 1791072000,
        "start_time_iso": "2026-10-04T00:00:00"
      }
    ],
    "has_more": false,
    "next_page": null
  }
}
~~~

Request, as the run script issued it

~~~text
POST /organization/projects/<project-id>/archive
~~~

Response

~~~json
{
  "status": 200,
  "body": {
    "id": "<project-id>",
    "object": "organization.project",
    "created_at": 1791076273,
    "status": "archived",
    "archived_at": 1791076589,
    "name": "pr161344-checkpoint-proof",
    "residency": "GLOBAL"
  }
}
~~~

Request, as the run script issued it

~~~text
DELETE /organization/admin_api_keys/<admin-key-id>  (the API refuses this for a key acting as itself, so the key was revoked in the provider dashboard instead)
~~~

Response, then the follow-up read with the same credential

~~~json
{
  "adminKeyId": "<key-id>",
  "deleteStatus": 404,
  "deleteBody": {},
  "probeAfterStatus": 200,
  "at": "2026-10-04T01:16:30.340Z"
}
~~~

Run summary and the credential window the records belong to

~~~json
[
  {
    "id": "01-default-admin",
    "admin": true,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-default --state-key r1"
    },
    "startedAt": "2026-10-04T01:11:37.312Z",
    "finishedAt": "2026-10-04T01:11:40.890Z",
    "http": 200,
    "status": "ok",
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 0,
    "providerAttemptsAfter": 1,
    "error": null
  },
  {
    "id": "02-repeat-refresh-false",
    "admin": true,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-default --state-key r1 --refresh false"
    },
    "startedAt": "2026-10-04T01:11:40.891Z",
    "finishedAt": "2026-10-04T01:11:43.122Z",
    "http": 200,
    "status": "ok",
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 1,
    "providerAttemptsAfter": 2,
    "error": null
  },
  {
    "id": "03-override-writer",
    "admin": false,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-rk-override"
    },
    "startedAt": "2026-10-04T01:11:43.122Z",
    "finishedAt": "2026-10-04T01:11:44.392Z",
    "http": 500,
    "status": null,
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 2,
    "providerAttemptsAfter": 2,
    "error": "{\"ok\":false,\"error\":{\"type\":\"tool_error\",\"message\":\"tool execution failed\"}}"
  },
  {
    "id": "04-override-admin",
    "admin": true,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-rk-override"
    },
    "startedAt": "2026-10-04T01:11:44.393Z",
    "finishedAt": "2026-10-04T01:11:46.690Z",
    "http": 200,
    "status": "ok",
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 2,
    "providerAttemptsAfter": 3,
    "error": null
  },
  {
    "id": "05-checkpoint-admin",
    "admin": true,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --model openai-paid/gpt-5.4-nano --prompt pr161344-rk-checkpoint | approve --emit --prompt use-answer"
    },
    "startedAt": "2026-10-04T01:11:46.691Z",
    "finishedAt": "2026-10-04T01:11:48.797Z",
    "http": 200,
    "status": "needs_approval",
    "resumeTokenIssued": true,
    "providerAttemptsBefore": 3,
    "providerAttemptsAfter": 4,
    "error": null
  },
  {
    "id": "06-resume-writer-refused",
    "admin": false,
    "agentId": "main",
    "args": {
      "approve": true,
      "action": "resume",
      "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV85OTczZWQ3OC0yNjJkLTQxNDYtODhkNi1iNmVkNDExMmI0YmQifQ"
    },
    "startedAt": "2026-10-04T01:11:48.798Z",
    "finishedAt": "2026-10-04T01:11:50.058Z",
    "http": 500,
    "status": null,
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 4,
    "providerAttemptsAfter": 4,
    "error": "{\"ok\":false,\"error\":{\"type\":\"tool_error\",\"message\":\"tool execution failed\"}}"
  },
  {
    "id": "07-checkpoint-admin-2",
    "admin": true,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-checkpoint2 | approve --emit --prompt use-answer"
    },
    "startedAt": "2026-10-04T01:11:50.059Z",
    "finishedAt": "2026-10-04T01:11:52.700Z",
    "http": 200,
    "status": "needs_approval",
    "resumeTokenIssued": true,
    "providerAttemptsBefore": 4,
    "providerAttemptsAfter": 5,
    "error": null
  },
  {
    "id": "08-resume-admin-allowed",
    "admin": true,
    "agentId": "main",
    "args": {
      "approve": true,
      "action": "resume",
      "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9iZmM5OTlkNC0wNjYxLTQ0NTktOTA5Ny1kYmQ1MjA0YjA2YzQifQ"
    },
    "startedAt": "2026-10-04T01:11:52.701Z",
    "finishedAt": "2026-10-04T01:11:53.969Z",
    "http": 200,
    "status": "ok",
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 5,
    "providerAttemptsAfter": 5,
    "error": null
  },
  {
    "id": "09-after-provider-revocation",
    "admin": true,
    "agentId": "main",
    "args": {
      "action": "run",
      "pipeline": "llm.invoke --provider embedded --prompt pr161344-rk-revoked"
    },
    "startedAt": "2026-10-04T01:12:17.402Z",
    "finishedAt": "2026-10-04T01:12:19.539Z",
    "http": 500,
    "status": null,
    "resumeTokenIssued": false,
    "providerAttemptsBefore": 0,
    "providerAttemptsAfter": 1,
    "error": "{\"ok\":false,\"error\":{\"type\":\"tool_error\",\"message\":\"tool execution failed\"}}"
  }
]
~~~

~~~json
{
  "projectId": "<project-id>",
  "serviceAccountId": "<service-account-id>",
  "keyId": "<key-id>",
  "createdAt": "2026-10-04T01:11:14.267Z",
  "windowStart": "2026-10-04T01:11:37.311Z",
  "revokedAt": "2026-10-04T01:11:56.224Z",
  "windowEnd": "2026-10-04T01:12:21.087Z",
  "acceptedProviderCalls": 5
}
~~~

</details>

### Earlier revision 4be8534dec3: repaired checkpoint authorization

Two authorization bypasses in this checkpoint protection were repaired on this revision: provenance is keyed by the decoded checkpoint identity rather than the literal token bytes, and a resume carrying both a token and an approval ID is refused, because Lobster gives the approval ID precedence. The scenarios below run the repaired revision 4be8534dec36cc8824fb17fb8403499022311df2 and its unpatched parent 134946619f2c3ff75affd20ff88c11aff7a91ac9 through the same Gateway tool entry point with the same script.

Identity: repaired revision 4be8534dec36cc8824fb17fb8403499022311df2; unpatched parent 134946619f2c3ff75affd20ff88c11aff7a91ac9. Disposable 4-vCPU Linux x86_64 VM, Node v24.19.0. One scratch trusted-proxy Gateway on 127.0.0.1:19000 per run, one logging model stub on 127.0.0.1:44081, fresh empty Lobster cache and state dirs. UTC window: 2026-10-04T02:17:00Z to 2026-10-04T02:21:00Z.

Host counts are "[model-fetch] response" lines in the Gateway log; stub counts are requests in the stub own model log. Both are read before and after each call, and the two totals agree at every step.

| Scenario | Environment | HTTP | Host before/after | Stub before/after | Result |
| --- | --- | --- | --- | --- | --- |
| Repaired: writer resumes with an equivalent token, 4be8534dec3 | writer | 500 | 1/1 | 1/1 | Refused, no provider call |
| Repaired: writer supplies a plain token plus the administrator approval ID, 4be8534dec3 | writer | 500 | 2/2 | 2/2 | Refused, no provider call |
| Repaired: administrator resumes its own embedded checkpoint, 4be8534dec3 | admin | 200 | 1/1 | 1/1 | Served from the saved answer, no provider call |
| Repaired: administrator resumes its second embedded checkpoint, 4be8534dec3 | admin | 200 | 2/2 | 2/2 | Served from the saved answer, no provider call |
| Unpatched parent: writer resumes with an equivalent token, 134946619f2c | writer | 200 | 1/1 | 1/1 | Bypass, administrator saved embedded output disclosed |
| Unpatched parent: writer supplies a plain token plus the administrator approval ID, 134946619f2c | writer | 200 | 2/2 | 2/2 | Bypass, administrator embedded checkpoint consumed |
| Unpatched parent: administrator resumes its own embedded checkpoint, 134946619f2c | admin | 500 | 1/1 | 1/1 | Failed, the bypass had consumed the checkpoint |

The run also includes the administrator embedded run, the writer original-token refusal control, and the plain checkpoint creation; the full sequence and counters are in the blocks below and in results.json.

Refusal reasons, read from the Gateway log rather than inferred from the status code:

- Equivalent-token resume on 4be8534dec3: "lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output"
- Conflicting-handle resume on 4be8534dec3: "resume accepts either token or approvalId, not both: the approval ID takes precedence, so the two can select different checkpoints"
- Equivalent-token resume on 134946619f2c: no refusal, HTTP 200, the writer received the administrator saved embedded output (source openclaw-embedded)
- Conflicting-handle resume on 134946619f2c: no refusal, HTTP 200, the writer consumed the administrator embedded checkpoint

Limits: these are stub-model scenarios, so they show routing and refusal, not provider auth. "Revocation during a pending resume" is shown as the producer-authority refusal of an equivalent token (the writer never held operator.admin); an in-flight completion cancelled when authority is withdrawn mid-request is not exercised. Legacy-checkpoint and remote-cache upgrade compatibility is not covered. Because the new claims only change plugin authorization, the real-provider credential, revocation and billing evidence remains the run on 134946619f2c recorded above; a real-provider rerun on this revision would need a freshly minted provider key and was not performed.

<details>
<summary>Repaired 4be8534dec3: writer resumes the administrator checkpoint with an equivalent token (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "<resume-token>"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:19:14.543+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:19:14.546+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T02:19:14.556+00:00 [scheduler] running startup:post-ready-work
2026-10-04T02:19:14.553+00:00 [tools-invoke] tool execution failed: Error: lobster checkpoint refused: the caller no longer holds operator.admin, which produced its embedded LLM output
2026-10-04T02:19:14.626+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T02:19:14.712+00:00 [scheduler] running update.check
2026-10-04T02:19:14.717+00:00 [scheduler] running update.remote-model-catalog
2026-10-04T02:19:14.744+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T02:19:14.827+00:00 [hooks] running gateway_start (1 handlers)
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/openclaw-llm-checkpoints/28059bb1c7b96fd711fdeab9128cd305beff06aa007044c190e0b0d0a8052faa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/pipeline_resume_1911c1ae-e636-487e-b185-2c0116ecde80.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/openclaw-llm-checkpoints/28059bb1c7b96fd711fdeab9128cd305beff06aa007044c190e0b0d0a8052faa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/pipeline_resume_1911c1ae-e636-487e-b185-2c0116ecde80.json 1299 bytes
~~~

</details>

<details>
<summary>Repaired 4be8534dec3: writer supplies a plain token plus the administrator approval ID (refused)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8zNGY0NzEzZS00OTdkLTQ3YzQtOGFkMS0wMGEyOGI3N2E3ZWMifQ",
    "approvalId": "f729b552"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:19:16.905+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:19:16.908+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T02:19:16.916+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T02:19:16.911+00:00 [tools-invoke] tool execution failed: Error: resume accepts either token or approvalId, not both: the approval ID takes precedence, so the two can select different checkpoints
2026-10-04T02:19:17.169+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/approval_bfd7a4ad.json 107 bytes
lobster-state/approval_f729b552.json 107 bytes
lobster-state/openclaw-llm-checkpoints/526f25ab9aaaafce5fe5ab3fd1bca80853bb4a6f0d47ba590922e3e8b8fd222a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/651339be5bc5ce242f49e67dfeef1fd5fd78c5843c4cf84b1525bfe97b690706.json 163 bytes
lobster-state/openclaw-llm-checkpoints/92f2e9f1afa9724cd0c6a7ad164d1e5e21c2dc2c613b2fe93672b2008fa0d203.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/openclaw-llm-checkpoints/f8b45d55104c2b163da745a5e6fd7ca4df6f7251a9ccf6c27d891ab4df4499d6.json 25 bytes
lobster-state/pipeline_resume_34f4713e-497d-47c4-8ad1-00a28b77a7ec.json 381 bytes
lobster-state/pipeline_resume_d9991f94-f166-45b8-b232-b2fd8d45231c.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/approval_bfd7a4ad.json 107 bytes
lobster-state/approval_f729b552.json 107 bytes
lobster-state/openclaw-llm-checkpoints/526f25ab9aaaafce5fe5ab3fd1bca80853bb4a6f0d47ba590922e3e8b8fd222a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/651339be5bc5ce242f49e67dfeef1fd5fd78c5843c4cf84b1525bfe97b690706.json 163 bytes
lobster-state/openclaw-llm-checkpoints/92f2e9f1afa9724cd0c6a7ad164d1e5e21c2dc2c613b2fe93672b2008fa0d203.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/openclaw-llm-checkpoints/f8b45d55104c2b163da745a5e6fd7ca4df6f7251a9ccf6c27d891ab4df4499d6.json 25 bytes
lobster-state/pipeline_resume_34f4713e-497d-47c4-8ad1-00a28b77a7ec.json 381 bytes
lobster-state/pipeline_resume_d9991f94-f166-45b8-b232-b2fd8d45231c.json 1299 bytes
~~~

</details>

<details>
<summary>Repaired 4be8534dec3: administrator resumes its own checkpoint (served)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8xOTExYzFhZS1lNjM2LTQ4N2UtYjE4NS0yYzAxMTZlY2RlODAifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T02:19:14.103Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T02:19:14.103Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:19:15.581+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:19:15.587+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T02:19:15.659+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T02:19:15.912+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/openclaw-llm-checkpoints/28059bb1c7b96fd711fdeab9128cd305beff06aa007044c190e0b0d0a8052faa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/pipeline_resume_1911c1ae-e636-487e-b185-2c0116ecde80.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
~~~

</details>

<details>
<summary>Repaired 4be8534dec3: administrator resumes its second checkpoint (served)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV9kOTk5MWY5NC1mMTY2LTQ1YjgtYjIzMi1iMmZkOGQ0NTIzMWMifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T02:19:16.521Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T02:19:16.521Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:19:17.265+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:19:17.269+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T02:19:17.420+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/approval_bfd7a4ad.json 107 bytes
lobster-state/approval_f729b552.json 107 bytes
lobster-state/openclaw-llm-checkpoints/526f25ab9aaaafce5fe5ab3fd1bca80853bb4a6f0d47ba590922e3e8b8fd222a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/651339be5bc5ce242f49e67dfeef1fd5fd78c5843c4cf84b1525bfe97b690706.json 163 bytes
lobster-state/openclaw-llm-checkpoints/92f2e9f1afa9724cd0c6a7ad164d1e5e21c2dc2c613b2fe93672b2008fa0d203.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/openclaw-llm-checkpoints/f8b45d55104c2b163da745a5e6fd7ca4df6f7251a9ccf6c27d891ab4df4499d6.json 25 bytes
lobster-state/pipeline_resume_34f4713e-497d-47c4-8ad1-00a28b77a7ec.json 381 bytes
lobster-state/pipeline_resume_d9991f94-f166-45b8-b232-b2fd8d45231c.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_78333f00.json 107 bytes
lobster-state/approval_bfd7a4ad.json 107 bytes
lobster-state/approval_f729b552.json 107 bytes
lobster-state/openclaw-llm-checkpoints/526f25ab9aaaafce5fe5ab3fd1bca80853bb4a6f0d47ba590922e3e8b8fd222a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/92f2e9f1afa9724cd0c6a7ad164d1e5e21c2dc2c613b2fe93672b2008fa0d203.json 163 bytes
lobster-state/openclaw-llm-checkpoints/d1ad5238945181fa18d9f84e052b23685ceac76ff126949ce9bc911c9c481c28.json 163 bytes
lobster-state/openclaw-llm-checkpoints/f8b45d55104c2b163da745a5e6fd7ca4df6f7251a9ccf6c27d891ab4df4499d6.json 25 bytes
lobster-state/pipeline_resume_34f4713e-497d-47c4-8ad1-00a28b77a7ec.json 381 bytes
~~~

</details>

<details>
<summary>Unpatched parent 134946619f2c: writer resumes with an equivalent token (bypass, served)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "<resume-token>"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T02:20:38.322Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"95c85ca5e52f42c2c9770b3773f84ba511aea35eaca856de7f9d11e9e4916a40","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T02:20:38.322Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:20:39.050+00:00 [scheduler] running startup:handler-prewarm
2026-10-04T02:20:39.170+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:20:39.172+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T02:20:39.303+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_de3c9f82.json 107 bytes
lobster-state/openclaw-llm-checkpoints/4d66eeb4172833d6cb5303b113d6f22e430ce179dedbccb7aea3eda1d7fbf7aa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/ce5c931be45ff49f2f657171fd52e730c7448b6caee7066f6ae3b44b5db61aa0.json 163 bytes
lobster-state/pipeline_resume_00313743-659d-4ebd-af8e-8f5a68e8a145.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_de3c9f82.json 107 bytes
lobster-state/openclaw-llm-checkpoints/4d66eeb4172833d6cb5303b113d6f22e430ce179dedbccb7aea3eda1d7fbf7aa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/ce5c931be45ff49f2f657171fd52e730c7448b6caee7066f6ae3b44b5db61aa0.json 163 bytes
~~~

</details>

<details>
<summary>Unpatched parent 134946619f2c: writer supplies a plain token plus the administrator approval ID (bypass, served)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8wMjJkZTA1Yi00MGZmLTQ4NmMtYWI0MC01YjU4YTdkNTJlYzYifQ",
    "approvalId": "9485b82e"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "writer@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.read,operator.write"
}
~~~

HTTP status

~~~text
200
~~~

Response

~~~text
{"ok":true,"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"status\": \"ok\",\n  \"output\": [\n    {\n      \"kind\": \"llm.invoke\",\n      \"runId\": null,\n      \"prompt\": null,\n      \"model\": null,\n      \"schemaVersion\": \"v1\",\n      \"status\": \"completed\",\n      \"cacheKey\": \"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c\",\n      \"artifactHashes\": [],\n      \"output\": {\n        \"format\": \"json\",\n        \"text\": \"{\\\"answeredBy\\\":\\\"other\\\"}\",\n        \"data\": {\n          \"answeredBy\": \"other\"\n        }\n      },\n      \"usage\": null,\n      \"metadata\": null,\n      \"warnings\": null,\n      \"diagnostics\": null,\n      \"createdAt\": \"2026-10-04T02:20:40.798Z\",\n      \"source\": \"openclaw-embedded\",\n      \"cached\": true,\n      \"attemptCount\": 1\n    }\n  ],\n  \"requiresApproval\": null\n}"}],"details":{"ok":true,"status":"ok","output":[{"kind":"llm.invoke","runId":null,"prompt":null,"model":null,"schemaVersion":"v1","status":"completed","cacheKey":"e93886ea571a4aef387e57acbfc86197913fc85aa4ba65b2ef8710bbd95aa59c","artifactHashes":[],"output":{"format":"json","text":"{\"answeredBy\":\"other\"}","data":{"answeredBy":"other"}},"usage":null,"metadata":null,"warnings":null,"diagnostics":null,"createdAt":"2026-10-04T02:20:40.798Z","source":"openclaw-embedded","cached":true,"attemptCount":1}],"requiresApproval":null}}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:20:41.165+00:00 [agents/tool-policy] tool policy removed 36 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:20:41.168+00:00 [plugins] lobster plugin runtime=2026.9.8
~~~

Counts before

~~~json
{"host":2,"stub":2}
~~~

Counts after

~~~json
{"host":2,"stub":2}
~~~

State before

~~~text
lobster-state/approval_8ae4c522.json 107 bytes
lobster-state/approval_9485b82e.json 107 bytes
lobster-state/approval_de3c9f82.json 107 bytes
lobster-state/openclaw-llm-checkpoints/0545319de4bdedd60908f78e5f53776dee9f2fe9dbd68f6260c7fc50732989e0.json 25 bytes
lobster-state/openclaw-llm-checkpoints/48bd55bd577b994a7ae3ab5e24586999e53c84d7ea1d8c1d04e346bfae6d46ab.json 163 bytes
lobster-state/openclaw-llm-checkpoints/4d66eeb4172833d6cb5303b113d6f22e430ce179dedbccb7aea3eda1d7fbf7aa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/8c86807750e5dd126e4dc0b95562c511256a07cffb07905f302d2a77406579f4.json 163 bytes
lobster-state/openclaw-llm-checkpoints/a0bd9c904f0a4b4a378a20c8750750f6461e321b1443dc0757dbb993934d519a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/ce5c931be45ff49f2f657171fd52e730c7448b6caee7066f6ae3b44b5db61aa0.json 163 bytes
lobster-state/pipeline_resume_022de05b-40ff-486c-ab40-5b58a7d52ec6.json 381 bytes
lobster-state/pipeline_resume_adb643f3-a416-4738-ab8e-c2a157abdef8.json 1299 bytes
~~~

State after

~~~text
lobster-state/approval_8ae4c522.json 107 bytes
lobster-state/approval_9485b82e.json 107 bytes
lobster-state/approval_de3c9f82.json 107 bytes
lobster-state/openclaw-llm-checkpoints/48bd55bd577b994a7ae3ab5e24586999e53c84d7ea1d8c1d04e346bfae6d46ab.json 163 bytes
lobster-state/openclaw-llm-checkpoints/4d66eeb4172833d6cb5303b113d6f22e430ce179dedbccb7aea3eda1d7fbf7aa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/a0bd9c904f0a4b4a378a20c8750750f6461e321b1443dc0757dbb993934d519a.json 25 bytes
lobster-state/openclaw-llm-checkpoints/ce5c931be45ff49f2f657171fd52e730c7448b6caee7066f6ae3b44b5db61aa0.json 163 bytes
lobster-state/pipeline_resume_022de05b-40ff-486c-ab40-5b58a7d52ec6.json 381 bytes
~~~

</details>

<details>
<summary>Unpatched parent 134946619f2c: administrator resumes its own checkpoint after the bypass (fails)</summary>

Request

~~~json
{
  "tool": "lobster",
  "args": {
    "approve": true,
    "action": "resume",
    "token": "eyJwcm90b2NvbFZlcnNpb24iOjEsInYiOjEsImtpbmQiOiJwaXBlbGluZS1yZXN1bWUiLCJzdGF0ZUtleSI6InBpcGVsaW5lX3Jlc3VtZV8wMDMxMzc0My02NTlkLTRlYmQtYWY4ZS04ZjVhNjhlOGExNDUifQ"
  },
  "sessionKey": "main",
  "agentId": "main"
}
~~~

Request headers

~~~json
{
  "x-forwarded-user": "admin@proof.test",
  "x-forwarded-for": "203.0.113.7",
  "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
}
~~~

HTTP status

~~~text
500
~~~

Response

~~~text
{"ok":false,"error":{"type":"tool_error","message":"tool execution failed"}}
~~~

Gateway log during the call

~~~text
2026-10-04T02:20:39.911+00:00 [agents/tool-policy] tool policy removed 37 tool(s) via agents.main.tools.allow: agents_list, agents_wait, ask_user, automations, computer, conversations_list, conversations_send, conversations_turn, create_goal, dashboard, gateway, get_goal, message, mobile_ui, nodes, openclaw, personal_instructions, plugins, portal, presence, secrets, session_status, sessions, sessions_history, sessions_list, sessions_search, sessions_send, sessions_spawn, sessions_yield, skill_workshop, subagents, terminal, theme, tts, update_goal, web_fetch, web_search
2026-10-04T02:20:39.914+00:00 [plugins] lobster plugin runtime=2026.9.8
2026-10-04T02:20:39.923+00:00 [tools-invoke] tool execution failed: Error: Pipeline resume state not found
2026-10-04T02:20:40.067+00:00 [scheduler] running startup:handler-prewarm
~~~

Counts before

~~~json
{"host":1,"stub":1}
~~~

Counts after

~~~json
{"host":1,"stub":1}
~~~

State before

~~~text
lobster-state/approval_de3c9f82.json 107 bytes
lobster-state/openclaw-llm-checkpoints/4d66eeb4172833d6cb5303b113d6f22e430ce179dedbccb7aea3eda1d7fbf7aa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/ce5c931be45ff49f2f657171fd52e730c7448b6caee7066f6ae3b44b5db61aa0.json 163 bytes
~~~

State after

~~~text
lobster-state/approval_de3c9f82.json 107 bytes
lobster-state/openclaw-llm-checkpoints/4d66eeb4172833d6cb5303b113d6f22e430ce179dedbccb7aea3eda1d7fbf7aa.json 163 bytes
lobster-state/openclaw-llm-checkpoints/ce5c931be45ff49f2f657171fd52e730c7448b6caee7066f6ae3b44b5db61aa0.json 163 bytes
~~~

</details>

## Regression and static checks

The repaired branch CI run failed three selected legs plus the Windows shard. One failing leg belonged to this change; two were upstream regressions that newest main already fixed; the Windows shard failure is unrelated to this change and could not be re-run by us.

- check:coercion-helpers (this change). The checkpoint files declared a local isRecord, which the coercion-helper guard bans. f61bb808cd1 imports the shared helper from openclaw/plugin-sdk/string-coerce-runtime instead. Reproduced red against the pre-fix files, exit 1:

~~~text
$ pnpm check:coercion-helpers
Banned local coercion-helper declarations:
- extensions/lobster/src/lobster-checkpoint-provenance.ts:48 isRecord (function declaration)
- extensions/lobster/src/lobster-runner.ts:238 isRecord (function declaration)
[check:coercion-helpers] FAILED (exit 1)
~~~

Green at this head, exit 0:

~~~text
$ pnpm check:coercion-helpers
Coercion helper declaration guard passed (112 allowlisted declarations).
~~~

- check:test-mock-exports (this change, fixed by 56d5b508751). The gateway-scope test mocked openclaw/plugin-sdk/plugin-runtime without preserving its real exports. Reproduced red, exit 1:

~~~text
$ pnpm check:test-mock-exports --base 2e76e316c286b32d14581e7ad3480e1ec49253d7
First-party mock factories must preserve real exports or explain isolation:
  extensions/lobster/src/lobster-gateway-scope.test.ts:10: openclaw/plugin-sdk/plugin-runtime
[ELIFECYCLE] Command failed with exit code 1.
~~~

Green at this head, exit 0: "Mock factory ratchet OK: 10858 grandfathered factories."

- checks-fast-baseline-ratchets (upstream, cleared by newest main). The failure was an ENOBUFS reading a large ratchet baseline through an execFileSync pipe. Upstream already fixes that read (06131c40d09 and 58310ca1471 read the baseline through an open file descriptor). After the merge of upstream/main 2e76e316c286b32d14581e7ad3480e1ec49253d7 the leg passes, exit 0. No repair from this change is carried for it.

- checks-node-compact-small-2 (upstream, cleared by newest main). test/scripts/type-suppression-inventory.test.ts failed against the old base. With newest main it passes 4 of 4, exit 0. No repair from this change is carried for it.

- checks-windows shard (unrelated to this change, not re-run by us). test/scripts/write-unified-entry-dts.test.ts failed on the Windows shard with ERR_MODULE_NOT_FOUND for a generated format-duration-internal.js. That generated file is produced by the build for a different subsystem and is not touched by this change, which alters only the lobster plugin and its tests. We cannot re-run the Windows shard because we lack administrative rights on the repository, so the re-test triggered by the fresh push is the retry for this leg.

No upstream file is repaired by this branch: the two upstream legs were cleared by the merge of newest main, not by any change of ours.

All gates re-run green at 9935db1aad19c2da254801c96d2f1116ccc91498 against base 2e76e316c286b32d14581e7ad3480e1ec49253d7: guards (coercion-helpers, import-cycles, dup:check, no-conflict-markers); ratchets (max-lines, line-cap, assertion-safety, database-worker, test-timeout-race, test-mock-exports); config:docs:check; plugins:inventory:check; and test/scripts/type-suppression-inventory.test.ts. The truth file records each command and its exit code.

The checkpoint re-authorization was reproduced red against the pre-fix sources (the writer equivalent-token and conflicting-handle resumes returned HTTP 200 and consumed the administrator saved output), then green at this head (both refused, with the administrator own resume still served).
