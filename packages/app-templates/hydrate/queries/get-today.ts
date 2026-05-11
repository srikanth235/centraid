import type { QueryHandler } from '@centraid/openclaw-plugin';

const GOAL = 8;

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default (async ({ db }) => {
  const today = todayKey();
  const row = db
    .prepare('SELECT cups FROM hydrate_daily WHERE date = ?')
    .get<{ cups: number }>(today);
  const cups = row ? row.cups : 0;
  return { date: today, cups, goal: GOAL };
}) satisfies QueryHandler;
