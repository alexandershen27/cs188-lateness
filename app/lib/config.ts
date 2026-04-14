// Shared between server and client — no passwords here

export const USERS: Record<string, { id: string; name: string; color: string; glow: string; emoji: string; joinDate?: string }> = {
  keshiv:  { id: "keshiv",  name: "Keshiv",  color: "#a78bfa", glow: "rgba(167,139,250,0.4)", emoji: "🦅" },
  alex:    { id: "alex",    name: "Alex",     color: "#60a5fa", glow: "rgba(96,165,250,0.4)",  emoji: "⚡" },
  vivek:   { id: "vivek",   name: "Vivek",    color: "#34d399", glow: "rgba(52,211,153,0.4)",  emoji: "🔥" },
  anahita: { id: "anahita", name: "Anahita",  color: "#fb923c", glow: "rgba(251,146,60,0.4)",  emoji: "☄️", joinDate: "2026-04-14" },
};

export type UserId = keyof typeof USERS;

export const CLASS_HOUR = 10;
export const CLASS_MINUTE = 0;
export const CLASS_END_HOUR = 11;
export const CLASS_END_MINUTE = 50;

// First day of official tracking (absences count from here)
export const FIRST_TRACKED_LECTURE = "2026-04-07";

// Penalty applied to stats for a missed lecture
export const ABSENCE_PENALTY_MINUTES = 110;

// Tue/Thu schedule weeks 1–10. April 2 was intro day (week 1, no absence tracking).
// Official lectures start April 7 (week 2).
export const LECTURE_SCHEDULE: { week: number; date: string }[] = [
  { week: 1,  date: "2026-04-02" },
  { week: 2,  date: "2026-04-07" },
  { week: 2,  date: "2026-04-09" },
  { week: 3,  date: "2026-04-14" },
  { week: 3,  date: "2026-04-16" },
  { week: 4,  date: "2026-04-21" },
  { week: 4,  date: "2026-04-23" },
  { week: 5,  date: "2026-04-28" },
  { week: 5,  date: "2026-04-30" },
  { week: 6,  date: "2026-05-05" },
  { week: 6,  date: "2026-05-07" },
  { week: 7,  date: "2026-05-12" },
  { week: 7,  date: "2026-05-14" },
  { week: 8,  date: "2026-05-19" },
  { week: 8,  date: "2026-05-21" },
  { week: 9,  date: "2026-05-26" },
  { week: 9,  date: "2026-05-28" },
  { week: 10, date: "2026-06-02" },
  { week: 10, date: "2026-06-04" },
];

export function getCurrentWeek(today: string): number {
  const past = LECTURE_SCHEDULE.filter((l) => l.date <= today);
  return past.length > 0 ? past[past.length - 1].week : 1;
}

export function getNextLecture(today: string): { week: number; date: string } | null {
  return LECTURE_SCHEDULE.find((l) => l.date > today) ?? null;
}

// Returns official lectures that have fully passed (date < today, or date === today and class is over)
export function getCompletedOfficialLectures(today: string, classIsOver: boolean): string[] {
  return LECTURE_SCHEDULE
    .filter((l) => l.date >= FIRST_TRACKED_LECTURE)
    .filter((l) => l.date < today || (l.date === today && classIsOver))
    .map((l) => l.date);
}

// Uses the LA-time toLocaleString trick so the difference is correct regardless of server timezone.
export function getLatenessMinutes(timestamp: Date | string): number {
  const ts = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const laString = ts.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const tsLA = new Date(laString);
  const classStart = new Date(tsLA);
  classStart.setHours(CLASS_HOUR, CLASS_MINUTE, 0, 0);
  return (tsLA.getTime() - classStart.getTime()) / 60000;
}

export function formatLateness(minutes: number): string {
  const abs = Math.abs(minutes);
  const mins = Math.floor(abs);
  const secs = Math.round((abs - mins) * 60);
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  if (minutes < -0.5) return `${timeStr} early`;
  if (minutes < 0.5) return "exactly on time";
  return `${timeStr} late`;
}

export function getLatenessQuip(minutes: number): string {
  if (minutes < -10) return "🏃 You absolute speedrunner.";
  if (minutes < -2)  return "🎉 Early bird! Slay.";
  if (minutes < 0)   return "✨ Technically early. We'll take it.";
  if (minutes < 1)   return "⚡ EXACTLY on time. Legend behavior.";
  if (minutes < 5)   return "😅 Only a little late. Fashionably.";
  if (minutes < 10)  return "😬 Getting there...";
  if (minutes < 20)  return "💀 Yikes. Did you even sleep?";
  return "🪦 You have transcended punctuality.";
}
