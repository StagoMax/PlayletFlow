import { expect, test, type Page } from "@playwright/test";

const browserErrors = new WeakMap<object, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
});

test("刷新时可选资源树接口不可用也不会阻塞工作区", async ({ page }) => {
  await page.route("**/api/v1/projects/**/workspace-nodes", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "fixture backend unavailable" } }),
    }),
  );

  await page.goto("/?fixture=ready");
  await expect(page.getByRole("tree", { name: "片段资源树" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("tree", { name: "片段资源树" })).toBeVisible();
  await expect(page.locator(".workspace-state-shell")).toHaveCount(0);

  const unexpectedErrors = (browserErrors.get(page) ?? []).filter(
    (message) => !message.includes("503 (Service Unavailable)"),
  );
  browserErrors.set(page, unexpectedErrors);
});

test("资产引用分类与候选媒体预览保持在视口内", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?fixture=ready");

  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.click();
  await composer.type("@");
  await expect(composer).toHaveText("@");
  await composer.type("x");
  await expect(composer).toHaveText("@x");
  await composer.fill("@");

  const main = page.locator(".asset-mention-popover");
  const preview = page.locator(".asset-mention-sidecar");
  await expect(main).toBeVisible();
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: /图片 \d+/ }).hover();
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("option")).toHaveCount(7);
  await expect(preview.locator(".asset-mention-copy small")).toHaveCount(0);
  await preview.getByRole("option").first().hover();
  const imageName = await preview.getByRole("option").first().locator("strong").innerText();
  const imagePanel = page.getByRole("tooltip", { name: `${imageName}大预览` });
  await expect(imagePanel.locator("img")).toBeVisible();
  expect(await imagePanel.evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10))).toBeGreaterThan(1000);
  const imagePanelBox = await imagePanel.boundingBox();
  expect(imagePanelBox).not.toBeNull();
  expect(imagePanelBox!.x).toBeGreaterThanOrEqual(0);
  expect(imagePanelBox!.y).toBeGreaterThanOrEqual(0);
  expect(imagePanelBox!.x + imagePanelBox!.width).toBeLessThanOrEqual(1280);
  expect(imagePanelBox!.y + imagePanelBox!.height).toBeLessThanOrEqual(720);
  await expect(preview).toBeVisible();

  await page.getByRole("button", { name: /视频 \d+/ }).hover();
  await expect(preview.getByRole("option")).toHaveCount(2);
  const videoOption = preview.getByRole("option").first();
  const videoName = await videoOption.locator("strong").innerText();
  await videoOption.hover();
  await expect(page.getByRole("tooltip", { name: `${videoName}大预览` }).locator("video")).toBeVisible();
  await page.getByRole("button", { name: /图片 \d+/ }).hover();
  await expect(preview.getByRole("option")).toHaveCount(7);

  for (const viewport of [{ width: 1280, height: 720 }, { width: 640, height: 720 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const [mainBox, previewBox] = await Promise.all([main.boundingBox(), preview.boundingBox()]);
      if (!mainBox || !previewBox) return { inside: false, separated: false, mainBox, previewBox };
      const panelsAreInside = [mainBox, previewBox].every((box) =>
        box.x >= 0
        && box.y >= 0
        && box.x + box.width <= viewport.width
        && box.y + box.height <= viewport.height,
      );
      const panelsDoNotOverlap = previewBox.x + previewBox.width <= mainBox.x
        || mainBox.x + mainBox.width <= previewBox.x
        || previewBox.y + previewBox.height <= mainBox.y
        || mainBox.y + mainBox.height <= previewBox.y;
      return { inside: panelsAreInside, separated: panelsDoNotOverlap, mainBox, previewBox };
    }).toMatchObject({ inside: true, separated: true });
  }

  const selectedName = await preview.getByRole("option").first().locator("strong").innerText();
  await preview.getByRole("option").first().click();
  const referenceToken = composer.locator(".inline-reference-token").first();
  await expect(referenceToken.locator(".inline-reference-token__label")).toHaveText(selectedName);
  await expect(composer).not.toContainText(`@${selectedName}`);
  await expect(page.locator(".conversation .shared-composer-source.is-reference")).toHaveCount(1);
  await expect(page.locator(".conversation .shared-composer-source.is-reference img")).toBeVisible();
  await expect(main).toBeHidden();
  await composer.press("End");
  await composer.press("Backspace");
  await expect(referenceToken).toBeVisible();
  await composer.press("Backspace");
  await expect(composer.locator(".inline-reference-token")).toHaveCount(0);
  await expect(page.locator(".conversation .shared-composer-source.is-reference")).toHaveCount(0);

  await composer.fill("@当前片段的主环境视图");
  await expect(main.getByText("没有匹配的资产")).toBeVisible();
});

test("已引用的图片和视频悬浮时在上方显示媒体预览", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?fixture=ready");

  const composer = page.getByRole("textbox", { name: "输入消息" });
  const sidecar = page.locator(".asset-mention-sidecar");
  const selectFirstReference = async (categoryName: RegExp) => {
    await composer.focus();
    await composer.press("End");
    await composer.type("@");
    await page.getByRole("button", { name: categoryName }).hover();
    const option = sidecar.getByRole("option").first();
    const name = await option.locator("strong").innerText();
    await option.click();
    return name;
  };

  const imageName = await selectFirstReference(/图片 \d+/);
  const videoName = await selectFirstReference(/视频 \d+/);
  const chips = composer.locator(".inline-reference-token");
  const imageChip = chips.filter({ hasText: imageName });
  const videoChip = chips.filter({ hasText: videoName });

  const videoThumbnail = videoChip.locator("img.inline-reference-token__preview");
  await expect(videoThumbnail).toBeVisible();
  const sidebarThumbnail = page.locator(".resource-tree__object")
    .filter({ hasText: videoName })
    .locator(".media-thumbnail img")
    .first();
  expect(await videoThumbnail.getAttribute("src")).toBe(await sidebarThumbnail.getAttribute("src"));

  await imageChip.hover();
  const panel = page.locator(".hover-preview-panel");
  await expect(panel.locator("img")).toBeVisible();

  await videoChip.hover();
  const video = panel.locator("video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("autoplay", "");
  await expect(video).toHaveAttribute("loop", "");
  await expect(video).toHaveAttribute("playsinline", "");
  expect(await video.evaluate((element) => element.muted)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0);

  const [chipBox, panelBox] = await Promise.all([videoChip.boundingBox(), panel.boundingBox()]);
  expect(chipBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(chipBox!.y);
  expect(panelBox!.x).toBeGreaterThanOrEqual(0);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(1280);
});

test("媒体生成提示词在正文位置渲染素材引用", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();

  const form = page.getByRole("form", { name: "图片生成提示词编辑器" });
  const prompt = form.getByRole("textbox", { name: "生成提示词" });
  await prompt.fill("@");
  await page.getByRole("button", { name: /图片 \d+/ }).hover();
  const option = page.locator(".asset-mention-sidecar").getByRole("option").first();
  const selectedName = await option.locator("strong").innerText();
  await option.click();

  const token = prompt.locator(".inline-reference-token");
  await expect(token.locator(".inline-reference-token__label")).toHaveText(selectedName);
  await expect(prompt).not.toContainText(`@${selectedName}`);
  await expect(form.locator(".shared-composer-source.is-reference")).toHaveCount(1);
  await expect(form.locator(".shared-composer-source.is-reference img")).toBeVisible();
  await expect(form.getByRole("button", { name: "添加附件" })).toBeVisible();
  await expect(form.getByRole("button", { name: "添加资产或附件" })).toHaveCount(0);

  const chooser = page.waitForEvent("filechooser");
  await form.getByRole("button", { name: "添加附件" }).click();
  await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("reference notes") });
  await expect(form.locator(".shared-composer-source.is-attachment")).toHaveCount(1);
});

test("视频全能参考跟随提示词引用，无需重复选择图片", async ({ page }) => {
  await page.setViewportSize({ width: 950, height: 800 });
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /生成版本 03，/ }).click();

  const form = page.getByRole("form", { name: "视频生成提示词编辑器" });
  const prompt = form.getByRole("textbox", { name: "生成提示词" });
  await expect(form.locator(".shared-composer-source.is-selected")).toHaveCount(0);
  await form.getByRole("button", { name: "画面参考方式" }).click();
  const menu = form.getByRole("dialog", { name: "画面参考方式" });
  const triggerBounds = await form.getByRole("button", { name: "画面参考方式" }).boundingBox();
  const menuBounds = await menu.boundingBox();
  expect(triggerBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(Math.abs(menuBounds!.x - triggerBounds!.x)).toBeLessThan(2);
  expect(triggerBounds!.y - (menuBounds!.y + menuBounds!.height)).toBeGreaterThanOrEqual(8);
  const compactWidth = await menu.evaluate((element) => element.getBoundingClientRect().width);
  expect(compactWidth).toBeLessThan(240);
  await expect(form.getByRole("radio", { name: "纯文本" })).toHaveCount(0);
  await expect(form.getByRole("radio", { name: "全能参考" })).toBeDisabled();
  await form.getByRole("radio", { name: "首尾帧" }).check();
  await expect(menu.getByRole("combobox", { name: "首帧" })).toBeVisible();
  expect(await menu.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(compactWidth);
  await page.keyboard.press("Escape");
  await form.getByRole("button", { name: /移除参考图片/ }).click();
  await expect(form.getByRole("button", { name: "画面参考方式" })).toContainText("画面参考");

  await prompt.fill("@");
  await page.getByRole("button", { name: /图片 \d+/ }).hover();
  const option = page.locator(".asset-mention-sidecar").getByRole("option").first();
  const selectedName = await option.locator("strong").innerText();
  await option.click();
  await expect(form.locator(".shared-composer-source.is-reference img")).toHaveCount(1);
  await expect(form.getByRole("button", { name: "画面参考方式" })).toContainText("全能参考");

  await form.getByRole("button", { name: "画面参考方式" }).click();
  await expect(form.getByRole("radio", { name: "全能参考" })).toBeChecked();
  await expect(form.getByRole("checkbox")).toHaveCount(0);
  await expect(form.getByRole("list", { name: "参考图片顺序" })).toHaveCount(0);
  await expect(form.getByText(/参考图片（最多/)).toHaveCount(0);
  await page.keyboard.press("Escape");

  await form.getByRole("button", { name: `移除资产引用 ${selectedName}` }).click();
  await expect(form.getByRole("button", { name: "画面参考方式" })).toContainText("画面参考");
  await form.getByRole("button", { name: "画面参考方式" }).click();
  await expect(form.getByRole("radio", { name: "全能参考" })).toBeDisabled();
  await page.keyboard.press("Escape");

  for (const width of [500, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await form.getByRole("button", { name: "画面参考方式" }).click();
    const trigger = await form.getByRole("button", { name: "画面参考方式" }).boundingBox();
    const popover = await menu.boundingBox();
    expect(trigger).not.toBeNull();
    expect(popover).not.toBeNull();
    expect(trigger!.y - (popover!.y + popover!.height)).toBeGreaterThanOrEqual(8);
    expect(popover!.x).toBeGreaterThanOrEqual(8);
    expect(popover!.x + popover!.width).toBeLessThanOrEqual(width - 8);
    await form.getByRole("radio", { name: "首尾帧" }).check();
    const framePopover = await menu.boundingBox();
    expect(framePopover).not.toBeNull();
    expect(framePopover!.x).toBeGreaterThanOrEqual(8);
    expect(framePopover!.x + framePopover!.width).toBeLessThanOrEqual(width - 8);
    await page.keyboard.press("Escape");
    await form.getByRole("button", { name: /移除参考图片/ }).click();
  }
});

test("视频输入框可从缩略图移除行内素材引用和生成参考", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /生成版本 03，/ }).click();

  const form = page.getByRole("form", { name: "视频生成提示词编辑器" });
  const prompt = form.getByRole("textbox", { name: "生成提示词" });
  await prompt.fill("@");
  await page.getByRole("button", { name: /图片 \d+/ }).hover();
  const option = page.locator(".asset-mention-sidecar").getByRole("option").first();
  const selectedName = await option.locator("strong").innerText();
  await option.click();

  const source = form.locator(".shared-composer-source.is-reference");
  await expect(source).toHaveCount(1);
  await expect(prompt.locator(".inline-reference-token")).toHaveCount(1);
  const removeReference = form.getByRole("button", { name: `移除资产引用 ${selectedName}` });
  await expect(removeReference).toBeVisible();
  await expect(removeReference).toHaveCSS("opacity", "1");
  await removeReference.click();

  await expect(source).toHaveCount(0);
  await expect(prompt.locator(".inline-reference-token")).toHaveCount(0);
  await expect(form.locator(".shared-composer-source.is-selected")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "画面参考方式" })).toContainText("画面参考");
});

test("图片视频与 Agent 输入框使用同规格单行工具栏", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /林舟 · 面部三视图，可预览/ }).click();

  const toolbars = page.locator(".composer-toolbar");
  await expect(toolbars).toHaveCount(2);
  await expect(page.getByText(/Enter 发送|Shift \+ Enter 换行/)).toHaveCount(0);

  const measurements = await toolbars.evaluateAll((items) => items.map((toolbar) => {
    const bounds = toolbar.getBoundingClientRect();
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button"));
    const summaries = Array.from(toolbar.querySelectorAll<HTMLElement>("summary"));
    const controls = [...buttons, ...summaries].map((control) => {
      const rect = control.getBoundingClientRect();
      return { width: rect.width, height: rect.height, centerY: rect.top + rect.height / 2 };
    });
    const icons = Array.from(toolbar.querySelectorAll<SVGElement>(
      ".composer-toolbar__button > svg, .composer-toolbar__action > svg, summary > svg",
    )).map((icon) => {
      const rect = icon.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const labelSizes = Array.from(toolbar.querySelectorAll<HTMLElement>(
      ".composer-runtime-model, summary",
    )).map((label) => getComputedStyle(label).fontSize);
    const action = toolbar.querySelector<HTMLElement>(".composer-toolbar__action")?.getBoundingClientRect();
    return {
      bounds: { width: bounds.width, height: bounds.height },
      controls,
      icons,
      labelSizes,
      action: action ? { width: action.width, height: action.height } : null,
    };
  }));

  for (const toolbar of measurements) {
    expect(toolbar.bounds.height).toBe(32);
    expect(toolbar.controls.every((control) => control.height === 32)).toBe(true);
    expect(Math.max(...toolbar.controls.map((control) => control.centerY))
      - Math.min(...toolbar.controls.map((control) => control.centerY))).toBeLessThanOrEqual(1);
    expect(toolbar.icons.every((icon) => icon.width === 15 && icon.height === 15)).toBe(true);
    expect(toolbar.labelSizes.every((size) => size === "12px")).toBe(true);
    expect(toolbar.action).toEqual({ width: 32, height: 32 });
  }
});

test("AC-02：200 个片段时菜单打开即定位第 137 个片段", async ({ page }) => {
  await page.goto("/?fixture=acceptance");
  const trigger = page.locator(".storyboard-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("片段 137");
  await trigger.click();

  const options = page.locator(".storyboard-options");
  const selected = page.getByRole("option", { name: /验收片段 137/ });
  await expect(selected).toBeVisible();
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(options).toContainText("验收片段 137");

  const inViewport = await selected.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const viewport = element.parentElement!.getBoundingClientRect();
    return item.top >= viewport.top && item.bottom <= viewport.bottom;
  });
  expect(inViewport).toBe(true);
});

test("新建片段只填写名称，创建空白片段后自动切换", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const name = `空白片段-${Date.now()}`;

  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建片段" }).click();
  const dialog = page.getByRole("dialog", { name: "新建片段" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("textbox").fill(name);
  await dialog.getByRole("button", { name: "创建并切换" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator(".storyboard-trigger")).toContainText(name);
  await expect(page.getByRole("textbox", { name: "脚本内容" })).toHaveValue("");

  const storyboardId = await page.locator(".runtime-panel").getAttribute("data-storyboard-id");
  expect(storyboardId).toBeTruthy();
  const bindings = await page.request.get(
    `/api/v1/projects/10000000-0000-4000-8000-000000000001/storyboards/${storyboardId}/asset-bindings`,
  );
  expect(bindings.ok()).toBe(true);
  expect((await bindings.json()).length).toBe(0);
});

test("AC-06：9:16 媒体缩略图裁切，悬停与主预览完整显示", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const portrait = page.getByRole("button", { name: /林舟 · 防雨服装，/ });
  await expect(portrait).toBeVisible();

  const thumbnail = portrait.locator(".media-thumbnail > img");
  await expect(thumbnail).toHaveCSS("object-fit", "cover");
  await expect(thumbnail).toHaveJSProperty("naturalWidth", 900);
  await expect(thumbnail).toHaveJSProperty("naturalHeight", 1600);

  await portrait.hover();
  const hoverPanel = page.locator(".hover-preview-panel");
  const hoverImage = hoverPanel.locator(".hover-preview-media img");
  await expect(hoverImage).toBeVisible();
  await expect(hoverImage).toHaveCSS("object-fit", "contain");
  await expect(hoverPanel.locator(".hover-preview-caption")).toHaveCount(0);
  await expect.poll(async () => {
    const box = await hoverPanel.boundingBox();
    return box ? Math.abs(box.height / box.width - 1600 / 900) : Infinity;
  }).toBeLessThan(0.02);
  const hoverBox = await hoverPanel.boundingBox();
  expect(hoverBox).not.toBeNull();
  expect(hoverBox!.y).toBeGreaterThanOrEqual(16);
  expect(hoverBox!.y + hoverBox!.height).toBeLessThanOrEqual(720 - 16 + 1);

  await portrait.click();
  await expect(page.locator(".hover-preview-panel")).toBeHidden();
  const mainImage = page.locator(".media-viewer-image");
  await expect(mainImage).toBeVisible();
  await expect(mainImage).toHaveCSS("object-fit", "contain");
  await expect(page.locator(".media-header-metadata")).toContainText("9:16");
  await expect(page.locator(".media-viewer figcaption")).toHaveCount(0);
});

test("工作区以递归资源树组织内容，并由选中对象驱动顶部名称与媒体信息", async ({ page }) => {
  await page.goto("/?fixture=ready");

  const canvasHeader = page.locator(".canvas-header");
  await expect(canvasHeader.locator(".canvas-title")).toHaveText("片段脚本");
  await expect(page.locator(".storyboard-current-label")).toHaveText("片段流");
  await expect(page.locator(".storyboard-header-pending")).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "片段资源树" })).toBeVisible();
  await expect(page.getByRole("button", { name: "角色", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "林舟", exact: true })).toBeVisible();
  await expect(page.locator(".script-editor-title-group")).toHaveCount(0);
  await expect(page.locator(".resource-browser__header")).toHaveCount(0);

  const scriptFolder = page.getByRole("button", { name: "脚本", exact: true });
  const scriptCreate = page.getByRole("button", { name: "在脚本中新建" });
  await expect(scriptCreate).toHaveCSS("opacity", "0");
  await scriptFolder.hover();
  await expect(scriptCreate).toHaveCSS("opacity", "1");

  const faceAsset = page.getByRole("button", { name: /林舟 · 面部三视图，/ });
  await expect(faceAsset.locator(".resource-tree__object-name")).toHaveText("面部三视图");
  await expect(faceAsset.locator(".resource-tree__pending-dot")).toHaveCount(0);
  await expect(faceAsset.locator("small")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /生成版本 03，/ }).locator(".resource-tree__video-mark")).toBeVisible();
  await faceAsset.click();

  await expect(canvasHeader.locator(".canvas-title")).toHaveText("面部三视图");
  await expect(page.locator(".inspector-heading")).toHaveCount(0);
  await expect(canvasHeader.locator(".media-header-metadata")).toContainText("1200 × 1200");
  await expect(canvasHeader.locator(".media-header-metadata")).toContainText("1:1");
});

test("资源树只为等待用户处理的内容显示黄色状态点", async ({ page }) => {
  await page.route("**/api/v1/projects/**/storyboards/**/proposals?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        id: "proposal-pending-media-prompt",
        projectId: "10000000-0000-4000-8000-000000000001",
        storyboardId: "20000000-0000-4000-8000-000000000012",
        target: { type: "mediaPrompt", mediaId: "character-face-12" },
        baseRevision: 2,
        beforeValue: "原提示词",
        proposedValue: "模型修改后的提示词",
        summary: "更新角色提示词",
        status: "pending",
        source: {
          type: "ai",
          threadId: "thread-pending",
          turnId: "turn-pending",
          toolCallId: "tool-pending",
        },
        revision: 1,
        createdAt: "2026-09-26T08:00:00.000Z",
        resolvedAt: null,
      }]),
    }),
  );

  await page.goto("/?fixture=ready");

  const pending = page.getByRole("button", { name: /林舟 · 面部三视图，.*有待确认或取消的 AI 建议/ });
  const dot = pending.locator(".resource-tree__pending-dot");
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute("title", "有待确认或取消的 AI 建议");
  const warningColors = await dot.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--warning)";
    document.body.append(probe);
    const colors = {
      dot: getComputedStyle(element).backgroundColor,
      token: getComputedStyle(probe).color,
    };
    probe.remove();
    return colors;
  });
  expect(warningColors.dot).toBe(warningColors.token);
  await expect(page.getByRole("button", { name: /林舟 · 防雨服装，/ }).locator(".resource-tree__pending-dot"))
    .toHaveCount(0);
});

test("Agent 直接写入的提示词显示待查看状态并在内容展示后自动清除", async ({ page }) => {
  const projectId = "10000000-0000-4000-8000-000000000001";
  const storyboardId = "20000000-0000-4000-8000-000000000012";
  const collection = `/api/v1/projects/${projectId}/storyboards/${storyboardId}/workspace-nodes`;
  const objectName = `AI 待查看视频-${Date.now()}`;
  const createdResponse = await page.request.post(collection, {
    headers: { "Idempotency-Key": `e2e-unseen-${Date.now()}` },
    data: { parentId: null, kind: "object", name: objectName, objectType: "video" },
  });
  expect(createdResponse.ok()).toBe(true);
  const created = await createdResponse.json() as { id: string };
  const mediaResponse = await page.request.post(`${collection}/${created.id}/media`);
  expect(mediaResponse.ok()).toBe(true);
  const media = await mediaResponse.json() as { id: string; name: string; revision: number };
  const agentPrompt = "镜头从村口全景缓慢推进，人物动作保持自然连贯";
  const promptResponse = await page.request.patch(`/api/v1/projects/${projectId}/media/${media.id}`, {
    data: { name: media.name, prompt: agentPrompt, expectedRevision: media.revision },
  });
  expect(promptResponse.ok()).toBe(true);

  const unseenUpdateAt = "2026-09-27T09:00:00Z";
  await page.route(`**${collection}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const nodes = await response.json() as Array<Record<string, unknown>>;
    await route.fulfill({
      response,
      json: nodes.map((node) => node.id === created.id ? { ...node, unseenUpdateAt } : node),
    });
  });
  let viewedPayload: { seenThrough?: string } | null = null;
  await page.route(`**${collection}/${created.id}/viewed`, async (route) => {
    viewedPayload = route.request().postDataJSON() as { seenThrough?: string };
    const response = await route.fetch();
    const node = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...node, unseenUpdateAt: null } });
  });

  await page.goto("/?fixture=ready");
  const pending = page.getByRole("button", { name: new RegExp(`${objectName}，AI 内容待查看`) });
  const dot = pending.locator(".resource-tree__pending-dot");
  await expect(dot).toBeVisible();
  await expect(dot).toHaveClass(/resource-tree__pending-dot--unseen/);
  await expect(dot).toHaveAttribute("title", "AI 内容待查看，打开后自动清除");

  await pending.click();
  await expect(page.getByRole("textbox", { name: "生成提示词" })).toHaveText(agentPrompt);
  await expect.poll(() => viewedPayload?.seenThrough ?? null).toBe(unseenUpdateAt);
  await expect(pending.locator(".resource-tree__pending-dot")).toHaveCount(0);
});

test("资源树可在任意文件夹下继续建文件夹并创建指定类型对象", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const categoryName = `自定义分类-${suffix}`;
  const nestedName = `第三层目录-${suffix}`;
  const objectName = `概念图-${suffix}`;

  await page.getByRole("button", { name: "资产", exact: true }).hover();
  await page.getByRole("button", { name: "在资产中新建" }).click();
  await page.getByRole("menuitem", { name: "新建文件夹" }).click();
  await page.getByRole("textbox", { name: "名称" }).fill(categoryName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("button", { name: categoryName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: categoryName, exact: true }).hover();
  await page.getByRole("button", { name: `在${categoryName}中新建` }).click();
  await page.getByRole("menuitem", { name: "新建文件夹" }).click();
  await page.getByRole("textbox", { name: "名称" }).fill(nestedName);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("button", { name: nestedName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: nestedName, exact: true }).hover();
  await page.getByRole("button", { name: `在${nestedName}中新建` }).click();
  await page.getByRole("menuitem", { name: "图片对象" }).click();
  await page.getByRole("textbox", { name: "名称" }).fill(objectName);
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await expect(page.getByRole("button", { name: objectName, exact: true })).toBeVisible();
  await expect(page.locator(".canvas-title")).toHaveText(objectName);
  await expect(page.getByRole("button", { name: "点击上传图片" })).toBeVisible();
  await expect(page.getByRole("form", { name: "图片生成提示词编辑器" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: categoryName, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: nestedName, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: objectName, exact: true })).toBeVisible();
});

test("媒体信息位于顶部右侧，提示词编辑器固定在预览区底部", async ({ page }) => {
  await page.goto("/?fixture=ready");

  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();
  const workspace = page.locator(".media-preview-workspace");
  const metadata = page.locator(".media-header-metadata");
  const promptDock = workspace.locator(".media-prompt-dock");
  await expect(metadata).toBeVisible();
  await expect(promptDock).toBeVisible();
  await expect(promptDock.getByRole("textbox", { name: "生成提示词" })).toHaveText("28岁东亚女性，冷静克制，正面与左右侧面角色设定图");
  const placement = await workspace.evaluate((element) => {
    const workspaceRect = element.getBoundingClientRect();
    const dockRect = element.querySelector(".media-prompt-dock")!.getBoundingClientRect();
    const metadataRect = document.querySelector(".media-header-metadata")!.getBoundingClientRect();
    const headerRect = document.querySelector(".media-canvas-header")!.getBoundingClientRect();
    return {
      dockBottomGap: Math.round(workspaceRect.bottom - dockRect.bottom),
      metadataRightGap: Math.round(headerRect.right - metadataRect.right),
    };
  });
  expect(placement.dockBottomGap).toBeLessThanOrEqual(1);
  expect(placement.metadataRightGap).toBeLessThanOrEqual(24);
  await expect(page.getByRole("group", { name: "图片缩放控制" })).toBeVisible();

  await page.getByRole("button", { name: "放大图片" }).click();
  await expect(page.locator(".media-viewer-zoom-value")).toContainText("125%");

  await page.getByRole("button", { name: /生成版本 03，/ }).click();
  const fixtureVideo = workspace.locator("video[controls]");
  await expect(fixtureVideo).toBeVisible();
  await expect(fixtureVideo).toHaveAttribute("src", /^data:video\/webm/);
  await expect(workspace.locator(".media-viewer-video-notice")).toHaveCount(0);
  await expect(workspace.getByRole("group", { name: "图片缩放控制" })).toHaveCount(0);
});

test("点击视频预览收起提示词，底部按钮可以重新展开", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /生成版本 03，/ }).click();

  const workspace = page.locator(".media-preview-workspace");
  const dock = workspace.locator(".media-prompt-dock");
  const editor = dock.getByRole("form", { name: "视频生成提示词编辑器" });
  const collapse = dock.getByRole("button", { name: "折叠提示词输入框" });
  await expect(editor).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");

  await workspace.locator(".media-viewer").click({ position: { x: 100, y: 100 } });
  await expect(dock).toHaveClass(/is-collapsed/);
  await expect(dock.locator(".media-prompt-dock__content")).toHaveAttribute("inert", "");
  const expand = dock.getByRole("button", { name: "展开提示词输入框" });
  await expect(expand).toBeVisible();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => dock.evaluate((element) => {
    const toggle = element.querySelector("button")!.getBoundingClientRect();
    const workspaceBottom = element.parentElement!.getBoundingClientRect().bottom;
    return Math.round(workspaceBottom - toggle.bottom);
  })).toBeLessThanOrEqual(12);

  await expand.click();
  await expect(dock).not.toHaveClass(/is-collapsed/);
  await expect(editor).toBeVisible();
});

test("媒体占满中心内容区域，提示词编辑器悬浮在底部", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();

  const geometry = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".canvas-body.media-canvas-body")!.getBoundingClientRect();
    const frame = document.querySelector<HTMLElement>(".media-viewer-frame")!.getBoundingClientRect();
    const image = document.querySelector<HTMLElement>(".media-viewer-image")!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>(".media-prompt-dock")!.getBoundingClientRect();
    const style = getComputedStyle(document.querySelector<HTMLElement>(".media-viewer-frame")!);
    return {
      body: { top: body.top, left: body.left, width: body.width, height: body.height, bottom: body.bottom },
      frame: { top: frame.top, left: frame.left, right: frame.right, width: frame.width, height: frame.height, bottom: frame.bottom },
      image: { top: image.top, left: image.left, right: image.right, bottom: image.bottom },
      dock: { top: dock.top, bottom: dock.bottom },
      borderWidth: style.borderTopWidth,
      borderRadius: style.borderTopLeftRadius,
      boxShadow: style.boxShadow,
    };
  });
  expect(Math.abs(geometry.body.top - geometry.frame.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.body.left - geometry.frame.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.body.width - geometry.frame.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.body.height - geometry.frame.height)).toBeLessThanOrEqual(1);
  expect(geometry.image.top - geometry.frame.top).toBeGreaterThanOrEqual(48);
  expect(geometry.image.left - geometry.frame.left).toBeGreaterThanOrEqual(24);
  expect(geometry.frame.right - geometry.image.right).toBeGreaterThanOrEqual(24);
  expect(geometry.frame.bottom - geometry.image.bottom).toBeGreaterThanOrEqual(24);
  expect(geometry.dock.top).toBeLessThan(geometry.frame.bottom);
  expect(Math.abs(geometry.body.bottom - geometry.dock.bottom)).toBeLessThanOrEqual(1);
  expect(geometry.borderWidth).toBe("0px");
  expect(geometry.borderRadius).toBe("0px");
  expect(geometry.boxShadow).toBe("none");
});

test("提示词像对话输入框一样编辑并提交图片或视频生成", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();

  const imagePrompt = page.getByRole("textbox", { name: "生成提示词" });
  await imagePrompt.fill("冷静克制的角色三视图");
  await imagePrompt.press("Shift+Enter");
  expect(await imagePrompt.textContent()).toBe("冷静克制的角色三视图\n");
  await imagePrompt.type("保持五官一致");
  await imagePrompt.press("Enter");
  await expect(page.locator(".media-prompt-composer").getByRole("status"))
    .toHaveText("图片生成任务已提交");
  await expect(page.locator(".media-viewer-state")).toContainText("媒体正在生成");
  await expect(page.getByRole("button", { name: /林舟 · 面部三视图，/ }).locator(".resource-tree__pending-dot"))
    .toHaveCount(0);

  await page.getByRole("button", { name: /生成版本 03，/ }).click();
  const videoPrompt = page.getByRole("textbox", { name: "生成提示词" });
  await videoPrompt.fill("镜头缓慢前推");
  await videoPrompt.press("Enter");
  await videoPrompt.type("雨幕形成视差");
  expect(await videoPrompt.textContent()).toBe("镜头缓慢前推\n雨幕形成视差");
  await videoPrompt.press("Control+Enter");
  await expect(page.locator(".media-prompt-composer").getByRole("status"))
    .toHaveText("视频生成任务已提交");
});

test("脚本选中后可编辑并保存", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const editor = page.getByRole("textbox", { name: "脚本内容" });
  const save = page.getByRole("button", { name: "保存" });

  await expect(editor).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(page.locator(".script-save-state")).toHaveCount(0);

  const revised = "雨声渐弱。林舟抬头确认桥上的脚步声，随后收起终端，沿阴影继续前进。";
  await editor.fill(revised);
  await expect(save).toBeEnabled();

  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();
  await page.locator(".script-card").click();
  await expect(editor).toHaveValue(revised);
  await expect(save).toBeEnabled();

  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.locator(".script-card")).toContainText(revised);
});

const scriptBeforeProposal = "雨水打在金属顶棚上。林舟停在桥下短暂对峙的入口，确认终端上闪烁的坐标后继续向前。镜头从环境全景缓慢推进到她手中的信号终端。";
const scriptProposalText = "雨水敲击金属顶棚。\n林舟在桥下入口停步，重新确认终端坐标。\n镜头从环境全景缓慢推进到闪烁的信号终端。";
const scriptProposal = {
  id: "proposal-script-review",
  projectId: "10000000-0000-4000-8000-000000000001",
  storyboardId: "20000000-0000-4000-8000-000000000012",
  target: { type: "script", storyboardId: "20000000-0000-4000-8000-000000000012" },
  baseRevision: 6,
  beforeValue: scriptBeforeProposal,
  proposedValue: scriptProposalText,
  summary: "收紧开场节奏并拆分镜头动作",
  status: "pending",
  source: {
    type: "ai",
    threadId: "thread-script-review",
    turnId: "turn-script-review",
    toolCallId: "tool-script-review",
  },
  revision: 1,
  createdAt: "2026-09-26T08:00:00.000Z",
  resolvedAt: null,
};

async function mockPendingScriptProposal(page: Page) {
  await page.route("**/api/v1/projects/**/storyboards/**/proposals?**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([scriptProposal]) }),
  );
  await page.route("**/api/v1/projects/**/storyboards/20000000-0000-4000-8000-000000000012/script", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: scriptBeforeProposal, revision: 6, updatedAt: "2026-09-26T08:00:00.000Z" }),
    });
  });
}

test("AI 脚本建议直接展示最新版，确认后更新正式脚本与版本", async ({ page }) => {
  await mockPendingScriptProposal(page);
  const nextEdit = `${scriptProposalText}\n补充一处镜头说明。`;
  await page.route("**/api/v1/projects/**/storyboards/20000000-0000-4000-8000-000000000012/script", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toMatchObject({ text: nextEdit, expectedRevision: 7 });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: nextEdit, revision: 8, updatedAt: "2026-09-26T08:03:00.000Z" }),
    });
  });
  await page.route("**/api/v1/projects/**/proposals/proposal-script-review/apply", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      expectedProposalRevision: 1,
      expectedTargetRevision: 6,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        proposal: { ...scriptProposal, status: "applied", revision: 2, resolvedAt: "2026-09-26T08:01:00.000Z" },
        target: { type: "script", revision: 7 },
        generationJob: null,
      }),
    });
  });

  await page.goto("/?fixture=ready");

  const editor = page.getByRole("textbox", { name: "脚本内容" });
  await expect(editor).toHaveValue(scriptProposalText);
  await expect(page.locator(".proposal-panel")).toHaveCount(0);
  await expect(page.getByText("AI 修改建议")).toHaveCount(0);
  await expect(page.locator(".script-save-state")).toHaveCount(0);
  await expect(page.locator(".proposal-diff")).toHaveCount(0);
  await expect(editor).toHaveCSS(
    "font-family",
    /Noto Serif SC|Songti SC|Microsoft YaHei/,
  );
  const headerActions = page.locator(".script-editor-actions");
  await expect(headerActions.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await expect(headerActions.getByRole("button", { name: "确认", exact: true })).toBeVisible();

  await headerActions.getByRole("button", { name: "确认", exact: true }).click();

  await expect(editor).toHaveValue(scriptProposalText);
  await expect(page.locator(".script-editor-feedback")).toHaveText("已保存");
  await expect(headerActions.getByRole("button", { name: "保存" })).toBeDisabled();
  await editor.fill(nextEdit);
  const nextSaveResponse = page.waitForResponse((response) =>
    response.request().method() === "PATCH" && response.url().includes("/script"),
  );
  await headerActions.getByRole("button", { name: "保存" }).click();
  expect((await nextSaveResponse).status()).toBe(200);
});

test("取消 AI 脚本最新版后恢复上一版正式内容", async ({ page }) => {
  await mockPendingScriptProposal(page);
  await page.route("**/api/v1/projects/**/proposals/proposal-script-review/reject", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      expectedProposalRevision: 1,
      expectedTargetRevision: 6,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...scriptProposal,
        status: "rejected",
        revision: 2,
        resolvedAt: "2026-09-26T08:01:00.000Z",
      }),
    });
  });

  await page.goto("/?fixture=ready");
  const editor = page.getByRole("textbox", { name: "脚本内容" });
  await expect(editor).toHaveValue(scriptProposalText);
  await page.locator(".script-editor-actions").getByRole("button", { name: "取消", exact: true }).click();

  await expect(editor).toHaveValue(scriptBeforeProposal);
});

test("AI 脚本建议可直接改写，放弃修改可返回建议，保存按人工脚本提交", async ({ page }) => {
  await mockPendingScriptProposal(page);
  const edited = "雨水敲击金属顶棚。\n林舟停步确认终端坐标，随后向桥下走去。";
  await page.route("**/api/v1/projects/**/storyboards/20000000-0000-4000-8000-000000000012/script", (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    expect(route.request().postDataJSON()).toMatchObject({ text: edited, expectedRevision: 6 });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: edited, revision: 7, updatedAt: "2026-09-26T08:02:00.000Z" }),
    });
  });

  await page.goto("/?fixture=ready");
  const editor = page.getByRole("textbox", { name: "脚本内容" });
  const actions = page.locator(".script-editor-actions");
  await expect(editor).toHaveValue(scriptProposalText);
  await editor.fill(edited);
  await expect(actions.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "放弃修改" })).toBeVisible();
  await actions.getByRole("button", { name: "放弃修改" }).click();
  await expect(editor).toHaveValue(scriptProposalText);
  await expect(actions.getByRole("button", { name: "确认", exact: true })).toBeVisible();

  await editor.fill(edited);
  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();
  await page.locator(".script-card").click();
  await expect(editor).toHaveValue(edited);
  await expect(actions.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  await actions.getByRole("button", { name: "保存" }).click();
  await expect(editor).toHaveValue(edited);
  await expect(page.locator(".script-editor-feedback")).toHaveText("已保存");
  await expect(actions.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看原建议" })).toBeVisible();
  await page.getByRole("button", { name: "查看原建议" }).click();
  await expect(editor).toHaveValue(scriptProposalText);
  await expect(actions.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
});

test("W2-D：切换片段创建独立会话，返回时恢复原绑定", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /.+/);
  const firstThread = await panel.getAttribute("data-thread-id");

  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: /信号源现身/ }).click();
  await expect(panel).toHaveAttribute("data-storyboard-id", "20000000-0000-4000-8000-000000000013");
  await expect(panel).toHaveAttribute("data-thread-id", /.+/);
  const secondThread = await panel.getAttribute("data-thread-id");
  expect(secondThread).not.toBe(firstThread);

  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: /桥下短暂对峙/ }).click();
  await expect(panel).toHaveAttribute("data-thread-id", firstThread!);
});

test("W2-E：同一片段可从标题下拉切换会话", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /.+/);
  const firstThread = await panel.getAttribute("data-thread-id");
  const initialSwitcher = page.getByRole("button", { name: /切换对话，当前：/ });
  await expect(initialSwitcher).toBeVisible();
  expect(await initialSwitcher.getAttribute("aria-label")).not.toMatch(/会话\s+\d+/);

  await page.getByRole("button", { name: "新建对话" }).click();
  await expect(panel).not.toHaveAttribute("data-thread-id", firstThread!);

  const switcher = page.getByRole("button", { name: /切换对话，当前：/ });
  await switcher.click();
  const options = page.locator(".thread-menu-item");
  await expect.poll(() => options.count()).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await options.allTextContents()).join(" ")).not.toMatch(/会话\s+\d+/);
  await expect(options.locator("small, time")).toHaveCount(0);
  await page.locator(`.thread-menu-item[data-thread-id="${firstThread}"]`).click();

  await expect(panel).toHaveAttribute("data-thread-id", firstThread!);
  await expect(page.locator(".assistant-titlebar")).toHaveCount(0);
  await expect(page.locator(".conversation-header")).toHaveCount(0);
});
