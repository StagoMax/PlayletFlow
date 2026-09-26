import { expect, test } from "@playwright/test";

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
  const panel = page.locator(".runtime-panel");
  const previousThreadId = await panel.getAttribute("data-thread-id");
  await page.getByRole("button", { name: "新建对话" }).click();
  await expect.poll(async () => {
    const currentThreadId = await panel.getAttribute("data-thread-id");
    return Boolean(currentThreadId && currentThreadId !== previousThreadId);
  }).toBe(true);

  const composer = page.getByRole("textbox", { name: "输入消息" });
  await composer.fill("请用两句话说明这个分镜的重点。");
  const send = page.getByRole("button", { name: "发送消息" });
  await expect(send).toBeEnabled();
  await send.evaluate((button: HTMLButtonElement) => button.click());
  await turnRequestSeen;

  await expect(page.getByRole("button", { name: "停止运行" })).toBeVisible();
  await expect(page.locator(".message.user")).toContainText("请用两句话说明这个分镜的重点。");
  await expect(page.locator(".turn-activity-heading")).toContainText("处理中");
  releaseTurnRequest();
  await expect(page.locator(".message.user")).toContainText("请用两句话说明这个分镜的重点。");
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
