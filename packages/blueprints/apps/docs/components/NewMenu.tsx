// The "+ New" menu popover contents (#newMenu root).
import { I } from "../icons.ts";
import { Icon } from "./Shared.tsx";

export function NewMenu({
  onUpload,
  onNewFolder,
}: {
  onUpload: () => void;
  onNewFolder: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="kit-popover-item"
        role="menuitem"
        onClick={onUpload}
      >
        <Icon svg={I.upload!} />
        Upload files
      </button>
      <div className="kit-popover-sep" />
      <button
        type="button"
        className="kit-popover-item"
        role="menuitem"
        onClick={onNewFolder}
      >
        <Icon svg={I.folderPlus!} />
        New folder
      </button>
    </>
  );
}
