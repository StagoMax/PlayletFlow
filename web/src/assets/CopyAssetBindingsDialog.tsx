import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetBinding, AssetSection, CopyAssetBindingsResponse, StoryboardSummary } from "../productApi/generated";
import type { AssetWorkspaceClient } from "./assetWorkspaceClient";
import { AssetBindingCard } from "./AssetBindingCard";
import type { AssetPreviewRenderer } from "./assetPreview";
import "./assets.css";

type CopyAssetBindingsDialogProps = {
  open: boolean;
  client: AssetWorkspaceClient;
  projectId: string;
  sourceStoryboardId: string;
  bindings: AssetBinding[];
  targetStoryboards: StoryboardSummary[];
  onClose: () => void;
  onCompleted?: (result: CopyAssetBindingsResponse) => void;
  renderPreview?: AssetPreviewRenderer;
};

export function CopyAssetBindingsDialog(props: CopyAssetBindingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const targets = useMemo(() => props.targetStoryboards.filter((item) => item.id !== props.sourceStoryboardId), [props.sourceStoryboardId, props.targetStoryboards]);
  const [targetStoryboardId, setTargetStoryboardId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includePrompts, setIncludePrompts] = useState(false);
  const [targetSections, setTargetSections] = useState<AssetSection[]>([]);
  const [targetSectionId, setTargetSectionId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CopyAssetBindingsResponse | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  useEffect(() => {
    if (props.open) return;
    setTargetStoryboardId("");
    setSelected(new Set());
    setTargetSectionId("");
    setError("");
    setResult(null);
  }, [props.open]);

  useEffect(() => {
    if (!props.open || includeStructure || !targetStoryboardId) {
      setTargetSections([]);
      setTargetSectionId("");
      return;
    }
    const controller = new AbortController();
    void props.client
      .listSections(props.projectId, targetStoryboardId, controller.signal)
      .then(setTargetSections)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => controller.abort();
  }, [includeStructure, props.client, props.open, props.projectId, targetStoryboardId]);

  function toggle(bindingId: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(bindingId);
      else next.delete(bindingId);
      return next;
    });
  }

  async function submit() {
    if (!targetStoryboardId || selected.size === 0 || (!includeStructure && !targetSectionId)) return;
    setSubmitting(true);
    setError("");
    setResult(null);
    try {
      const response = await props.client.copyBindings(
        props.projectId,
        props.sourceStoryboardId,
        {
          targetStoryboardId,
          bindingIds: [...selected],
          includeSectionStructure: includeStructure,
          targetSectionId: includeStructure ? null : targetSectionId,
          includePromptOverrides: includePrompts,
          onDuplicate: "skip",
        },
        crypto.randomUUID(),
      );
      setResult(response);
      props.onCompleted?.(response);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="asset-dialog asset-copy-dialog" onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClose={props.onClose}>
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <header className="asset-dialog__header"><div><strong>复制资产引用</strong><p>共享资产和源媒体不会被复制。</p></div><button type="button" className="asset-dialog__close" onClick={props.onClose} aria-label="关闭复制对话框">×</button></header>
        <div className="asset-copy-dialog__body">
          <label className="asset-field"><span>目标分镜</span><select value={targetStoryboardId} onChange={(event) => setTargetStoryboardId(event.target.value)}><option value="">请选择目标分镜</option>{targets.map((storyboard) => <option key={storyboard.id} value={storyboard.id}>{storyboard.index}. {storyboard.name}</option>)}</select></label>
          <fieldset><legend>选择引用</legend><div className="asset-copy-dialog__bindings">{props.bindings.map((binding) => <AssetBindingCard key={binding.id} binding={binding} checked={selected.has(binding.id)} onCheckedChange={toggle} renderPreview={props.renderPreview} />)}</div></fieldset>
          <fieldset className="asset-copy-options"><legend>复制方式</legend><label><input type="checkbox" checked={includeStructure} onChange={(event) => setIncludeStructure(event.target.checked)} />复用原分区结构</label>{!includeStructure ? <label className="asset-field"><span>统一放入目标分区</span><select value={targetSectionId} onChange={(event) => setTargetSectionId(event.target.value)}><option value="">请选择分区</option>{targetSections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></label> : null}<label><input type="checkbox" checked={includePrompts} onChange={(event) => setIncludePrompts(event.target.checked)} />同时复制分镜级提示词覆盖</label></fieldset>
          {error ? <p className="asset-dialog__error" role="alert">{error}</p> : null}
          {result ? <div className="asset-copy-report" role="status"><strong>复制完成</strong><span>新增 {result.createdBindingIds.length} 项</span><span>跳过 {result.skipped.length} 项</span>{result.skipped.length > 0 ? <small>目标分镜已有相同资产，已按 skip 策略跳过。</small> : null}</div> : null}
        </div>
        <footer className="asset-dialog__footer"><span>已选择 {selected.size} 项引用</span><div><button type="button" onClick={props.onClose}>关闭</button><button type="button" className="is-primary" disabled={submitting || result !== null || !targetStoryboardId || selected.size === 0 || (!includeStructure && !targetSectionId)} onClick={() => void submit()}>{submitting ? "复制中…" : result ? "复制完成" : "复制引用"}</button></div></footer>
      </form>
    </dialog>
  );
}
