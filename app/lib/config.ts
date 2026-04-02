// Shared between server and client — no passwords here

export const USERS = {
  keshiv: { id: "keshiv", name: "Keshiv", color: "#a78bfa", glow: "rgba(167,139,250,0.4)", emoji: "🦅" },
  alex:   { id: "alex",   name: "Alex",   color: "#60a5fa", glow: "rgba(96,165,250,0.4)",  emoji: "⚡" },
  vivek:  { id: "vivek",  name: "Vivek",  color: "#34d399", glow: "rgba(52,211,153,0.4)",  emoji: "🔥" },
} as const;

export type UserId = keyof typeof USERS;

export const CLASS_HOUR = 10;
export const CLASS_MINUTE = 0;

export function getLatenessMinutes(timestamp: Date | string): number {
  const ts = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const classStart = new Date(ts);
  classStart.setHours(CLASS_HOUR, CLASS_MINUTE, 0, 0);
  return (ts.getTime() - classStart.getTime()) / 60000;
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
