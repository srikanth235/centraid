import { Avatar } from "../../_shared/Avatar.tsx";
import { displayText } from "../../_shared/untrusted.ts";
import { avatarColor } from "../format.ts";
import type { Person } from "../types.ts";

import styles from "./TrashCard.module.css";

export function TrashCard({
  person,
  onRestore,
}: {
  person: Person;
  onRestore: (person: Person) => void;
}) {
  const purge = person.purge_at ? new Date(person.purge_at) : null;
  const name = displayText(person.name);
  return (
    <article className={styles.card}>
      <Avatar color={avatarColor(person)} name={name} size="48px" />
      <div className={styles.copy}>
        <strong>{name}</strong>
        <span>{displayText(person.role || "No role")}</span>
        <small>
          {purge && !Number.isNaN(purge.getTime())
            ? `Purges ${purge.toLocaleDateString()}`
            : "Scheduled for purge"}
        </small>
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
