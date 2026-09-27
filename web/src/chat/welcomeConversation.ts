import type { AgentEvent, Message, Thread } from "../types";
import source from "./welcomeConversation.json";

type WelcomeConversation = {
  thread: Thread;
  projectId: string;
  storyboardId: string;
  messages: Message[];
  events: AgentEvent[];
};

const welcome = source as unknown as WelcomeConversation;
export const welcomeThreadId = welcome.thread.id;
const markerKey = "videoflow:welcome-conversation:v1";
const threadListKey = "videoflow:threads:v1";
const conversationKey = `videoflow:conversation:v1:${welcome.thread.id}`;
const bindingKey = `videoflow:workspace-thread:v1:${welcome.projectId}:${welcome.storyboardId}`;

export function isWelcomeConversationUntouched() {
  try {
    const saved = window.localStorage.getItem(conversationKey);
    if (!saved) return false;
    const conversation = JSON.parse(saved) as { messages?: Message[] };
    return conversation.messages?.length === welcome.messages.length;
  } catch {
    return false;
  }
}

export function seedWelcomeConversation(projectId: string, storyboardId: string) {
  if (projectId !== welcome.projectId || storyboardId !== welcome.storyboardId) return;
  try {
    if (window.localStorage.getItem(markerKey)) return;
    const threads = JSON.parse(window.localStorage.getItem(threadListKey) ?? "[]") as Thread[];
    if (!threads.some((thread) => thread.id === welcome.thread.id)) {
      window.localStorage.setItem(threadListKey, JSON.stringify([welcome.thread, ...threads]));
    }
    if (!window.localStorage.getItem(conversationKey)) {
      window.localStorage.setItem(conversationKey, JSON.stringify({
        messages: welcome.messages,
        events: welcome.events,
      }));
    }
    const bindings = JSON.parse(window.localStorage.getItem(bindingKey) ?? "[]") as Array<{ threadId: string }>;
    if (!bindings.some((binding) => binding.threadId === welcome.thread.id)) {
      window.localStorage.setItem(bindingKey, JSON.stringify([{
        projectId,
        storyboardId,
        threadId: welcome.thread.id,
        createdAt: welcome.thread.createdAt,
      }, ...bindings]));
    }
    window.localStorage.setItem(markerKey, "1");
  } catch (error) {
    console.warn("无法初始化示例对话", error);
  }
}
