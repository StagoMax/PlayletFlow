import type { WorkspaceSnapshot } from "./types";

const tokenKey = "videoflow:cloud-workspace-key:v1";
// v1 used HTTP If-Match, which Vercel could answer after a successful write
// with 412. A missing v2 revision marks a local draft that needs one rebase.
const revisionKey = "videoflow:cloud-workspace-revision:v2";
const dirtyKey = "videoflow:cloud-workspace-dirty:v1";
let etag: string | null = null;
let pending: WorkspaceSnapshot | null = null;
let timer: number | undefined;
let sending: Promise<void> = Promise.resolve();

export function cloudWorkspaceKey() {
  let value = localStorage.getItem(tokenKey);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(tokenKey, value);
  }
  return value;
}

function headers(extra: Record<string, string> = {}) {
  return { "X-Videoflow-Workspace-Key": cloudWorkspaceKey(), ...extra };
}

async function error(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error || `工作区同步失败 (${response.status})`);
}

export async function readCloudWorkspace(): Promise<WorkspaceSnapshot | null> {
  const response = await fetch("/api/cloud-workspace", { headers: headers() });
  if (response.status === 404) return null;
  if (!response.ok) throw await error(response);
  etag = response.headers.get("x-videoflow-revision");
  if (!etag) throw new Error("云端工作区缺少版本号。");
  if (!localStorage.getItem(dirtyKey)) localStorage.setItem(revisionKey, etag);
  return response.json() as Promise<WorkspaceSnapshot>;
}

async function writeCloudWorkspace(snapshot: WorkspaceSnapshot) {
  if (!etag) throw new Error("云端工作区尚未初始化。");
  const response = await fetch("/api/cloud-workspace", {
    method: "PUT",
    headers: headers({ "Content-Type": "application/json", "X-Videoflow-Revision": etag }),
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw await error(response);
  etag = response.headers.get("x-videoflow-revision");
  if (etag) localStorage.setItem(revisionKey, etag);
  localStorage.removeItem(dirtyKey);
  window.dispatchEvent(new CustomEvent("videoflow:cloud-workspace-sync", { detail: null }));
}

export async function initializeCloudWorkspace(local: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
  const localRevision = localStorage.getItem(revisionKey);
  const hasPendingLocalEdits = Boolean(localStorage.getItem(dirtyKey));
  const remote = await readCloudWorkspace();
  if (remote) {
    if (!hasPendingLocalEdits) return remote;
    if (JSON.stringify(remote) === JSON.stringify(local)) {
      localStorage.setItem(revisionKey, etag!);
      localStorage.removeItem(dirtyKey);
      return remote;
    }
    if (localRevision && localRevision !== etag) throw new Error("本地和云端工作区都有新修改，请先备份本地数据再解决冲突。");
    await writeCloudWorkspace(local);
    return local;
  }
  const response = await fetch("/api/cloud-workspace", {
    method: "PUT",
    headers: headers({ "Content-Type": "application/json", "X-Videoflow-Create": "1" }),
    body: JSON.stringify(local),
  });
  if (response.status === 412) return await readCloudWorkspace() ?? local;
  if (!response.ok) throw await error(response);
  etag = response.headers.get("x-videoflow-revision");
  if (etag) localStorage.setItem(revisionKey, etag);
  localStorage.removeItem(dirtyKey);
  window.dispatchEvent(new CustomEvent("videoflow:cloud-workspace-sync", { detail: null }));
  return local;
}

export function queueCloudWorkspaceSave(snapshot: WorkspaceSnapshot) {
  pending = snapshot;
  localStorage.setItem(dirtyKey, "1");
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = undefined;
    void flushCloudWorkspace().catch((cause) => {
      console.error("云端工作区同步失败", cause);
      window.dispatchEvent(new CustomEvent("videoflow:cloud-workspace-sync", {
        detail: cause instanceof Error ? cause.message : String(cause),
      }));
    });
  }, 300);
}

export async function flushCloudWorkspace(): Promise<void> {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  if (!pending) return sending;
  const snapshot = pending;
  pending = null;
  sending = sending.catch(() => undefined).then(() => writeCloudWorkspace(snapshot));
  try { await sending; }
  catch (cause) {
    pending ??= snapshot;
    throw cause;
  }
  if (pending) await flushCloudWorkspace();
}
