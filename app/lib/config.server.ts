// Server-only: passwords + validation. Not imported by client components.
export * from "./config";

// Change these before your first real class!
const PASSWORDS: Record<string, string> = {
  keshiv: "keshiv",
  alex: "alex",
  vivek: "vivek",
};

export function validateUser(userId: string, password: string): boolean {
  return !!PASSWORDS[userId] && PASSWORDS[userId] === password;
}
