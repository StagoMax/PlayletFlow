import { expect, test, type Page } from "@playwright/test";

async function createFreshThread(page: Page) {
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /^[0-9a-f-]+$/u);
  const previousThreadId = await panel.getAttribute("data-thread-id");
  await page.getByRole("button", { name: "新建对话" }).click();
  await expect.poll(() => panel.getAttribute("data-thread-id")).not.toBe(previousThreadId);
}

test("会话列表支持右键删除，当前会话删除后自动切换", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /^[0-9a-f-]+$/u);
  const firstId = await panel.getAttribute("data-thread-id");
  await createFreshThread(page);
  const secondId = await panel.getAttribute("data-thread-id");
  const trigger = page.locator(".thread-trigger");

  await trigger.click();
  const menuHeight = await page.locator(".thread-menu").evaluate((element) => element.getBoundingClientRect().height);
  await page.locator(`.thread-menu-item[data-thread-id="${firstId}"]`).click({ button: "right" });
  await expect(page.locator(".thread-context-menu")).toHaveCSS("position", "fixed");
  await expect(page.locator(".thread-menu .thread-context-menu")).toHaveCount(0);
  expect(await page.locator(".thread-menu").evaluate((element) => element.getBoundingClientRect().height)).toBe(menuHeight);
  await expect(page.getByRole("menuitem", { name: "删除会话" })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "删除会话" }).click();
  await expect(panel).toHaveAttribute("data-thread-id", secondId!);
  const deletedThread = await page.request.get(`/api/threads/${firstId}/messages`);
  expect(deletedThread.status()).toBe(404);

  await trigger.click();
  await expect(page.locator(`.thread-menu-item[data-thread-id="${firstId}"]`)).toHaveCount(0);
  await page.locator(`.thread-menu-item[data-thread-id="${secondId}"]`).click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "删除会话" }).click();
  await expect.poll(() => panel.getAttribute("data-thread-id")).not.toBe(secondId);
  await expect(panel).toHaveAttribute("data-thread-id", /^[0-9a-f-]+$/u);

  await page.reload();
  await expect(panel).toHaveAttribute("data-thread-id", /^[0-9a-f-]+$/u);
  await trigger.click();
  await expect(page.locator(`.thread-menu-item[data-thread-id="${secondId}"]`)).toHaveCount(0);
});

test("AI 对话收起后释放工作区，并通过悬浮入口恢复原状态", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /^[0-9a-f-]+$/u);
  const threadId = await panel.getAttribute("data-thread-id");
  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("保留这段未发送的草稿");

  const canvasWidthBefore = await page.locator(".workspace-canvas").evaluate((element) => (
    element.getBoundingClientRect().width
  ));
  await page.getByRole("button", { name: "收起 AI 对话" }).click();

  const launcher = page.getByRole("button", { name: "与 AI 对话" });
  await expect(page.locator(".workspace-assistant")).toBeHidden();
  await expect(launcher).toBeVisible();
  await expect(launcher).toBeFocused();
  const canvasWidthAfter = await page.locator(".workspace-canvas").evaluate((element) => (
    element.getBoundingClientRect().width
  ));
  expect(canvasWidthAfter).toBeGreaterThan(canvasWidthBefore);

  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-thread-id", threadId!);
  await expect(composer).toHaveText("保留这段未发送的草稿");
  await expect(page.getByRole("button", { name: "收起 AI 对话" })).toBeFocused();
});

test("收起入口吸附右边界，并支持悬停展开和拖动定位", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: "收起 AI 对话" }).click();
  const launcher = page.getByRole("button", { name: "与 AI 对话" });
  await expect(launcher).toBeVisible();
  await launcher.evaluate((element: HTMLButtonElement) => element.blur());
  await page.mouse.move(100, 100);

  const viewport = page.viewportSize()!;
  await expect.poll(async () => (await launcher.boundingBox())?.x).toBe(viewport.width - 52);
  const compactBox = await launcher.boundingBox();
  expect(compactBox).not.toBeNull();
  await expect(launcher.locator("span")).toHaveCSS("visibility", "hidden");

  await launcher.hover();
  await expect.poll(async () => (await launcher.boundingBox())?.x).toBeLessThan(compactBox!.x - 60);
  const expandedBox = await launcher.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.x).toBeLessThan(compactBox!.x - 60);
  expect(expandedBox!.width).toBeLessThan(140);
  await expect(launcher.locator("span")).toHaveCSS("visibility", "visible");

  const dragX = viewport.width - 24;
  const dragStartY = expandedBox!.y + expandedBox!.height / 2;
  const dragEndY = Math.max(40, dragStartY - 120);
  await page.mouse.move(dragX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragX, dragEndY, { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(100, 100);

  const movedBox = await launcher.boundingBox();
  expect(movedBox).not.toBeNull();
  expect(movedBox!.y).toBeLessThan(expandedBox!.y - 80);
  await expect(page.locator(".workspace-assistant")).toBeHidden();

  await launcher.click();
  await expect(page.locator(".workspace-assistant")).toBeVisible();
  await page.getByRole("button", { name: "收起 AI 对话" }).click();
  await launcher.evaluate((element: HTMLButtonElement) => element.blur());
  await page.mouse.move(100, 100);
  const restoredBox = await launcher.boundingBox();
  expect(restoredBox).not.toBeNull();
  expect(Math.abs(restoredBox!.y - movedBox!.y)).toBeLessThanOrEqual(1);
});

test("Topia 式对话把一次 Turn 连续呈现并保持 Composer 交互", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  let releaseTurnRequest!: () => void;
  let markTurnRequestSeen!: () => void;
  const turnRequestReleased = new Promise<void>((resolve) => { releaseTurnRequest = resolve; });
  const turnRequestSeen = new Promise<void>((resolve) => { markTurnRequestSeen = resolve; });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.route("**/api/threads/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      markTurnRequestSeen();
      await turnRequestReleased;
    }
    await route.continue();
  });

  await page.goto("/?fixture=ready");
  await expect(page.getByText("当前连接的是演示后端，只会固定回显消息，不会调用真实模型或分镜工具。")).toBeVisible();
  await expect(page.getByRole("status", { name: "当前 Agent 模型" })).toContainText("mock-fixture");
  await createFreshThread(page);

  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("请用两句话说明这个片段的重点。");
  const send = page.getByRole("button", { name: "发送消息" });
  await expect(send).toBeEnabled();
  await send.evaluate((button: HTMLButtonElement) => button.click());
  await turnRequestSeen;

  await expect(page.getByRole("button", { name: "停止运行" })).toBeVisible();
  await expect(page.locator(".message.user")).toContainText("请用两句话说明这个片段的重点。");
  await expect(page.getByRole("button", { name: "切换对话，当前：请用两句话说明这个片段的重点。" })).toBeVisible();
  await expect(page.locator(".turn-activity-heading")).toContainText("处理中");
  releaseTurnRequest();
  await expect(page.locator(".message.user")).toContainText("请用两句话说明这个片段的重点。");
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  await expect(page.locator(".message.assistant")).toContainText("OpenTopia MVP mock provider received");
  await expect(page.locator(".turn-activity-heading")).toContainText("已处理");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
  await expect(page.locator(".activity-layer-label")).toHaveCount(0);

  const geometry = await page.evaluate(() => {
    const user = document.querySelector<HTMLElement>(".message.user .message-body")!.getBoundingClientRect();
    const assistant = document.querySelector<HTMLElement>(".message.assistant .message-body")!;
    const turn = document.querySelector<HTMLElement>(".conversation-turn")!.getBoundingClientRect();
    return {
      userWidth: user.width,
      turnWidth: turn.width,
      assistantBackground: getComputedStyle(assistant).backgroundColor,
      assistantFontSize: getComputedStyle(assistant).fontSize,
    };
  });
  expect(geometry.userWidth).toBeLessThan(geometry.turnWidth * 0.9);
  expect(geometry.assistantBackground).toBe("rgba(0, 0, 0, 0)");
  expect(geometry.assistantFontSize).toBe("14px");

  const initialHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  await composer.fill("第一行\n第二行\n第三行\n第四行");
  await expect.poll(() => composer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(initialHeight);
  const expandedHeight = await composer.evaluate((element) => element.getBoundingClientRect().height);
  expect(expandedHeight).toBeGreaterThan(initialHeight);
  expect(expandedHeight).toBeLessThanOrEqual(150);

  await page.locator(".workspace-assistant").screenshot({
    path: testInfo.outputPath("conversation-topia.png"),
  });
  expect(browserErrors).toEqual([]);
});

test("消息引用保持结构化，并复用工作区导航和媒体预览", async ({ page }) => {
  const sentBodies: Array<{ contentParts?: Array<Record<string, unknown>> }> = [];
  await page.route("**/api/threads/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      sentBodies.push(route.request().postDataJSON());
    }
    await route.continue();
  });

  await page.goto("/?fixture=ready");
  await createFreshThread(page);
  const composer = page.getByRole("textbox", { name: "输入消息" });

  await composer.fill("@片段");
  await page.getByRole("option", { name: "片段脚本" }).click();
  await composer.press("End");
  await composer.type(" 把开头改得更紧张。");
  await page.getByRole("button", { name: "发送消息" }).click();

  const firstUserMessage = page.locator(".message.user").last();
  const scriptReference = firstUserMessage.getByRole("button", { name: "打开片段脚本" });
  await expect(scriptReference).toBeVisible();
  await expect(firstUserMessage).not.toContainText("引用资产：");
  await expect(firstUserMessage.locator("time")).toHaveCount(0);
  await expect.poll(() => sentBodies.length).toBeGreaterThan(0);
  expect(sentBodies[0].contentParts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "asset_ref", assetId: expect.stringMatching(/^script-/u) }),
  ]));

  const scriptTreeItem = page.getByRole("button", { name: "该片段的脚本" });
  await page.locator(".resource-tree__object:not(.script-card)").first().click();
  await expect(scriptTreeItem).toHaveAttribute("aria-pressed", "false");
  await scriptReference.click();
  await expect(scriptTreeItem).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".workspace-canvas .script-editor")).toBeVisible();

  await expect(page.getByRole("button", { name: "发送消息" })).toBeVisible();
  await composer.fill("@首帧");
  await page.getByRole("option", { name: "首帧" }).click();
  await composer.press("End");
  await composer.type(" 检查这张画面。");
  await page.getByRole("button", { name: "发送消息" }).click();

  const imageReference = page.locator(".message.user").last().getByRole("button", { name: "预览首帧" });
  await expect(imageReference).toBeVisible();
  await imageReference.click();
  await expect(page.getByRole("tooltip", { name: "首帧大预览" })).toBeVisible();
  expect(sentBodies[1].contentParts).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "asset_ref", assetId: "first-frame-12" }),
  ]));
});
