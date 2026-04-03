import { useState, useEffect, useRef } from "react";
import { data, useFetcher, useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/_index";
import { connectDB } from "~/lib/db.server";
import { ClockIn, CorrectionRequest } from "~/lib/models.server";
import { validateUser, getUsersWithoutPassword } from "~/lib/config.server";
import {
  USERS,
  getLatenessMinutes,
  formatLateness,
  getLatenessQuip,
  getCurrentWeek,
  getNextLecture,
  LECTURE_SCHEDULE,
} from "~/lib/config";

// ── Types ────────────────────────────────────────────────────────────────────

interface UserStats {
  userId: string;
  name: string;
  color: string;
  glow: string;
  emoji: string;
  totalClockIns: number;
  averageLateness: number | null;
  bestLateness: number | null;
  worstLateness: number | null;
  onTimeRate: number | null;
  lastClockIn: string | null;
  todayClockedIn: boolean;
  todayLateness: number | null;
}

interface SerialClockIn {
  id: string;
  userId: string;
  timestamp: string;
  date: string;
  effectiveTimestamp: string;
  location: { lat: number; lng: number } | null;
  latenessMinutes: number;
}

interface SerialCorrection {
  id: string;
  clockInId: string;
  clockInUserId: string;
  requestedBy: string;
  originalTimestamp: string;
  requestedTimestamp: string;
  reason: string;
  status: string;
  approvedBy?: string;
  createdAt: string;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export async function loader() {
  try {
    await connectDB();
  } catch (error) {
    throw new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const allClockIns = await ClockIn.find().sort({ timestamp: 1 }).lean();
  const pendingCorrections = await CorrectionRequest.find({ status: "pending" })
    .sort({ createdAt: -1 })
    .lean();

  // Build per-user stats
  const stats: UserStats[] = Object.values(USERS).map((user) => {
    const userClockIns = allClockIns.filter((c) => c.userId === user.id);
    const todayClockIn = userClockIns.find((c) => c.date === today);

    const latenesses = userClockIns.map((c) => {
      const effective = c.correctedTimestamp ?? c.timestamp;
      return getLatenessMinutes(effective);
    });

    const todayLateness = todayClockIn
      ? getLatenessMinutes(todayClockIn.correctedTimestamp ?? todayClockIn.timestamp)
      : null;

    return {
      userId: user.id,
      name: user.name,
      color: user.color,
      glow: user.glow,
      emoji: user.emoji,
      totalClockIns: userClockIns.length,
      averageLateness: latenesses.length
        ? latenesses.reduce((a, b) => a + b, 0) / latenesses.length
        : null,
      bestLateness: latenesses.length ? Math.min(...latenesses) : null,
      worstLateness: latenesses.length ? Math.max(...latenesses) : null,
      onTimeRate: latenesses.length
        ? (latenesses.filter((l) => l <= 5).length / latenesses.length) * 100
        : null,
      lastClockIn: userClockIns.length
        ? (userClockIns[userClockIns.length - 1].correctedTimestamp ?? userClockIns[userClockIns.length - 1].timestamp).toISOString()
        : null,
      todayClockedIn: !!todayClockIn,
      todayLateness,
    };
  });

  // Serialize clock-ins for client (for corrections UI)
  const serialClockIns: SerialClockIn[] = allClockIns.map((c) => ({
    id: c._id.toString(),
    userId: c.userId,
    timestamp: c.timestamp.toISOString(),
    date: c.date,
    effectiveTimestamp: (c.correctedTimestamp ?? c.timestamp).toISOString(),
    location: c.location?.lat != null ? { lat: c.location.lat, lng: c.location.lng } : null,
    latenessMinutes: getLatenessMinutes(c.correctedTimestamp ?? c.timestamp),
  }));

  const serialCorrections: SerialCorrection[] = pendingCorrections.map((r) => ({
    id: r._id.toString(),
    clockInId: r.clockInId.toString(),
    clockInUserId: r.clockInUserId,
    requestedBy: r.requestedBy,
    originalTimestamp: r.originalTimestamp.toISOString(),
    requestedTimestamp: r.requestedTimestamp.toISOString(),
    reason: r.reason,
    status: r.status,
    approvedBy: r.approvedBy,
    createdAt: r.createdAt.toISOString(),
  }));

  const usersWithoutPassword = await getUsersWithoutPassword();

  return { stats, clockIns: serialClockIns, corrections: serialCorrections, today, usersWithoutPassword };
}

// ── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  await connectDB();
  const fd = await request.formData();
  const intent = fd.get("intent") as string;

  if (intent === "clockin") {
    const userId = fd.get("userId") as string;
    const password = fd.get("password") as string;
    const lat = fd.get("lat") ? parseFloat(fd.get("lat") as string) : null;
    const lng = fd.get("lng") ? parseFloat(fd.get("lng") as string) : null;

    if (!await validateUser(userId, password)) {
      return data({ error: "Wrong password. Try again." }, { status: 401 });
    }

    if (lat !== null && lng !== null) {
      const dx = lat - 34.073471;
      const dy = lng - -118.440165;
      const approxKm = Math.sqrt(dx * dx + dy * dy) * 111;
      if (approxKm > 0.05) {
        return data({ error: "You need to be at Perloff Hall to clock in." }, { status: 403 });
      }
    }

    const now = new Date();
    const date = now.toISOString().slice(0, 10);

    const existing = await ClockIn.findOne({ userId, date });
    if (existing) {
      const lateness = getLatenessMinutes(existing.correctedTimestamp ?? existing.timestamp);
      return data({
        alreadyClockedIn: true,
        lateness,
        quip: getLatenessQuip(lateness),
        latenessStr: formatLateness(lateness),
      });
    }

    const clockIn = await ClockIn.create({
      userId,
      timestamp: now,
      date,
      location: lat != null && lng != null ? { lat, lng } : null,
    });

    const lateness = getLatenessMinutes(clockIn.timestamp);
    return data({
      success: true,
      lateness,
      quip: getLatenessQuip(lateness),
      latenessStr: formatLateness(lateness),
    });
  }

  if (intent === "request-correction") {
    const userId = fd.get("userId") as string;
    const password = fd.get("password") as string;
    const clockInId = fd.get("clockInId") as string;
    const requestedTimestamp = new Date(fd.get("requestedTimestamp") as string);
    const reason = (fd.get("reason") as string) || "";

    if (!await validateUser(userId, password)) {
      return data({ error: "Wrong password." }, { status: 401 });
    }

    const clockIn = await ClockIn.findById(clockInId);
    if (!clockIn) return data({ error: "Clock-in not found." }, { status: 404 });
    if (clockIn.userId !== userId) return data({ error: "That's not your clock-in." }, { status: 403 });

    await CorrectionRequest.create({
      clockInId: clockIn._id,
      clockInUserId: clockIn.userId,
      requestedBy: userId,
      originalTimestamp: clockIn.correctedTimestamp ?? clockIn.timestamp,
      requestedTimestamp,
      reason,
    });

    return data({ success: true, message: "Correction requested! Waiting for peer approval." });
  }

  if (intent === "approve-correction") {
    const approverId = fd.get("approverId") as string;
    const approverPassword = fd.get("approverPassword") as string;
    const correctionId = fd.get("correctionId") as string;

    if (!validateUser(approverId, approverPassword)) {
      return data({ error: "Wrong approver password." }, { status: 401 });
    }

    const correction = await CorrectionRequest.findById(correctionId);
    if (!correction) return data({ error: "Correction not found." }, { status: 404 });
    if (correction.requestedBy === approverId) {
      return data({ error: "You can't approve your own correction." }, { status: 403 });
    }

    correction.status = "approved";
    correction.approvedBy = approverId;
    await correction.save();

    await ClockIn.findByIdAndUpdate(correction.clockInId, {
      correctedTimestamp: correction.requestedTimestamp,
    });

    return data({ success: true, message: "Correction approved!" });
  }

  if (intent === "reject-correction") {
    const approverId = fd.get("approverId") as string;
    const approverPassword = fd.get("approverPassword") as string;
    const correctionId = fd.get("correctionId") as string;

    if (!validateUser(approverId, approverPassword)) {
      return data({ error: "Wrong password." }, { status: 401 });
    }

    const correction = await CorrectionRequest.findById(correctionId);
    if (!correction) return data({ error: "Not found." }, { status: 404 });
    if (correction.requestedBy === approverId) {
      return data({ error: "You can't reject your own correction." }, { status: 403 });
    }

    correction.status = "rejected";
    correction.approvedBy = approverId;
    await correction.save();

    return data({ success: true, message: "Correction rejected." });
  }

  return data({ error: "Unknown intent." }, { status: 400 });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function latenessColor(minutes: number | null): string {
  if (minutes === null) return "#6b7280";
  if (minutes < 0) return "#34d399";
  if (minutes < 5) return "#fbbf24";
  if (minutes < 15) return "#f97316";
  return "#ef4444";
}

function LatenessTag({ minutes }: { minutes: number | null }) {
  if (minutes === null) return <span className="text-sm" style={{ color: "#6b7280" }}>No data</span>;
  const color = latenessColor(minutes);
  return (
    <span className="text-sm font-mono font-bold px-2 py-0.5 rounded-full" style={{ color, background: color + "22" }}>
      {formatLateness(minutes)}
    </span>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

const UCLA_LAT = 34.073471;
const UCLA_LNG = -118.440165;
const AT_LECTURE_RADIUS_KM = 0.05; // ~50m — must be in Perloff Hall

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ClockInSection({ today, usersWithoutPassword, isLectureDay, nextLecture }: {
  today: string;
  usersWithoutPassword: string[];
  isLectureDay: boolean;
  nextLecture: { week: number; date: string } | null;
}) {
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const [selectedUser, setSelectedUser] = useState<string>("");
  const [password, setPassword] = useState("");
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  const [showSuccess, setShowSuccess] = useState(false);
  const prevSubmitting = useRef(false);

  const atLecture = locationStatus === "granted" && location
    ? distanceKm(location.lat, location.lng, UCLA_LAT, UCLA_LNG) <= AT_LECTURE_RADIUS_KM
    : null; // null = unknown (still requesting or denied)

  useEffect(() => {
    if (locationStatus === "idle") {
      setLocationStatus("requesting");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setLocationStatus("granted");
        },
        () => setLocationStatus("denied")
      );
    }
  }, []);

  useEffect(() => {
    const wasSubmitting = prevSubmitting.current;
    const isNowIdle = fetcher.state === "idle";
    if (wasSubmitting && isNowIdle && fetcher.data && !("error" in fetcher.data)) {
      setShowSuccess(true);
      setPassword("");
      revalidate();
      setTimeout(() => setShowSuccess(false), 6000);
    }
    prevSubmitting.current = fetcher.state === "submitting";
  }, [fetcher.state, fetcher.data]);

  const responseData = fetcher.data as Record<string, unknown> | undefined;
  const error = responseData?.error as string | undefined;
  const success = (responseData?.success || responseData?.alreadyClockedIn) as boolean | undefined;
  const quip = responseData?.quip as string | undefined;
  const latenessStr = responseData?.latenessStr as string | undefined;
  const alreadyClockedIn = responseData?.alreadyClockedIn as boolean | undefined;

  const headerRight = isLectureDay
    ? new Date(today + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + " · 10:00 AM"
    : nextLecture
    ? "Next class: " + new Date(nextLecture.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    : "No upcoming lectures";

  return (
    <div className="glass rounded-2xl p-6 animate-slide-up">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Clock In</h2>
        <div className="text-sm font-mono" style={{ color: "#6b7280" }}>
          {headerRight}
        </div>
      </div>

      {showSuccess && success && !alreadyClockedIn && (
        <div className="mb-4 p-4 rounded-xl text-center animate-bounce-in" style={{ background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.3)" }}>
          <div className="text-2xl mb-1">{quip?.split(" ")[0]}</div>
          <div className="font-bold text-lg" style={{ color: "#34d399" }}>{latenessStr}</div>
          <div className="text-sm mt-1" style={{ color: "#9ca3af" }}>{quip?.slice(quip.indexOf(" ") + 1)}</div>
        </div>
      )}

      {alreadyClockedIn && success && (
        <div className="mb-4 p-4 rounded-xl text-center" style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)" }}>
          <div className="font-semibold" style={{ color: "#fbbf24" }}>Already clocked in today — {latenessStr}</div>
          <div className="text-sm mt-1" style={{ color: "#9ca3af" }}>{quip}</div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444" }}>
          {error}
        </div>
      )}

      <fetcher.Form method="post" className="space-y-5">
        <input type="hidden" name="intent" value="clockin" />
        {location && (
          <>
            <input type="hidden" name="lat" value={location.lat} />
            <input type="hidden" name="lng" value={location.lng} />
          </>
        )}

        {/* User selection */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "#9ca3af" }}>Who are you?</label>
          <div className="grid grid-cols-3 gap-3">
            {Object.values(USERS).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUser(user.id)}
                className="p-3 rounded-xl font-semibold transition-all duration-200 text-center"
                style={{
                  background: selectedUser === user.id ? user.color + "22" : "rgba(255,255,255,0.04)",
                  border: `2px solid ${selectedUser === user.id ? user.color : "rgba(255,255,255,0.08)"}`,
                  color: selectedUser === user.id ? user.color : "#9ca3af",
                  boxShadow: selectedUser === user.id ? `0 0 20px ${user.glow}` : "none",
                }}
              >
                <div className="text-2xl mb-1">{user.emoji}</div>
                <div>{user.name}</div>
              </button>
            ))}
          </div>
          <input type="hidden" name="userId" value={selectedUser} />
        </div>

        {/* Password */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "#9ca3af" }}>Password</label>
          <input
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={selectedUser && usersWithoutPassword.includes(selectedUser) ? "Set a password" : "Enter your password"}
            className="w-full px-4 py-3 rounded-xl outline-none transition-all duration-200"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "white",
              fontFamily: "JetBrains Mono, monospace",
            }}
          />
        </div>

        {/* Location status */}
        {(() => {
          const dotColor = locationStatus === "requesting"
            ? "#fbbf24"
            : locationStatus === "denied"
            ? "#6b7280"
            : atLecture === true
            ? "#34d399"
            : "#fbbf24";

          return (
            <div className="flex items-center gap-2 text-sm" style={{ color: "#6b7280" }}>
              <div className="relative w-2 h-2 flex-shrink-0">
                <div className="w-2 h-2 rounded-full" style={{ background: dotColor }} />
                {locationStatus === "requesting" && (
                  <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping" style={{ background: dotColor }} />
                )}
              </div>
              {locationStatus === "granted" && atLecture === true && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" }}>
                  at lecture
                </span>
              )}
              {locationStatus === "granted" && atLecture === false && <span>not at lecture</span>}
              {locationStatus === "denied" && <span>location not shared</span>}
              {locationStatus === "requesting" && <span>Requesting location...</span>}
              {locationStatus === "idle" && <span>Location pending</span>}
            </div>
          );
        })()}

        <button
          type="submit"
          disabled={!selectedUser || !password || fetcher.state === "submitting" || atLecture === false}
          className="btn-clockin w-full py-4 rounded-xl font-bold text-lg text-white transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none relative overflow-hidden"
        >
          <span className="relative z-10">
            {fetcher.state === "submitting" ? "Clocking in..." : atLecture === false ? "Not at lecture" : "🕙 CLOCK IN"}
          </span>
        </button>
      </fetcher.Form>
    </div>
  );
}

function Leaderboard({ stats }: { stats: UserStats[] }) {
  const ranked = [...stats]
    .filter((s) => s.averageLateness !== null)
    .sort((a, b) => (a.averageLateness ?? 0) - (b.averageLateness ?? 0));

  const unranked = stats.filter((s) => s.averageLateness === null);
  const allRanked = [...ranked, ...unranked];

  const rankStyles = ["rank-1", "rank-2", "rank-3"];
  const rankLabels = ["🥇", "🥈", "🥉"];
  const rankTitles = ["Most Punctual", "Second Best", "Room to Grow"];

  return (
    <div className="glass rounded-2xl p-6 animate-slide-up" style={{ animationDelay: "0.1s" }}>
      <h2 className="text-xl font-bold mb-5">Leaderboard</h2>
      <div className="space-y-3">
        {allRanked.map((user, i) => (
          <div
            key={user.userId}
            className="flex items-center gap-4 p-4 rounded-xl transition-all"
            style={{
              background: "rgba(255,255,255,0.03)",
              border: `1px solid ${i === 0 ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.06)"}`,
            }}
          >
            <div className={`${rankStyles[i] || ""} w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold flex-shrink-0`}
              style={i >= 3 ? { background: "rgba(255,255,255,0.08)" } : {}}>
              {rankLabels[i] || `#${i + 1}`}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-lg">{user.emoji}</span>
                <span className="font-bold" style={{ color: user.color }}>{user.name}</span>
                {i < 3 && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.05)", color: "#6b7280" }}>{rankTitles[i]}</span>}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
                {user.totalClockIns} class{user.totalClockIns !== 1 ? "es" : ""}
                {user.onTimeRate !== null && ` · ${user.onTimeRate.toFixed(0)}% on time`}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              {user.averageLateness !== null ? (
                <div className="font-mono font-bold text-sm" style={{ color: latenessColor(user.averageLateness) }}>
                  avg {user.averageLateness < 0 ? "−" : "+"}{Math.abs(user.averageLateness).toFixed(1)}m
                </div>
              ) : (
                <div className="text-sm" style={{ color: "#4b5563" }}>no data</div>
              )}
              {user.todayClockedIn && (
                <div className="text-xs mt-0.5" style={{ color: latenessColor(user.todayLateness) }}>
                  today: {formatLateness(user.todayLateness!)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsCards({ stats }: { stats: UserStats[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {stats.map((user, i) => (
        <div
          key={user.userId}
          className="glass rounded-2xl p-5 animate-slide-up"
          style={{
            animationDelay: `${i * 0.08}s`,
            borderColor: user.color + "33",
          }}
        >
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center text-xl"
              style={{ background: user.color + "22", boxShadow: `0 0 16px ${user.glow}` }}
            >
              {user.emoji}
            </div>
            <div>
              <div className="font-bold text-base" style={{ color: user.color }}>{user.name}</div>
              <div className="text-xs" style={{ color: "#6b7280" }}>{user.totalClockIns} clock-ins</div>
            </div>
            {user.todayClockedIn && (
              <div className="ml-auto">
                <div className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" }}>
                  ✓ Today
                </div>
              </div>
            )}
          </div>

          {user.averageLateness !== null ? (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs" style={{ color: "#6b7280" }}>Average</span>
                <span className="font-mono font-bold text-sm" style={{ color: latenessColor(user.averageLateness) }}>
                  {formatLateness(user.averageLateness)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs" style={{ color: "#6b7280" }}>Best</span>
                <span className="font-mono text-sm" style={{ color: "#34d399" }}>
                  {user.bestLateness !== null ? formatLateness(user.bestLateness) : "—"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs" style={{ color: "#6b7280" }}>Worst</span>
                <span className="font-mono text-sm" style={{ color: "#ef4444" }}>
                  {user.worstLateness !== null ? formatLateness(user.worstLateness) : "—"}
                </span>
              </div>
              {user.onTimeRate !== null && (
                <div>
                  <div className="flex justify-between text-xs mb-1" style={{ color: "#6b7280" }}>
                    <span>On-time rate</span>
                    <span style={{ color: user.color }}>{user.onTimeRate.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${user.onTimeRate}%`, background: `linear-gradient(90deg, ${user.color}, ${user.color}88)` }} />
                  </div>
                </div>
              )}
              {user.todayClockedIn && user.todayLateness !== null && (
                <div className="pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                  <div className="flex justify-between items-center">
                    <span className="text-xs" style={{ color: "#6b7280" }}>Today</span>
                    <LatenessTag minutes={user.todayLateness} />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-4 text-sm" style={{ color: "#4b5563" }}>
              No lectures recorded yet
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CorrectionsSection({ clockIns, corrections }: { clockIns: SerialClockIn[]; corrections: SerialCorrection[] }) {
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const [mode, setMode] = useState<"request" | "approve" | null>(null);
  const [selectedClockIn, setSelectedClockIn] = useState("");
  const [requestedTime, setRequestedTime] = useState("");
  const [reason, setReason] = useState("");
  const [requestUserId, setRequestUserId] = useState("");
  const [requestPassword, setRequestPassword] = useState("");
  const [approverId, setApproverId] = useState("");
  const [approverPassword, setApproverPassword] = useState("");
  const [selectedCorrectionId, setSelectedCorrectionId] = useState("");
  const prevSubmitting = useRef(false);

  useEffect(() => {
    const wasSubmitting = prevSubmitting.current;
    const isNowIdle = fetcher.state === "idle";
    if (wasSubmitting && isNowIdle && fetcher.data && !("error" in (fetcher.data as object))) {
      revalidate();
      setMode(null);
      setSelectedClockIn("");
      setRequestedTime("");
      setReason("");
      setRequestUserId("");
      setRequestPassword("");
      setApproverId("");
      setApproverPassword("");
      setSelectedCorrectionId("");
    }
    prevSubmitting.current = fetcher.state === "submitting";
  }, [fetcher.state, fetcher.data]);

  const responseData = fetcher.data as Record<string, unknown> | undefined;
  const error = responseData?.error as string | undefined;
  const successMsg = responseData?.message as string | undefined;

  const myClockIns = clockIns.filter((c) => c.userId === requestUserId);

  return (
    <div className="glass rounded-2xl p-6 animate-slide-up" style={{ animationDelay: "0.2s" }}>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">Corrections</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setMode(mode === "request" ? null : "request")}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: mode === "request" ? "rgba(167,139,250,0.2)" : "rgba(255,255,255,0.05)",
              color: mode === "request" ? "#a78bfa" : "#9ca3af",
              border: `1px solid ${mode === "request" ? "rgba(167,139,250,0.3)" : "rgba(255,255,255,0.08)"}`,
            }}
          >
            + Request
          </button>
          {corrections.length > 0 && (
            <button
              onClick={() => setMode(mode === "approve" ? null : "approve")}
              className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{
                background: mode === "approve" ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.05)",
                color: mode === "approve" ? "#fbbf24" : "#9ca3af",
                border: `1px solid ${mode === "approve" ? "rgba(251,191,36,0.3)" : "rgba(255,255,255,0.08)"}`,
              }}
            >
              ✓ Approve ({corrections.length})
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444" }}>
          {error}
        </div>
      )}
      {successMsg && (
        <div className="mb-4 p-3 rounded-xl text-sm font-medium" style={{ background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)", color: "#34d399" }}>
          {successMsg}
        </div>
      )}

      {/* Request form */}
      {mode === "request" && (
        <fetcher.Form method="post" className="space-y-4 mb-5 p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <input type="hidden" name="intent" value="request-correction" />
          <div className="text-sm font-semibold mb-3" style={{ color: "#a78bfa" }}>Request a Correction</div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Your name</label>
            <select
              name="userId"
              value={requestUserId}
              onChange={(e) => setRequestUserId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}
            >
              <option value="">Select...</option>
              {Object.values(USERS).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>

          {requestUserId && myClockIns.length > 0 && (
            <div>
              <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Clock-in to correct</label>
              <select
                name="clockInId"
                value={selectedClockIn}
                onChange={(e) => setSelectedClockIn(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}
              >
                <option value="">Select clock-in...</option>
                {myClockIns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.date} — {formatTime(c.effectiveTimestamp)} ({formatLateness(c.latenessMinutes)})
                  </option>
                ))}
              </select>
            </div>
          )}

          {requestUserId && myClockIns.length === 0 && (
            <div className="text-sm" style={{ color: "#6b7280" }}>No clock-ins found for this user.</div>
          )}

          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Corrected time</label>
            <input
              type="datetime-local"
              name="requestedTimestamp"
              value={requestedTime}
              onChange={(e) => setRequestedTime(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", colorScheme: "dark" }}
            />
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Reason</label>
            <input
              type="text"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Phone died, forgot to clock in, etc."
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}
            />
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Your password</label>
            <input
              type="password"
              name="password"
              value={requestPassword}
              onChange={(e) => setRequestPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontFamily: "JetBrains Mono, monospace" }}
            />
          </div>

          <button
            type="submit"
            disabled={!selectedClockIn || !requestedTime || !requestPassword || !requestUserId || fetcher.state === "submitting"}
            className="w-full py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "rgba(167,139,250,0.2)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.3)" }}
          >
            {fetcher.state === "submitting" ? "Submitting..." : "Submit Request"}
          </button>
        </fetcher.Form>
      )}

      {/* Pending corrections list */}
      {corrections.length > 0 ? (
        <div className="space-y-3">
          {corrections.map((c) => {
            const user = Object.values(USERS).find((u) => u.id === c.clockInUserId);
            const originalLateness = getLatenessMinutes(c.originalTimestamp);
            const requestedLateness = getLatenessMinutes(c.requestedTimestamp);

            return (
              <div key={c.id} className="p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span style={{ color: user?.color }}>{user?.emoji} {user?.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: "rgba(251,191,36,0.1)", color: "#fbbf24" }}>pending</span>
                    </div>
                    <div className="text-xs space-y-0.5" style={{ color: "#9ca3af" }}>
                      <div>
                        {formatDate(c.originalTimestamp)}: <span style={{ color: latenessColor(originalLateness) }}>{formatTime(c.originalTimestamp)}</span>
                        {" → "}
                        <span style={{ color: latenessColor(requestedLateness) }}>{formatTime(c.requestedTimestamp)}</span>
                      </div>
                      {c.reason && <div className="italic">&ldquo;{c.reason}&rdquo;</div>}
                      <div style={{ color: "#4b5563" }}>Requested by {USERS[c.requestedBy as keyof typeof USERS]?.name ?? c.requestedBy}</div>
                    </div>
                  </div>
                </div>

                {mode === "approve" && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                    <div className="flex gap-2 mb-2">
                      <select
                        value={selectedCorrectionId === c.id ? approverId : ""}
                        onChange={(e) => { setApproverId(e.target.value); setSelectedCorrectionId(c.id); }}
                        className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}
                      >
                        <option value="">Approver...</option>
                        {Object.values(USERS)
                          .filter((u) => u.id !== c.requestedBy)
                          .map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      <input
                        type="password"
                        placeholder="Password"
                        value={selectedCorrectionId === c.id ? approverPassword : ""}
                        onChange={(e) => { setApproverPassword(e.target.value); setSelectedCorrectionId(c.id); }}
                        className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontFamily: "JetBrains Mono" }}
                      />
                    </div>
                    <div className="flex gap-2">
                      <fetcher.Form method="post" className="flex-1">
                        <input type="hidden" name="intent" value="approve-correction" />
                        <input type="hidden" name="correctionId" value={c.id} />
                        <input type="hidden" name="approverId" value={selectedCorrectionId === c.id ? approverId : ""} />
                        <input type="hidden" name="approverPassword" value={selectedCorrectionId === c.id ? approverPassword : ""} />
                        <button
                          type="submit"
                          disabled={selectedCorrectionId !== c.id || !approverId || !approverPassword || fetcher.state === "submitting"}
                          className="w-full py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ background: "rgba(52,211,153,0.15)", color: "#34d399", border: "1px solid rgba(52,211,153,0.3)" }}
                        >
                          ✓ Approve
                        </button>
                      </fetcher.Form>
                      <fetcher.Form method="post" className="flex-1">
                        <input type="hidden" name="intent" value="reject-correction" />
                        <input type="hidden" name="correctionId" value={c.id} />
                        <input type="hidden" name="approverId" value={selectedCorrectionId === c.id ? approverId : ""} />
                        <input type="hidden" name="approverPassword" value={selectedCorrectionId === c.id ? approverPassword : ""} />
                        <button
                          type="submit"
                          disabled={selectedCorrectionId !== c.id || !approverId || !approverPassword || fetcher.state === "submitting"}
                          className="w-full py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}
                        >
                          ✗ Reject
                        </button>
                      </fetcher.Form>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-6 text-sm" style={{ color: "#4b5563" }}>
          No pending corrections
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Index() {
  const { stats, clockIns, corrections, today, usersWithoutPassword } = useLoaderData<typeof loader>();
  const [tab, setTab] = useState<"dashboard" | "clockin" | "corrections">("clockin");

  const now = new Date();
  const isClassTime = now.getHours() >= 9 && (now.getHours() < 11 || (now.getHours() === 11 && now.getMinutes() <= 50));
  const classOver = now.getHours() > 11 || (now.getHours() === 11 && now.getMinutes() > 50);
  const isLectureDay = LECTURE_SCHEDULE.some((l) => l.date === today) && !classOver;
  const currentWeek = getCurrentWeek(today);
  const nextLecture = getNextLecture(today);

  const tabs = [
    { id: "clockin", label: "Clock In", badge: null },
    { id: "dashboard", label: "Dashboard", badge: null },
    { id: "corrections", label: "Corrections", badge: corrections.length > 0 ? corrections.length : null },
  ] as const;

  return (
    <div className="min-h-screen" style={{ background: "#07070f" }}>
      {/* Header */}
      <div className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-3xl mx-auto px-4 py-5">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-black tracking-tight gradient-text">CS 188 Tracker</h1>
              <p className="text-xs mt-0.5" style={{ color: "#4b5563" }}>
                Human-AI Interaction · Week {currentWeek} of 10
                {nextLecture && !isLectureDay && (
                  <span> · Next: {new Date(nextLecture.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
                )}
              </p>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono" style={{ color: "#6b7280" }}>
                {now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </div>
              {isClassTime && (
                <div className="flex items-center gap-1 justify-end mt-1">
                  <div className="relative w-1.5 h-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    <div className="absolute inset-0 w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                  </div>
                  <span className="text-xs" style={{ color: "#ef4444" }}>Class time!</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b sticky top-0 z-10" style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(7,7,15,0.95)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-3xl mx-auto px-4">
          <div className="flex">
            {tabs.map(({ id, label, badge }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className="px-5 py-3.5 text-sm font-medium transition-all relative"
                style={{ color: tab === id ? "white" : "#6b7280" }}
              >
                {label}
                {badge && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold" style={{ background: "rgba(251,191,36,0.2)", color: "#fbbf24" }}>
                    {badge}
                  </span>
                )}
                {tab === id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full" style={{ background: "linear-gradient(90deg, #a78bfa, #60a5fa)" }} />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {tab === "clockin" && <ClockInSection today={today} usersWithoutPassword={usersWithoutPassword} isLectureDay={isLectureDay} nextLecture={nextLecture} />}

        {tab === "dashboard" && (
          <>
            <Leaderboard stats={stats} />
            <StatsCards stats={stats} />
          </>
        )}

        {tab === "corrections" && (
          <CorrectionsSection clockIns={clockIns} corrections={corrections} />
        )}
      </div>

      {/* Footer */}
      <div className="text-center py-8 text-xs" style={{ color: "#1f2937" }}>
        built in 15 minutes for CS 188 · vibe coded
      </div>
    </div>
  );
}
