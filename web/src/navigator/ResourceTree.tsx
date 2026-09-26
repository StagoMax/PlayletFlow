import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { HoverPreview } from "../preview/HoverPreview";
import { mediaStatusLabel } from "../preview/formatMedia";
import { MediaThumbnail } from "../preview/MediaThumbnail";
import { Icon } from "../workspace/Icons";
import { selectionMatches } from "../workspace/resourceTree";
import type { NavigatorItem, WorkspaceObjectType, WorkspaceSelection, WorkspaceTreeNode } from "../workspace/types";
import { PendingUserActionDot } from "./PendingUserActionDot";

export type ResourceCreationIntent =
  | { kind: "folder" }
  | { kind: "object"; objectType: WorkspaceObjectType };

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
  scriptText: string;
  selection: WorkspaceSelection;
  selectedFolderId: string | null;
  pendingUserActionTargets: ReadonlySet<string>;
  onSelectFolder: (folderId: string | null) => void;
  onSelectObject: (selection: WorkspaceSelection) => void;
  onCreateRequest: (folderId: string | null, intent: ResourceCreationIntent) => void;
};

export function ResourceTree(props: ResourceTreeProps) {
  const itemsById = useMemo(() => new Map(props.items.map((item) => [item.id, item])), [props.items]);
  const [createTarget, setCreateTarget] = useState<CreateMenuTarget | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="resource-tree-shell">
      <div className={`resource-tree__root${createTarget?.folderId === null ? " menu-open" : ""}`}>
        <button type="button" className="resource-tree__root-name" onClick={() => props.onSelectFolder(null)}>
          <Icon name="folder" /><span>{props.rootName}</span>
        </button>
        <CreateButton
          folderName={props.rootName}
          open={createTarget?.folderId === null}
          onClick={(event) => openCreateMenu(null, props.rootName, event)}
        />
      </div>
      <ul className="resource-tree" role="tree" aria-label="分镜资源树">
        {props.nodes.map((node) => (
          <ResourceNode
            key={node.id}
            node={node}
            depth={0}
            itemsById={itemsById}
            createTargetId={createTarget?.folderId}
            onOpenCreateMenu={openCreateMenu}
            {...props}
          />
        ))}
      </ul>
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
    </div>
  );
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
  itemsById,
  createTargetId,
  onOpenCreateMenu,
  ...props
}: ResourceTreeProps & {
  node: WorkspaceTreeNode;
  depth: number;
  itemsById: Map<string, NavigatorItem>;
  createTargetId: string | null | undefined;
  onOpenCreateMenu: (folderId: string | null, folderName: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const style = { "--tree-depth": depth } as CSSProperties;
  if (node.kind === "folder") {
    return (
      <li role="treeitem" aria-expanded={expanded} style={style}>
        <div className={`resource-tree__folder${createTargetId === node.id ? " menu-open" : ""}`}>
          <button
            type="button"
            className="resource-tree__toggle"
            aria-label={`${expanded ? "折叠" : "展开"}${node.name}`}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon name="chevron-right" className={expanded ? "expanded" : ""} />
          </button>
          <button type="button" className="resource-tree__folder-name" onClick={() => props.onSelectFolder(node.id)}>
            <Icon name="folder" />
            <span>{node.name}</span>
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
                itemsById={itemsById}
                createTargetId={createTargetId}
                onOpenCreateMenu={onOpenCreateMenu}
                {...props}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const selected = selectionMatches(node.selection, props.selection);
  const item = node.selection.kind === "item" ? itemsById.get(node.selection.itemId) : null;
  const pendingTarget = node.selection.kind === "script"
    ? `script:${node.selection.storyboardId}`
    : item
      ? `mediaPrompt:${item.media.id}`
      : null;
  const pendingUserAction = pendingTarget !== null && props.pendingUserActionTargets.has(pendingTarget);
  const row = (
    <button
      type="button"
      className={`resource-tree__object${selected ? " selected" : ""}${node.selection.kind === "script" ? " script-card" : ""}`}
      style={style}
      aria-label={`${item ? `${item.name}，${mediaStatusLabel(item.media.status)}` : node.name}${pendingUserAction ? "，等待用户处理" : ""}`}
      aria-pressed={selected}
      onClick={() => props.onSelectObject(node.selection)}
    >
      <span className="resource-tree__object-icon">
        {item ? <MediaThumbnail item={item} /> : node.objectType === "text" ? <Icon name="file-text" /> : node.objectType === "image" ? <Icon name="image" /> : <Icon name="film" />}
        {item?.media.kind === "video" ? <span className="resource-tree__video-mark"><Icon name="pause" /></span> : null}
      </span>
      <span className="resource-tree__object-name">{node.name}</span>
      {pendingUserAction ? <PendingUserActionDot /> : null}
      {node.selection.kind === "script" ? <span className="sr-only">{props.scriptText}</span> : null}
    </button>
  );

  return <li role="treeitem">{item ? <HoverPreview item={item}>{row}</HoverPreview> : row}</li>;
}
