import { useMemo, useSyncExternalStore } from "react";
import { ConversationStore } from "../conversationStore";

const stores = new Map<string, ConversationStore>();

export function forgetConversation(threadId: string) {
  stores.delete(threadId);
}

function getStore(threadId: string) {
  let store = stores.get(threadId);
  if (!store) {
    store = new ConversationStore(threadId);
    stores.set(threadId, store);
  }
  return store;
}

export function useConversation(threadId: string) {
  const store = useMemo(() => getStore(threadId), [threadId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, state };
}
