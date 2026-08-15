// Shared light-DOM reactivity base for the kit custom elements (issue #327;
// de-Lit pass). Each element owns its implementation in its own module so the
// lint gate can enforce one custom-element class per module.

type PropertyType =
  | typeof String
  | typeof Number
  | typeof Boolean
  | typeof Array
  | typeof Object;

/** How one reactive property maps to its attribute, if it has one. */
export interface KitPropertyConfig {
  type?: PropertyType;
  /** `false` for a property with no attribute; a string renames it. */
  attribute?: string | false;
}

export type KitProperties = Record<string, KitPropertyConfig>;

const propertiesInstalled = new WeakSet<object>();

function attributeNameFor(
  propName: string,
  cfg: KitPropertyConfig | undefined
): string | null {
  if (cfg?.attribute === false) return null;
  if (typeof cfg?.attribute === "string") return cfg.attribute;
  return propName.toLowerCase();
}

function convertFromAttribute(
  type: PropertyType | undefined,
  raw: string | null
): unknown {
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

function installProperty(proto: object, name: string): void {
  const store = Symbol(name);
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: true,
    get(this: Record<symbol, unknown>) {
      return this[store];
    },
    set(this: Record<symbol, unknown> & KitElement, value: unknown) {
      this[store] = value;
      this.requestUpdate();
    },
  });
}

function ensurePropertiesInstalled(ctor: typeof KitElement): void {
  if (propertiesInstalled.has(ctor)) return;
  propertiesInstalled.add(ctor);
  for (const name of Object.keys(ctor.properties))
    installProperty(ctor.prototype, name);
}

/** Shared light-DOM reactivity base for every kit custom element. */
export abstract class KitElement extends HTMLElement {
  static properties: KitProperties = {};

  static get observedAttributes(): string[] {
    return Object.entries(this.properties)
      .map(([name, cfg]) => attributeNameFor(name, cfg))
      .filter((attr): attr is string => attr !== null);
  }

  constructor() {
    super();
    ensurePropertiesInstalled(new.target as typeof KitElement);
  }

  connectedCallback(): void {
    this.dataset.kitHost = "";
    this.requestUpdate();
  }

  attributeChangedCallback(
    attrName: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    if (oldValue === newValue) return;
    const properties = (this.constructor as typeof KitElement).properties;
    const entry = Object.entries(properties).find(
      ([name, cfg]) => attributeNameFor(name, cfg) === attrName
    );
    if (!entry) return;
    const [name, cfg] = entry;
    (this as unknown as Record<string, unknown>)[name] = convertFromAttribute(
      cfg.type,
      newValue
    );
  }

  requestUpdate(): void {
    if (!this.isConnected) return;
    const result = this.render();
    this.replaceChildren(
      ...(result == null ? [] : Array.isArray(result) ? result : [result])
    );
  }

  abstract render(): Node | Node[] | null;
}
