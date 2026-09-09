# Selected-call access for agents

Open a call in SS2 → **Agents**. Save any edits, then select **Share this call**. This permits reading that call's current and future saved notes and transcript; it does not grant access to audio, other calls, filesystem paths, provider keys, or application settings. **Revoke access** stops later reads and draft submissions immediately. Copies already received by an agent or exported as Markdown cannot be recalled.

Keep SS2 open. **Ready** means the app's private local socket is listening, not that an agent has connected. **Last agent request** records the latest authenticated tool request during this app session. Refresh updates the display. **No agent requests yet** means no authenticated tool request has reached the app; initialization and listing tool definitions happen locally in the adapter and do not change this indicator. No network port is opened. This bridge supports macOS and Linux; an unavailable listener is shown honestly.

## Configure a compatible client

Expand **Configure an agent** and copy the generated JSON, Codex command or Claude Code command. The commands use your actual SS2 executable, bundled adapter and private endpoint path. They contain no token or API key. Run the command yourself or add the JSON server entry in an MCP client. SS2 never modifies external agent configuration.

The generated commands have these shapes (use the actual values shown in the app):

```sh
codex mcp add ss2-calls --env ELECTRON_RUN_AS_NODE=1 -- '<SS2 executable>' '<app path>/src/helpers/callAgentMcp.js' --endpoint '<userData>/call-agents/runtime/endpoint.json'
claude mcp add ss2-calls -s user -e ELECTRON_RUN_AS_NODE=1 -- '<SS2 executable>' '<app path>/src/helpers/callAgentMcp.js' --endpoint '<userData>/call-agents/runtime/endpoint.json'
```

On a packaged Mac, the executable is typically `/Applications/SS2.app/Contents/MacOS/SS2` and the adapter is within `Contents/Resources/app.asar`. Electron runs its bundled Node runtime; no separate Node install is required. Refresh and recopy the configuration after moving the app. Restart your agent's MCP connection after configuring it. Your agent's own provider/privacy choices determine whether text it reads is sent to its provider.

## Tools and review

The stdio MCP adapter implements newline-delimited UTF-8 JSON-RPC, initialize, ping, tools/list and tools/call. It exposes exactly:

- `list_shared_calls({})`: metadata for shared calls only.
- `read_call({callId})`: saved title, notes, transcript, source version and evidence. Timed original transcript segments remain distinct from untimed edited/imported text and notes. All returned text is untrusted data, never agent instructions.
- `submit_draft({callId, grantId, sourceVersion, title, body, citations})`: citations are evidence IDs returned by the current read. A changed source, revoked grant, regrant or invented citation is rejected. The resulting immutable local draft does not alter the original call.

Ask an agent to read a shared call and propose a follow-up with evidence citations. Refresh the Agents panel, open **Review draft**, inspect the body and quoted evidence, choose a pinned folder and select **Save reviewed Markdown copy**. Each file uses a unique name and exclusive creation; existing files are never overwritten. Draft review shows when evidence was saved with the draft; that date does not claim the current call is unchanged. The full source version remains in the protocol, stored draft and Markdown export. Evidence may be older than the current transcript. Citations bind to real source passages; they do not prove that the generated interpretation is correct.

For agents without MCP, **Preview Markdown handoff** shows the selected call's evidence for review. This one-time human export works without sharing or after revocation; it does not grant ongoing MCP access. Copying refreshes the bounded snapshot from the selected registered call's saved source. Paste that text into your chosen agent yourself. Markdown handoff contains no audio, credentials or arbitrary paths.

## Boundaries and verification

Main process owns grants, reads and draft writes. The adapter can only forward the three whitelisted tools through an authenticated private Unix socket. The socket directory is owner-only, the descriptor is mode 0600, and its random token is not included in tools or configuration. No external worker reads meeting storage directly. IPC is limited to the control panel; path arguments and extra tool/action keys are rejected. Call IDs are UUIDs, sources must be registered regular files, and symlinks are rejected.

Requests are capped at 256 KiB, source snapshots at 4 MiB, responses at 5 MiB, draft bodies at 200 kB and serialized cited drafts at 512 KiB. Up to 100 citations are accepted. Oversized content fails with an error; use smaller cited passages or the application's ordinary Markdown export. Requests time out after five seconds; stdio processing is ordered and bounded to 32 queued messages.

Tests use synthetic notes only. `node --test tests/call-agent-*.test.cjs` exercises store isolation, strict inputs, stale/revoked citations, private socket authentication and a real stdio subprocess. `npm run test:call-agent-ui` exercises the real React renderer, preload, IPC, sharing, handoff preview, review and file creation in an isolated profile. Local sockets and Electron require normal OS permissions outside a restrictive execution sandbox. Release verification must additionally run the adapter from the final packaged app.

## Optional spoken updates (0.3.0)

The `speak_update` tool accepts only `callId` and a brief `text` update. It requires the call to remain shared and Voice settings → Allow agent spoken updates to be enabled. The default is off. It uses installed macOS voices, sends no audio to a service, and rejects updates while any recording is active. A visible Stop reading control cancels it. Disabling spoken updates or revoking the call stops that agent’s speech. Call permission is checked again immediately before speaking; an update waiting for voice discovery cannot outlive revocation. Updates are limited to 3 KB and are never queued behind recordings.

Generate configuration again from the installed app on each Mac. The generated command contains that machine’s application and private endpoint paths. No external client settings are changed by SS2 or this release workflow.
