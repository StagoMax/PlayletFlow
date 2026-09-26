import { expect, test, type Page } from "@playwright/test";

async function createFreshThread(page: Page) {
  const panel = page.locator(".runtime-panel");
  await expect(panel).toHaveAttribute("data-thread-id", /^[0-9a-f-]+$/u);
  const previousThreadId = await panel.getAttribute("data-thread-id");
  await page.getByRole("button", { name: "新建对话" }).click();
  await expect.poll(() => panel.getAttribute("data-thread-id")).not.toBe(previousThreadId);
}

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
