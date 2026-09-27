export function WorkspaceAttentionDot({ label, kind }: { label: string; kind: "action" | "unseen" }) {
  return (
    <span
      className={`resource-tree__pending-dot resource-tree__pending-dot--${kind}`}
      title={label}
      aria-hidden="true"
    />
  );
}
