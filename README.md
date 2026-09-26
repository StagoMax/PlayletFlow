# Videoflow AgentRuntime foundation

This repository is the minimal browser-visible integration of OpenTopia's
`AgentTurnDriver`. It currently provides model conversation, a harmless tool
round-trip, persisted messages/events, cursor-based history loading, and SSE.
Story workflow logic is intentionally outside this runtime boundary.

## Product workspace documentation

The planned storyboard workspace is specified separately from the current
runtime foundation. Start with the [documentation index](docs/README.md), then
read the [product requirements](docs/product-requirements.md), the
[product API contract](docs/product-api.md), and the
[module and multi-agent delivery plan](docs/modules-and-agent-plan.md).

## Run locally

Prerequisites: Rust, Node.js, and pnpm. Cargo downloads the pinned public
OpenTopia commit used by `server/Cargo.toml`.

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
server in memory. This optional development bridge assumes a sibling OpenTopia
checkout. For example, from this repository:

```powershell
& ..\OpenTopia\node_modules\electron\dist\electron.exe .\scripts\run-with-opentopia-key.cjs '--provider=YOUR_PROVIDER_ID' --smoke
```

Omit `--smoke` to start the API. This bridge is for the local development
machine only; a deployed service needs its own server-side secret management.

The local server binds to loopback. The Vercel adapter uses a separate stateless
turn API; the browser never receives provider keys. See
[the API handoff](docs/runtime-api.md).

## Deploy to Vercel

`vercel.json` deploys the Vite frontend and a Rust container service on one
domain. The container runs OpenTopia `AgentCore` and `AgentTurnDriver` for each
request. It does not depend on a persistent server process or local SQLite.

1. Log in with `vercel login`, then run `vercel link` from the repository root.
2. Add production environment variables to the Vercel project:
   `OPENTOPIA_OPENAI_BASE_URL`, `OPENTOPIA_MODEL`, `OPENTOPIA_API_KEY`, and
   `PORT=3000`.
   Keep the API key in Vercel's server-side environment settings, never in a
   `VITE_` variable or Git.
3. Run `vercel deploy --prod` from the repository root.
4. Verify `/health`, then send a message and ask the model to call
   `runtime_probe` in the deployed page.

The public demo saves each visitor's threads and event history in that
browser's local storage. Refresh works; cross-device sync and account recovery
need a database in a later iteration. The API accepts at most 2,000 characters
and 40 messages of history per turn. It has a small per-instance rate limiter;
configure a Vercel Firewall rate rule and a model-provider spending cap for a
long-running public deployment. The response currently arrives after the
model turn completes, while the page shows a working state. Local development
still uses SQLite and SSE.

## Boundaries

- `server/src/runtime.rs` owns OpenTopia AgentCore composition and the explicit
  tool registry. Product-specific tools can be registered here later.
- `server/src/conversation.rs` owns persistence, event publication, and one
  active turn per conversation.
- `server/src/history.rs` restores provider-neutral tool calls and results from
  canonical events for later turns.
- `server/src/api.rs` is the browser contract. Workflow agents can call these
  endpoints without importing OpenTopia internals.
- `web/src/conversationStore.ts` borrows OpenTopia's bounded history, event
  batching, and reconnect concepts while keeping a small browser-only surface.

## Current boundaries

The tool registry contains only `runtime_probe`. Account-based sync, approval
resume, cancellation, model settings UI, and media generation are not
implemented. Prior user/assistant text is included in each new turn along with
structured tool calls and results. Long conversations still need context
budgeting and compaction before production use.
