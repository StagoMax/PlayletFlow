import { expect, test, type Page } from "@playwright/test";

async function createIn(page: Page, folder: string, kind: string, name: string) {
  await page.getByRole("button", { name: folder, exact: true }).hover();
  await page.getByRole("button", { name: `在${folder}中新建` }).click();
  await page.getByRole("menuitem", { name: kind }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "名称" }).fill(name);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

test("新片段中的虚拟目录可以创建各类节点并在刷新后保留", async ({ page }) => {
  const createRequests: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/workspace-nodes")) {
      createRequests.push(request.postDataJSON());
    }
  });
  await page.goto("/?fixture=ready");
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const storyboardName = `节点创建回归-${suffix}`;
  const imageName = `图片-${suffix}`;
  const folderName = `分类-${suffix}`;
  const nestedName = `子目录-${suffix}`;
  const textName = `文本-${suffix}`;
  const videoName = `视频-${suffix}`;

  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建片段" }).click();
  const storyboardDialog = page.getByRole("dialog", { name: "新建片段" });
  await storyboardDialog.getByRole("textbox").fill(storyboardName);
  await storyboardDialog.getByRole("button", { name: "创建并切换" }).click();
  await expect(page.locator(".storyboard-trigger")).toContainText(storyboardName);

  await createIn(page, "资产", "图片对象", imageName);
  await createIn(page, "资产", "新建文件夹", folderName);
  await createIn(page, folderName, "新建文件夹", nestedName);
  await createIn(page, nestedName, "文本对象", textName);
  await createIn(page, nestedName, "视频对象", videoName);
  expect(createRequests.length).toBeGreaterThan(0);
  for (const body of createRequests) expect(body).not.toHaveProperty("id");

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("option", { name: new RegExp(storyboardName) }).click();
  for (const name of [imageName, folderName, nestedName, textName, videoName]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
});

test("已有片段的角色目录创建图片后保留原有媒体", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const imageName = `角色图片-${Date.now()}`;
  await createIn(page, "林舟", "图片对象", imageName);

  await page.reload();
  await expect(page.getByRole("button", { name: imageName, exact: true })).toBeVisible();
  await expect(page.locator(".resource-tree__object").filter({ hasText: "面部三视图" })).toHaveCount(1);
  await expect(page.locator(".resource-tree__object").filter({ hasText: "防雨服装" })).toHaveCount(1);

  await page.getByRole("button", { name: imageName, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("dialog", { name: "删除资源" }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: imageName, exact: true })).toHaveCount(0);
});

test("复制片段后资源树不重复展示原有媒体", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.locator(".storyboard-trigger").click();
  await page.locator('.storyboard-option[data-storyboard-id="20000000-0000-4000-8000-000000000012"]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制片段" }).click();
  await expect(page.locator(".storyboard-trigger")).toContainText("副本");
  await expect(page.locator(".resource-tree__object").filter({ hasText: "面部三视图" })).toHaveCount(1);
  await expect(page.locator(".resource-tree__object").filter({ hasText: "防雨服装" })).toHaveCount(1);

  const imageName = `副本图片-${Date.now()}`;
  await createIn(page, "林舟", "图片对象", imageName);
  await page.locator(".storyboard-trigger").click();
  const copyId = await page.locator('.storyboard-option[aria-selected="true"]')
    .getAttribute("data-storyboard-id");
  expect(copyId).toBeTruthy();
  const response = await page.request.get(
    `/api/v1/projects/10000000-0000-4000-8000-000000000001/storyboards/${copyId}/workspace-nodes`,
  );
  expect(response.ok()).toBe(true);
  const nodes = await response.json() as { parentId: string | null; name: string }[];
  expect(nodes.filter((node) => node.parentId === null && node.name === "资产")).toHaveLength(1);

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await page.locator(`.storyboard-option[data-storyboard-id="${copyId}"]`).click();
  await expect(page.getByRole("button", { name: imageName, exact: true })).toBeVisible();
  await expect(page.locator(".resource-tree__object").filter({ hasText: "面部三视图" })).toHaveCount(1);
});
