import type { ToolCall } from "../types";
import type { IconName } from "../workspace/Icons";

export type ToolGroupKind = "explore" | "edit" | "create" | "tool";

export type ToolPresentation = {
  group: ToolGroupKind;
  icon: IconName;
  title: string;
};

/** Keep tool headlines derived from structured calls, never from model prose. */
export function toolPresentation(call: ToolCall): ToolPresentation {
  const input = asRecord(call.input);
  switch (call.name) {
    case "search_storyboard_assets":
      return {
        group: "explore",
        icon: "search",
        title: withDetail("搜索分镜素材", input?.query),
      };
    case "read_storyboard_asset":
      return { group: "explore", icon: "file-text", title: "读取分镜素材" };
    case "create_workspace_object":
      return { group: "create", icon: "plus", title: withDetail("创建工作区对象", input?.name) };
    case "save_workspace_object_prompt":
      return { group: "edit", icon: "save", title: "保存对象提示词" };
    case "propose_text_patch":
      return { group: "edit", icon: "square-pen", title: "提交脚本修改提案" };
    case "propose_image_prompt_change":
      return { group: "edit", icon: "image", title: "提交图片提示词提案" };
    case "propose_video_prompt_change":
      return { group: "edit", icon: "film", title: "提交视频提示词提案" };
    default:
      return { group: "tool", icon: "wrench", title: call.name || "工具调用" };
  }
}

export function toolGroupPresentation(group: ToolGroupKind, count: number) {
  if (group === "explore") return { icon: "search" as const, title: `探索了 ${count} 处` };
  if (group === "edit") return { icon: "square-pen" as const, title: `修改了 ${count} 次` };
  if (group === "create") return { icon: "plus" as const, title: `创建了 ${count} 个对象` };
  return { icon: "wrench" as const, title: `调用了 ${count} 个工具` };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function withDetail(title: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return title;
  const detail = value.trim().replace(/\s+/gu, " ");
  return `${title} · ${detail.length > 48 ? `${detail.slice(0, 48)}…` : detail}`;
}
