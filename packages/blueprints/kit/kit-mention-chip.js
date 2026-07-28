import { entityKindLabel, KitElement } from './elements-base.js';

export class KitMentionChip extends KitElement {
  static properties = { card: { type: Object, attribute: false } };
  constructor() {
    super();
    this.card = {};
  }
  render() {
    const card = this.card ?? {},
      gone = card.status === 'missing' || card.status === 'trashed';
    const label =
      card.status === 'missing'
        ? 'removed from the vault'
        : (card.title ?? entityKindLabel(card.type));
    const span = document.createElement('span');
    span.className = gone ? 'kit-mention-chip ref-gone' : 'kit-mention-chip';
    span.title = `${entityKindLabel(card.type)} — linked reference`;
    span.textContent = label;
    return span;
  }
}
customElements.define('kit-mention-chip', KitMentionChip);
