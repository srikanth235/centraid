// The "+ New" menu popover contents (#newMenu root).
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import styles from './NewMenu.module.css';

export function NewMenu({
  onAddPerson,
  onNewList,
}: {
  onAddPerson: () => void;
  onNewList: () => void;
}) {
  return (
    <>
      <button type="button" className={styles.menuItem} role="menuitem" onClick={onAddPerson}>
        <Icon svg={I.addPerson} />
        Add person
      </button>
      <div className={styles.menuSep}></div>
      <button type="button" className={styles.menuItem} role="menuitem" onClick={onNewList}>
        <Icon svg={I.circlePlus} />
        New list
      </button>
    </>
  );
}
