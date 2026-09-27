import { expect, test } from "@playwright/test";

const proposal = {
  id: "90000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000001",
  storyboardId: "20000000-0000-4000-8000-000000000012",
  target: { type: "mediaPrompt", mediaId: "60000000-0000-4000-8000-000000000012" },
  baseRevision: 2,
  beforeValue: "镜头缓慢前推",
  proposedValue: "从 @首帧 平稳过渡到 @尾帧\n\n引用资产：\n- 图片「首帧」(first-frame-12)\n- 图片「尾帧」(last-frame-12)",
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
  await expect(review.getByText("提示词引用资产")).toBeVisible();
  await expect(review).not.toContainText("first-frame-12");
  await expect(review).not.toContainText("last-frame-12");
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

test("confirming a referenced proposal renders asset tokens in the saved prompt", async ({ page }) => {
  await page.route("**/api/v1/projects/*/proposals/*/apply", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        proposal: { ...proposal, status: "applied", revision: 2, resolvedAt: "2026-09-28T00:00:00Z" },
        target: { type: "mediaPrompt", revision: 3 },
        generationJob: null,
      }),
    });
  });
  await openVideoProposal(page, {
    type: "firstLastFrames",
    firstFrameMediaId: "first-frame-12",
    lastFrameMediaId: "last-frame-12",
  });
  await page.getByRole("region", { name: "待确认的媒体修改" })
    .getByRole("button", { name: "确认并应用" }).click();
  const editor = page.getByRole("textbox", { name: "生成提示词" });
  const form = page.getByRole("form", { name: "视频生成提示词编辑器" });
  await expect(form.getByRole("listitem", { name: "已引用资产：首帧" })).toBeVisible();
  await expect(form.getByRole("listitem", { name: "已引用资产：尾帧" })).toBeVisible();
  await expect(editor.getByRole("img", { name: "引用素材：首帧" })).toBeVisible();
  await expect(editor.getByRole("img", { name: "引用素材：尾帧" })).toBeVisible();
  await expect(editor).not.toContainText("first-frame-12");
});

test("an older generated video restores its real input images in the prompt editor", async ({ page }) => {
  await page.route("**/generation-jobs/*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      targetRevision: 2,
      status: "succeeded",
      spec: { input: { type: "referenceImages", mediaIds: ["first-frame-12", "last-frame-12"] } },
    }) });
  });
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /生成版本 03，/ }).click();
  const editor = page.getByRole("textbox", { name: "生成提示词" });
  await expect(editor).toContainText("首帧");
  await expect(editor).toContainText("尾帧");
  await expect(page.getByRole("listitem", { name: "已引用资产：首帧" })).toBeVisible();
  await expect(page.getByRole("listitem", { name: "已引用资产：尾帧" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /生成版本 03，/ }).click();
  await expect(page.getByRole("img", { name: "引用素材：首帧" })).toHaveCount(1);
  await expect(page.getByRole("img", { name: "引用素材：尾帧" })).toHaveCount(1);
});
