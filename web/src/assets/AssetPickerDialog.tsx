import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { Asset, AssetKind } from "../productApi/generated";
import { assetKindLabel, type AssetWorkspaceClient } from "./assetWorkspaceClient";
import type { AssetPreviewRenderer } from "./assetPreview";
import "./assets.css";

type AssetPickerDialogProps = {
  open: boolean;
  client: AssetWorkspaceClient;
  projectId: string;
  sectionName: string;
  alreadyBoundAssetIds?: ReadonlySet<string>;
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (assetIds: string[]) => Promise<void> | void;
  renderPreview?: AssetPreviewRenderer;
};

const KINDS: Array<AssetKind | "all"> = ["all", "character", "scene", "prop", "custom"];
const EMPTY_ASSET_IDS: ReadonlySet<string> = new Set();

export function AssetPickerDialog({
  open,
  client,
  projectId,
  sectionName,
  alreadyBoundAssetIds = EMPTY_ASSET_IDS,
  submitting = false,
  onClose,
  onConfirm,
  renderPreview,
}: AssetPickerDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resultsVersionRef = useRef(0);
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [assets, setAssets] = useState<Asset[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) setSelected(new Set());
  }, [open]);

  useEffect(() => {
    const requestVersion = resultsVersionRef.current + 1;
    resultsVersionRef.current = requestVersion;
    if (!open) return;
    const controller = new AbortController();
    setStatus("loading");
    setError("");
    void client
      .listAssets(projectId, {
        type: kind === "all" ? undefined : kind,
        query: deferredQuery || undefined,
        limit: 50,
      }, controller.signal)
      .then((page) => {
        if (resultsVersionRef.current !== requestVersion) return;
        setAssets(page.items);
        setNextCursor(page.page.nextCursor);
        setStatus("idle");
      })
      .catch((cause) => {
        if (controller.signal.aborted || resultsVersionRef.current !== requestVersion) return;
        setError(String(cause));
        setStatus("error");
      });
    return () => controller.abort();
  }, [client, deferredQuery, kind, open, projectId]);

  function toggle(assetId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  async function loadMore() {
    if (!nextCursor || status === "loading") return;
    const requestVersion = resultsVersionRef.current;
    setStatus("loading");
    try {
      const page = await client.listAssets(projectId, {
        type: kind === "all" ? undefined : kind,
        query: deferredQuery || undefined,
        cursor: nextCursor,
        limit: 50,
      });
      if (resultsVersionRef.current !== requestVersion) return;
      setAssets((current) => [...current, ...page.items]);
      setNextCursor(page.page.nextCursor);
      setStatus("idle");
    } catch (cause) {
      if (resultsVersionRef.current !== requestVersion) return;
      setError(String(cause));
      setStatus("error");
    }
  }

  return (
    <dialog ref={dialogRef} className="asset-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <header className="asset-dialog__header">
          <div><strong>向“{sectionName}”添加资产</strong><p>选择项目共享资产，只会创建引用，不会复制文件。</p></div>
          <button type="button" className="asset-dialog__close" onClick={onClose} aria-label="关闭资产选择器">×</button>
        </header>
        <div className="asset-picker__filters">
          <label><span className="sr-only">搜索共享资产</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或描述" autoFocus /></label>
          <div className="asset-kind-tabs" role="group" aria-label="资产类型">
            {KINDS.map((value) => (
              <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>
                {value === "all" ? "全部" : assetKindLabel(value)}
              </button>
            ))}
          </div>
        </div>
        <div className="asset-picker__results" aria-busy={status === "loading"}>
          {status === "loading" && assets.length === 0 ? <p className="asset-dialog__state">正在加载共享资产…</p> : null}
          {status === "error" ? <p role="alert" className="asset-dialog__error">{error}</p> : null}
          {status !== "loading" && status !== "error" && assets.length === 0 ? <p className="asset-dialog__state">没有匹配资产。可以稍后通过“新建资产”创建占位资产。</p> : null}
          <div className="asset-picker__grid">
            {assets.map((asset) => {
              const bound = alreadyBoundAssetIds.has(asset.id);
              const representation = asset.representations.find((item) => item.mediaId !== null) ?? asset.representations[0];
              const preview = representation?.mediaId && renderPreview
                ? renderPreview(asset, representation.mediaId)
                : asset.name.slice(0, 2);
              return (
                <label key={asset.id} className={`asset-picker-card${selected.has(asset.id) ? " is-selected" : ""}${bound ? " is-disabled" : ""}`}>
                  <input type="checkbox" checked={selected.has(asset.id)} disabled={bound} onChange={() => toggle(asset.id)} />
                  <span className="asset-picker-card__preview" aria-hidden="true">{preview}</span>
                  <span><strong>{asset.name}</strong><small>{assetKindLabel(asset.type)} · 被 {asset.referenceCount} 个片段使用</small></span>
                  {bound ? <em>已添加</em> : null}
                </label>
              );
            })}
          </div>
          {nextCursor ? <button type="button" className="asset-load-more" onClick={() => void loadMore()} disabled={status === "loading"}>{status === "loading" ? "加载中…" : "加载更多"}</button> : null}
        </div>
        <footer className="asset-dialog__footer">
          <span aria-live="polite">已选择 {selected.size} 项</span>
          <div><button type="button" onClick={onClose}>取消</button><button type="button" className="is-primary" disabled={selected.size === 0 || submitting} onClick={() => void onConfirm([...selected])}>{submitting ? "添加中…" : "添加引用"}</button></div>
        </footer>
      </form>
    </dialog>
  );
}
