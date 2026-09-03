import type { JSX } from "react";

import { useKeychainPromptExpected } from "../../screens/useKeychainPrompt.js";
import type { ConnectFlowResult, ConnectMethod } from "./connectFlow-core.js";
import ConnectFlow from "./ConnectFlow.js";

import styles from "./ConnectFlow.module.css";

export const CONNECT_TICKET_INTRO =
  "Paste or scan the pairing ticket for the vaults you are joining.";

const TICKET_ONLY: readonly ConnectMethod[] = ["gateway"];

export interface ConnectTicketPanelProps {
  context: "onboarding" | "switcher";
  methods?: readonly ConnectMethod[];
  onDone: (result: ConnectFlowResult) => void;
  onCancel?: () => void;
}

export default function ConnectTicketPanel({
  context,
  methods = TICKET_ONLY,
  onDone,
  onCancel,
}: ConnectTicketPanelProps): JSX.Element {
  const keychainNote = useKeychainPromptExpected();
  const ticketOnly = methods.length === 1 && methods[0] === "gateway";
  return (
    <>
      <ConnectFlow
        context={context}
        methods={methods}
        {...(ticketOnly ? { initialMethod: "gateway" as const } : {})}
        {...(onCancel ? { onCancel } : {})}
        onDone={onDone}
      />
      {keychainNote ? (
        <p className={styles.keychainNote}>
          Connecting stores this device&rsquo;s keys in your system keychain —
          your OS may ask once to allow it.
        </p>
      ) : null}
    </>
  );
}
