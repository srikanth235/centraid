// The Search shelf's own read: debounced, sequenced, and honest about a miss.
//
// LIFTED OUT OF THE ORCHESTRATOR because it is one concern with two rules that
// are easy to lose in a bigger file:
//
//   * A THROW IS NOT AN EMPTY RESULT SET. An index that did not answer reports
//     `unreachable`, and the scaffold says NOTHING WAS CHECKED — collapsing it
//     into "no results" would be a claim nobody verified.
//   * A LATE ANSWER NEVER WINS. Each run takes a sequence number and a reply
//     that is not the latest is dropped, so typing "ferry" fast cannot leave
//     the results for "fer" on screen under the word "ferry".
//
// THE SEQUENCE COUNTER LIVES INSIDE THE DEBOUNCED RUNNER, not beside it. It is
// bookkeeping between two in-flight reads and nothing renders it, so it belongs
// in the one closure that increments and checks it — which also makes the
// runner a value this hook creates exactly once.
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

  // Created once. The runner closes over nothing but `setState` — which React
  // guarantees is stable — and its own sequence counter, so it never needs to
  // be rebuilt and the empty dependency list is the whole truth about it.
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
