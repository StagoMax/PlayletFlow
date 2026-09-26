import { useState } from "react";
import { CreateStoryboardDialog } from "../storyboards/CreateStoryboardDialog";
import { Icon } from "./Icons";

export function WorkspaceLoading() {
  return (
    <div className="workspace-state-shell" role="status" aria-label="正在加载工作区">
      <aside className="skeleton-column"><div className="skeleton skeleton-title" />{Array.from({ length: 7 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}</aside>
      <main className="skeleton-main"><div className="skeleton skeleton-bar" /><div className="skeleton skeleton-stage" /></main>
      <aside className="skeleton-column"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-stage" /></aside>
      <span className="sr-only">正在加载项目与片段内容…</span>
    </div>
  );
}

export function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="full-page-state" role="alert">
      <span className="state-icon error"><Icon name="alert" /></span>
      <p className="state-eyebrow">工作区加载失败</p>
      <h1>暂时无法打开这个项目</h1>
      <p>{message}</p>
      <button type="button" className="primary-button" onClick={onRetry}><Icon name="refresh" />重新加载</button>
    </div>
  );
}

export function WorkspaceEmpty({ projectName, onCreate }: { projectName: string; onCreate: (name: string) => Promise<void> }) {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <div className="full-page-state">
        <span className="state-icon"><Icon name="film" /></span>
        <p className="state-eyebrow">{projectName}</p>
        <h1>从第一个片段开始</h1>
        <p>这个项目还没有片段。创建一个片段，开始制作。</p>
        <button type="button" className="primary-button" onClick={() => setCreateOpen(true)}>新建片段</button>
      </div>
      <CreateStoryboardDialog open={createOpen} defaultName="片段 1" onClose={() => setCreateOpen(false)} onCreate={onCreate} />
    </>
  );
}
