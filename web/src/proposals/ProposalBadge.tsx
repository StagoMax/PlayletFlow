import type { ProposalStatus } from "../productApi/generated";
import "./proposals.css";

type ProposalBadgeProps = {
  status: ProposalStatus;
  count?: number;
};

const STATUS_COPY: Record<ProposalStatus, { icon: string; label: string }> = {
  pending: { icon: "◇", label: "待确认" },
  applying: { icon: "↻", label: "确认中" },
  applied: { icon: "✓", label: "已应用" },
  rejected: { icon: "×", label: "已取消" },
  conflicted: { icon: "!", label: "有冲突" },
  expired: { icon: "⌛", label: "已过期" },
  failed: { icon: "!", label: "处理失败" },
};

export function ProposalBadge({ status, count = 1 }: ProposalBadgeProps) {
  const copy = STATUS_COPY[status];
  return (
    <span className={`proposal-badge proposal-badge--${status}`}>
      <span aria-hidden="true">{copy.icon}</span>
      {copy.label}{count > 1 ? ` ${count}` : ""}
    </span>
  );
}
