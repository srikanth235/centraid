import { avatarColor } from "../format.ts";
import type { Person } from "../types.ts";
import { KitAvatar } from "./Shared.tsx";

import styles from "./TrashCard.module.css";

export function TrashCard({
  person,
  onRestore,
}: {
  person: Person;
  onRestore: (person: Person) => void;
}) {
  const purge = person.purge_at ? new Date(person.purge_at) : null;
  return (
    <article className={styles.card}>
      <KitAvatar name={person.name} size="48px" color={avatarColor(person)} />
      <div className={styles.copy}>
        <strong>{person.name}</strong>
        <span>{person.role || "No role"}</span>
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
