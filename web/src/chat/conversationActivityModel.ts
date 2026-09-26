import type { AgentEvent, ToolCall, ToolResult } from "../types";

export type ToolActivity = {
  call: ToolCall;
  started: AgentEvent;
  finished?: AgentEvent;
  result?: ToolResult;
};

export type ToolActivityGroup = {
  key: string;
  round: number;
  tools: ToolActivity[];
};

export type RuntimePhase = {
  label: string;
  detail?: string;
  tone: "running" | "complete" | "cancelled" | "error";
};

export type TurnActivityProjection = {
  active: boolean;
  commentary: string;
  reasoning: string;
  liveAnswer: string;
  phase: RuntimePhase;
  startedAt: number;
  endedAt?: number;
  toolGroups: ToolActivityGroup[];
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
  const toolGroups = projectToolGroups(ordered);
  const reasoning = joinDeltas(ordered, "reasoning_delta");
  const { commentary, liveAnswer } = projectModelText(ordered, Boolean(finished), Boolean(cancelled || error));

  return {
    active,
    commentary,
    reasoning,
    liveAnswer,
    phase: projectPhase(ordered, { cancelling, error, cancelled, finished }),
    startedAt,
    endedAt,
    toolGroups,
  };
}

function projectToolGroups(events: AgentEvent[]) {
  const results = new Map<string, { event: AgentEvent; result: ToolResult }>();
  for (const event of events) {
    if (event.payload.type !== "tool_call_finished") continue;
    const result = event.payload.result as ToolResult | undefined;
    if (result?.callId) results.set(result.callId, { event, result });
  }

  let round = 0;
  const groups = new Map<number, ToolActivityGroup>();
  for (const event of events) {
    if (event.payload.type === "model_request") {
      round = Number(event.payload.round ?? round + 1);
      continue;
    }
    if (event.payload.type !== "tool_call_started") continue;
    const call = event.payload.call as ToolCall | undefined;
    if (!call?.id) continue;
    const completion = results.get(call.id);
    const group = groups.get(round) ?? { key: `round-${round}`, round, tools: [] };
    group.tools.push({ call, started: event, finished: completion?.event, result: completion?.result });
    groups.set(round, group);
  }
  return [...groups.values()];
}

function projectModelText(events: AgentEvent[], completed: boolean, interrupted: boolean) {
  const deltas = events.filter((event) => event.payload.type === "model_delta");
  if (!deltas.length) return { commentary: "", liveAnswer: "" };

  const rounds = deltas.map((event) => {
    const attempt = event.payload.provider_attempt as { round?: number } | undefined;
    return attempt?.round;
  });
  const numericRounds = rounds.filter((round): round is number => typeof round === "number");
  const latestRound = numericRounds.length ? Math.max(...numericRounds) : undefined;
  const lastToolSeq = events.reduce(
    (latest, event) => event.payload.type.startsWith("tool_call_") ? Math.max(latest, event.seq) : latest,
    -1,
  );
  const commentary: string[] = [];
  const answer: string[] = [];

  deltas.forEach((event, index) => {
    const text = String(event.payload.text ?? "");
    const isFinalRound = latestRound !== undefined
      ? rounds[index] === latestRound
      : lastToolSeq < 0 || event.seq > lastToolSeq;
    (isFinalRound ? answer : commentary).push(text);
  });

  return {
    commentary: commentary.join(""),
    liveAnswer: completed && !interrupted ? "" : answer.join(""),
  };
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

function joinDeltas(events: AgentEvent[], type: string) {
  return events
    .filter((event) => event.payload.type === type)
    .map((event) => String(event.payload.text ?? ""))
    .join("");
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
