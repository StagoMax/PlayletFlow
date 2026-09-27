import { expect, test } from "@playwright/test";

test("右键复制片段并拖拽排序，刷新后保持顺序", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.locator(".storyboard-trigger").click();
  const options = page.locator(".storyboard-option");
  const source = page.locator('.storyboard-option[data-storyboard-id="20000000-0000-4000-8000-000000000012"]');
  const sourceId = await source.getAttribute("data-storyboard-id");
  expect(sourceId).toBeTruthy();
  const before = await options.count();

  await source.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "复制片段" })).toBeVisible();
  await page.getByRole("menuitem", { name: "复制片段" }).click();
  await expect(page.locator(".storyboard-trigger")).toHaveAttribute("aria-label", /当前片段 \d+：桥下短暂对峙（副本）/);
  await page.locator(".storyboard-trigger").click();
  await expect(options).toHaveCount(before + 1);
  const copy = options.filter({ hasText: "桥下短暂对峙（副本）" }).and(
    page.locator('.storyboard-option[aria-selected="true"]'));
  const copyId = await copy.getAttribute("data-storyboard-id");
  expect(copyId).toBeTruthy();
  await expect(copy).toHaveAttribute("aria-selected", "true");

  await copy.dragTo(source, { targetPosition: { x: 50, y: 3 } });
  await expect.poll(async () => {
    const ids = await options.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-storyboard-id")));
    return ids.indexOf(copyId) < ids.indexOf(sourceId);
  }).toBe(true);

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await expect.poll(async () => {
    const ids = await page.locator(".storyboard-option").evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-storyboard-id")));
    return ids.indexOf(copyId) < ids.indexOf(sourceId);
  }).toBe(true);
  await page.locator(`.storyboard-option[data-storyboard-id="${copyId}"]`).click();
  const firstFrame = page.getByRole("tree", { name: "片段资源树" })
    .getByRole("button", { name: /首帧，可预览/ });
  await expect(firstFrame).toBeVisible();
  await firstFrame.click();
  await expect(page.locator(".workspace-canvas")).toContainText("首帧");
  await expect(page.locator(".workspace-canvas")).not.toContainText("未选择内容");
});

test("悬停片段时显示更多按钮，并对对应片段执行删除", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建片段" }).click();
  const first = `待删除 A ${Date.now()}`;
  const second = `待删除 B ${Date.now()}`;
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("textbox").fill(first);
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("button", { name: "创建并切换" }).click();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建片段" }).click();
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("textbox").fill(second);
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("button", { name: "创建并切换" }).click();

  await page.locator(".storyboard-trigger").click();
  await expect(page.getByRole("button", { name: "当前片段操作" })).toHaveCount(0);
  const firstOption = page.getByRole("option", { name: new RegExp(first) });
  const firstMore = page.getByRole("button", { name: `${first}的更多操作` });
  await expect(firstMore).toHaveCSS("opacity", "0");
  await firstOption.hover();
  await expect(firstMore).toHaveCSS("opacity", "1");
  await firstMore.click();
  await expect(page.locator(".storyboard-trigger")).toHaveAttribute("aria-label", new RegExp(second));
  await page.getByRole("menuitem", { name: "删除片段" }).click();
  await expect(page.getByRole("dialog", { name: "删除片段" })).toContainText(first);
  await page.getByRole("dialog", { name: "删除片段" }).getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".storyboard-trigger")).toHaveAttribute("aria-label", new RegExp(second));
  await page.locator(".storyboard-trigger").click();
  await expect(page.getByRole("option", { name: new RegExp(first) })).toHaveCount(0);
  await page.getByRole("option", { name: new RegExp(second) }).hover();
  await page.getByRole("button", { name: `${second}的更多操作` }).click();
  await page.getByRole("menuitem", { name: "删除片段" }).click();
  await expect(page.getByRole("dialog", { name: "删除片段" })).toContainText(second);
  await page.getByRole("dialog", { name: "删除片段" }).getByRole("button", { name: "删除" }).click();
  await page.locator(".storyboard-trigger").click();
  await expect(page.getByRole("option", { name: new RegExp(second) })).toHaveCount(0);
});
