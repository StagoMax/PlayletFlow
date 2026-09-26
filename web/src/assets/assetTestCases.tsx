import { renderToStaticMarkup } from "react-dom/server";
import type { AssetBinding, AssetSection } from "../productApi/generated";
import { AssetBindingCard } from "./AssetBindingCard";
import { buildAssetSectionTree } from "./assetTree";

type TestResult = { ok: boolean; message: string };

const root: AssetSection = {
  id: "section-root",
  storyboardId: "storyboard-1",
  parentId: null,
  name: "角色",
  kind: "character",
  position: "b",
  revision: 1,
  bindingCount: 1,
};

const binding: AssetBinding = {
  id: "binding-1",
  storyboardId: "storyboard-1",
  sectionId: root.id,
  assetId: "asset-1",
  position: "a",
  promptOverride: null,
  derivedMediaId: null,
  revision: 1,
  asset: {
    id: "asset-1",
    projectId: "project-1",
    type: "character",
    name: "女主角",
    description: null,
    canonicalPrompt: "短发，蓝色夹克",
    revision: 1,
    referenceCount: 3,
    representations: [],
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00Z",
  },
};

export const assetTestCases: Record<string, () => TestResult> = {
  "asset section tree is sorted and limited to coherent parent ownership"() {
    const child: AssetSection = { ...root, id: "section-child", parentId: root.id, name: "服装", position: "a" };
    const earlierRoot: AssetSection = { ...root, id: "section-earlier", name: "场景", kind: "scene", position: "a" };
    const result = buildAssetSectionTree([root, child, earlierRoot]);
    const ok = result.map((item) => item.id).join(",") === "section-earlier,section-root"
      && result[1].children[0]?.id === child.id;
    return { ok, message: "根分区应按 position 排序，子分区应挂在其根分区下。" };
  },
  "asset card exposes pending state with text instead of color only"() {
    const markup = renderToStaticMarkup(<AssetBindingCard binding={binding} pendingCount={2} />);
    const ok = markup.includes("asset-binding-card--pending") && markup.includes("待确认 2") && markup.includes("女主角");
    return { ok, message: "资产卡应同时输出黄色状态类和可读的待确认数量。" };
  },
};
