import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { folderPath } from "../workspace/resourceTree";
import { Icon } from "../workspace/Icons";
import { useWorkspace } from "../workspace/WorkspaceContext";
import type { WorkspaceObjectType } from "../workspace/types";
import { ResourceTree, type ResourceCreationIntent } from "./ResourceTree";

type CreationIntent = ResourceCreationIntent;

const objectTypeLabel: Record<WorkspaceObjectType, string> = {
  text: "文本",
  image: "图片",
  video: "视频",
};

export function ContentNavigator({
  pendingUserActionTargets,
}: {
  pendingUserActionTargets: ReadonlySet<string>;
}) {
  const { data, current, state, dispatch, createFolder, createObject } = useWorkspace();
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [intent, setIntent] = useState<CreationIntent | null>(null);
  const targetPath = useMemo(
    () => folderPath(current.navigationTree, selectedFolderId),
    [current.navigationTree, selectedFolderId],
  );
  const items = useMemo(
    () => [...current.assetGroups, ...current.videoGroups].flatMap((group) => group.items),
    [current.assetGroups, current.videoGroups],
  );
  useEffect(() => {
    setSelectedFolderId(null);
    setIntent(null);
  }, [current.storyboard.id]);

  return (
    <nav className="content-navigator resource-browser" aria-label="分镜资源">
      <ResourceTree
        rootName={current.storyboard.name}
        nodes={current.navigationTree}
        items={items}
        scriptText={current.storyboard.script.text}
        selection={state.selection}
        selectedFolderId={selectedFolderId}
        pendingUserActionTargets={pendingUserActionTargets}
        onSelectFolder={setSelectedFolderId}
        onSelectObject={(selection) => dispatch({ type: "contentSelected", selection })}
        onCreateRequest={(folderId, nextIntent) => {
          setSelectedFolderId(folderId);
          setIntent(nextIntent);
        }}
      />

      {intent ? (
        <CreateResourceDialog
          intent={intent}
          targetPath={targetPath.length > 0 ? targetPath : [current.storyboard.name]}
          onCancel={() => setIntent(null)}
          onCreate={async (name) => {
            if (intent.kind === "folder") {
              await createFolder(current.storyboard.id, selectedFolderId, name);
            } else {
              const node = await createObject(current.storyboard.id, selectedFolderId, name, intent.objectType);
              dispatch({ type: "contentSelected", selection: node.selection });
            }
            setIntent(null);
          }}
        />
      ) : null}
    </nav>
  );
}

function CreateResourceDialog({
  intent,
  targetPath,
  onCancel,
  onCreate,
}: {
  intent: CreationIntent;
  targetPath: string[];
  onCancel: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const objectLabel = intent.kind === "object" ? objectTypeLabel[intent.objectType] : null;
  const [name, setName] = useState(intent.kind === "folder" ? "新建文件夹" : `新建${objectLabel}`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("请输入名称。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败，请重试。");
      setSaving(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="resource-dialog"
      aria-labelledby="resource-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="resource-dialog__icon">
          {intent.kind === "folder" ? <Icon name="folder" /> : intent.objectType === "text" ? <Icon name="file-text" /> : intent.objectType === "image" ? <Icon name="image" /> : <Icon name="film" />}
        </div>
        <div className="resource-dialog__heading">
          <span id="resource-dialog-title">{intent.kind === "folder" ? "新建文件夹" : `新建${objectLabel}对象`}</span>
          <small>创建到：{targetPath.length > 0 ? targetPath.join(" / ") : "当前分镜根目录"}</small>
        </div>
        <label htmlFor="resource-name">名称</label>
        <input
          id="resource-name"
          value={name}
          maxLength={120}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError(null);
          }}
          aria-describedby={error ? "resource-name-error" : undefined}
        />
        {error ? <p id="resource-name-error" role="alert">{error}</p> : null}
        <div className="resource-dialog__actions">
          <button type="button" onClick={onCancel} disabled={saving}>取消</button>
          <button type="submit" disabled={saving || !name.trim()}>{saving ? "创建中…" : "创建"}</button>
        </div>
      </form>
    </dialog>
  );
}
