import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { HoverPreview } from "../preview/HoverPreview";
import { mediaStatusLabel } from "../preview/formatMedia";
import { MediaThumbnail } from "../preview/MediaThumbnail";
import { Icon } from "../workspace/Icons";
import { folderChain, selectionMatches } from "../workspace/resourceTree";
import type { NavigatorItem, WorkspaceObjectNode, WorkspaceObjectType, WorkspaceSelection, WorkspaceTreeNode } from "../workspace/types";
import type { MediaItem } from "../productApi/generated";
import { WorkspaceAttentionDot } from "./WorkspaceAttentionDot";

export type ResourceCreationIntent =
  | { kind: "folder" }
  | { kind: "object"; objectType: WorkspaceObjectType };

export type ResourceAction = "rename" | "delete" | "copy";
type ResourceMenuAction = ResourceAction | "download";

type CreateMenuTarget = {
  folderId: string | null;
  folderName: string;
  trigger: HTMLButtonElement;
  top: number;
  left: number;
};

type ResourceTreeProps = {
  rootName: string;
  nodes: WorkspaceTreeNode[];
  items: NavigatorItem[];
  objectMedia: Readonly<Record<string, MediaItem>>;
  scriptText: string;
  selection: WorkspaceSelection;
  selectedFolderId: string | null;
  pendingUserActionTargets: ReadonlySet<string>;
  onSelectFolder: (folderId: string | null) => void;
  onSelectObject: (selection: WorkspaceSelection) => void;
  onReorder: (nodeId: string, targetId: string, placement: "before" | "after") => Promise<void>;
  onMove: (nodeId: string, parentId: string | null) => Promise<void>;
  onCreateRequest: (folderId: string | null, intent: ResourceCreationIntent) => void;
  onActionRequest: (node: WorkspaceTreeNode, action: ResourceAction) => void;
  onDownloadRequest: (node: WorkspaceObjectNode, media: MediaItem | null) => void;
  onRootActionRequest: (action: ResourceAction) => void;
};

type DragState = { id: string; parentId: string | null };
type DropState = { id: string | null; placement: "before" | "after" | "inside" };
type NodeDrag = {
  source: DragState | null;
  drop: DropState | null;
  busy: boolean;
  start: (event: ReactDragEvent<HTMLElement>, nodeId: string, parentId: string | null) => void;
  over: (event: ReactDragEvent<HTMLElement>, nodeId: string | null, parentId: string | null, folder: boolean) => void;
  finish: () => void;
  commit: (event: ReactDragEvent<HTMLElement>, nodeId: string | null, parentId: string | null, folder: boolean) => void;
};

export function ResourceTree(props: ResourceTreeProps) {
  const itemsById = useMemo(() => new Map(props.items.map((item) => [item.id, item])), [props.items]);
  const [createTarget, setCreateTarget] = useState<CreateMenuTarget | null>(null);
  const [contextTarget, setContextTarget] = useState<{ node: WorkspaceTreeNode; root: boolean; trigger: HTMLButtonElement; top: number; left: number } | null>(null);
  const [dragSource, setDragSource] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropState | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [rootExpanded, setRootExpanded] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextTarget) return;
    contextRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        contextTarget.trigger.focus();
      } else if (contextRef.current?.contains(event.target as Node)) return;
      setContextTarget(null);
    };
    const closeOnViewportChange = () => setContextTarget(null);
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("wheel", closeOnViewportChange, true);
    window.addEventListener("touchmove", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("wheel", closeOnViewportChange, true);
      window.removeEventListener("touchmove", closeOnViewportChange, true);
    };
  }, [contextTarget]);

  const openContextMenu = (node: WorkspaceTreeNode, trigger: HTMLButtonElement, x: number, y: number, root = false) => {
    setCreateTarget(null);
    const menuHeight = menuActions(node, root).length * 38 + 28;
    setContextTarget({ node, root, trigger,
      left: Math.max(8, Math.min(x, window.innerWidth - 172)),
      top: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  };
  const contextMenu = (node: WorkspaceTreeNode, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    openContextMenu(node, event.currentTarget, event.clientX, event.clientY);
  };
  const contextKey = (node: WorkspaceTreeNode, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    openContextMenu(node, event.currentTarget, rect.left + 24, rect.bottom);
  };
  const rootNode: WorkspaceTreeNode = { kind: "folder", id: `storyboard-${props.rootName}`, name: props.rootName, children: [] };
  const contextMedia = contextTarget?.node.kind === "object"
    ? contextTarget.node.selection.kind === "item"
      ? itemsById.get(contextTarget.node.selection.itemId)?.media ?? null
      : props.objectMedia[contextTarget.node.id] ?? null
    : null;

  useEffect(() => {
    if (!createTarget) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      createTarget.trigger.focus();
      setCreateTarget(null);
    };
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node) || createTarget.trigger.contains(event.target as Node)) return;
      setCreateTarget(null);
    };
    const closeOnViewportChange = () => setCreateTarget(null);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [createTarget]);

  const openCreateMenu = (folderId: string | null, folderName: string, event: MouseEvent<HTMLButtonElement>) => {
    const trigger = event.currentTarget;
    if (createTarget?.folderId === folderId) {
      setCreateTarget(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 190;
    const menuHeight = 218;
    const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
    const top = rect.bottom + 5 + menuHeight <= window.innerHeight
      ? rect.bottom + 5
      : Math.max(8, rect.top - menuHeight - 5);
    props.onSelectFolder(folderId);
    setCreateTarget({ folderId, folderName, trigger, top, left });
  };

  const chooseIntent = (intent: ResourceCreationIntent) => {
    if (!createTarget) return;
    props.onCreateRequest(createTarget.folderId, intent);
    setCreateTarget(null);
  };

  const resolveDrop = (event: ReactDragEvent<HTMLElement>, nodeId: string | null, parentId: string | null, folder: boolean): DropState | null => {
    if (!dragSource || reorderBusy || dragSource.id === nodeId) return null;
    if (nodeId === null) return dragSource.parentId === null ? null : { id: null, placement: "inside" };
    if (parentId !== null && folderChain(props.nodes, parentId)?.some((node) => node.id === dragSource.id)) return null;
    if (folder) {
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = (event.clientY - rect.top) / rect.height;
      const placement = fraction < .25 ? "before" : fraction > .75 ? "after" : "inside";
      if (placement === "inside" && (dragSource.parentId === nodeId
        || folderChain(props.nodes, nodeId)?.some((node) => node.id === dragSource.id))) return null;
      return { id: nodeId, placement };
    }
    const rect = event.currentTarget.getBoundingClientRect();
    return { id: nodeId, placement: event.clientY < rect.top + rect.height / 2 ? "before" : "after" };
  };

  const drag: NodeDrag = {
    source: dragSource,
    drop: dropTarget,
    busy: reorderBusy,
    start: (event, nodeId, parentId) => {
      if (reorderBusy) { event.preventDefault(); return; }
      setCreateTarget(null);
      setContextTarget(null);
      setDragSource({ id: nodeId, parentId });
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", nodeId);
    },
    over: (event, nodeId, parentId, folder) => {
      event.stopPropagation();
      const target = resolveDrop(event, nodeId, parentId, folder);
      if (!target) { setDropTarget(null); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget((current) => current?.id === target.id && current.placement === target.placement
        ? current : target);
    },
    finish: () => { setDragSource(null); setDropTarget(null); },
    commit: (event, nodeId, parentId, folder) => {
      event.stopPropagation();
      const target = resolveDrop(event, nodeId, parentId, folder);
      if (!dragSource || !target) return;
      event.preventDefault();
      const sourceId = dragSource.id;
      setDragSource(null);
      setDropTarget(null);
      setReorderBusy(true);
      const action = target.placement === "inside"
        ? props.onMove(sourceId, target.id)
        : props.onReorder(sourceId, target.id!, target.placement);
      void action.finally(() => setReorderBusy(false));
    },
  };

  return (
    <div className="resource-tree-shell">
      <div className={`resource-tree__root${createTarget?.folderId === null ? " menu-open" : ""}${dropTarget?.id === null && dropTarget.placement === "inside" ? " drop-inside" : ""}`}
        onDragOver={(event) => drag.over(event, null, null, true)}
        onDrop={(event) => drag.commit(event, null, null, true)}>
        <button type="button" className="resource-tree__root-name" aria-expanded={rootExpanded}
          onClick={() => { props.onSelectFolder(null); setRootExpanded((value) => !value); }}
          onContextMenu={(event) => { event.preventDefault(); openContextMenu(rootNode, event.currentTarget, event.clientX, event.clientY, true); }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openContextMenu(rootNode, event.currentTarget, rect.left + 24, rect.bottom, true);
          }}>
          <span className="resource-tree__root-title">
            <span className="resource-tree__node-label">{props.rootName}</span>
            {!rootExpanded ? <span className="resource-tree__collapsed-count" aria-hidden="true">{countObjects(props.nodes)} 项</span> : null}
          </span>
        </button>
        <CreateButton
          folderName={props.rootName}
          open={createTarget?.folderId === null}
          onClick={(event) => openCreateMenu(null, props.rootName, event)}
        />
      </div>
      {rootExpanded ? <ul className="resource-tree" role="tree" aria-label="片段资源树">
        {props.nodes.map((node) => (
          <ResourceNode
            key={node.id}
            node={node}
            depth={0}
            parentId={null}
            drag={drag}
            itemsById={itemsById}
            createTargetId={createTarget?.folderId}
            onOpenCreateMenu={openCreateMenu}
            onOpenContextMenu={contextMenu}
            onContextKey={contextKey}
            {...props}
          />
        ))}
      </ul> : null}
      {createTarget ? (
        <div
          ref={menuRef}
          className="resource-create__menu"
          role="menu"
          aria-label={`在${createTarget.folderName}中新建`}
          style={{ top: createTarget.top, left: createTarget.left }}
        >
          <span>结构</span>
          <button type="button" role="menuitem" onClick={() => chooseIntent({ kind: "folder" })}>
            <Icon name="folder" />新建文件夹
          </button>
          <span>对象</span>
          <button type="button" role="menuitem" onClick={() => chooseIntent({ kind: "object", objectType: "text" })}>
            <Icon name="file-text" />文本对象
          </button>
          <button type="button" role="menuitem" onClick={() => chooseIntent({ kind: "object", objectType: "image" })}>
            <Icon name="image" />图片对象
          </button>
          <button type="button" role="menuitem" onClick={() => chooseIntent({ kind: "object", objectType: "video" })}>
            <Icon name="film" />视频对象
          </button>
        </div>
      ) : null}
      {contextTarget ? (
        <div ref={contextRef} className="resource-create__menu resource-context__menu" role="menu"
          aria-label={`${contextTarget.node.name}操作`}
          style={{ top: contextTarget.top, left: contextTarget.left }}>
          {menuActions(contextTarget.node, contextTarget.root).map((action) => (
            <button key={action} type="button" role="menuitem"
              disabled={action === "download" && contextTarget.node.kind === "object"
                && contextTarget.node.selection.kind !== "script"
                && (contextMedia?.status !== "ready" || !contextMedia.preview?.url)}
              onClick={() => {
                if (action === "download") {
                  if (contextTarget.node.kind === "object") props.onDownloadRequest(contextTarget.node, contextMedia);
                } else if (contextTarget.root) props.onRootActionRequest(action);
                else props.onActionRequest(contextTarget.node, action);
                setContextTarget(null);
              }}>
              {action === "rename" ? "重命名" : action === "copy" ? "复制" : action === "download" ? "下载" : "删除"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function menuActions(node: WorkspaceTreeNode, root: boolean): ResourceMenuAction[] {
  if (root) return ["rename", "copy", "delete"];
  if (node.kind === "folder") return containsScript(node) ? ["rename"] : ["rename", "copy", "delete"];
  if (node.selection.kind === "script") return ["rename", "download"];
  return ["rename", "copy", "download", "delete"];
}

function containsScript(node: WorkspaceTreeNode): boolean {
  return node.kind === "folder"
    ? node.children.some(containsScript)
    : node.selection.kind === "script";
}

function countObjects(nodes: WorkspaceTreeNode[]): number {
  return nodes.reduce((count, node) => count + (node.kind === "folder" ? countObjects(node.children) : 1), 0);
}

function CreateButton({
  folderName,
  open,
  onClick,
}: {
  folderName: string;
  open: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="resource-tree__add"
      aria-label={`在${folderName}中新建`}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
    >
      <Icon name="plus" />
    </button>
  );
}

function ResourceNode({
  node,
  depth,
  parentId,
  drag,
  itemsById,
  createTargetId,
  onOpenCreateMenu,
  onOpenContextMenu,
  onContextKey,
  ...props
}: ResourceTreeProps & {
  node: WorkspaceTreeNode;
  depth: number;
  parentId: string | null;
  drag: NodeDrag;
  itemsById: Map<string, NavigatorItem>;
  createTargetId: string | null | undefined;
  onOpenCreateMenu: (folderId: string | null, folderName: string, event: MouseEvent<HTMLButtonElement>) => void;
  onOpenContextMenu: (node: WorkspaceTreeNode, event: MouseEvent<HTMLButtonElement>) => void;
  onContextKey: (node: WorkspaceTreeNode, event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const style = { "--tree-depth": depth } as CSSProperties;
  const dropClass = drag.drop?.id === node.id ? ` drop-${drag.drop.placement}` : "";
  const draggingClass = drag.source?.id === node.id ? " is-dragging" : "";
  if (node.kind === "folder") {
    const objectCount = countObjects(node.children);
    return (
      <li role="treeitem" aria-expanded={expanded} style={style}
        className={drag.drop?.id === node.id && drag.drop.placement === "after" ? "resource-tree__branch drop-after" : "resource-tree__branch"}>
        <div className={`resource-tree__folder${createTargetId === node.id ? " menu-open" : ""}${drag.drop?.id === node.id && drag.drop.placement !== "after" ? dropClass : ""}${draggingClass}`}
          onDragOver={(event) => drag.over(event, node.id, parentId, true)}
          onDrop={(event) => drag.commit(event, node.id, parentId, true)}>
          <button type="button" className="resource-tree__folder-name" aria-expanded={expanded}
            onClick={() => { props.onSelectFolder(node.id); setExpanded((value) => !value); }}
            draggable={!drag.busy} title="拖拽排序或移入文件夹"
            onDragStart={(event) => drag.start(event, node.id, parentId)}
            onDragEnd={drag.finish}
            onContextMenu={(event) => onOpenContextMenu(node, event)} onKeyDown={(event) => onContextKey(node, event)}>
            <span className="resource-tree__node-label">{node.name}</span>
            {!expanded ? <span className="resource-tree__item-count" aria-hidden="true">{objectCount} 项</span> : null}
          </button>
          <CreateButton
            folderName={node.name}
            open={createTargetId === node.id}
            onClick={(event) => onOpenCreateMenu(node.id, node.name, event)}
          />
        </div>
        {expanded ? (
          <ul role="group">
            {node.children.map((child) => (
              <ResourceNode
                key={child.id}
                node={child}
                depth={depth + 1}
                parentId={node.id}
                drag={drag}
                itemsById={itemsById}
                createTargetId={createTargetId}
                onOpenCreateMenu={onOpenCreateMenu}
                onOpenContextMenu={onOpenContextMenu}
                onContextKey={onContextKey}
                {...props}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const selected = props.selection.nodeId
    ? props.selection.nodeId === node.id
    : selectionMatches(node.selection, props.selection);
  const savedMedia = node.selection.kind === "emptyObject" ? props.objectMedia[node.id] : null;
  const objectItem: NavigatorItem | null = savedMedia && savedMedia.status !== "placeholder"
    ? { id: node.id, name: node.name, description: "", label: "", accent: "var(--accent)", media: savedMedia }
    : null;
  const item = node.selection.kind === "item" ? itemsById.get(node.selection.itemId) : objectItem;
  const pendingTarget = node.selection.kind === "script"
    ? `script:${node.selection.storyboardId}`
    : node.selection.kind === "emptyObject" && node.objectType !== "text"
      ? `mediaPrompt:${node.mediaId ?? node.id}`
      : item ? `mediaPrompt:${item.media.id}` : null;
  const pendingUserAction = pendingTarget !== null && props.pendingUserActionTargets.has(pendingTarget);
  const attentionLabel = [
    pendingUserAction ? "有待确认或取消的 AI 建议" : null,
    node.unseenUpdateAt ? "AI 内容待查看，打开后自动清除" : null,
  ].filter(Boolean).join("；");
  const row = (
    <button
      type="button"
      className={`resource-tree__object${selected ? " selected" : ""}${node.selection.kind === "script" ? " script-card" : ""}`}
      style={style}
      aria-label={`${node.selection.kind === "emptyObject" ? node.name : item ? `${item.name}，${mediaStatusLabel(item.media.status)}` : node.name}${attentionLabel ? `，${attentionLabel}` : ""}`}
      aria-pressed={selected}
      draggable={!drag.busy}
      title="拖拽排序或移入文件夹"
      onDragStart={(event) => drag.start(event, node.id, parentId)}
      onDragEnd={drag.finish}
      onClick={() => props.onSelectObject({ ...node.selection, nodeId: node.id })}
      onContextMenu={(event) => onOpenContextMenu(node, event)}
      onKeyDown={(event) => onContextKey(node, event)}
    >
      <span className="resource-tree__object-icon">
        {item ? <MediaThumbnail item={item} /> : node.objectType === "text" ? <Icon name="file-text" /> : node.objectType === "image" ? <Icon name="image" /> : <Icon name="film" />}
        {item?.media.kind === "video" ? <span className="resource-tree__video-mark"><Icon name="pause" /></span> : null}
      </span>
      <span className="resource-tree__object-name">{node.name}</span>
      {attentionLabel ? <WorkspaceAttentionDot label={attentionLabel} kind={pendingUserAction ? "action" : "unseen"} /> : null}
      {node.selection.kind === "script" ? <span className="sr-only">{props.scriptText}</span> : null}
    </button>
  );

  return <li role="treeitem" className={`resource-tree__leaf${dropClass}${draggingClass}`}
    onDragOver={(event) => drag.over(event, node.id, parentId, false)}
    onDrop={(event) => drag.commit(event, node.id, parentId, false)}>
    {item ? <HoverPreview item={item} disabled={selected}>{row}</HoverPreview> : row}
  </li>;
}
