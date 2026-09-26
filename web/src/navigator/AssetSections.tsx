import { Icon } from "../workspace/Icons";
import type { NavigatorGroup, NavigatorItem } from "../workspace/types";
import { NavigatorCard } from "./NavigatorCard";

type AssetSectionsProps = {
  groups: NavigatorGroup[];
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
};

export function AssetSections({ groups, selectedItemId, onSelect }: AssetSectionsProps) {
  return (
    <section className="navigator-section" aria-labelledby="asset-section-title">
      <div className="section-title-row">
        <h2 id="asset-section-title">资产</h2>
        <span>{groups.reduce((total, group) => total + group.items.length, 0)} 项</span>
      </div>
      <div className="navigator-group-stack">
        {groups.map((group) => (
          <div className="navigator-group" key={group.id}>
            <h3><Icon name="box" />{group.name}</h3>
            {group.kind === "character" ? (
              <CharacterAssetGroups items={group.items} selectedItemId={selectedItemId} onSelect={onSelect} />
            ) : (
              <NavigatorCardGrid items={group.items} selectedItemId={selectedItemId} onSelect={onSelect} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

type NavigatorCardGridProps = {
  items: NavigatorItem[];
  selectedItemId: string | null;
  onSelect: (itemId: string) => void;
};

function CharacterAssetGroups({ items, selectedItemId, onSelect }: NavigatorCardGridProps) {
  const subjects = new Map<string, { name: string; items: NavigatorItem[] }>();
  for (const item of items) {
    const id = item.subject?.id ?? "unassigned";
    const subject = subjects.get(id) ?? { name: item.subject?.name ?? "未分组角色", items: [] };
    subject.items.push(item);
    subjects.set(id, subject);
  }

  return (
    <div className="navigator-subgroup-stack">
      {[...subjects].map(([id, subject]) => (
        <div className="navigator-subgroup" key={id}>
          <h4>{subject.name}</h4>
          <NavigatorCardGrid items={subject.items} selectedItemId={selectedItemId} onSelect={onSelect} />
        </div>
      ))}
    </div>
  );
}

function NavigatorCardGrid({ items, selectedItemId, onSelect }: NavigatorCardGridProps) {
  return (
    <div className="navigator-card-grid">
      {items.map((item) => (
        <NavigatorCard key={item.id} item={item} selected={selectedItemId === item.id} onSelect={() => onSelect(item.id)} />
      ))}
    </div>
  );
}
