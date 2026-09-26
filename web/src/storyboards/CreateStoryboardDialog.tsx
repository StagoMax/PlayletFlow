import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssetBinding, AssetCopySummary } from "../productApi/generated";

export type CreateStoryboardInput = {
  name: string;
  bindingIds: string[];
  includePromptOverrides: boolean;
};

type CreateStoryboardDialogProps = {
  open: boolean;
  defaultName: string;
  sourceName: string;
  loadBindings: (signal: AbortSignal) => Promise<AssetBinding[]>;
  onClose: () => void;
  onCreate: (input: CreateStoryboardInput) => Promise<AssetCopySummary>;
};

export function CreateStoryboardDialog(props: CreateStoryboardDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(props.defaultName);
  const [bindings, setBindings] = useState<AssetBinding[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includePrompts, setIncludePrompts] = useState(false);
  const [loadingBindings, setLoadingBindings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const controller = new AbortController();
    setName(props.defaultName);
    setBindings([]);
    setSelected(new Set());
    setIncludePrompts(false);
    setError("");
    setLoadingBindings(true);
    void props.loadBindings(controller.signal).then(
      (items) => {
        setBindings(items);
        setLoadingBindings(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? `资产列表加载失败：${cause.message}` : "资产列表加载失败。仍可创建空白分镜。");
        setLoadingBindings(false);
      },
    );
    return () => controller.abort();
  }, [props.defaultName, props.loadBindings, props.open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await props.onCreate({
        name: name.trim(),
        bindingIds: [...selected],
        includePromptOverrides: includePrompts,
      });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建分镜失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  const allSelected = bindings.length > 0 && selected.size === bindings.length;
  return (
    <dialog
      ref={dialogRef}
      className="storyboard-create-dialog"
      aria-labelledby="storyboard-create-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) props.onClose();
      }}
      onClose={props.onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <header>
          <div><strong id="storyboard-create-title">新建分镜</strong><p>新分镜会插入到“{props.sourceName}”之后。</p></div>
          <button type="button" aria-label="关闭新建分镜对话框" onClick={props.onClose} disabled={saving}>×</button>
        </header>
        <label className="storyboard-create-field">
          <span>分镜名称</span>
          <input value={name} maxLength={200} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset>
          <legend>复用当前分镜资产（可选）</legend>
          {loadingBindings ? <p className="storyboard-create-note">正在读取可复用资产…</p> : null}
          {!loadingBindings && bindings.length === 0 ? <p className="storyboard-create-note">当前分镜没有可复用的资产引用，将创建空白分镜。</p> : null}
          {bindings.length > 0 ? (
            <>
              <label className="storyboard-create-check-all"><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(bindings.map((item) => item.id)) : new Set())} />全选 {bindings.length} 项</label>
              <div className="storyboard-create-assets">
                {bindings.map((binding) => (
                  <label key={binding.id}>
                    <input type="checkbox" checked={selected.has(binding.id)} onChange={(event) => setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(binding.id); else next.delete(binding.id);
                      return next;
                    })} />
                    <span><strong>{binding.asset.name}</strong><small>{binding.asset.type}</small></span>
                  </label>
                ))}
              </div>
              <label className="storyboard-create-check-all"><input type="checkbox" checked={includePrompts} disabled={selected.size === 0} onChange={(event) => setIncludePrompts(event.target.checked)} />同时复用分镜级提示词覆盖</label>
            </>
          ) : null}
        </fieldset>
        <p className="storyboard-create-note">只会创建新的分区和引用，不会复制共享资产或媒体文件。</p>
        {error ? <p className="storyboard-create-error" role="alert">{error}</p> : null}
        <footer><button type="button" onClick={props.onClose} disabled={saving}>取消</button><button type="submit" className="is-primary" disabled={saving || !name.trim()}>{saving ? "创建中…" : "创建并切换"}</button></footer>
      </form>
    </dialog>
  );
}
