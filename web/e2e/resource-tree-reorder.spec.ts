import { expect, test, type Page } from "@playwright/test";

async function createFolder(page: Page, parent: string, name: string) {
  await page.getByRole("button", { name: parent, exact: true }).hover();
  await page.getByRole("button", { name: `在${parent}中新建` }).click();
  await page.getByRole("menuitem", { name: "新建文件夹" }).click();
  const dialog = page.getByRole("dialog", { name: "新建文件夹" });
  await dialog.getByRole("textbox", { name: "名称" }).fill(name);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function createTextObject(page: Page, parent: string, name: string) {
  await page.getByRole("button", { name: parent, exact: true }).hover();
  await page.getByRole("button", { name: `在${parent}中新建` }).click();
  await page.getByRole("menuitem", { name: "文本对象" }).click();
  const dialog = page.getByRole("dialog", { name: "新建文本对象" });
  await dialog.getByRole("textbox", { name: "名称" }).fill(name);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("资源树可跨层级拖到指定位置，刷新后保持结构和顺序", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建片段" }).click();
  const dialog = page.getByRole("dialog", { name: "新建片段" });
  const storyboardName = `资源排序-${Date.now()}`;
  await dialog.getByRole("textbox").fill(storyboardName);
  await dialog.getByRole("button", { name: "创建并切换" }).click();

  const roots = page.locator(".resource-tree > li > .resource-tree__folder .resource-tree__folder-name");
  const rootNames = roots.locator(".resource-tree__node-label");
  await expect(rootNames).toHaveText(["脚本", "资产", "视频"]);
  const video = roots.filter({ hasText: "视频" });
  const asset = roots.filter({ hasText: "资产" });
  expect(await video.evaluate((element) => getComputedStyle(element).cursor)).not.toBe("grab");
  const bounds = await video.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  expect(await video.evaluate((element) => getComputedStyle(element).cursor)).toBe("grabbing");
  await page.mouse.up();
  await video.dragTo(asset, { targetPosition: { x: 50, y: 3 }, steps: 10 });
  await expect(rootNames).toHaveText(["脚本", "视频", "资产"]);

  await createFolder(page, "资产", "目录甲");
  await createFolder(page, "资产", "目录乙");
  const children = page.locator(".resource-tree > li").filter({ has: page.locator(".resource-tree__folder-name", { hasText: "资产" }) })
    .first().locator(":scope > ul > li > .resource-tree__folder .resource-tree__folder-name");
  const childNames = children.locator(".resource-tree__node-label");
  await expect(childNames).toHaveText(["目录甲", "目录乙"]);
  await children.filter({ hasText: "目录乙" }).dragTo(children.filter({ hasText: "目录甲" }),
    { targetPosition: { x: 50, y: 3 }, steps: 10 });
  await expect(childNames).toHaveText(["目录乙", "目录甲"]);

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  await expect(rootNames).toHaveText(["脚本", "视频", "资产"]);
  await expect(childNames).toHaveText(["目录乙", "目录甲"]);

  await children.filter({ hasText: "目录乙" }).dragTo(children.filter({ hasText: "目录甲" }),
    { targetPosition: { x: 50, y: 18 }, steps: 10 });
  await expect(childNames).toHaveText(["目录甲"]);
  const nestedNames = page.locator(".resource-tree__folder-name", { hasText: "目录甲" }).first()
    .locator("xpath=../following-sibling::ul/child::li/div/button/span[contains(@class, 'resource-tree__node-label')]");
  await expect(nestedNames).toHaveText(["目录乙"]);
  await page.getByRole("button", { name: "目录甲", exact: true })
    .dragTo(page.getByRole("button", { name: "目录乙", exact: true }), { steps: 10 });
  await expect(nestedNames).toHaveText(["目录乙"]);

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  await expect(nestedNames).toHaveText(["目录乙"]);

  await page.locator(".resource-tree__folder-name", { hasText: "目录乙" }).dragTo(page.locator(".resource-tree__root-name"), { steps: 10 });
  await expect(rootNames).toHaveText(["脚本", "视频", "资产", "目录乙"]);
  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  await expect(rootNames).toHaveText(["脚本", "视频", "资产", "目录乙"]);

  await createTextObject(page, "目录乙", "测试文本");
  await page.getByRole("button", { name: "测试文本", exact: true })
    .dragTo(page.getByRole("button", { name: "目录甲", exact: true }), { steps: 10 });
  const movedObject = page.locator(".resource-tree__folder-name", { hasText: "目录甲" }).first()
    .locator("xpath=../following-sibling::ul/child::li/button[contains(@class, 'resource-tree__object')]");
  await expect(movedObject).toHaveText("测试文本");
  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  await expect(movedObject).toHaveText("测试文本");

  await createTextObject(page, "目录乙", "前置文本");
  await page.getByRole("button", { name: "前置文本", exact: true })
    .dragTo(page.getByRole("button", { name: "测试文本", exact: true }),
      { targetPosition: { x: 50, y: 3 }, steps: 10 });
  await expect(movedObject).toHaveText(["前置文本", "测试文本"]);
  await createTextObject(page, "目录乙", "后置文本");
  await page.getByRole("button", { name: "后置文本", exact: true })
    .dragTo(page.getByRole("button", { name: "测试文本", exact: true }),
      { targetPosition: { x: 50, y: 33 }, steps: 10 });
  await expect(movedObject).toHaveText(["前置文本", "测试文本", "后置文本"]);

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  await expect(movedObject).toHaveText(["前置文本", "测试文本", "后置文本"]);

  await createFolder(page, "目录甲", "目录丙");
  await page.getByRole("button", { name: "目录乙", exact: true })
    .dragTo(page.getByRole("button", { name: "目录丙", exact: true }),
      { targetPosition: { x: 50, y: 3 }, steps: 10 });
  await expect(nestedNames).toHaveText(["目录乙", "目录丙"]);
  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  await expect(nestedNames).toHaveText(["目录乙", "目录丙"]);
});
