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

async function recordedVideo(page: Page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
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
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await (await finished).arrayBuffer()));
  });
  return Buffer.from(bytes);
}

for (const kind of ["image", "video"] as const) {
  test(`生成的${kind === "image" ? "图片" : "视频"}完成后可预览并正确引用`, async ({ page }) => {
    const label = kind === "image" ? "图片" : "视频";
    const name = `生成${label}-${Date.now()}`;
    const sentBodies: Array<{ contentParts?: Array<Record<string, unknown>> }> = [];
    let targetRevision: number | null = null;
    let complete = false;
    await page.route("**/api/threads/*/messages", async (route) => {
      if (route.request().method() === "POST") sentBodies.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.goto("/?fixture=ready");
    const ensured = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/workspace-nodes\/[^/]+\/media$/u.test(response.url()));
    await createObject(page, kind === "image" ? "资产" : "视频", `${label}对象`, name);
    const mediaId = ((await (await ensured).json()) as { id: string }).id;
    const sourceUrl = kind === "image"
      ? `data:image/png;base64,${tinyPng.toString("base64")}`
      : `data:video/mp4;base64,${(await recordedVideo(page)).toString("base64")}`;
    const serveReadyMedia = async (route: import("@playwright/test").Route) => {
      const response = await route.fetch();
      if (targetRevision === null || !complete) return route.fulfill({ response });
      const media = await response.json();
      const access = { url: sourceUrl, expiresAt: null, width: 64, height: 64 };
      await route.fulfill({ response, json: {
        ...media,
        status: "ready",
        revision: targetRevision,
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        width: 64,
        height: 64,
        durationMs: kind === "video" ? 300 : null,
        thumbnail: kind === "image" ? access : null,
        preview: { ...access, mimeType: kind === "image" ? "image/png" : "video/mp4" },
      } });
    };
    await page.route(`**/api/v1/projects/*/media/${mediaId}`, serveReadyMedia);
    await page.route("**/api/v1/projects/*/storyboards/*/workspace-nodes/*/media", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await serveReadyMedia(route);
    });
    await page.route("**/api/v1/projects/*/generation-jobs/*", async (route) => {
      const response = await route.fetch();
      if (!complete) return route.fulfill({ response });
      const job = await response.json();
      await route.fulfill({ response, json: { ...job, status: "succeeded", resultMediaId: mediaId } });
    });

    await expect(page.getByText(`或在下方输入提示词生成${label}`)).toBeVisible();
    await expect(page.getByRole("button", { name: `通过提示词生成${label}` })).toHaveCount(0);
    const fileChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: `点击上传${label}` }).click({ position: { x: 30, y: 30 } });
    expect(await (await fileChooser).element().getAttribute("aria-label")).toBe(`选择${label}文件`);
    await page.getByRole("textbox", { name: "生成提示词" }).fill(`生成${label}预览`);
    const submitted = page.waitForResponse((response) => response.request().method() === "POST"
      && response.url().endsWith("/generations"));
    await page.getByRole("button", { name: `发送并生成${label}` }).click();
    targetRevision = ((await (await submitted).json()) as { targetRevision: number }).targetRevision;
    await expect(page.getByRole("status", { name: `${label}生成状态` })).toContainText(`正在生成${label}`);
    await expect(page.locator(".media-prompt-composer-status")).toHaveCount(0);
    await page.waitForResponse((response) => response.request().method() === "GET"
      && /\/generation-jobs\/[^/]+$/u.test(response.url()));
    await expect(page.getByRole("status", { name: `${label}生成状态` })).toBeVisible();
    if (kind === "image") {
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("status", { name: "图片生成状态" }))
        .toContainText("正在生成图片");
    }
    complete = true;
    await page.getByRole("button", { name: "该片段的脚本" }).click();

    const row = page.getByRole("button", { name, exact: true });
    const thumbnail = row.locator(kind === "image" ? ".resource-tree__object-icon img" : ".resource-tree__object-icon video");
    await expect(thumbnail).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => thumbnail.evaluate((element, mediaKind) => mediaKind === "image"
      ? (element as HTMLImageElement).naturalWidth
      : (element as HTMLVideoElement).readyState, kind)).toBeGreaterThan(0);
    await row.click();
    if (kind === "image") {
      const preview = page.getByRole("img", { name });
      await expect(preview).toHaveAttribute("src", sourceUrl);
      await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    } else {
      const preview = page.locator(`video[aria-label="${name}视频预览"]`);
      await expect(preview).toHaveAttribute("src", sourceUrl);
      await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    }

    const composer = page.getByRole("textbox", { name: "输入消息" });
    await composer.fill(`@${name}`);
    await page.getByRole("option", { name }).click();
    await composer.press("End");
    await composer.type(" 请检查这个素材");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => sentBodies.length).toBeGreaterThan(0);
    expect(sentBodies[0].contentParts?.filter((part) => part.type === "asset_ref"))
      .toEqual([{ type: "asset_ref", assetId: mediaId }]);
    await expect(page.locator(".message.user").last().getByRole("button", { name: `预览${name}` })).toHaveCount(1);
  });
}

test("图片生成失败后在预览区显示原因并允许上传", async ({ page }) => {
  const name = `失败图片-${Date.now()}`;
  await page.goto("/?fixture=ready");
  const ensured = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/workspace-nodes\/[^/]+\/media$/u.test(response.url()));
  await createObject(page, "资产", "图片对象", name);
  const mediaId = ((await (await ensured).json()) as { id: string }).id;
  let shouldFail = false;
  await page.route("**/api/v1/projects/*/generation-jobs/*", async (route) => {
    const response = await route.fetch();
    if (!shouldFail) return route.fulfill({ response });
    const job = await response.json();
    await route.fulfill({ response, json: { ...job, status: "failed", error: "参考图片处理失败，请重试。" } });
  });

  await page.getByRole("textbox", { name: "生成提示词" }).fill("生成图片预览");
  const submitted = page.waitForResponse((response) => response.request().method() === "POST"
    && response.url().endsWith("/generations"));
  await page.getByRole("button", { name: "发送并生成图片" }).click();
  const job = (await (await submitted).json()) as { targetId: string };
  expect(job.targetId).toBe(mediaId);
  shouldFail = true;

  const failure = page.getByRole("alert", { name: "图片生成失败" });
  await expect(failure).toContainText("参考图片处理失败，请重试。", { timeout: 10_000 });
  const fileChooser = page.waitForEvent("filechooser");
  await failure.getByRole("button", { name: "上传图片" }).click();
  await (await fileChooser).setFiles({ name: "recovery.png", mimeType: "image/png", buffer: tinyPng });
  await expect(page.getByRole("img", { name })).toBeVisible({ timeout: 10_000 });
  await expect(failure).toHaveCount(0);
});

test("生成服务未配置时不会显示虚假的生成中状态", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await createObject(page, "资产", "图片对象", `未配置生成-${Date.now()}`);
  await page.route("**/generations", async (route) => route.fulfill({
    status: 501,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "DEPENDENCY_UNAVAILABLE", message: "请设置 ARK_API_KEY 并重启后端服务。" } }),
  }));
  await page.getByRole("textbox", { name: "生成提示词" }).fill("生成测试图片");
  await page.getByRole("button", { name: "发送并生成图片" }).click();
  const failure = page.getByRole("alert", { name: "图片生成失败" });
  await expect(failure).toContainText("ARK_API_KEY");
  await expect(failure.getByRole("button", { name: "上传图片" })).toBeEnabled();
  await expect(page.getByRole("status", { name: "图片生成状态" })).toHaveCount(0);
});

for (const kind of ["image", "video"] as const) {
  test(`${kind === "image" ? "图片" : "视频"}生成请求过大时显示 413 的原因`, async ({ page }) => {
    const label = kind === "image" ? "图片" : "视频";
    await page.goto("/?fixture=ready");
    await createObject(page, kind === "image" ? "资产" : "视频", `${label}对象`, `过大${label}-${Date.now()}`);
    await page.route("**/generations", async (route) => route.fulfill({
      status: 413,
      contentType: "text/plain",
      body: "Payload Too Large",
    }));
    await page.getByRole("textbox", { name: "生成提示词" }).fill(`生成测试${label}`);
    await page.getByRole("button", { name: `发送并生成${label}` }).click();
    const failure = page.getByRole("alert", { name: `${label}生成失败` });
    await expect(failure).toContainText("生成请求内容过大（HTTP 413）");
    await expect(failure).toContainText("减少参考图片数量，或压缩图片后重试");
  });
}
