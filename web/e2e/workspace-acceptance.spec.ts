import { expect, test } from "@playwright/test";

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
  await expect(page.getByRole("tree", { name: "分镜资源树" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("tree", { name: "分镜资源树" })).toBeVisible();
  await expect(page.locator(".workspace-state-shell")).toHaveCount(0);

  const unexpectedErrors = (browserErrors.get(page) ?? []).filter(
    (message) => !message.includes("503 (Service Unavailable)"),
  );
  browserErrors.set(page, unexpectedErrors);
});

test("资产引用分类在相邻面板预览且始终保持在视口内", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?fixture=ready");

  const composer = page.getByRole("textbox", { name: "输入消息" });
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
  await page.waitForTimeout(200);
  await expect(preview).toBeVisible();

  await page.getByRole("button", { name: /视频 \d+/ }).hover();
  await expect(preview.getByRole("option")).toHaveCount(2);
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

  await composer.fill("@当前分镜的主环境视图");
  await expect(main.getByText("没有匹配的资产")).toBeVisible();
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
      ".composer-model-trigger, .composer-runtime-model, summary",
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

test("AC-02：200 个分镜时菜单打开即定位第 137 个分镜", async ({ page }) => {
  await page.goto("/?fixture=acceptance");
  const trigger = page.locator(".storyboard-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("分镜 137");
  await trigger.click();

  const options = page.locator(".storyboard-options");
  const selected = page.getByRole("option", { name: /验收分镜 137/ });
  await expect(selected).toBeVisible();
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(options).toContainText("验收分镜 137");

  const inViewport = await selected.evaluate((element) => {
    const item = element.getBoundingClientRect();
    const viewport = element.parentElement!.getBoundingClientRect();
    return item.top >= viewport.top && item.bottom <= viewport.bottom;
  });
  expect(inViewport).toBe(true);
});

test("新建分镜时可复用资产并在成功后自动切换", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const name = `复制资产分镜-${Date.now()}`;

  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建分镜" }).click();
  const dialog = page.getByRole("dialog", { name: "新建分镜" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill(name);
  await expect(dialog.getByText(/全选 1 项/)).toBeVisible();
  await dialog.getByText(/全选 1 项/).click();
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
  expect((await bindings.json()).length).toBe(1);
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
  const hoverImage = page.locator(".hover-preview-panel .hover-preview-media img");
  await expect(hoverImage).toBeVisible();
  await expect(hoverImage).toHaveCSS("object-fit", "contain");

  await portrait.click();
  const mainImage = page.locator(".media-viewer-image");
  await expect(mainImage).toBeVisible();
  await expect(mainImage).toHaveCSS("object-fit", "contain");
  await expect(page.locator(".media-viewer figcaption")).toContainText("9:16");
});

test("工作区以递归资源树组织内容，并由选中对象驱动顶部名称与媒体信息", async ({ page }) => {
  await page.goto("/?fixture=ready");

  const canvasHeader = page.locator(".canvas-header");
  await expect(canvasHeader.locator(".canvas-title")).toHaveText("分镜脚本");
  await expect(page.locator(".storyboard-current-index")).toHaveText("分镜 12");
  await expect(page.locator(".storyboard-header-pending")).toHaveCount(0);
  await expect(page.getByRole("tree", { name: "分镜资源树" })).toBeVisible();
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

  await expect(canvasHeader.locator(".canvas-title")).toHaveText("林舟 · 面部三视图");
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

  const pending = page.getByRole("button", { name: /林舟 · 面部三视图，.*等待用户处理/ });
  const dot = pending.locator(".resource-tree__pending-dot");
  await expect(dot).toBeVisible();
  await expect(dot).toHaveAttribute("title", "等待用户处理");
  await expect(dot).toHaveCSS("background-color", "rgb(244, 189, 98)");
  await expect(page.getByRole("button", { name: /林舟 · 防雨服装，/ }).locator(".resource-tree__pending-dot"))
    .toHaveCount(0);
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
  await expect(page.getByText("这是一个空的图片对象。后续可以在这里编辑内容或添加媒体。")).toBeVisible();

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
  await expect(promptDock.getByRole("textbox", { name: "生成提示词" })).toHaveValue("28岁东亚女性，冷静克制，正面与左右侧面角色设定图");
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
  await expect(workspace.locator("video[controls]")).toBeVisible();
  await expect(workspace.locator(".media-viewer-video-notice")).toHaveText("视频源尚未就绪");
  await expect(workspace.getByRole("group", { name: "图片缩放控制" })).toHaveCount(0);
});

test("媒体占满中心内容区域，提示词编辑器悬浮在底部", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: /林舟 · 面部三视图，/ }).click();

  const geometry = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".canvas-body.media-canvas-body")!.getBoundingClientRect();
    const frame = document.querySelector<HTMLElement>(".media-viewer-frame")!.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>(".media-prompt-dock")!.getBoundingClientRect();
    const style = getComputedStyle(document.querySelector<HTMLElement>(".media-viewer-frame")!);
    return {
      body: { top: body.top, left: body.left, width: body.width, height: body.height, bottom: body.bottom },
      frame: { top: frame.top, left: frame.left, width: frame.width, height: frame.height, bottom: frame.bottom },
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
  await expect(imagePrompt).toHaveValue("冷静克制的角色三视图\n");
  await imagePrompt.type("保持五官一致");
  await imagePrompt.press("Enter");
  await expect(page.locator(".media-prompt-composer").getByRole("status"))
    .toHaveText("图片生成任务已提交");
  await expect(page.locator(".media-viewer-state")).toContainText("媒体正在生成");
  await expect(page.getByRole("button", { name: /林舟 · 面部三视图，/ }).locator(".resource-tree__pending-dot"))
    .toHaveCount(0);

  await page.getByRole("button", { name: /生成版本 03，/ }).click();
  const videoPrompt = page.getByRole("textbox", { name: "生成提示词" });
  await videoPrompt.fill("镜头缓慢前推，雨幕形成视差");
  await page.getByRole("button", { name: "发送并生成视频" }).click();
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

test("AI 脚本建议以 Git 式差异展示，确认后更新正式脚本与版本", async ({ page }) => {
  const before = "雨水打在金属顶棚上。林舟停在桥下短暂对峙的入口，确认终端上闪烁的坐标后继续向前。镜头从环境全景缓慢推进到她手中的信号终端。";
  const proposed = "雨水敲击金属顶棚。\n林舟在桥下入口停步，重新确认终端坐标。\n镜头从环境全景缓慢推进到闪烁的信号终端。";
  const proposal = {
    id: "proposal-script-review",
    projectId: "10000000-0000-4000-8000-000000000001",
    storyboardId: "20000000-0000-4000-8000-000000000012",
    target: { type: "script", storyboardId: "20000000-0000-4000-8000-000000000012" },
    baseRevision: 6,
    beforeValue: before,
    proposedValue: proposed,
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

  await page.route("**/api/v1/projects/**/storyboards/**/proposals?**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([proposal]) }),
  );
  await page.route("**/api/v1/projects/**/storyboards/20000000-0000-4000-8000-000000000012/script", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: before, revision: 6, updatedAt: "2026-09-26T08:00:00.000Z" }),
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
        proposal: { ...proposal, status: "applied", revision: 2, resolvedAt: "2026-09-26T08:01:00.000Z" },
        target: { type: "script", revision: 7 },
        generationJob: null,
      }),
    });
  });

  await page.goto("/?fixture=ready");

  await expect(page.getByRole("textbox", { name: "脚本内容" })).toHaveCount(0);
  await expect(page.locator(".proposal-panel")).toHaveCount(0);
  await expect(page.getByText("AI 修改建议")).toHaveCount(0);
  await expect(page.locator(".script-save-state")).toHaveCount(0);
  await expect(page.locator(".proposal-diff--editor")).toBeVisible();
  await expect(page.locator(".proposal-diff__line--removed")).toContainText(before);
  await expect(page.locator(".proposal-diff__line--added")).toHaveCount(3);
  await expect(page.locator(".proposal-diff--editor .proposal-diff__marker").first()).toHaveCSS("display", "none");
  await expect(page.locator(".proposal-diff--editor .proposal-diff__number").first()).toHaveCSS("display", "none");
  await expect(page.locator(".proposal-diff--editor code").first()).toHaveCSS(
    "font-family",
    /Noto Serif SC|Songti SC|Microsoft YaHei/,
  );
  const headerActions = page.locator(".script-editor-actions");
  await expect(headerActions.getByRole("button", { name: "取消建议" })).toBeVisible();
  await expect(headerActions.getByRole("button", { name: "确认并应用" })).toBeVisible();

  await headerActions.getByRole("button", { name: "确认并应用" }).click();

  const editor = page.getByRole("textbox", { name: "脚本内容" });
  await expect(editor).toHaveValue(proposed);
  await expect(page.locator(".script-editor-feedback")).toContainText("版本 7");
  await expect(page.locator(".proposal-diff--editor")).toHaveCount(0);
});

test("W2-D：切换分镜创建独立会话，返回时恢复原绑定", async ({ page }) => {
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

test("W2-E：同一分镜可从标题下拉切换会话", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /.+/);
  const firstThread = await panel.getAttribute("data-thread-id");

  await page.getByRole("button", { name: "新建对话" }).click();
  await expect(panel).not.toHaveAttribute("data-thread-id", firstThread!);

  const switcher = page.getByRole("button", { name: /切换对话，当前：/ });
  await switcher.click();
  const options = page.locator(".thread-menu-item");
  await expect.poll(() => options.count()).toBeGreaterThanOrEqual(2);
  await page.locator(`.thread-menu-item[data-thread-id="${firstThread}"]`).click();

  await expect(panel).toHaveAttribute("data-thread-id", firstThread!);
  await expect(page.locator(".assistant-titlebar")).toHaveCount(0);
  await expect(page.locator(".conversation-header")).toHaveCount(0);
});
