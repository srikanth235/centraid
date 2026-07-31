import type { JSX } from "react";

import { useKeychainPromptExpected } from "../../screens/useKeychainPrompt.js";
import type { ConnectFlowResult, ConnectMethod } from "./connectFlow-core.js";
import ConnectFlow from "./ConnectFlow.js";

import styles from "./ConnectFlow.module.css";

/*
 * The pairing-ticket step, as ONE component.
 *
 * Adding a vault used to be a different experience depending on where you
 * started: onboarding opened straight on the ticket field with a sentence
 * explaining what a ticket is and a keychain heads-up, while the switcher's
 * modal opened on a one-card chooser with neither. Same act, two wizards.
 * Both hosts render this panel now, so the steps, the copy, and the keychain
 * warning cannot drift; what stays host-owned is only the chrome around it
 * (onboarding's dark card headline, the modal's dialog head).
 */

/** The one sentence that explains a pairing ticket. Exported rather than
 *  rendered here because each host styles its own lede (onboarding's card
 *  sub vs the modal's note), but they must say the same thing. */
export const CONNECT_TICKET_INTRO =
  "Paste or scan the pairing ticket for the vault you want to join. The ticket decides which vault you land in.";

const TICKET_ONLY: readonly ConnectMethod[] = ["gateway"];

export interface ConnectTicketPanelProps {
  /** Only changes the commit button's copy — see `ConnectFlowProps`. */
  context: "onboarding" | "switcher";
  /** Methods to offer. Ticket-only (the default) skips the chooser entirely;
   *  a caller that also offers `local` — desktop creating a fresh vault on
   *  its own embedded gateway — keeps the method grid, since there is a real
   *  choice to make then. */
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
