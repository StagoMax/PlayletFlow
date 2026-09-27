import { useMemo } from "react";
import { parseMediaPromptDraft, type SavedPromptReference } from "../preview/mediaPromptDraft";
import { buildLineDiff } from "./diff";
import "./proposals.css";

type ProposalDiffProps = {
  beforeValue: string;
  proposedValue: string;
};

export function ProposalDiff({ beforeValue, proposedValue }: ProposalDiffProps) {
  const before = useMemo(() => parseMediaPromptDraft(beforeValue), [beforeValue]);
  const proposed = useMemo(() => parseMediaPromptDraft(proposedValue), [proposedValue]);
  const lines = useMemo(() => buildLineDiff(before.text, proposed.text), [before.text, proposed.text]);
  const referencesChanged = !sameReferences(before.references, proposed.references);
  const changed = referencesChanged || lines.some((line) => line.kind !== "unchanged");

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
      {before.references.length > 0 || proposed.references.length > 0 ? (
        <div className="proposal-diff__references">
          <strong>提示词引用资产</strong>
          {before.references.length > 0 ? <ReferenceList label="当前" references={before.references} /> : null}
          <ReferenceList label="AI 建议" references={proposed.references} />
        </div>
      ) : null}
    </section>
  );
}

function ReferenceList({ label, references }: { label: string; references: SavedPromptReference[] }) {
  return <div className="proposal-diff__reference-row">
    <span>{label}</span>
    {references.length > 0 ? <ul>{references.map((reference) => <li key={reference.id}>
      {reference.kind === "image" ? "图片" : reference.kind === "video" ? "视频" : "文本"} · {reference.name}
    </li>)}</ul> : <span>无</span>}
  </div>;
}

function sameReferences(a: SavedPromptReference[], b: SavedPromptReference[]) {
  return a.length === b.length && a.every((reference, index) =>
    reference.id === b[index].id && reference.kind === b[index].kind && reference.name === b[index].name);
}
