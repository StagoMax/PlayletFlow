import { Icon } from "../workspace/Icons";

type ScriptSectionProps = {
  text: string;
  selected: boolean;
  onSelect: () => void;
};

export function ScriptSection({ text, selected, onSelect }: ScriptSectionProps) {
  return (
    <section className="navigator-section" aria-labelledby="script-section-title">
      <div className="section-title-row">
        <h2 id="script-section-title">脚本</h2>
        <span>当前分镜</span>
      </div>
      <button type="button" className={`script-card${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
        <span className="script-card-icon"><Icon name="file-text" /></span>
        <span><strong>该分镜的脚本</strong><small>{text}</small></span>
      </button>
    </section>
  );
}
