import type { MouseEventHandler, ReactNode } from "react";
import { Icon, type IconName } from "../workspace/Icons";
import "./composer.css";

type ComposerToolbarProps = {
  onAttach?: () => void;
  onMention: () => void;
  leadingControls?: ReactNode;
  controls?: ReactNode;
  action: {
    type: "button" | "submit";
    icon: IconName;
    label: string;
    title?: string;
    disabled?: boolean;
    tone?: "primary" | "danger";
    onClick?: MouseEventHandler<HTMLButtonElement>;
  };
};

export function ComposerToolbar({ onAttach, onMention, leadingControls, controls, action }: ComposerToolbarProps) {
  return (
    <div className="composer-toolbar">
      <div className="composer-toolbar__start">
        {onAttach ? (
          <button
            type="button"
            className="composer-toolbar__button"
            onClick={onAttach}
            aria-label="添加附件"
            title="添加图片、视频或文本附件"
          >
            <Icon name="plus" />
          </button>
        ) : null}
        <button
          type="button"
          className="composer-toolbar__button is-at"
          onClick={() => onMention()}
          aria-label="引用资产"
          title="引用资产"
        >
          @
        </button>
        {leadingControls}
      </div>
      <div className="composer-toolbar__end">
        {controls}
        <button
          type={action.type}
          className={`composer-toolbar__action is-${action.tone ?? "primary"}`}
          onClick={action.onClick}
          disabled={action.disabled}
          aria-label={action.label}
          title={action.title ?? action.label}
        >
          <Icon name={action.icon} />
        </button>
      </div>
    </div>
  );
}
