import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type {
  AgentCardDTO,
  AgentModelDTO,
  AgentRunnerKind,
  AgentsStatusDTO,
  AgentToolDTO,
  SettingsProvidersBridgeProps,
} from '../bridge.js';

const TIER_ORDER = ['smart', 'balanced', 'fast'] as const;
const TIER_LABEL: Record<(typeof TIER_ORDER)[number], string> = {
  smart: 'Most capable',
  balanced: 'Balanced',
  fast: 'Fastest',
};
const POLL_MS = 800;
const POLL_WINDOW_MS = 30_000;

function ModelSelect({
  card,
  saved,
  onChange,
}: {
  card: AgentCardDTO;
  saved: string;
  onChange: (v: string) => void;
}): JSX.Element {
  const tiered = card.models.some((m) => m.tier);
  const opt = (m: AgentModelDTO): JSX.Element => (
    <option key={m.id} value={m.id}>
      {(m.name ?? m.id) + (m.default ? ' · default' : '')}
    </option>
  );
  return (
    <select
      className="agent-model-select"
      aria-label={`Default model for ${card.title}`}
      disabled={!card.connected}
      value={saved}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Gateway default</option>
      {saved && !card.models.some((m) => m.id === saved) ? (
        <option value={saved}>{`${saved} · unavailable`}</option>
      ) : null}
      {tiered ? (
        <>
          {TIER_ORDER.map((tier) => {
            const inTier = card.models.filter((m) => m.tier === tier);
            return inTier.length ? (
              <optgroup key={tier} label={TIER_LABEL[tier]}>
                {inTier.map(opt)}
              </optgroup>
            ) : null;
          })}
          {card.models.some((m) => !m.tier) ? (
            <optgroup label="Other">{card.models.filter((m) => !m.tier).map(opt)}</optgroup>
          ) : null}
        </>
      ) : (
        card.models.map(opt)
      )}
      {card.modelsLoading ? (
        <option value="__loading" disabled>
          Discovering models…
        </option>
      ) : null}
    </select>
  );
}

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
    <div className="tools-groups">
      {groups.map((g) => (
        <div key={g.label} className="tools-group">
          <div className="tools-group-head">
            <span className="tools-group-label">{g.label}</span>
            <span className="tools-group-count">{String(g.items.length)}</span>
          </div>
          <div className="tools-list">
            {g.items
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => (
                <div key={t.name} className="tool-item">
                  <div className="tool-item-head">
                    <span className="tool-name">{t.name}</span>
                    {t.hasArgs ? (
                      <span className="tool-args" title="Takes JSON arguments">
                        args
                      </span>
                    ) : null}
                  </div>
                  {t.description ? <span className="tool-desc">{t.description}</span> : null}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentEntry({
  card,
  active,
  saved,
  open,
  onToggle,
  onSetModel,
}: {
  card: AgentCardDTO;
  active: boolean;
  saved: string;
  open: boolean;
  onToggle: () => void;
  onSetModel: (v: string) => void;
}): JSX.Element {
  const count = card.tools.length;
  return (
    <div
      className="agent-entry"
      data-tools-open={open ? 'true' : ''}
      style={{ '--row-accent': card.accent } as CSSProperties}
    >
      <div
        className="agent-row"
        data-active={active ? 'true' : ''}
        data-unavail={card.connected ? '' : 'true'}
      >
        <span
          className="agent-row-dot"
          style={{ background: card.connected ? card.accent : 'var(--ink-4, var(--ink-3))' }}
        />
        <div className="agent-row-meta">
          <div className="agent-row-name">
            {card.title}
            {active ? <span className="agent-row-active">Active</span> : null}
          </div>
          <span className="agent-row-sub">{card.subtitle}</span>
        </div>
        <div className="agent-row-tools">
          <button
            type="button"
            className="agent-tools-toggle"
            aria-expanded={open}
            title="Show tools this agent exposes (builtins + MCP)"
            onClick={onToggle}
          >
            <Icon name="Code" size={12} />
            <span className="agent-tools-count">{`${count} ${count === 1 ? 'tool' : 'tools'}`}</span>
            <span className="agent-tools-chev">
              <Icon name="ChevronDown" size={12} />
            </span>
          </button>
        </div>
        <div className="agent-row-model">
          <ModelSelect card={card} saved={saved} onChange={onSetModel} />
        </div>
      </div>
      <div className="agent-tools" hidden={!open}>
        {count > 0 ? (
          <ToolGroups tools={card.tools} />
        ) : (
          <div className="agent-tools-empty">
            {card.toolsLoading
              ? 'Scanning tools…'
              : 'No tools scanned yet — use Refresh tools below.'}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Settings → Providers (agents console), ported to React (issue #325,
 * Phase 3). Active-agent switch, per-agent status + default-model picker +
 * tool disclosure, and the two refreshes. The vanilla side owns the gateway
 * I/O (loadStatus/refresh/activate/save); React owns the view, the tool-open
 * state, and the bounded poll while any surface is still enumerating.
 */
export default function SettingsProvidersScreen({
  loadStatus,
  refreshModels,
  refreshTools,
  activateRunner,
  setAgentModel,
}: SettingsProvidersBridgeProps): JSX.Element {
  const [status, setStatus] = useState<AgentsStatusDTO | null>(null);
  const [selected, setSelected] = useState<AgentRunnerKind>('codex');
  const [savedByKind, setSavedByKind] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<AgentRunnerKind>>(new Set());
  const [busyModels, setBusyModels] = useState(false);
  const [busyTools, setBusyTools] = useState(false);
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((s: AgentsStatusDTO) => {
    setStatus(s);
    setSelected(s.selectedKind);
    setSavedByKind(s.savedModelByKind);
  }, []);

  const poll = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void loadStatus().then((s) => {
        // Poll only fills in loading model/tool lists — keep the user's
        // optimistic runner/model selection, don't reapply from the server.
        setStatus(s);
        if (s.anyLoading && Date.now() < deadlineRef.current) poll();
      });
    }, POLL_MS);
  }, [loadStatus]);

  useEffect(() => {
    deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    void loadStatus().then((s) => {
      apply(s);
      if (s.anyLoading) poll();
    });
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loadStatus, apply, poll]);

  const doRefresh = (fn: () => Promise<AgentsStatusDTO>, setBusy: (b: boolean) => void): void => {
    setBusy(true);
    deadlineRef.current = Date.now() + POLL_WINDOW_MS;
    fn()
      .then((s) => {
        apply(s);
        if (s.anyLoading) poll();
      })
      .finally(() => setBusy(false));
  };

  const onActivate = (kind: AgentRunnerKind): void => {
    if (kind === selected) return;
    const prev = selected;
    setSelected(kind); // optimistic
    void activateRunner(kind).then((ok) => {
      if (!ok) setSelected(prev);
    });
  };

  const onSetModel = (kind: AgentRunnerKind, v: string): void => {
    setSavedByKind((m) => {
      const next = { ...m };
      if (v) next[kind] = v;
      else delete next[kind];
      return next;
    });
    setAgentModel(kind, v);
  };

  const toggleTools = (kind: AgentRunnerKind): void => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const cards = status?.cards ?? [];

  return (
    <div className="drawer-group">
      <div className="drawer-group-label">Connected</div>
      <div className="drawer-group-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="settings-note">
            Switch the active agent below; set each agent’s default model. Detection is CLI-only —
            the gateway ran `&lt;bin&gt; --version`; Centraid doesn’t inspect how each agent
            authenticates.
          </div>
          <div
            className="agent-switch"
            role="tablist"
            aria-label="Active agent"
            data-active-index={String(selected === 'codex' ? 0 : 1)}
          >
            <span className="agent-switch-ind" />
            {cards.map((card) => (
              <button
                key={card.kind}
                type="button"
                className="agent-switch-seg"
                role="tab"
                aria-selected={card.kind === selected}
                data-active={card.kind === selected ? 'true' : ''}
                data-unavail={card.connected ? '' : 'true'}
                disabled={!card.connected || card.kind === selected}
                title={`Make ${card.title} the active agent`}
                onClick={() => onActivate(card.kind)}
              >
                <span className="agent-switch-dot" style={{ background: card.accent }} />
                <span>{card.title}</span>
              </button>
            ))}
          </div>
          <div className="agents-panel">
            {status === null ? (
              <div className="settings-note">Reading credential status…</div>
            ) : (
              cards.map((card) => (
                <AgentEntry
                  key={card.kind}
                  card={card}
                  active={card.kind === selected}
                  saved={savedByKind[card.kind] ?? ''}
                  open={open.has(card.kind)}
                  onToggle={() => toggleTools(card.kind)}
                  onSetModel={(v) => onSetModel(card.kind, v)}
                />
              ))
            )}
          </div>
        </div>
      </div>
      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn-soft"
          disabled={busyModels}
          onClick={() => doRefresh(refreshModels, setBusyModels)}
        >
          <Icon name="Reset" size={13} />
          <span>Refresh models</span>
        </button>
        <button
          type="button"
          className="btn btn-soft"
          disabled={busyTools}
          onClick={() => doRefresh(refreshTools, setBusyTools)}
        >
          <Icon name="Refresh" size={13} />
          <span>{busyTools ? 'Scanning tools…' : 'Refresh tools'}</span>
        </button>
      </div>
    </div>
  );
}
