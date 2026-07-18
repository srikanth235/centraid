// The "+ New" menu popover contents (#newMenu root).
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import styles from './NewMenu.module.css';

export function NewMenu({
  onUpload,
  onNewFolder,
}: {
  onUpload: () => void;
  onNewFolder: () => void;
}) {
  return (
    <>
      <button type="button" className={styles.menuItem} role="menuitem" onClick={onUpload}>
        <Icon svg={I.upload!} />
        Upload files
      </button>
      <div className={styles.menuSep}></div>
      <button type="button" className={styles.menuItem} role="menuitem" onClick={onNewFolder}>
        <Icon svg={I.folderPlus!} />
        New folder
      </button>
    </>
  );
}
