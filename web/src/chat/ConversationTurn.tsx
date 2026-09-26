import { memo, useMemo } from "react";
import { projectTurnActivity } from "./conversationActivityModel";
import { messageText, type ConversationTurn as ConversationTurnModel } from "./conversationTurnModel";
import { AssistantMessage, UserMessage } from "./ConversationMessage";
import { PendingTurnStatus, TurnActivityTimeline } from "./TurnActivityTimeline";

export const ConversationTurn = memo(function ConversationTurn({
  turn,
  threadId,
  pending,
  cancelling,
}: {
  turn: ConversationTurnModel;
  threadId: string;
  pending: boolean;
  cancelling: boolean;
}) {
  const activity = useMemo(
    () => turn.turnId ? projectTurnActivity(turn.events, cancelling) : null,
    [turn.turnId, turn.events, cancelling],
  );
  const finalMessages = turn.assistantMessages;
  const liveAnswer = finalMessages.length === 0 ? activity?.liveAnswer ?? "" : "";
  const interrupted = Boolean(activity && !activity.active && activity.phase.tone !== "complete");

  return (
    <div className="conversation-turn" data-active={activity?.active || pending || undefined}>
      {turn.userMessage ? <UserMessage message={turn.userMessage} /> : null}
      {pending ? <PendingTurnStatus cancelling={cancelling} /> : null}
      {!pending && activity && (turn.events.length > 0 || activity.active) ? (
        <TurnActivityTimeline activity={activity} threadId={threadId} />
      ) : null}
      {liveAnswer ? (
        <AssistantMessage
          text={liveAnswer}
          streaming={Boolean(activity?.active)}
          interrupted={interrupted}
        />
      ) : null}
      {finalMessages.map((message) => (
        <AssistantMessage key={message.id} text={messageText(message)} createdAt={message.createdAt} />
      ))}
    </div>
  );
});
