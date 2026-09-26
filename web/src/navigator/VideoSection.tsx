import { Icon } from "../workspace/Icons";
import type { NavigatorGroup } from "../workspace/types";
import { NavigatorCard } from "./NavigatorCard";

type VideoSectionProps = {
  groups: NavigatorGroup[];
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
};

export function VideoSection({ groups, selectedItemId, onSelect }: VideoSectionProps) {
  return (
    <section className="navigator-section" aria-labelledby="video-section-title">
      <div className="section-title-row">
        <h2 id="video-section-title">视频</h2>
        <span>{groups.reduce((total, group) => total + group.items.length, 0)} 项</span>
      </div>
      <div className="navigator-group-stack">
        {groups.map((group) => (
          <div className="navigator-group" key={group.id}>
            <h3><Icon name="film" />{group.name}</h3>
            <div className="navigator-card-grid">
              {group.items.map((item) => (
                <NavigatorCard key={item.id} item={item} selected={selectedItemId === item.id} onSelect={() => onSelect(item.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
