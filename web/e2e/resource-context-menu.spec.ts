import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
  "base64",
);

test("资源右键可重命名、复制和删除，刷新后保持结果", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const suffix = Date.now();
  const folder = `右键目录-${suffix}`;
  const image = `右键图片-${suffix}`;
  const renamed = `已改名图片-${suffix}`;

  await page.getByRole("button", { name: "资产", exact: true }).hover();
  await page.getByRole("button", { name: "在资产中新建" }).click();
  await page.getByRole("menuitem", { name: "新建文件夹" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "名称" }).fill(folder);
  await page.getByRole("dialog").getByRole("button", { name: "创建" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: folder, exact: true }).hover();
  await page.getByRole("button", { name: `在${folder}中新建` }).click();
  await page.getByRole("menuitem", { name: "图片对象" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "名称" }).fill(image);
  await page.getByRole("dialog").getByRole("button", { name: "创建" }).click();
  await page.getByRole("button", { name: image, exact: true }).click();
  await page.getByLabel("选择图片文件").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: tinyPng });
  await expect(page.getByRole("img", { name: image })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新上传图片" })).toHaveCount(0);

  await page.getByRole("button", { name: image, exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["重命名", "复制", "下载", "删除"]);
  const imageDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载" }).click();
  const downloadedImage = await imageDownload;
  expect(downloadedImage.suggestedFilename()).toBe(`${image}.png`);
  expect(await readFile(await downloadedImage.path())).toEqual(tinyPng);

  await page.getByRole("button", { name: image, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.getByRole("dialog", { name: "重命名资源" }).getByRole("textbox", { name: "名称" }).fill(renamed);
  await page.getByRole("dialog", { name: "重命名资源" }).getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: renamed, exact: true })).toBeVisible();

  await page.getByRole("button", { name: folder, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制" }).click();
  await expect(page.getByRole("button", { name: `${folder} 副本`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: renamed, exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: folder, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await expect(page.getByRole("dialog", { name: "删除资源" })).toContainText("文件夹内的所有资源也会删除");
  await page.getByRole("dialog", { name: "删除资源" }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: folder, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: renamed, exact: true })).toHaveCount(1);

  await page.reload();
  await expect(page.getByRole("button", { name: folder, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${folder} 副本`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: renamed, exact: true }).click();
  await expect(page.getByRole("img", { name: renamed })).toBeVisible();
});

test("脚本与视频可下载，未上传的媒体不可下载", async ({ page }) => {
  await page.goto("/?fixture=ready");
  await page.getByRole("button", { name: "该片段的脚本", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["重命名", "下载"]);
  const scriptDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载" }).click();
  const script = await scriptDownload;
  expect(script.suggestedFilename()).toBe("该片段的脚本.txt");
  expect((await readFile(await script.path(), "utf8")).length).toBeGreaterThan(0);

  await page.getByRole("button", { name: /^生成版本 03，可预览/ }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "下载" })).toBeVisible();
  const videoDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "下载" }).click();
  const video = await videoDownload;
  expect(video.suggestedFilename()).toBe("生成版本 03.webm");
  expect((await readFile(await video.path())).subarray(0, 4).toString("hex")).toBe("1a45dfa3");

  await page.getByRole("button", { name: "资产", exact: true }).hover();
  await page.getByRole("button", { name: "在资产中新建" }).click();
  await page.getByRole("menuitem", { name: "图片对象" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "名称" }).fill("尚未上传图片");
  await page.getByRole("dialog").getByRole("button", { name: "创建" }).click();
  await page.getByRole("button", { name: "尚未上传图片", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "下载" })).toBeDisabled();
});

test("新片段的默认目录也可右键编辑", async ({ page }) => {
  await page.goto("/?fixture=ready");
  const suffix = Date.now();
  const storyboard = `默认目录右键-${suffix}`;
  const renamedStoryboard = `${storyboard}-已改名`;
  const renamed = `资料-${suffix}`;
  await page.locator(".storyboard-trigger").click();
  await page.getByRole("button", { name: "新建片段" }).click();
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("textbox").fill(storyboard);
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("button", { name: "创建并切换" }).click();
  await expect(page.locator(".storyboard-trigger")).toContainText(storyboard);

  await page.getByRole("button", { name: storyboard, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.getByRole("dialog", { name: "重命名片段" }).getByRole("textbox", { name: "名称" }).fill(renamedStoryboard);
  await page.getByRole("dialog", { name: "重命名片段" }).getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".storyboard-trigger")).toContainText(renamedStoryboard);
  await page.getByRole("button", { name: "该片段的脚本", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "重命名" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "复制" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "删除" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: renamedStoryboard, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制" }).click();
  const copiedStoryboard = `${renamedStoryboard}（副本）`;
  await expect(page.getByRole("button", { name: copiedStoryboard, exact: true })).toBeVisible();
  await page.getByRole("button", { name: copiedStoryboard, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await expect(page.getByRole("dialog", { name: "删除片段" })).toContainText("片段内的脚本和所有资源也会删除");
  await page.getByRole("dialog", { name: "删除片段" }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: copiedStoryboard, exact: true })).toHaveCount(0);
  await page.locator(".storyboard-trigger").click();
  await expect(page.getByRole("option", { name: new RegExp(copiedStoryboard) })).toHaveCount(0);
  await page.getByRole("option", { name: new RegExp(renamedStoryboard) }).click();
  await expect(page.getByRole("button", { name: renamedStoryboard, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "资产", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名" }).click();
  await page.getByRole("dialog", { name: "重命名资源" }).getByRole("textbox", { name: "名称" }).fill(renamed);
  await page.getByRole("dialog", { name: "重命名资源" }).getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("button", { name: renamed, exact: true })).toBeVisible();

  await page.getByRole("button", { name: renamed, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "复制" }).click();
  await expect(page.getByRole("button", { name: `${renamed} 副本`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: renamed, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await page.getByRole("dialog", { name: "删除资源" }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: renamed, exact: true })).toHaveCount(0);

  await page.reload();
  await page.locator(".storyboard-trigger").click();
  await expect(page.getByRole("option", { name: new RegExp(copiedStoryboard) })).toHaveCount(0);
  await page.getByRole("option", { name: new RegExp(renamedStoryboard) }).click();
  await expect(page.locator(".storyboard-trigger")).toContainText(renamedStoryboard);
  await expect(page.getByRole("button", { name: renamed, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `${renamed} 副本`, exact: true })).toBeVisible();
});

test("删除工作区中的最后一个片段会创建空白片段", async ({ page }) => {
  await page.goto("/?fixture=empty");
  const name = `待删除片段-${Date.now()}`;
  await page.getByRole("button", { name: "新建片段" }).click();
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("textbox").fill(name);
  await page.getByRole("dialog", { name: "新建片段" }).getByRole("button", { name: "创建并切换" }).click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();

  await page.getByRole("button", { name, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除" }).click();
  await expect(page.getByRole("dialog", { name: "删除片段" })).toContainText("系统会创建一个空白片段");
  await page.getByRole("dialog", { name: "删除片段" }).getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: "新片段", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "该片段的脚本", exact: true })).toBeVisible();
});
