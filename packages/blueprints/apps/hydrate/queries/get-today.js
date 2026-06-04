const GOAL = 8;

function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Read today's cup count, defaulting to 0 when no row exists yet.
 *
 * @typedef {Object} DailyRow
 * @property {number} cups
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ db }) => {
  const today = todayKey();
  const row = /** @type {DailyRow | undefined} */ (
    await db.prepare('SELECT cups FROM hydrate_daily WHERE date = ?').get(today)
  );
  const cups = row ? row.cups : 0;
  return { date: today, cups, goal: GOAL };
};
