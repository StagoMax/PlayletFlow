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
