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

1. Set `OPENTOPIA_API_KEY` to a DeepSeek API key in the server process
   environment. The right-side AI conversation defaults to DeepSeek's
   OpenAI-compatible endpoint (`https://api.deepseek.com`) and
   `deepseek-flash`; `OPENTOPIA_OPENAI_BASE_URL` and `OPENTOPIA_MODEL` remain
   available as explicit overrides. The key must remain server-side. Image and
   video generation keep their separate Ark configuration. The local product
   schema uses `VIDEOFLOW_PRODUCT_DB`, defaulting to
   `.videoflow/product.sqlite`.
2. In `server/`, run `cargo run`.
3. In `web/`, run `pnpm install` and `pnpm dev`.
4. Open `http://127.0.0.1:5173`.

To enable media regeneration after a confirmed AI proposal or a direct prompt edit, set the
server-only `ARK_API_KEY`. The local server submits Seedream images,
polls Seedance videos, and persists provider results before their temporary
URLs expire. The confirmation contract supports a server-approved model choice,
optional first/last frames, and optional reference keyframes. See
[the Volcengine generation integration](docs/volcengine-generation.md).

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
To copy the selected provider key from OpenTopia's encrypted local store into
the linked Vercel project's Production environment without printing or writing
the plaintext key, use `--sync-vercel-production` instead of `--smoke`.

The local server binds to loopback. The Vercel adapter uses a separate stateless
turn API; the browser never receives provider keys. See
[the API handoff](docs/runtime-api.md).

## Deploy to Vercel

`vercel.json` deploys the Vite frontend and a Rust container service on one
domain. The container runs OpenTopia `AgentCore` and `AgentTurnDriver` for each
request. It does not depend on a persistent server process or local SQLite.

1. Log in with `vercel login`, then run `vercel link` from the repository root.
2. Add `OPENTOPIA_API_KEY` and `PORT=3000` to the Vercel project. The
   conversation endpoint and model use the DeepSeek defaults above; set
   `OPENTOPIA_OPENAI_BASE_URL` or `OPENTOPIA_MODEL` only when intentionally
   overriding them.
   Keep the API key in Vercel's server-side environment settings, never in a
   `VITE_` variable or Git.
3. To enable the lightweight Seedream/Seedance demo, also add `ARK_API_KEY`
   and the server-only `TOS_*` variables shown in `.env.example`. Bootstrap the
   private bucket once with `cargo run --manifest-path server/Cargo.toml --
   --bootstrap-tos`. This request-driven mode stores job snapshots and media in
   TOS and needs neither ECS nor PostgreSQL; see
   [the generation guide](docs/volcengine-generation.md).
4. Run `vercel deploy --prod` from the repository root.
5. Verify `/health`, then send a message and ask the model to call
   `runtime_probe` in the deployed page.

The public demo saves each visitor's threads and event history in that
browser's local storage. Refresh works; cross-device sync and account recovery
need a database in a later iteration. The API accepts at most 2,000 characters
and 40 messages of history per turn. It has a small per-instance rate limiter;
configure a Vercel Firewall rate rule and a model-provider spending cap for a
long-running public deployment. The cloud response streams OpenTopia
`AgentEvent` frames as the turn runs and ends with a deduplicated `result`
snapshot. Local development uses the same interaction projection over SQLite
and a reconnectable SSE subscription.

## Boundaries

- `server/src/runtime.rs` owns OpenTopia AgentCore composition and the explicit
  tool registry. It remains product-agnostic; the composition root will register
  product tool adapters without moving product rules into this module.
- `server/src/product/` owns the storyboard product domain, application ports,
  product API mount point, and versioned SQLite schema.
- `server/src/conversation.rs` owns persistence, event publication, one
  cancellable active turn per conversation, and its runtime-safe stop signal.
- `server/src/conversation_events.rs` owns the shared durable/streaming event
  projection, including Provider lifecycle visibility and payload redaction.
- `server/src/history.rs` restores provider-neutral tool calls and results from
  canonical events for later turns.
- `server/src/api.rs` is the browser contract. Workflow agents can call these
  endpoints without importing OpenTopia internals.
- `web/src/conversationStore.ts` mirrors OpenTopia's session/controller split:
  bounded history and live events merge through one projection, while command
  sending and the active turn remain distinct interaction states.
- `docs/openapi.json` is the machine-readable product contract;
  `web/src/productApi/generated.ts` is generated from it and checked by builds.

## Current boundaries

The cloud demo tool registry contains only `runtime_probe`. Account-based sync
and durable cloud project editing are not implemented in the stateless
entrypoint. Image/video generation is available through a request-driven TOS
adapter: direct prompt confirmation supports selectable Seedream/Seedance
models and optional first/last frames or reference keyframes. The local product
API additionally includes durable SQLite proposal confirmation. Prior
user/assistant text is included in each new turn along with
structured tool calls and results. Long conversations still need context
budgeting and compaction before production use.
