import { expect, test, type Page } from "@playwright/test";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
  "base64",
);

async function createObject(page: Page, folder: string, kind: string, name: string) {
  await page.getByRole("button", { name: folder, exact: true }).hover();
  await page.getByRole("button", { name: `在${folder}中新建` }).click();
  await page.getByRole("menuitem", { name: kind }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "名称" }).fill(name);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name, exact: true }).click();
}

test("图片对象可上传并在刷新后继续预览及编辑生成提示词", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const name = `上传图片-${Date.now()}`;
  await createObject(page, "资产", "图片对象", name);
  const row = page.getByRole("button", { name, exact: true });
  await expect(page.getByRole("button", { name: "点击上传图片" })).toBeVisible();
  await expect(page.getByRole("form", { name: "图片生成提示词编辑器" })).toBeVisible();
  await expect(row.locator(".resource-tree__object-icon img")).toHaveCount(0);
  await page.getByLabel("选择图片文件").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: tinyPng });
  await expect(page.getByRole("img", { name: name })).toBeVisible();
  await expect(row.locator(".resource-tree__object-icon img")).toBeVisible();
  await expect(page.getByRole("button", { name: "重新上传图片" })).toHaveCount(0);
  const agentComposer = page.getByRole("textbox", { name: "输入消息" });
  await agentComposer.fill("@");
  await page.getByRole("button", { name: /图片 \d+/ }).hover();
  await expect(page.locator(".asset-mention-sidecar").getByRole("option", { name })).toBeVisible();
  await agentComposer.fill("");

  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("img", { name: name })).toBeVisible();
  await expect(page.getByRole("button", { name, exact: true }).locator(".resource-tree__object-icon img")).toBeVisible();
  await expect(page.getByRole("form", { name: "图片生成提示词编辑器" })).toBeVisible();

  await page.locator(".storyboard-trigger").click();
  await page.locator('.storyboard-option[aria-selected="true"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制片段" }).click();
  await expect(page.getByRole("listbox", { name: "选择片段" })).toBeHidden();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("img", { name: name })).toBeVisible();
  await expect(page.getByRole("button", { name, exact: true }).locator(".resource-tree__object-icon img")).toBeVisible();
});

test("视频对象提供上传区域和视频生成输入", async ({ page }) => {
  const generationBodies: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/generations")) {
      generationBodies.push(request.postDataJSON());
    }
  });
  await page.goto("/?fixture=ready");
  const name = `上传视频-${Date.now()}`;
  await createObject(page, "视频", "视频对象", name);
  await expect(page.getByRole("button", { name: "点击上传视频" })).toBeVisible();
  await expect(page.getByRole("form", { name: "视频生成提示词编辑器" })).toBeVisible();
  await expect(page.getByLabel("选择视频文件")).toHaveAttribute("accept", /video\/mp4/);
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#8255dc";
    context.fillRect(0, 0, 64, 64);
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: "video/mp4" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/mp4" }));
    });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    recorder.stop();
    const blob = await finished;
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByLabel("选择视频文件").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from(videoBytes) });
  await expect(page.getByRole("button", { name: "重新上传视频" })).toHaveCount(0);
  await expect(page.getByRole("button", { name, exact: true }).locator(".resource-tree__object-icon video")).toBeVisible();
  const agentComposer = page.getByRole("textbox", { name: "输入消息" });
  await agentComposer.fill("@");
  await page.getByRole("button", { name: /视频 \d+/ }).hover();
  await expect(page.locator(".asset-mention-sidecar").getByRole("option", { name })).toBeVisible();
  await agentComposer.fill("");
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  const thumbnailVideo = page.getByRole("button", { name, exact: true }).locator(".resource-tree__object-icon video");
  await expect(thumbnailVideo).toBeVisible();
  await expect.poll(() => thumbnailVideo.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".media-viewer-video")).toBeVisible();
  await page.getByRole("textbox", { name: "生成提示词" }).fill("雾中的城市夜景，缓慢推镜");
  await expect(page.getByRole("button", { name: "发送并生成视频" })).toBeEnabled();
  await page.getByRole("button", { name: "发送并生成视频" }).click();
  await expect(page.getByRole("status", { name: "视频生成状态" })).toContainText("正在生成视频");
  expect(generationBodies).toHaveLength(1);
  expect(generationBodies[0]).not.toHaveProperty("kind");
});

test("未本地编辑时 Ctrl+Z 恢复 Agent 写入前的提示词", async ({ page }) => {
  let undoRevision: number | null = null;
  await page.route("**/workspace-nodes/*/media", async (route) => {
    const response = await route.fetch();
    const media = await response.json();
    await route.fulfill({ response, json: { ...media, prompt: "Agent 最新提示词", revision: 2 } });
  });
  await page.route("**/workspace-nodes/*/prompt/undo", async (route) => {
    undoRevision = route.request().postDataJSON().expectedRevision;
    const parts = new URL(route.request().url()).pathname.split("/");
    const objectId = parts.at(-3)!;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        objectId,
        mediaId: objectId,
        objectType: "video",
        prompt: "旧提示词",
        revision: 3,
      },
    });
  });

  await page.goto("/?fixture=ready");
  const name = `撤销提示词-${Date.now()}`;
  await createObject(page, "视频", "视频对象", name);
  const prompt = page.getByRole("textbox", { name: "生成提示词" });
  await expect(prompt).toHaveText("Agent 最新提示词");
  await prompt.press("Control+z");
  await expect(prompt).toHaveText("旧提示词");
  expect(undoRevision).toBe(2);
});

test("提示词草稿在切换对象后保留，并支持复制粘贴与撤销反撤销", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?fixture=ready");
  const name = `草稿编辑-${Date.now()}`;
  await createObject(page, "视频", "视频对象", name);
  const prompt = page.getByRole("textbox", { name: "生成提示词" });
  await prompt.fill("镜头缓慢推进");
  await prompt.press("Control+a");
  await prompt.press("Control+c");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("镜头缓慢推进");
  await page.evaluate(() => navigator.clipboard.writeText("，人物走入画面"));
  await prompt.press("End");
  await prompt.press("Control+v");
  await expect(prompt).toHaveText("镜头缓慢推进，人物走入画面");
  await prompt.press("Control+z");
  await expect(prompt).toHaveText("镜头缓慢推进");
  await prompt.press("Control+Shift+z");
  await expect(prompt).toHaveText("镜头缓慢推进，人物走入画面");
  await prompt.press("Control+a");
  await prompt.press("Control+x");
  await expect(prompt).toBeEmpty();
  await prompt.press("Control+z");
  await expect(prompt).toHaveText("镜头缓慢推进，人物走入画面");
  await prompt.press("Control+y");
  await expect(prompt).toBeEmpty();
  await prompt.press("Control+z");
  await expect(prompt).toHaveText("镜头缓慢推进，人物走入画面");

  await page.getByRole("button", { name: "该片段的脚本" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "生成提示词" }))
    .toHaveText("镜头缓慢推进，人物走入画面");
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("textbox", { name: "生成提示词" }))
    .toHaveText("镜头缓慢推进，人物走入画面");
});

test("自建媒体对象可处理黄点对应的待确认建议", async ({ page }) => {
  const projectId = "10000000-0000-4000-8000-000000000001";
  const storyboardId = "20000000-0000-4000-8000-000000000012";
  const collection = `/api/v1/projects/${projectId}/storyboards/${storyboardId}/workspace-nodes`;
  const name = `待确认图片-${Date.now()}`;
  const createdResponse = await page.request.post(collection, {
    headers: { "Idempotency-Key": `proposal-object-${Date.now()}` },
    data: { parentId: null, kind: "object", name, objectType: "image" },
  });
  expect(createdResponse.ok()).toBe(true);
  const created = await createdResponse.json() as { id: string };
  const uploaded = await page.request.put(`${collection}/${created.id}/media?width=1&height=1`, {
    headers: { "Content-Type": "image/png" }, data: tinyPng,
  });
  expect(uploaded.ok()).toBe(true);
  const media = await uploaded.json() as { id: string; revision: number };
  const proposal = {
    id: "proposal-object-review", projectId, storyboardId,
    target: { type: "mediaPrompt", mediaId: media.id },
    baseRevision: media.revision, beforeValue: "", proposedValue: "清晨村落全景",
    summary: "调整画面提示词", status: "pending",
    source: { type: "ai", threadId: "thread-review", turnId: "turn-review", toolCallId: "tool-review" },
    revision: 1, createdAt: "2026-09-26T08:00:00.000Z", resolvedAt: null,
  };
  await page.route("**/api/v1/projects/**/storyboards/**/proposals?**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([proposal]) }));
  await page.route("**/api/v1/projects/**/proposals/proposal-object-review/reject", (route) =>
    route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ...proposal, status: "rejected", revision: 2, resolvedAt: "2026-09-26T08:01:00.000Z" }) }));

  await page.goto("/?fixture=ready");
  const row = page.getByRole("button", { name: new RegExp(`${name}，.*有待确认或取消的 AI 建议`) });
  await expect(row.locator(".resource-tree__pending-dot--action")).toBeVisible();
  await row.click();
  const panel = page.getByRole("region", { name: "待确认的媒体修改" });
  await expect(panel.getByText("调整画面提示词")).toBeVisible();
  await panel.getByRole("button", { name: "关闭建议面板" }).click();
  await expect(panel.getByText("调整画面提示词")).toHaveCount(0);
  await expect(row.locator(".resource-tree__pending-dot--action")).toBeVisible();
  await panel.getByRole("button", { name: "查看待确认的 AI 修改（1）" }).click();
  await expect(panel.getByText("调整画面提示词")).toBeVisible();
  await panel.getByRole("button", { name: "取消建议", exact: true }).click();
  await expect(row.locator(".resource-tree__pending-dot")).toHaveCount(0);
});
