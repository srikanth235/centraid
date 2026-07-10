// The "+ New" menu popover contents (#newMenu root).
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

export function NewMenu({ onUpload, onNewFolder }) {
  return (
    <>
      <button type="button" className="d-menu-item" role="menuitem" onClick={onUpload}>
        <Icon svg={I.upload} />
        Upload files
      </button>
      <div className="d-menu-sep"></div>
      <button type="button" className="d-menu-item" role="menuitem" onClick={onNewFolder}>
        <Icon svg={I.folderPlus} />
        New folder
      </button>
    </>
  );
}
