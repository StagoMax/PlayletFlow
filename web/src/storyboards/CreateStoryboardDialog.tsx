import { useEffect, useRef, useState, type FormEvent } from "react";

type CreateStoryboardDialogProps = {
  open: boolean;
  defaultName: string;
  sourceName?: string;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
};

export function CreateStoryboardDialog(props: CreateStoryboardDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(props.defaultName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      dialog.showModal();
      nameRef.current?.focus();
      nameRef.current?.select();
    }
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    setName(props.defaultName);
    setError("");
  }, [props.defaultName, props.open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await props.onCreate(name.trim());
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建片段失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog storyboard-create-dialog"
      aria-labelledby="storyboard-create-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) props.onClose();
      }}
      onClose={props.onClose}
    >
      <form className="ui-dialog__content" onSubmit={(event) => void submit(event)}>
        <header className="ui-dialog__header">
          <div><strong className="ui-dialog__title" id="storyboard-create-title">新建片段</strong><p className="ui-dialog__description">{props.sourceName ? `插入到“${props.sourceName}”之后` : "创建项目的第一个片段"}</p></div>
        </header>
        <label className="ui-field">
          <span className="ui-field__label">片段名称</span>
          <input ref={nameRef} className="ui-input" value={name} maxLength={200} aria-invalid={Boolean(error)} aria-describedby={error ? "storyboard-create-error" : undefined} onChange={(event) => setName(event.target.value)} />
        </label>
        {error ? <p className="ui-field__error" id="storyboard-create-error" role="alert">{error}</p> : null}
        <footer className="ui-dialog__actions"><button type="button" className="ui-button" onClick={props.onClose} disabled={saving}>取消</button><button type="submit" className="ui-button ui-button--primary" disabled={saving || !name.trim()}>{saving ? "创建中…" : "创建并切换"}</button></footer>
      </form>
    </dialog>
  );
}
