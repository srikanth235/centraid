/** Human labels for the entity kinds the picker / references surface. */
export const PICK_KIND_LABELS = {
  "core.party": "Person",
  "core.place": "Place",
  "core.event": "Event",
  "core.transaction": "Transaction",
  "core.content_item": "File",
  "schedule.task": "Task",
  "knowledge.note": "Note",
  "core.collection": "Collection",
  "social.thread": "Thread",
  "media.asset": "Photo",
  "home.asset_item": "Belonging",
  "business.client": "Client",
  "business.project": "Project",
  "business.invoice": "Invoice",
};

/** Human label for an entity kind — falls back to the table name. */
export function entityKindLabel(type) {
  if (PICK_KIND_LABELS[type]) return PICK_KIND_LABELS[type];
  const table = String(type).split(".")[1] ?? String(type);
  return table.replace(/_/gu, " ");
}

const propertiesInstalled = new WeakSet();

function attributeNameFor(propName, cfg) {
  if (cfg?.attribute === false) return null;
  if (typeof cfg?.attribute === "string") return cfg.attribute;
  return propName.toLowerCase();
}

function convertFromAttribute(type, raw) {
  if (raw == null) return type === Boolean ? false : null;
  if (type === Number) return Number(raw);
  if (type === Boolean) return true;
  if (type === Array || type === Object) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function installProperty(proto, name) {
  const store = Symbol(name);
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: true,
    get() {
      return this[store];
    },
    set(value) {
      this[store] = value;
      this.requestUpdate();
    },
  });
}

function ensurePropertiesInstalled(ctor) {
  if (propertiesInstalled.has(ctor)) return;
  propertiesInstalled.add(ctor);
  for (const name of Object.keys(ctor.properties ?? {}))
    installProperty(ctor.prototype, name);
}

/** Shared light-DOM reactivity base for every kit custom element. */
export class KitElement extends HTMLElement {
  static properties = {};

  static get observedAttributes() {
    return Object.entries(this.properties ?? {})
      .map(([name, cfg]) => attributeNameFor(name, cfg))
      .filter((attr) => attr !== null);
  }

  constructor() {
    super();
    ensurePropertiesInstalled(new.target);
  }

  connectedCallback() {
    this.dataset.kitHost = "";
    this.requestUpdate();
  }

  attributeChangedCallback(attrName, oldValue, newValue) {
    if (oldValue === newValue) return;
    const entry = Object.entries(this.constructor.properties ?? {}).find(
      ([name, cfg]) => attributeNameFor(name, cfg) === attrName
    );
    if (!entry) return;
    const [name, cfg] = entry;
    this[name] = convertFromAttribute(cfg.type, newValue);
  }

  requestUpdate() {
    if (!this.isConnected) return;
    const result = this.render();
    this.replaceChildren(
      ...(result == null ? [] : Array.isArray(result) ? result : [result])
    );
  }
}
