import type { ReactNode } from "react";

/** Direct recovery path for a denied blueprint read (#630). */
export function VaultAccessButton(): ReactNode {
  return (
    <button
      type="button"
      className="kit-btn"
      onClick={() => {
        const shell = (
          window as unknown as {
            Centraid?: {
              openAppVaultSettings?: () => void;
              openSettings?: () => void | Promise<void>;
            };
          }
        ).Centraid;
        if (shell?.openAppVaultSettings) {
          shell.openAppVaultSettings();
        } else {
          void shell?.openSettings?.();
        }
      }}
    >
      Review vault access
    </button>
  );
}
