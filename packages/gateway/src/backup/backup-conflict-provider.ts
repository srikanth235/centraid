/**
 * A provider decorator for the takeover contract: the second `registerSnapshot`
 * and every one after it fails with `conflict_generation`, as a real provider
 * would once another machine has claimed the vault. Delegates everything else
 * to the real provider, so the test still exercises genuine behaviour on both
 * sides of the conflict.
 */

import { BackupProviderError } from "@centraid/backup";
import type { BackupProvider } from "@centraid/backup";

export function conflictAfterFirstCall(real: BackupProvider): BackupProvider {
  let calls = 0;
  return {
    capabilities: (...a) => real.capabilities(...a),
    createTarget: (...a) => real.createTarget(...a),
    deleteTarget: (...a) => real.deleteTarget(...a),
    undeleteTarget: (...a) => real.undeleteTarget(...a),
    purgeTarget: (...a) => real.purgeTarget(...a),
    openDataPlane: (...a) => real.openDataPlane(...a),
    registerSnapshot: (...a) => {
      calls += 1;
      if (calls === 1) return real.registerSnapshot(...a);
      const conflict: Error = BackupProviderError.of(
        "conflict_generation",
        "another machine has taken over this vault",
        {
          currentGeneration: 5,
        }
      );
      return Promise.reject(conflict);
    },
    listSnapshots: (...a) => real.listSnapshots(...a),
    getSnapshot: (...a) => real.getSnapshot(...a),
    getTarget: (...a) => real.getTarget(...a),
    usage: (...a) => real.usage(...a),
  };
}
