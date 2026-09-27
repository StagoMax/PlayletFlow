import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { folderPath } from "../workspace/resourceTree";
import { Icon } from "../workspace/Icons";
import { DeleteStoryboardDialog } from "../storyboards/DeleteStoryboardDialog";
import { useWorkspace } from "../workspace/WorkspaceContext";
import type { WorkspaceObjectType, WorkspaceTreeNode } from "../workspace/types";
import { ResourceTree, type ResourceAction, type ResourceCreationIntent } from "./ResourceTree";

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
  const { data, current, objectMedia, state, dispatch, createFolder, createObject, duplicateStoryboard, renameStoryboard, deleteStoryboard, renameNode, deleteNode, copyNode, reorderNode, moveNode } = useWorkspace();
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [intent, setIntent] = useState<CreationIntent | null>(null);
  const [actionTarget, setActionTarget] = useState<{ node: WorkspaceTreeNode; action: Exclude<ResourceAction, "copy">; root?: boolean } | null>(null);
  const [actionError, setActionError] = useState("");
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
    setActionTarget(null);
  }, [current.storyboard.id]);

  return (
    <nav className="content-navigator resource-browser" aria-label="片段资源">
      <ResourceTree
        rootName={current.storyboard.name}
        nodes={current.navigationTree}
        items={items}
        objectMedia={objectMedia}
        scriptText={current.storyboard.script.text}
        selection={state.selection}
        selectedFolderId={selectedFolderId}
        pendingUserActionTargets={pendingUserActionTargets}
        onSelectFolder={setSelectedFolderId}
        onSelectObject={(selection) => dispatch({ type: "contentSelected", selection })}
        onReorder={async (nodeId, targetId, placement) => {
          setActionError("");
          try { await reorderNode(nodeId, targetId, placement); }
          catch (cause) {
            setActionError(cause instanceof Error ? cause.message : "调整顺序失败，请重试。");
          }
        }}
        onMove={async (nodeId, parentId) => {
          setActionError("");
          try { await moveNode(nodeId, parentId); }
          catch (cause) {
            setActionError(cause instanceof Error ? cause.message : "移动资源失败，请重试。");
          }
        }}
        onCreateRequest={(folderId, nextIntent) => {
          setSelectedFolderId(folderId);
          setIntent(nextIntent);
        }}
        onActionRequest={(node, action) => {
          setActionError("");
          if (action === "copy") {
            void copyNode(node.id).catch((cause: unknown) => {
              setActionError(cause instanceof Error ? cause.message : "复制失败，请重试。");
            });
          } else {
            setActionTarget({ node, action });
          }
        }}
        onRootActionRequest={(action) => {
          setActionError("");
          if (action === "copy") {
            void duplicateStoryboard(current.storyboard.id).catch((cause: unknown) => {
              setActionError(cause instanceof Error ? cause.message : "复制片段失败，请重试。");
            });
          } else {
            setActionTarget({
              node: { kind: "folder", id: current.storyboard.id, name: current.storyboard.name, children: [] },
              action, root: true,
            });
          }
        }}
      />
      {actionError ? <p className="resource-action-error" role="alert">{actionError}</p> : null}

      {actionTarget?.root && actionTarget.action === "delete" ? (
        <DeleteStoryboardDialog key={current.storyboard.id}
          storyboard={current.storyboard}
          lastStoryboard={data.storyboards.length === 1}
          onCancel={() => setActionTarget(null)}
          onDelete={async (storyboardId) => { await deleteStoryboard(storyboardId); setActionTarget(null); }} />
      ) : actionTarget ? (
        <ResourceActionDialog key={`${actionTarget.action}:${actionTarget.node.id}`}
          target={actionTarget}
          onCancel={() => setActionTarget(null)}
          onConfirm={async (name) => {
            if (actionTarget.root && actionTarget.action === "rename") await renameStoryboard(name);
            else if (actionTarget.action === "rename") await renameNode(actionTarget.node.id, name);
            else await deleteNode(actionTarget.node.id);
            setActionTarget(null);
          }} />
      ) : null}

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
          <small>创建到：{targetPath.length > 0 ? targetPath.join(" / ") : "当前片段根目录"}</small>
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

function ResourceActionDialog({
  target, onCancel, onConfirm,
}: {
  target: { node: WorkspaceTreeNode; action: "rename" | "delete"; root?: boolean };
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(target.node.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const isDelete = target.action === "delete";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isDelete && !name.trim()) { setError("请输入名称。"); return; }
    setBusy(true);
    setError("");
    try { await onConfirm(name.trim()); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialogRef} className="resource-dialog" aria-labelledby="resource-action-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="resource-dialog__icon"><Icon name={target.node.kind === "folder" ? "folder" : target.node.objectType === "text" ? "file-text" : target.node.objectType === "image" ? "image" : "film"} /></div>
        <div className="resource-dialog__heading">
          <span id="resource-action-title">{target.root ? isDelete ? "删除片段" : "重命名片段" : isDelete ? "删除资源" : "重命名资源"}</span>
          <small>{target.node.name}</small>
        </div>
        {isDelete ? <p className="resource-dialog__message">确定删除“{target.node.name}”吗？{target.node.kind === "folder" ? "文件夹内的所有资源也会删除。" : ""}</p> : (
          <><label htmlFor="resource-action-name">名称</label>
            <input id="resource-action-name" value={name} maxLength={120} autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => { setName(event.target.value); setError(""); }} /></>
        )}
        {error ? <p role="alert">{error}</p> : null}
        <div className="resource-dialog__actions">
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="submit" disabled={busy || (!isDelete && !name.trim())}
            className={isDelete ? "danger" : undefined}>{busy ? "处理中…" : isDelete ? "删除" : "保存"}</button>
        </div>
      </form>
    </dialog>
  );
}
