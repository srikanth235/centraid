import type { CSSProperties, JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { AgentCardDTO, AgentToolDTO } from '../screen-contracts.js';
import { ModelSelect } from './SettingsProvidersSelects.js';
import styles from './SettingsProvidersScreen.module.css';

// Settings → Agents' inventory section: what is installed, what it exposes, and
// which routing lanes land on it. Carries no routing choice — those all live in
// the Routing table on the screen itself.

function ToolGroups({ tools }: { tools: AgentToolDTO[] }): JSX.Element {
  const native = tools.filter((t) => t.source === 'native');
  const mcp = new Map<string, AgentToolDTO[]>();
  for (const t of tools) {
    if (t.source !== 'mcp') continue;
    const server = t.server ?? 'mcp';
    mcp.set(server, [...(mcp.get(server) ?? []), t]);
  }
  const groups: Array<{ label: string; items: AgentToolDTO[] }> = [];
  if (native.length) groups.push({ label: 'Built-in', items: native });
  for (const server of [...mcp.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ label: server, items: mcp.get(server) ?? [] });
  }
  return (
    <div className={styles.groups}>
      {groups.map((g) => (
        <div key={g.label} className={styles.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupLabel}>{g.label}</span>
            <span className={styles.groupCount}>{String(g.items.length)}</span>
          </div>
          <div className={styles.list}>
            {g.items
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => (
                <div key={t.name} className={styles.item}>
                  <div className={styles.itemHead}>
                    <span className={styles.name}>{t.name}</span>
                    {t.hasArgs ? (
                      <span className={styles.args} title="Takes JSON arguments">
                        args
                      </span>
                    ) : null}
                  </div>
                  {t.description ? <span className={styles.desc}>{t.description}</span> : null}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One agent in the inventory. The "used by" chips report which lanes land here,
 * which is what the old "Active" pill meant back when exactly one agent could be
 * active — and strictly more informative now: they answer what breaks if this
 * agent goes away.
 */
export default function AgentEntry({
  card,
  usedBy,
  isDefault,
  saved,
  open,
  onToggle,
  onSetModel,
}: {
  card: AgentCardDTO;
  usedBy: string[];
  isDefault: boolean;
  saved: string;
  open: boolean;
  onToggle: () => void;
  onSetModel: (v: string) => void;
}): JSX.Element {
  const count = card.tools.length;
  return (
    <div
      className={styles.entry}
      data-tools-open={open ? 'true' : ''}
      style={{ '--row-accent': card.accent } as CSSProperties}
    >
      <div className={styles.row} data-unavail={card.connected ? '' : 'true'}>
        <span
          className={styles.rowDot}
          style={{ background: card.connected ? card.accent : 'var(--ink-4)' }}
        />
        <div className={styles.rowMeta}>
          <div className={styles.rowName}>{card.title}</div>
          <span className={styles.rowSub}>{card.subtitle}</span>
          <div className={styles.usedBy}>
            {isDefault ? (
              <span className={styles.usedByChip} data-default="true">
                Default
              </span>
            ) : null}
            {usedBy.map((s) => (
              <span key={s} className={styles.usedByChip}>
                {s}
              </span>
            ))}
            {!isDefault && usedBy.length === 0 ? (
              <span className={styles.usedByNone}>Unused</span>
            ) : null}
          </div>
        </div>
        <div className={styles.rowTools}>
          <button
            type="button"
            className={styles.toolsToggle}
            aria-expanded={open}
            title="Show tools this agent exposes (builtins + MCP)"
            onClick={onToggle}
          >
            <Icon name="Code" size={12} />
            <span
              className={styles.toolsCount}
            >{`${count} ${count === 1 ? 'tool' : 'tools'}`}</span>
            <span className={styles.toolsChev}>
              <Icon name="ChevronDown" size={12} />
            </span>
          </button>
        </div>
        <ModelSelect
          card={card}
          saved={saved}
          onChange={onSetModel}
          emptyLabel="Built-in default"
          ariaLabel={`Default model for ${card.title}`}
        />
      </div>
      <div className={styles.tools} hidden={!open}>
        {count > 0 ? (
          <ToolGroups tools={card.tools} />
        ) : (
          <div className={styles.desc}>
            {card.toolsLoading
              ? 'Scanning tools…'
              : 'No tools scanned yet — use Refresh tools below.'}
          </div>
        )}
      </div>
    </div>
  );
}
