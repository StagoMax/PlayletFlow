import { expect, test, type Locator, type Page } from "@playwright/test";

async function dragSeparator(page: Page, separator: Locator, distance: number) {
  const box = await separator.boundingBox();
  if (!box) throw new Error("Separator is not visible");
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 200);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 5 });
  await page.mouse.up();
}

test("两条分隔线可调整宽度，保留设置并保障脚本区空间", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?fixture=ready");

  const navigator = page.getByRole("separator", { name: "调整左侧导航宽度" });
  const assistant = page.getByRole("separator", { name: "调整右侧 AI 对话宽度" });
  await expect(navigator).toHaveAttribute("aria-valuenow", "264");
  await expect(assistant).toHaveAttribute("aria-valuenow", "360");

  await dragSeparator(page, navigator, 80);
  await expect(navigator).toHaveAttribute("aria-valuenow", "344");
  await dragSeparator(page, assistant, -90);
  await expect(assistant).toHaveAttribute("aria-valuenow", "450");

  await assistant.focus();
  await assistant.press("ArrowRight");
  await expect(assistant).toHaveAttribute("aria-valuenow", "434");

  await page.reload();
  await expect(navigator).toHaveAttribute("aria-valuenow", "344");
  await expect(assistant).toHaveAttribute("aria-valuenow", "434");

  await page.setViewportSize({ width: 1000, height: 900 });
  const canvas = page.locator(".workspace-canvas");
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(360);
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(navigator).toHaveAttribute("aria-valuenow", "344");
  await expect(assistant).toHaveAttribute("aria-valuenow", "434");

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(navigator).toBeHidden();
  await expect(assistant).toBeHidden();
});
