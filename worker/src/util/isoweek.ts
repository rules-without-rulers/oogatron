// ISO-8601 week label ("2026-W01") computed in JS: SQLite's %G/%V only landed
// in 3.46 and D1's engine version is not part of any contract we control.
export function isoWeek(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  // Shift to the Thursday of this week; its year is the ISO week-year.
  const day = d.getUTCDay() || 7; // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
