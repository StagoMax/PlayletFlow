import type { AgentEvent, Message, ToolCall, ToolResult } from "../types";
import { toolPresentation, type ToolGroupKind } from "./toolActivityPresentation";

export type ToolActivity = {
  call: ToolCall;
  started: AgentEvent;
  finished?: AgentEvent;
  result?: ToolResult;
};

export type ToolActivityGroup = {
  key: string;
  kind: "tool-group";
  group: ToolGroupKind;
  tools: ToolActivity[];
};

export type ActivityTextEntry = {
  key: string;
  kind: "commentary" | "reasoning";
  text: string;
};

export type ActivityEntry = ActivityTextEntry | ToolActivityGroup;

export type RuntimePhase = {
  label: string;
  detail?: string;
  tone: "running" | "complete" | "cancelled" | "error";
};

export type TurnActivityProjection = {
  active: boolean;
  entries: ActivityEntry[];
  liveAnswer: string;
  phase: RuntimePhase;
  startedAt: number;
  endedAt?: number;
};

const providerEventTypes = new Set([
  "provider_request_sent",
  "provider_request_retried",
  "provider_response_headers_received",
  "provider_first_token_received",
  "provider_stream_progress",
  "provider_response_commit_started",
  "provider_response_received",
]);

export function projectTurnActivity(events: AgentEvent[], cancelling = false): TurnActivityProjection {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const error = lastWhere(ordered, (event) => event.payload.type === "error");
  const cancelled = lastWhere(ordered, (event) => event.payload.type === "turn_cancelled");
  const finished = lastWhere(ordered, (event) => event.payload.type === "turn_finished");
  const terminal = error ?? cancelled ?? finished;
  const active = !terminal;
  const startedAt = eventTime(ordered[0]) ?? Date.now();
  const endedAt = eventTime(terminal);
  const finalAnswerDeltas = findFinalAnswerDeltas(ordered);
  const liveAnswerDeltas = findLiveAnswerDeltas(ordered, finalAnswerDeltas);
  const entries = projectActivityEntries(ordered, finalAnswerDeltas, liveAnswerDeltas);
  const liveAnswer = ordered
    .filter((event) => liveAnswerDeltas.has(event.seq))
    .map((event) => String(event.payload.text ?? ""))
    .join("");

  return {
    active,
    entries,
    liveAnswer,
    phase: projectPhase(ordered, { cancelling, error, cancelled, finished }),
    startedAt,
    endedAt,
  };
}

function projectActivityEntries(
  events: AgentEvent[],
  finalAnswerDeltas: Set<number>,
  liveAnswerDeltas: Set<number>,
): ActivityEntry[] {
  const results = new Map<string, { event: AgentEvent; result: ToolResult }>();
  for (const event of events) {
    if (event.payload.type !== "tool_call_finished") continue;
    const result = event.payload.result as ToolResult | undefined;
    if (result?.callId) results.set(result.callId, { event, result });
  }

  const startedCallIds = new Set<string>();
  const primitives: Array<ActivityTextEntry & { seq: number } | { kind: "tool"; seq: number; tool: ToolActivity }> = [];
  for (const event of events) {
    if (event.payload.type === "reasoning_delta" || event.payload.type === "model_delta") {
      if (finalAnswerDeltas.has(event.seq) || liveAnswerDeltas.has(event.seq)) continue;
      const text = String(event.payload.text ?? "");
      if (text) primitives.push({
        key: event.id,
        kind: event.payload.type === "model_delta" ? "commentary" : "reasoning",
        seq: event.seq,
        text,
      });
    }
    if (event.payload.type !== "tool_call_started") continue;
    const call = event.payload.call as ToolCall | undefined;
    if (!call?.id) continue;
    startedCallIds.add(call.id);
    const completion = results.get(call.id);
    primitives.push({
      kind: "tool",
      seq: event.seq,
      tool: { call, started: event, finished: completion?.event, result: completion?.result },
    });
  }

  // A history window can contain a completion after its start fell off the page.
  for (const [callId, completion] of results) {
    if (startedCallIds.has(callId)) continue;
    const name = typeof completion.result.metadata?.toolName === "string"
      ? completion.result.metadata.toolName : "tool";
    primitives.push({
      kind: "tool",
      seq: completion.event.seq,
      tool: {
        call: { id: callId, name, input: {} },
        started: completion.event,
        finished: completion.event,
        result: completion.result,
      },
    });
  }

  primitives.sort((left, right) => left.seq - right.seq);
  const entries: ActivityEntry[] = [];
  for (const primitive of primitives) {
    const previous = entries.at(-1);
    if (primitive.kind === "tool") {
      const group = toolPresentation(primitive.tool.call).group;
      if (previous?.kind === "tool-group" && previous.group === group) {
        previous.tools.push(primitive.tool);
      } else {
        entries.push({ key: `tool-${primitive.seq}`, kind: "tool-group", group, tools: [primitive.tool] });
      }
    } else if (previous?.kind === primitive.kind) {
      previous.text += primitive.text;
    } else {
      entries.push({ key: primitive.key, kind: primitive.kind, text: primitive.text });
    }
  }
  return entries;
}

/** Match only the streamed text that became the persisted final answer. */
function findFinalAnswerDeltas(events: AgentEvent[]): Set<number> {
  const assistantIndex = events.findLastIndex((event) => event.payload.type === "assistant_message");
  if (assistantIndex < 0) return new Set();
  const message = events[assistantIndex].payload.message as Message | undefined;
  const finalText = message?.parts
    ?.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : [])
    .join("") ?? "";
  if (!finalText) return new Set();

  let requestIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index--) {
    if (events[index].payload.type === "model_request") {
      requestIndex = index;
      break;
    }
  }
  if (requestIndex < 0) return new Set();

  let remaining = finalText;
  const matched = new Set<number>();
  for (const event of events.slice(requestIndex + 1, assistantIndex)) {
    if (event.payload.type !== "model_delta") continue;
    const text = String(event.payload.text ?? "");
    if (!remaining.startsWith(text)) return new Set();
    remaining = remaining.slice(text.length);
    matched.add(event.seq);
    if (!remaining) return matched;
  }
  return new Set();
}

function findLiveAnswerDeltas(events: AgentEvent[], finalAnswerDeltas: Set<number>): Set<number> {
  if (events.some((event) => event.payload.type === "assistant_message")) return new Set();
  const lastToolSeq = events.reduce(
    (latest, event) => event.payload.type.startsWith("tool_call_") ? Math.max(latest, event.seq) : latest,
    -1,
  );
  const lastRequestSeq = lastWhere(events, (event) => event.payload.type === "model_request")?.seq ?? -1;
  const boundary = Math.max(lastToolSeq, lastRequestSeq);
  return new Set(events
    .filter((event) => event.payload.type === "model_delta" && event.seq > boundary && !finalAnswerDeltas.has(event.seq))
    .map((event) => event.seq));
}

function projectPhase(
  events: AgentEvent[],
  terminal: {
    cancelling: boolean;
    error?: AgentEvent;
    cancelled?: AgentEvent;
    finished?: AgentEvent;
  },
): RuntimePhase {
  if (terminal.error) {
    return { label: "运行失败", detail: String(terminal.error.payload.message ?? "请重试"), tone: "error" };
  }
  if (terminal.cancelled) {
    return { label: "已停止", detail: "保留停止前已经生成的内容", tone: "cancelled" };
  }
  if (terminal.finished) return { label: "已完成", tone: "complete" };
  if (terminal.cancelling) return { label: "正在停止", detail: "等待当前操作安全结束", tone: "cancelled" };

  const runningTool = findRunningTool(events);
  if (runningTool) return { label: "正在执行工具", detail: runningTool.name, tone: "running" };

  const provider = lastWhere(events, (event) => providerEventTypes.has(event.payload.type));
  if (provider) {
    const request = lastWhere(
      events,
      (event) => event.seq <= provider.seq && event.payload.type === "model_request",
    );
    return providerPhase(provider, positiveNumber(request?.payload.round));
  }
  if (events.some((event) => event.payload.type === "model_request")) {
    const request = lastWhere(events, (event) => event.payload.type === "model_request")!;
    return {
      label: "正在请求模型",
      detail: `第 ${positiveNumber(request.payload.round) ?? 1} 轮`,
      tone: "running",
    };
  }
  return { label: "正在准备上下文", detail: "Turn 已启动", tone: "running" };
}

function providerPhase(event: AgentEvent, fallbackRound?: number): RuntimePhase {
  const attempt = positiveNumber(event.payload.attempt) ?? 1;
  const round = positiveNumber(event.payload.round) ?? fallbackRound;
  const roundLabel = round ? `第 ${round} 轮` : "模型请求";
  const retryLabel = attempt > 1 ? ` · 第 ${attempt} 次尝试` : "";
  switch (event.payload.type) {
    case "provider_request_sent":
      return { label: "已发送至 Provider", detail: `${String(event.payload.adapter ?? "模型服务")} · ${roundLabel}${retryLabel}`, tone: "running" };
    case "provider_request_retried":
      return { label: "Provider 正在重试", detail: `${roundLabel} · ${String(event.payload.reason ?? `第 ${attempt} 次尝试`)}`, tone: "running" };
    case "provider_response_headers_received":
      return { label: "Provider 已响应", detail: `${roundLabel} · HTTP ${String(event.payload.status ?? "—")}`, tone: "running" };
    case "provider_first_token_received":
      return { label: "Provider 开始生成", detail: `${roundLabel} · 正在接收首批内容`, tone: "running" };
    case "provider_stream_progress": {
      const bytes = Number(event.payload.output_bytes ?? 0);
      return { label: "Provider 正在生成", detail: `${roundLabel} · ${formatBytes(bytes)} · ${formatDuration(Number(event.payload.elapsed_ms ?? 0))}`, tone: "running" };
    }
    case "provider_response_commit_started":
      return { label: "正在整理响应", detail: `${roundLabel} · Provider 输出已接收`, tone: "running" };
    case "provider_response_received":
      return { label: "Provider 响应完成", detail: `${roundLabel}${event.payload.status ? ` · HTTP ${String(event.payload.status)}` : ""}`, tone: "running" };
    default:
      return { label: "模型正在处理", tone: "running" };
  }
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function findRunningTool(events: AgentEvent[]) {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.payload.type === "tool_call_finished") {
      const result = event.payload.result as ToolResult | undefined;
      if (result?.callId) completed.add(result.callId);
    }
  }
  return lastWhere(
    events
    .filter((event) => event.payload.type === "tool_call_started")
    .map((event) => event.payload.call as ToolCall),
    (call) => Boolean(call?.id && !completed.has(call.id)),
  );
}

export function eventTime(event?: AgentEvent) {
  if (!event) return undefined;
  const value = Date.parse(event.createdAt);
  return Number.isFinite(value) ? value : undefined;
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  return `${(bytes / 1_024).toFixed(1)} KB`;
}

function lastWhere<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}
