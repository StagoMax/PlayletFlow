import type { StoryboardDetail } from "../productApi/generated";
import type { WorkspaceSnapshot } from "../workspace/types";
import type { StoryboardClient } from "./storyboardClient";

// The Vercel runtime has no durable storyboard API. Keep browser-owned
// storyboards behind the same client boundary used by the local server.
export function createBrowserStoryboardClient(read: () => WorkspaceSnapshot): StoryboardClient {
  const requireStoryboard = (projectId: string, storyboardId: string) => {
    const snapshot = read();
    if (snapshot.project.id !== projectId) throw new Error("项目不存在。");
    const storyboard = snapshot.workspaces[storyboardId]?.storyboard;
    if (!storyboard) throw new Error("片段不存在。");
    return storyboard;
  };
  return {
    async listAll(projectId) {
      const snapshot = read();
      return snapshot.project.id === projectId ? snapshot.storyboards : [];
    },
    async get(projectId, storyboardId) {
      return requireStoryboard(projectId, storyboardId);
    },
    async create(projectId, request) {
      const snapshot = read();
      if (snapshot.project.id !== projectId) throw new Error("项目不存在。");
      const now = new Date().toISOString();
      const storyboard: StoryboardDetail = {
        id: crypto.randomUUID(),
        projectId,
        name: request.name.trim(),
        position: String(Date.now()),
        index: snapshot.storyboards.length + 1,
        revision: 1,
        pendingProposalCount: 0,
        thumbnail: null,
        updatedAt: now,
        createdAt: now,
        script: { text: "", revision: 1, updatedAt: now },
        counts: { assetBindings: 0, keyframes: 0, videos: 0 },
      };
      return { storyboard, assetCopy: { created: 0, skipped: 0, failed: [] } };
    },
    async update(projectId, storyboardId, request) {
      const source = requireStoryboard(projectId, storyboardId);
      if (source.revision !== request.expectedRevision) throw new Error("片段已更新，请刷新后重试。");
      return { ...source, name: request.name.trim(), revision: source.revision + 1,
        updatedAt: new Date().toISOString() };
    },
    async delete(projectId, storyboardId, expectedRevision) {
      const source = requireStoryboard(projectId, storyboardId);
      if (source.revision !== expectedRevision) throw new Error("片段已更新，请刷新后重试。");
    },
    async duplicate(projectId, storyboardId) {
      const source = requireStoryboard(projectId, storyboardId);
      const now = new Date().toISOString();
      return { ...source, id: crypto.randomUUID(), name: `${source.name} 副本`,
        revision: 1, updatedAt: now, createdAt: now,
        script: { ...source.script, revision: 1, updatedAt: now } };
    },
    async reorder(projectId, storyboardId, request) {
      const source = requireStoryboard(projectId, storyboardId);
      if (source.revision !== request.expectedRevision) throw new Error("片段已更新，请刷新后重试。");
      return { ...source, revision: source.revision + 1, updatedAt: new Date().toISOString() };
    },
    async getScript(projectId, storyboardId) {
      return requireStoryboard(projectId, storyboardId).script;
    },
    async updateScript(projectId, storyboardId, request) {
      const source = requireStoryboard(projectId, storyboardId);
      if (source.script.revision !== request.expectedRevision) throw new Error("脚本已更新，请刷新后重试。");
      return { text: request.text, revision: source.script.revision + 1, updatedAt: new Date().toISOString() };
    },
  };
}
