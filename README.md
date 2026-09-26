# Videoflow AgentRuntime foundation

This repository is the minimal browser-visible integration of OpenTopia's
`AgentTurnDriver`. It currently provides model conversation, a harmless tool
round-trip, persisted messages/events, cursor-based history loading, and SSE.
Story workflow logic is intentionally outside this runtime boundary.

## Run locally

Prerequisites: Rust, Node.js, pnpm, and a sibling checkout of OpenTopia at
`../OpenTopia` (the current path dependency in `server/Cargo.toml`).

1. Set the three `OPENTOPIA_*` model variables from `.env.example` in the
   server process environment. The API key must remain server-side.
2. In `server/`, run `cargo run`.
3. In `web/`, run `pnpm install` and `pnpm dev`.
4. Open `http://127.0.0.1:5173`.

For a command-line provider check, run `cargo run -- --smoke` in `server/`.
The `runtime_probe` tool has no side effects. Ask the model to call it with a
short `text` value to inspect the complete tool loop in the web page.
If provider credentials are unavailable, `cargo run -- --fixture` starts an
explicit local fixture provider for browser and persistence checks; its replies
do not demonstrate remote model access.

To reuse an OpenTopia Desktop provider during local development, set
`VIDEOFLOW_OPENTOPIA_DB` to its SQLite database and `VIDEOFLOW_PROVIDER_ID` to
the saved provider ID. The server reads that provider profile without modifying
the database; its `apiKeySource` must be present in the server environment.
On Windows, `scripts/run-with-opentopia-key.cjs` can launch the server through
OpenTopia's installed Electron binary and pass one encrypted Desktop key to the
server in memory. For example, from this repository:

```powershell
& ..\OpenTopia\node_modules\electron\dist\electron.exe .\scripts\run-with-opentopia-key.cjs '--provider=YOUR_PROVIDER_ID' --smoke
```

Omit `--smoke` to start the API. This bridge is for the local development
machine only; a deployed service needs its own server-side secret management.

The server deliberately binds to loopback. Before public deployment, a hosting
adapter must supply user authentication and project authorization; the browser
must never receive provider keys. See [the API handoff](docs/runtime-api.md).

## Boundaries

- `server/src/runtime.rs` owns OpenTopia AgentCore composition and the explicit
  tool registry. Product-specific tools can be registered here later.
- `server/src/conversation.rs` owns persistence, event publication, and one
  active turn per conversation.
- `server/src/api.rs` is the browser contract. Workflow agents can call these
  endpoints without importing OpenTopia internals.
- `web/src/conversationStore.ts` borrows OpenTopia's bounded history, event
  batching, and reconnect concepts while keeping a small browser-only surface.

## Current boundaries

The tool registry contains only `runtime_probe`. Multi-user authentication,
approval resume, cancellation, model settings UI, media generation, and public
deployment are not implemented. Prior user/assistant text is included in each
new turn; cross-turn structured tool transcript replay still needs to be wired
before relying on long tool-heavy conversations.
