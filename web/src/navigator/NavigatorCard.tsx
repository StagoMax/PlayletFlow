import { HoverPreview } from "../preview/HoverPreview";
import { MediaThumbnail } from "../preview/MediaThumbnail";
import { mediaStatusLabel } from "../preview/formatMedia";
import type { NavigatorItem } from "../workspace/types";

type NavigatorCardProps = {
  item: NavigatorItem;
  selected: boolean;
  onSelect: () => void;
};

export function NavigatorCard({ item, selected, onSelect }: NavigatorCardProps) {
  const navigationName = item.navigationName ?? item.name;
  return (
    <HoverPreview item={item}>
      <button
        type="button"
        className={`navigator-card${selected ? " selected" : ""}`}
        aria-label={`${item.name}，${mediaStatusLabel(item.media.status)}`}
        aria-pressed={selected}
        title={item.name}
        onClick={onSelect}
      >
        <MediaThumbnail item={item} />
        <span className="navigator-card-name">{navigationName}</span>
      </button>
    </HoverPreview>
  );
}
