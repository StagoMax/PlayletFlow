import { expect, test } from "@playwright/test";

const proposal = {
  id: "90000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000001",
  storyboardId: "20000000-0000-4000-8000-000000000012",
  target: { type: "mediaPrompt", mediaId: "video-draft-12" },
  baseRevision: 2,
  beforeValue: "镜头缓慢前推",
  proposedValue: "从图片 1 平稳过渡到图片 2",
  summary: "锁定视频首尾帧",
  status: "pending",
  source: { type: "ai", threadId: "a", turnId: "b", toolCallId: "c" },
  revision: 1,
  createdAt: "2026-09-27T00:00:00Z",
  resolvedAt: null,
};

async function openVideoProposal(page: import("@playwright/test").Page, proposedInput: object) {
  await page.route("**/api/v1/projects/*/storyboards/*/proposals?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ ...proposal, proposedInput }]),
    });
  });
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /生成版本 03，/ }).click();
}

test("video prompt proposal shows its referenced frames before confirmation", async ({ page }, testInfo) => {
  await openVideoProposal(page, {
    type: "firstLastFrames",
    firstFrameMediaId: "first-frame-12",
    lastFrameMediaId: "last-frame-12",
  });
  const review = page.getByRole("region", { name: "待确认的媒体修改" });
  await expect(review.getByRole("heading", { name: "待确认的 AI 修改" })).toBeVisible();
  await expect(review.getByText("媒体提示词 · 生成版本 03")).toBeVisible();
  await expect(review.getByText("AI 建议的生成引用")).toBeVisible();
  await expect(review.getByText("严格首帧：首帧；尾帧：尾帧")).toBeVisible();
  await expect(review.getByRole("radio", { name: "锁定首帧 / 尾帧" })).toBeChecked();
  await expect(review.getByRole("button", { name: "确认并应用" })).toBeVisible();
  await review.screenshot({ path: testInfo.outputPath("video-proposal-references.png") });
});

test("reference images retain a visible, editable prompt order", async ({ page }) => {
  await openVideoProposal(page, {
    type: "referenceImages",
    mediaIds: ["first-frame-12", "last-frame-12"],
  });
  const review = page.getByRole("region", { name: "待确认的媒体修改" });
  const order = review.getByRole("list", { name: "参考图片顺序" });
  await expect(review.getByText("参考图片：图片 1 首帧；图片 2 尾帧")).toBeVisible();
  await expect(order.getByRole("listitem").first()).toContainText("图片 1 · 首帧");
  await order.getByRole("button", { name: "下移图片 1" }).click();
  await expect(order.getByRole("listitem").first()).toContainText("图片 1 · 尾帧");
});
