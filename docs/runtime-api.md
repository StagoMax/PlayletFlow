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
| GET | `/health` | Runtime health. |
| GET | `/api/threads` | List conversations. |
| POST | `/api/threads` | Create conversation. Body: `{ "title": "..." }`. |
| GET | `/api/threads/:id/messages?limit=61` | Latest visible messages. Use `beforeCreatedAt` and `beforeId` to page backward. |
| POST | `/api/threads/:id/messages` | Start a turn. Body: `{ "content": "..." }`. Returns `202` with `{ message, turnId }`. |
| GET | `/api/threads/:id/events?limit=250` | Latest compact events. `since` catches up; `before` pages backward. |
| GET | `/api/threads/:id/events/stream?since=N` | SSE. Events have durable `seq` IDs and replay after `since` or `Last-Event-ID`. |
| GET | `/api/threads/:id/events/:eventId/tool-result` | Full result, fetched only when expanded. |

Messages use OpenTopia's `Message` JSON shape. Events use its `AgentEvent`
shape: `{ id, threadId, turnId, seq, createdAt, payload }`. `payload.type`
is snake_case; the runtime web client handles `turn_started`, `model_delta`,
`tool_call_started`, `tool_call_finished`, `assistant_message`, `turn_finished`,
and `error`.

The server commits an event before broadcasting it. History reads use bounded
pages; tool results in conversation pages contain compact previews, while the
detail endpoint reads the canonical result. The browser batches stream events
for 32 ms and loads older history on demand.

## Future workflow integration

Supply trusted project context as `CompiledModelContext`, and register
project-scoped tools through `ToolRegistry`. The server must derive tool scope
from authenticated project membership, not from model arguments. Do not add
story workflow routes or prompts to `server/src/runtime.rs`.
