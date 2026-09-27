import type { ReactNode } from "react";
import { Icon } from "../workspace/Icons";

type MediaPromptDockProps = {
  children: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
};

export function MediaPromptDock({ children, collapsible = false, collapsed = false, onToggle }: MediaPromptDockProps) {
  const isCollapsed = collapsible && collapsed;
  return (
    <div className={`media-prompt-dock${collapsible ? " is-collapsible" : ""}${isCollapsed ? " is-collapsed" : ""}`}>
      {collapsible ? (
        <button type="button" className="media-prompt-dock__toggle"
          aria-label={isCollapsed ? "展开提示词输入框" : "折叠提示词输入框"}
          aria-expanded={!isCollapsed} onClick={onToggle}>
          <Icon name="chevron-down" />
        </button>
      ) : null}
      <div className="media-prompt-dock__content" inert={isCollapsed}>
        {children}
      </div>
    </div>
  );
}
