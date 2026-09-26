import { useMemo } from "react";
import { buildLineDiff } from "./diff";
import "./proposals.css";

type ProposalDiffProps = {
  beforeValue: string;
  proposedValue: string;
};

export function ProposalDiff({ beforeValue, proposedValue }: ProposalDiffProps) {
  const lines = useMemo(() => buildLineDiff(beforeValue, proposedValue), [beforeValue, proposedValue]);
  const changed = lines.some((line) => line.kind !== "unchanged");

  return (
    <section className="proposal-diff" aria-label="正式内容与 AI 建议的差异">
      <header>
        <strong>变更差异</strong>
        <span><i className="proposal-diff__legend proposal-diff__legend--removed" />正式内容</span>
        <span><i className="proposal-diff__legend proposal-diff__legend--added" />AI 建议</span>
      </header>
      {!changed ? <p className="proposal-diff__empty">建议内容与当前内容没有可见差异。</p> : (
        <ol className="proposal-diff__lines">
          {lines.map((line, index) => (
            <li key={`${line.kind}-${line.beforeLine ?? "x"}-${line.afterLine ?? "x"}-${index}`} className={`proposal-diff__line proposal-diff__line--${line.kind}`}>
              <span className="proposal-diff__marker" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <span className="proposal-diff__number" aria-hidden="true">{line.beforeLine ?? ""}</span>
              <span className="proposal-diff__number" aria-hidden="true">{line.afterLine ?? ""}</span>
              <code><span className="sr-only">{line.kind === "added" ? "建议新增：" : line.kind === "removed" ? "当前将删除：" : "未修改："}</span>{line.text || " "}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
