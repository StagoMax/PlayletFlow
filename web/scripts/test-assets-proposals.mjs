import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({
  root,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true },
});

const assetModule = await server.ssrLoadModule("/src/assets/assetTestCases.tsx");
const proposalModule = await server.ssrLoadModule("/src/proposals/proposalTestCases.tsx");
const cases = { ...assetModule.assetTestCases, ...proposalModule.proposalTestCases };

test("asset and proposal UI module cases", async (context) => {
  for (const [name, run] of Object.entries(cases)) {
    await context.test(name, () => {
      const result = run();
      assert.equal(result.ok, true, result.message);
    });
  }
});

test.after(async () => {
  await server.close();
});
