import { entityKindLabel, KitElement } from './elements-base.js';

export class KitReferenceStrip extends KitElement {
  static properties = {
    refs: { type: Array },
    inlineIds: { attribute: false },
    onRemove: { attribute: false },
    emptyText: { type: String, attribute: 'empty-text' },
  };
  constructor() {
    super();
    this.refs = [];
    this.inlineIds = null;
    this.onRemove = null;
    this.emptyText = '';
  }
  #hasInline(linkId) {
    const ids = this.inlineIds;
    return (
      !!ids && (typeof ids.has === 'function' ? ids.has(linkId) : Array.from(ids).includes(linkId))
    );
  }
  render() {
    const list = this.refs ?? [],
      wrap = document.createElement('div');
    wrap.className = 'kit-ref-strip';
    if (list.length === 0) {
      if (this.emptyText) {
        const empty = document.createElement('p');
        empty.className = 'kit-ref-empty';
        empty.textContent = this.emptyText;
        wrap.appendChild(empty);
      }
      return wrap;
    }
    for (const ref of list) wrap.appendChild(this.#tile(ref));
    return wrap;
  }
  #tile(ref) {
    const card = ref.card ?? {},
      gone = card.status === 'missing' || card.status === 'denied' || card.status === 'trashed';
    let title;
    if (card.status === 'missing') title = 'removed from the vault';
    else if (card.status === 'denied') title = 'access not granted';
    else {
      title = card.title ?? entityKindLabel(card.type);
      if (card.status === 'trashed') title += ' (in trash)';
    }
    const tile = document.createElement('div');
    tile.className = gone ? 'kit-ref-tile is-gone' : 'kit-ref-tile';
    const kind = document.createElement('span');
    kind.className = 'kit-ref-kind';
    kind.textContent = entityKindLabel(card.type);
    tile.appendChild(kind);
    if (ref.selector) {
      const flag = document.createElement('span');
      const inline = this.#hasInline(ref.link_id);
      flag.className = inline ? 'kit-ref-flag is-inline' : 'kit-ref-flag';
      flag.title = inline
        ? 'Shown inline in the text above'
        : "This reference's words are no longer in the text";
      flag.textContent = inline ? 'in text' : 'in strip';
      tile.appendChild(flag);
    }
    const titleSpan = document.createElement('span');
    titleSpan.className = 'kit-ref-title';
    titleSpan.textContent = title;
    tile.appendChild(titleSpan);
    if (card.subtitle && card.status === 'live') {
      const sub = document.createElement('span');
      sub.className = 'kit-ref-sub';
      sub.textContent = card.subtitle;
      tile.appendChild(sub);
    }
    if (this.onRemove) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'kit-ref-remove';
      remove.title = 'Remove reference';
      remove.setAttribute('aria-label', `Remove reference to ${title}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => this.onRemove(ref));
      tile.appendChild(remove);
    }
    return tile;
  }
}
customElements.define('kit-reference-strip', KitReferenceStrip);
