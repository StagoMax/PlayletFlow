import { Icon } from "./Icons";

export function WorkspaceLoading() {
  return (
    <div className="workspace-state-shell" role="status" aria-label="正在加载工作区">
      <aside className="skeleton-column"><div className="skeleton skeleton-title" />{Array.from({ length: 7 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}</aside>
      <main className="skeleton-main"><div className="skeleton skeleton-bar" /><div className="skeleton skeleton-stage" /></main>
      <aside className="skeleton-column"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-stage" /></aside>
      <span className="sr-only">正在加载项目与分镜内容…</span>
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

export function WorkspaceEmpty({ projectName }: { projectName: string }) {
  return (
    <div className="full-page-state">
      <span className="state-icon"><Icon name="film" /></span>
      <p className="state-eyebrow">{projectName}</p>
      <h1>从第一个分镜开始</h1>
      <p>这个项目还没有分镜。创建能力将在分镜写接口接入后开放。</p>
    </div>
  );
}
