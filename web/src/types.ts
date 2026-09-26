export type MessagePart = { type: "text"; text: string } | { type: string; [key: string]: unknown };

export type Message = {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: MessagePart[];
  createdAt: string;
};

export type Thread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentEvent = {
  id: string;
  threadId: string;
  turnId: string | null;
  seq: number;
  createdAt: string;
  payload: { type: string; [key: string]: unknown };
};

export type ToolCall = { id: string; name: string; input: unknown };
export type ToolResult = { callId: string; output: string; metadata: Record<string, unknown> };
