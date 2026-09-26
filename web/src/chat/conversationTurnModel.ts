import type { AgentEvent, Message } from "../types";
import { workspaceReferenceFromPart } from "./workspaceReference";

export type ConversationTurn = {
  key: string;
  turnId: string | null;
  userMessage: Message | null;
  assistantMessages: Message[];
  events: AgentEvent[];
};

/**
 * Projects persisted messages and runtime events into the unit the UI actually
 * presents: one user request followed by its activity and assistant response.
 * Keeping this association outside React prevents streaming and final messages
 * from becoming two unrelated visual rows.
 */
export function projectConversationTurns(
  messages: Message[],
  events: AgentEvent[],
  activeTurnId: string | null,
  previous: ConversationTurn[] = [],
): ConversationTurn[] {
  const visibleMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const eventsByTurn = new Map<string, AgentEvent[]>();
  const turnByUserMessage = new Map<string, string>();
  const turnByAssistantMessage = new Map<string, string>();

  for (const event of orderedEvents) {
    if (event.turnId) {
      const turnEvents = eventsByTurn.get(event.turnId) ?? [];
      turnEvents.push(event);
      eventsByTurn.set(event.turnId, turnEvents);
    }
    if (event.payload.type === "turn_started" && event.turnId) {
      turnByUserMessage.set(String(event.payload.user_message_id), event.turnId);
    }
    if (event.payload.type === "assistant_message" && event.turnId) {
      const message = event.payload.message as Message | undefined;
      if (message?.id) turnByAssistantMessage.set(message.id, event.turnId);
    }
  }

  const turns: ConversationTurn[] = [];
  const turnById = new Map<string, ConversationTurn>();
  const lastUserMessage = [...visibleMessages].reverse().find((message) => message.role === "user");

  for (const message of visibleMessages) {
    if (message.role === "user") {
      let turnId = turnByUserMessage.get(message.id) ?? null;
      if (!turnId && activeTurnId && message.id === lastUserMessage?.id && !turnById.has(activeTurnId)) {
        // Catch-up pages can begin after turn_started. The active turn still
        // belongs to the latest unpaired user message in that bounded history.
        turnId = activeTurnId;
      }
      const turn: ConversationTurn = {
        key: turnId ?? `pending-${message.id}`,
        turnId,
        userMessage: message,
        assistantMessages: [],
        events: turnId ? (eventsByTurn.get(turnId) ?? []) : [],
      };
      turns.push(turn);
      if (turnId) turnById.set(turnId, turn);
      continue;
    }

    const turnId = turnByAssistantMessage.get(message.id) ?? null;
    const owner = turnId ? turnById.get(turnId) : undefined;
    if (owner) {
      owner.assistantMessages.push(message);
      continue;
    }

    const standalone: ConversationTurn = {
      key: turnId ? `orphan-${turnId}-${message.id}` : `assistant-${message.id}`,
      turnId,
      userMessage: null,
      assistantMessages: [message],
      events: turnId ? (eventsByTurn.get(turnId) ?? []) : [],
    };
    turns.push(standalone);
    if (turnId) turnById.set(turnId, standalone);
  }

  if (!previous.length) return turns;
  const previousByKey = new Map(previous.map((turn) => [turn.key, turn]));
  return turns.map((turn) => {
    const cached = previousByKey.get(turn.key);
    return cached && sameTurn(cached, turn) ? cached : turn;
  });
}

export function messageText(message: Message) {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export function messageClipboardText(message: Message) {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      const reference = workspaceReferenceFromPart(part);
      return reference ? [`[${reference.name}]`] : [];
    })
    .join("")
    .trim();
}

function sameTurn(left: ConversationTurn, right: ConversationTurn) {
  return left.turnId === right.turnId
    && left.userMessage === right.userMessage
    && sameItems(left.assistantMessages, right.assistantMessages)
    && sameItems(left.events, right.events);
}

function sameItems<T>(left: T[], right: T[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
