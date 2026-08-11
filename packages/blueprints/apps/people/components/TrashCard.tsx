import { displayText } from "../../_shared/untrusted.ts";
import { avatarColor } from "../format.ts";
import type { Person } from "../types.ts";
import { KitAvatar } from "./Shared.tsx";

import styles from "./TrashCard.module.css";

export function TrashCard({
  person,
  pending,
  onRestore,
}: {
  person: Person;
  /** A trash/restore write for this row is unsettled (issue #738). */
  pending?: boolean;
  onRestore: (person: Person) => void;
}) {
  const purge = person.purge_at ? new Date(person.purge_at) : null;
  const name = displayText(person.name);
  return (
    <article className={pending ? `${styles.card} kit-pending` : styles.card}>
      <KitAvatar name={name} size="48px" color={avatarColor(person)} />
      <div className={styles.copy}>
        <strong>{name}</strong>
        <span>{displayText(person.role || "No role")}</span>
        <small>
          {purge && !Number.isNaN(purge.getTime())
            ? `Purges ${purge.toLocaleDateString()}`
            : "Scheduled for purge"}
        </small>
        {pending ? <span className="kit-pending-chip">pending</span> : null}
      </div>
      <button
        type="button"
        className="kit-btn primary"
        onClick={() => onRestore(person)}
      >
        Restore
      </button>
    </article>
  );
}
