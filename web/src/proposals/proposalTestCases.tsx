import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeProposal } from "../productApi/generated";
import type { ProposalClient } from "./proposalClient";
import { buildLineDiff } from "./diff";
import { ProposalPanel } from "./ProposalPanel";
import { ProposalTargetBoundary } from "./ProposalTargetBoundary";

type TestResult = { ok: boolean; message: string };

const proposal: ChangeProposal = {
  id: "proposal-1",
  projectId: "project-1",
  storyboardId: "storyboard-1",
  target: { type: "script", storyboardId: "storyboard-1" },
  baseRevision: 7,
  beforeValue: "夜景\n角色走入画面",
  proposedValue: "雨夜\n角色快速走入画面",
  summary: "增强开场的紧张感",
  status: "pending",
  source: { type: "ai", threadId: "thread-1", turnId: "turn-1", toolCallId: "tool-1" },
  revision: 1,
  createdAt: "2026-09-26T00:00:00Z",
  resolvedAt: null,
};

const client: ProposalClient = {
  listGenerationModels: async () => [],
  list: async () => [],
  get: async () => proposal,
  getGeneration: async () => { throw new Error("not invoked while rendering"); },
  apply: async () => { throw new Error("not invoked while rendering"); },
  reject: async () => { throw new Error("not invoked while rendering"); },
};

export const proposalTestCases: Record<string, () => TestResult> = {
  "line diff preserves unchanged context and marks replacements"() {
    const lines = buildLineDiff("第一行\n保留", "新的第一行\n保留");
    const ok = lines.some((line) => line.kind === "removed" && line.text === "第一行")
      && lines.some((line) => line.kind === "added" && line.text === "新的第一行")
      && lines.some((line) => line.kind === "unchanged" && line.text === "保留");
    return { ok, message: "差异应同时包含删除、新增和未修改上下文。" };
  },
  "target boundary makes pending state keyboard discoverable"() {
    const markup = renderToStaticMarkup(
      <ProposalTargetBoundary proposals={[proposal]}><span>正式脚本</span></ProposalTargetBoundary>,
    );
    const ok = markup.includes("proposal-target--pending")
      && markup.includes("查看1条待确认建议")
      && markup.includes("待确认");
    return { ok, message: "待确认边界应包含可聚焦按钮和可读状态，而不只是黄色边框。" };
  },
  "proposal panel states that AI output is not applied and exposes both decisions"() {
    const markup = renderToStaticMarkup(
      <ProposalPanel client={client} projectId="project-1" proposal={proposal} currentTargetRevision={7} />,
    );
    const ok = markup.includes("尚未写入正式内容")
      && markup.includes("确认并应用")
      && markup.includes("取消建议")
      && markup.includes("变更差异");
    return { ok, message: "提案详情应说明未应用语义，并提供差异、确认和取消入口。" };
  },
  "conflicted proposal disables apply and explains overwrite protection"() {
    const markup = renderToStaticMarkup(
      <ProposalPanel client={client} projectId="project-1" proposal={{ ...proposal, status: "conflicted" }} currentTargetRevision={8} />,
    );
    const ok = markup.includes("版本冲突")
      && markup.includes("不会覆盖新内容")
      && markup.includes("disabled");
    return { ok, message: "冲突提案必须禁止直接应用并解释原因。" };
  },
  "media proposal exposes optional model and frame controls before confirmation"() {
    const mediaProposal: ChangeProposal = {
      ...proposal,
      target: { type: "mediaPrompt", mediaId: "media-video-1" },
    };
    const markup = renderToStaticMarkup(
      <ProposalPanel
        client={client}
        projectId="project-1"
        proposal={mediaProposal}
        currentTargetRevision={7}
        generationContext={{
          kind: "video",
          media: [
            { id: "frame-1", name: "首帧候选" },
            { id: "frame-2", name: "尾帧候选" },
          ],
        }}
      />,
    );
    const ok = markup.includes("Seedance 2.0 Mini")
      && markup.includes("锁定首帧 / 尾帧")
      && markup.includes("使用参考关键帧")
      && markup.includes("同步生成声音");
    return { ok, message: "媒体提案确认前应显示固定模型，并可配置首尾帧或参考关键帧。" };
  },
};
