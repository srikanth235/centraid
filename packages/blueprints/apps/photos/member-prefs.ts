// Seam, not storage (§16). Do not use localStorage — a member-record pref
// must not fork per device. A remount reset is visibly incomplete; a silent
// fork is not.
import { DEFAULT_RUNG } from "./layout.ts";
import type { Rung } from "./layout.ts";

export interface MemberPrefs {
  tileSize: Rung;
  vaultsOn: ReadonlySet<string>;
}

const DEFAULTS: MemberPrefs = {
  tileSize: DEFAULT_RUNG,
  vaultsOn: new Set(),
};

export interface MemberPrefsStore {
  read: () => MemberPrefs;
  write: (next: Partial<MemberPrefs>) => void;
}

export function createMemberPrefs(
  onChange: () => void,
  seed: Partial<MemberPrefs> = {}
): MemberPrefsStore {
  let held: MemberPrefs = { ...DEFAULTS, ...seed };
  return {
    read: () => held,
    write: (next) => {
      held = { ...held, ...next };
      onChange();
    },
  };
}

export function stepTileSize(current: Rung, delta: number): Rung {
  const next = Math.min(3, Math.max(0, current + delta));
  return next as Rung;
}
