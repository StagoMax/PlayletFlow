import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  appType: "custom",
  logLevel: "error",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

const cases = await server.ssrLoadModule("/src/preview/previewTestCases.tsx");
const previewCss = await readFile(new URL("../src/preview/preview.css", import.meta.url), "utf8");

test("preview components preserve media semantics and states", async (context) => {
  for (const [name, run] of Object.entries(cases.previewTestCases)) {
    await context.test(name, () => {
      const result = run();
      assert.equal(result.ok, true, result.message);
    });
  }
});

test("thumbnail crops while hover and main previews preserve the full frame", () => {
  assert.match(previewCss, /\.media-thumbnail > img[\s\S]*?object-fit:\s*cover/);
  assert.match(previewCss, /\.hover-preview-media img,[\s\S]*?object-fit:\s*contain/);
  assert.match(previewCss, /\.media-viewer-image,[\s\S]*?object-fit:\s*contain/);
});

test.after(async () => {
  await server.close();
});
