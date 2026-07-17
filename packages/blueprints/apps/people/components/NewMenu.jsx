// The "+ New" menu popover contents (#newMenu root).
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

export function NewMenu({ onAddPerson, onNewList }) {
  return (
    <>
      <button type="button" className="d-menu-item" role="menuitem" onClick={onAddPerson}>
        <Icon svg={I.addPerson} />
        Add person
      </button>
      <div className="d-menu-sep"></div>
      <button type="button" className="d-menu-item" role="menuitem" onClick={onNewList}>
        <Icon svg={I.circlePlus} />
        New list
      </button>
    </>
  );
}
