import { Icon } from "../workspace/Icons";

export function ComposerDropOverlay() {
  return <div className="shared-composer-drop" aria-hidden="true"><Icon name="plus" /><span>释放以添加附件</span></div>;
}
