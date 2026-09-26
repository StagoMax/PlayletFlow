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
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  const thumbnailVideo = page.getByRole("button", { name, exact: true }).locator(".resource-tree__object-icon video");
  await expect(thumbnailVideo).toBeVisible();
  await expect.poll(() => thumbnailVideo.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".media-viewer-video")).toBeVisible();
  await page.getByRole("textbox", { name: "生成提示词" }).fill("雾中的城市夜景，缓慢推镜");
  await expect(page.getByRole("button", { name: "发送并生成视频" })).toBeEnabled();
  await page.getByRole("button", { name: "发送并生成视频" }).click();
  await expect(page.getByText("视频生成任务已提交")).toBeVisible();
  expect(generationBodies).toHaveLength(1);
  expect(generationBodies[0]).not.toHaveProperty("kind");
});
