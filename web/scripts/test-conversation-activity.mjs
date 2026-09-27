import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});
const { projectTurnActivity } = await server.ssrLoadModule("/src/chat/conversationActivityModel.ts");
const { toolPresentation } = await server.ssrLoadModule("/src/chat/toolActivityPresentation.ts");
const { TurnActivityTimeline } = await server.ssrLoadModule("/src/chat/TurnActivityTimeline.tsx");

function event(seq, payload) {
  return {
    id: `event-${seq}`,
    threadId: "thread-1",
    turnId: "turn-1",
    seq,
    createdAt: new Date(seq * 1_000).toISOString(),
    payload,
  };
}

function call(seq, id, name, input = {}) {
  return event(seq, { type: "tool_call_started", call: { id, name, input } });
}

function result(seq, id) {
  return event(seq, {
    type: "tool_call_finished",
    result: { callId: id, output: "完成", metadata: {} },
  });
}

test("activity keeps commentary and tools in event order during replay", () => {
  const events = [
    event(1, { type: "model_request", round: 1 }),
    event(2, { type: "model_delta", text: "先搜索素材。" }),
    call(3, "search", "search_storyboard_assets", { query: "村落" }),
    result(4, "search"),
    event(5, { type: "model_request", round: 2 }),
    event(6, { type: "model_delta", text: "再读取结果。" }),
    call(7, "read", "read_storyboard_asset", { id: "asset-1", kind: "image" }),
    result(8, "read"),
    event(9, { type: "model_request", round: 3 }),
    event(10, { type: "model_delta", text: "最终回答" }),
    event(11, { type: "assistant_message", message: { parts: [{ type: "text", text: "最终回答" }] } }),
    event(12, { type: "turn_finished" }),
  ];
  const activity = projectTurnActivity([...events].reverse());
  assert.deepEqual(activity.entries.map((entry) => entry.kind), [
    "commentary", "tool-group", "commentary", "tool-group",
  ]);
  assert.equal(activity.entries[0].text, "先搜索素材。");
  assert.equal(activity.entries[1].tools[0].call.name, "search_storyboard_assets");
  assert.equal(activity.entries[2].text, "再读取结果。");
  assert.equal(activity.entries[3].tools[0].call.name, "read_storyboard_asset");
  assert.equal(activity.liveAnswer, "");
  assert.ok(!activity.entries.some((entry) => entry.text?.includes("最终回答")));
});

test("only adjacent calls of the same class form a group", () => {
  const activity = projectTurnActivity([
    call(1, "search", "search_storyboard_assets"),
    call(2, "read", "read_storyboard_asset"),
    event(3, { type: "model_delta", text: "继续修改。" }),
    call(4, "edit", "save_workspace_object_prompt"),
  ]);
  assert.deepEqual(activity.entries.map((entry) => entry.kind), [
    "tool-group", "commentary", "tool-group",
  ]);
  assert.equal(activity.entries[0].tools.length, 2);
  assert.equal(activity.entries[2].tools.length, 1);
});

test("streaming text becomes commentary when a later tool starts", () => {
  const events = [event(1, { type: "model_request", round: 1 }), event(2, { type: "model_delta", text: "先检查。" })];
  const beforeCall = projectTurnActivity(events);
  assert.equal(beforeCall.liveAnswer, "先检查。");
  assert.deepEqual(beforeCall.entries, []);

  const afterCall = projectTurnActivity([...events, call(3, "search", "search_storyboard_assets")]);
  assert.equal(afterCall.liveAnswer, "");
  assert.deepEqual(afterCall.entries.map((entry) => entry.kind), ["commentary", "tool-group"]);
});

test("a single call shows its action and tool icon instead of a one-item count", () => {
  const activity = projectTurnActivity([call(1, "search", "search_storyboard_assets", { query: "村落" })]);
  const html = renderToStaticMarkup(createElement(TurnActivityTimeline, { activity, threadId: "thread-1" }));
  assert.match(html, /data-icon="search"/);
  assert.match(html, /搜索分镜素材 · 村落/);
  assert.doesNotMatch(html, /1 项/);
  assert.deepEqual(toolPresentation({ id: "other", name: "custom_tool", input: {} }), {
    group: "tool", icon: "wrench", title: "custom_tool",
  });
});

test.after(async () => {
  await server.close();
});
