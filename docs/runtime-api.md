# AgentRuntime API handoff

The browser contract is intentionally independent of any story workflow.
Another agent may build workflow pages and call these routes without changing
the runtime's model/tool loop.

The runtime seam for parallel work is `ConversationService`: it accepts a
`ModelProvider` and `ToolRegistry`. Workflow agents should add their own
project context and scoped tools at that composition boundary, while web agents
use the HTTP contract below. Do not make the browser import `opentopia-core`.

## Endpoints

| Method | Path | Use |
| --- | --- | --- |
| GET | `/health` | Runtime health and the active, non-secret `model` identifier shown by the conversation UI. |
| GET | `/api/threads` | List conversations. |
| POST | `/api/threads` | Create conversation. Body: `{ "title": "..." }`. |
| GET | `/api/threads/:id/messages?limit=61` | Latest visible messages. Use `beforeCreatedAt` and `beforeId` to page backward. |
| POST | `/api/threads/:id/messages` | Start a turn. Body: `{ "content": "..." }`. Returns `202` with `{ message, turnId }`. |
| POST | `/api/threads/:id/turn/cancel` | Cancel the active turn at a runtime safe point. Optional body: `{ "turnId": "..." }`. |
| GET | `/api/threads/:id/events?limit=250` | Latest compact events. `since` catches up; `before` pages backward. |
| GET | `/api/threads/:id/events/stream?since=N` | SSE. Events have durable `seq` IDs and replay after `since` or `Last-Event-ID`. |
| GET | `/api/threads/:id/events/:eventId/tool-result` | Full result, fetched only when expanded. |

Messages use OpenTopia's `Message` JSON shape. Events use its `AgentEvent`
shape: `{ id, threadId, turnId, seq, createdAt, payload }`. `payload.type`
is snake_case. The runtime web client handles turn lifecycle, `model_request`,
the `provider_*` request/stream/response phases, `model_delta`,
`reasoning_delta`, grouped tool activity, `assistant_message`, token usage,
`turn_cancelled`, `turn_finished`, and `error`. Provider request and response
bodies are removed at the shared conversation-event projection boundary; only
the metadata needed for status UI is persisted or streamed.

The server commits an event before broadcasting it. History reads use bounded
pages; tool results in conversation pages contain compact previews, while the
detail endpoint reads the canonical result. The browser batches stream events
for 32 ms and loads older history on demand.
The next model turn reads canonical events to rebuild structured tool calls and
results with their original provider call IDs; display previews are not used as
model context.

The stateless cloud adapter exposes `POST /api/turn` with
`Accept: text/event-stream`. It emits `started`, then the same named
`AgentEvent` frames used by the local session (including provider phases,
reasoning, model deltas, tool activity, cancellation, and completion), followed by a final
`result` snapshot. The browser applies each frame immediately and deduplicates
the final snapshot by event ID, so cloud and local transports share the same
continuous-conversation interaction state.

## Product workflow integration

Supply trusted project context as `CompiledModelContext`, and register
project-scoped tools through `ToolRegistry`. The server must derive tool scope
from authenticated project membership, not from model arguments. Do not add
story workflow routes or prompts to `server/src/runtime.rs`.

The local composition registers `propose_script_change` and
`propose_media_prompt_change`. Both read the Runtime-owned `threadId` and
`turnId`, resolve `workspace_thread_bindings`, and pass that trusted scope to
`ProposalService`; neither schema accepts `projectId` or `storyboardId`.
Successful execution means only that a pending proposal was persisted. Formal
content still changes exclusively through the user-confirmation API.
