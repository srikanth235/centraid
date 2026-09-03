import { ALL_LAYERS_ON } from "./day-context.ts";
import type { LayerId, LayerState } from "./day-context.ts";

export interface MemberPrefs {
  layers: LayerState;
}

const DEFAULTS: MemberPrefs = { layers: ALL_LAYERS_ON };

export interface MemberPrefsStore {
  read: () => MemberPrefs;
  toggleLayer: (id: LayerId) => void;
}

export function createMemberPrefs(
  onChange: () => void,
  seed: Partial<MemberPrefs> = {}
): MemberPrefsStore {
  let held: MemberPrefs = { ...DEFAULTS, ...seed };
  return {
    read: () => held,
    toggleLayer: (id) => {
      held = { ...held, layers: { ...held.layers, [id]: !held.layers[id] } };
      onChange();
    },
  };
}
