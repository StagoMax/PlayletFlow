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
const composerModule = await server.ssrLoadModule("/src/composer/composerTestCases.ts");
const proposalModule = await server.ssrLoadModule("/src/proposals/proposalTestCases.tsx");
const workspaceModule = await server.ssrLoadModule("/src/workspace/workspaceTestCases.ts");
const cases = {
  ...assetModule.assetTestCases,
  ...composerModule.composerTestCases,
  ...proposalModule.proposalTestCases,
  ...workspaceModule.workspaceTestCases,
};

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
