import type { ProposalStatus } from "../productApi/generated";
import "./proposals.css";

type ProposalBadgeProps = {
  status: ProposalStatus;
  count?: number;
};

const STATUS_COPY: Record<ProposalStatus, { icon: string; label: string; tone: "pending" | "success" | "error" | "neutral" }> = {
  pending: { icon: "◇", label: "待确认", tone: "pending" },
  applying: { icon: "↻", label: "确认中", tone: "pending" },
  applied: { icon: "✓", label: "已应用", tone: "success" },
  rejected: { icon: "×", label: "已取消", tone: "neutral" },
  conflicted: { icon: "!", label: "有冲突", tone: "error" },
  expired: { icon: "⌛", label: "已过期", tone: "neutral" },
  failed: { icon: "!", label: "处理失败", tone: "error" },
};

export function ProposalBadge({ status, count = 1 }: ProposalBadgeProps) {
  const copy = STATUS_COPY[status];
  return (
    <span className="ui-badge proposal-badge" data-tone={copy.tone}>
      <span aria-hidden="true">{copy.icon}</span>
      {copy.label}{count > 1 ? ` ${count}` : ""}
    </span>
  );
}
