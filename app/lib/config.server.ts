// Server-only: passwords + validation. Not imported by client components.
export * from "./config";

import { UserPassword } from "./models.server";
import { USERS } from "./config";

// Returns true if password is valid. If user has no password yet, saves it and returns true.
export async function validateUser(userId: string, password: string): Promise<boolean> {
  if (!password || !(userId in USERS)) return false;
  const record = await UserPassword.findOne({ userId });
  if (!record) {
    await UserPassword.create({ userId, password });
    return true;
  }
  return record.password === password;
}

// Returns userIds that haven't set a password yet.
export async function getUsersWithoutPassword(): Promise<string[]> {
  const records = await UserPassword.find({}, { userId: 1 }).lean();
  const withPassword = new Set(records.map((r) => r.userId));
  return Object.keys(USERS).filter((id) => !withPassword.has(id));
}
