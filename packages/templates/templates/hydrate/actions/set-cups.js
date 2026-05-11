const GOAL = 8;
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
export default async ({ body, db }) => {
  const input = body;
  const requested = Number(input?.cups ?? 0);
  const next = Math.max(0, Math.min(GOAL, Number.isFinite(requested) ? requested : 0));
  const today = todayKey();
  db.prepare(`INSERT INTO hydrate_daily (date, cups) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET cups = excluded.cups`).run(today, next);
  return { status: 200, body: { date: today, cups: next, goal: GOAL } };
};
