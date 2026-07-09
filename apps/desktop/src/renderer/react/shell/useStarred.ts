import { Store } from './store.js';
import { useCallback, useState } from 'react';

// Starred apps/automations, ported from the vanilla app.ts star helpers. Backed
// by the local Store ('home.starred' — an id→true map); reactive so toggling a
// star re-renders Home. Keyed by app id or automation ref.
export interface StarController {
  isStarred: (id: string) => boolean;
  toggleStar: (id: string) => void;
}

export function useStarred(): StarController {
  const [starred, setStarred] = useState<Record<string, boolean>>(() =>
    Store.get<Record<string, boolean>>('home.starred', {}),
  );

  const isStarred = useCallback((id: string) => starred[id] === true, [starred]);

  const toggleStar = useCallback((id: string) => {
    setStarred((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      Store.set('home.starred', next);
      return next;
    });
  }, []);

  return { isStarred, toggleStar };
}
