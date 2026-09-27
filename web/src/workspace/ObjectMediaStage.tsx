import type { DragEvent } from "react";
import type { MediaItem, MediaKind } from "../productApi/generated";
import type { MediaSubmissionState } from "../preview/MediaPromptComposer";
import { MediaViewer } from "../preview/MediaViewer";
import { Icon } from "./Icons";
import "./objectMediaStage.css";

type ObjectMediaStageProps = {
  kind: MediaKind;
  name: string;
  media: MediaItem | null;
  submission: MediaSubmissionState;
  loading: boolean;
  uploading: boolean;
  dragging: boolean;
  error: string;
  onUploadClick: () => void;
  onPreviewClick?: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
};

export function ObjectMediaStage({
  kind, name, media, submission, loading, uploading, dragging, error,
  onUploadClick, onPreviewClick, onDragOver, onDragLeave, onDrop,
}: ObjectMediaStageProps) {
  const label = kind === "video" ? "视频" : "图片";
  const submitting = submission.status === "submitting";
  const failure = submission.status === "error"
    ? submission.message
    : error || (media?.status === "failed" ? media.generation?.error || "生成服务没有返回可预览内容。" : "");

  if (submitting || (!failure && media?.status === "processing")) {
    return (
      <section className="object-media-generation-stage" aria-label={`${label}生成状态`} role="status" aria-live="polite">
        <div className="object-media-generation-lights" aria-hidden="true"><span /><span /><span /></div>
        <div className="object-media-generation-content">
          <span className="object-media-generation-symbol" aria-hidden="true"><Icon name={kind === "image" ? "image" : "film"} /></span>
          <span className="object-media-generation-eyebrow">AI 创作中</span>
          <strong>{submitting ? `正在提交${label}生成` : `正在生成${label}`}</strong>
          <p>{submitting ? "正在准备素材并发送生成请求…" : "任务已提交，生成完成后将在这里直接显示。"}</p>
          {!submitting && media?.prompt ? <p className="object-media-generation-prompt" title={media.prompt}>{media.prompt}</p> : null}
        </div>
      </section>
    );
  }

  if (failure) {
    return (
      <section className={`object-media-result-stage is-failed${dragging ? " is-dragging" : ""}`}
        aria-label={`${label}生成失败`} role="alert"
        onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <span className="object-media-result-icon" aria-hidden="true"><Icon name={kind === "image" ? "image" : "film"} /></span>
        <strong>{uploading ? `正在上传${label}…` : `${label}生成失败`}</strong>
        <p className="object-media-failure-reason">{failure}</p>
        <button type="button" onClick={onUploadClick} disabled={loading || uploading}>上传{label}</button>
        <span>也可以拖放文件到这里，或修改提示词后重新生成</span>
      </section>
    );
  }

  if (media?.status === "ready") {
    return <MediaViewer item={{ id: media.id, name, description: "", label, accent: "var(--accent)", media }}
      onPreviewClick={onPreviewClick} />;
  }

  return (
    <button type="button" className={`object-media-upload-zone${dragging ? " is-dragging" : ""}`}
      disabled={loading || uploading}
      aria-label={`点击上传${label}`}
      aria-describedby={`object-media-generation-hint-${media?.id ?? name}`}
      onClick={onUploadClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <span className="object-media-upload-icon"><Icon name={kind === "image" ? "image" : "film"} /></span>
      <strong>{uploading ? `正在上传${label}…` : loading ? `正在准备${label}…` : `点击上传${label}`}</strong>
      <span id={`object-media-generation-hint-${media?.id ?? name}`} className="object-media-generation-hint">或在下方输入提示词生成{label}</span>
      <span>{kind === "image" ? "支持 JPEG、PNG、WebP" : "支持 MP4、MOV"} · 也可拖放文件到这里</span>
    </button>
  );
}
