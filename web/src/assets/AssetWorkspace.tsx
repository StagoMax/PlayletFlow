import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetBinding, AssetSection, StoryboardSummary } from "../productApi/generated";
import type { AssetWorkspaceClient } from "./assetWorkspaceClient";
import { AssetPickerDialog } from "./AssetPickerDialog";
import { AssetSectionTree } from "./AssetSectionTree";
import { CopyAssetBindingsDialog } from "./CopyAssetBindingsDialog";
import type { AssetPreviewRenderer } from "./assetPreview";
import "./assets.css";

type AssetWorkspaceProps = {
  client: AssetWorkspaceClient;
  projectId: string;
  storyboardId: string;
  storyboards: StoryboardSummary[];
  selectedBindingId?: string | null;
  pendingByBindingId?: Readonly<Record<string, number>>;
  onSelectBinding?: (binding: AssetBinding) => void;
  onCreateSection?: (parent: AssetSection | null) => void;
  renderPreview?: AssetPreviewRenderer;
};

export function AssetWorkspace(props: AssetWorkspaceProps) {
  const contextKey = `${props.projectId}:${props.storyboardId}`;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const [sections, setSections] = useState<AssetSection[]>([]);
  const [bindings, setBindings] = useState<AssetBinding[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [pickerSection, setPickerSection] = useState<AssetSection | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setError("");
    void Promise.all([
      props.client.listSections(props.projectId, props.storyboardId, controller.signal),
      props.client.listBindings(props.projectId, props.storyboardId, controller.signal),
    ])
      .then(([nextSections, nextBindings]) => {
        setSections(nextSections);
        setBindings(nextBindings);
        setStatus("ready");
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(String(cause));
        setStatus("error");
      });
    return () => controller.abort();
  }, [props.client, props.projectId, props.storyboardId, reloadToken]);

  const boundAssetIds = useMemo(() => new Set(bindings.map((binding) => binding.assetId)), [bindings]);

  async function addBindings(assetIds: string[]) {
    if (!pickerSection) return;
    const operationContext = contextKey;
    setSubmitting(true);
    setError("");
    try {
      const created = await props.client.createBindings(
        props.projectId,
        props.storyboardId,
        { sectionId: pickerSection.id, assetIds },
        crypto.randomUUID(),
      );
      if (contextKeyRef.current !== operationContext) return;
      setBindings((current) => [...current, ...created]);
      setPickerSection(null);
    } catch (cause) {
      if (contextKeyRef.current !== operationContext) return;
      setError(String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "loading") return <div className="asset-workspace-state" aria-busy="true">正在加载资产分区…</div>;
  if (status === "error") return <div className="asset-workspace-state" role="alert"><strong>资产加载失败</strong><p>{error}</p><button type="button" onClick={() => setReloadToken((value) => value + 1)}>重试</button></div>;

  return (
    <section className="asset-workspace" aria-label="当前分镜资产">
      <header className="asset-workspace__header"><div><strong>资产</strong><small>{bindings.length} 个共享资产引用</small></div><button type="button" onClick={() => setCopyOpen(true)} disabled={bindings.length === 0}>复制到其他分镜</button></header>
      {error ? <p role="alert" className="asset-dialog__error">{error}</p> : null}
      <AssetSectionTree
        sections={sections}
        bindings={bindings}
        selectedBindingId={props.selectedBindingId}
        pendingByBindingId={props.pendingByBindingId}
        onSelectBinding={props.onSelectBinding}
        onAddAsset={setPickerSection}
        onCreateSection={props.onCreateSection}
        renderPreview={props.renderPreview}
      />
      <AssetPickerDialog
        open={pickerSection !== null}
        client={props.client}
        projectId={props.projectId}
        sectionName={pickerSection?.name ?? "资产"}
        alreadyBoundAssetIds={boundAssetIds}
        submitting={submitting}
        onClose={() => setPickerSection(null)}
        onConfirm={addBindings}
        renderPreview={props.renderPreview}
      />
      <CopyAssetBindingsDialog
        open={copyOpen}
        client={props.client}
        projectId={props.projectId}
        sourceStoryboardId={props.storyboardId}
        bindings={bindings}
        targetStoryboards={props.storyboards}
        onClose={() => setCopyOpen(false)}
        renderPreview={props.renderPreview}
      />
    </section>
  );
}
