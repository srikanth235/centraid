import { useCallback, useMemo, useState } from "react";

import { debounce } from "@centraid/design/elements";

import type { SearchStatus } from "../_shared/search-scaffold.ts";
import type { SearchData } from "./types.ts";

export interface LedgerSearch {
  query: string;
  status: SearchStatus;
  data: SearchData | null;
  onQuery: (value: string) => void;
  retry: () => void;
}

interface SearchState {
  query: string;
  status: SearchStatus;
  data: SearchData | null;
}

const RESTING: SearchState = { query: "", status: "resting", data: null };

export function useLedgerSearch(): LedgerSearch {
  const [state, setState] = useState<SearchState>(RESTING);

  const run = useMemo(() => {
    let seq = 0;
    return debounce(async (term: string) => {
      if (!term) {
        setState((prior) => ({ ...prior, data: null, status: "resting" }));
        return;
      }
      const mine = ++seq;
      setState((prior) => ({ ...prior, status: "searching" }));
      let data: SearchData | null = null;
      try {
        data = await window.centraid.read<SearchData>({
          query: "search",
          input: { term },
        });
      } catch {
        data = null;
      }
      if (mine !== seq) return;
      setState((prior) => ({
        ...prior,
        data,
        status: data ? "ready" : "unreachable",
      }));
    }, 150);
  }, []);

  const onQuery = useCallback(
    (value: string) => {
      setState((prior) => ({ ...prior, query: value }));
      run(value);
    },
    [run]
  );

  const retry = useCallback(() => run(state.query), [run, state.query]);

  return { ...state, onQuery, retry };
}
