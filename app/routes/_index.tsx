import { useState, useEffect, useRef } from "react";
import { data, useFetcher, useLoaderData, useRevalidator, useNavigate } from "react-router";
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
  getCompletedOfficialLectures,
  ABSENCE_PENALTY_MINUTES,
  FIRST_TRACKED_LECTURE,
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
  attended: number;
  absences: number;
  totalTracked: number;
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
  type: string;
  clockInId: string | null;
  clockInUserId: string;
  requestedBy: string;
  originalTimestamp: string | null;
  requestedTimestamp: string;
  reason: string;
  status: string;
  approvedBy?: string;
  createdAt: string;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const devMode = params.get("dev") === "1";
  const mockDate = devMode ? params.get("mockDate") : null;
  const mockTimeParam = devMode ? params.get("mockTime") : null; // HH:MM

  try {
    await connectDB();
  } catch (error) {
    throw new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }

  const today = mockDate ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  // Determine if class is over
  const realTodayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const nowLA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  let classIsOver: boolean;
  if (mockDate && mockTimeParam) {
    // Dev mode: use the mocked time to decide if class is over on that date
    const [mockH, mockM] = mockTimeParam.split(":").map(Number);
    classIsOver = realTodayLA > today || (mockH * 60 + mockM) >= 11 * 60 + 50;
  } else {
    classIsOver = realTodayLA > today ||
      (realTodayLA === today && (nowLA.getHours() > 11 || (nowLA.getHours() === 11 && nowLA.getMinutes() >= 50)));
  }

  const completedLectures = getCompletedOfficialLectures(today, classIsOver);

  const allClockIns = await ClockIn.find().sort({ timestamp: 1 }).lean();
  const allCorrections = await CorrectionRequest.find().sort({ createdAt: -1 }).lean();

  // Build per-user stats
  const stats: UserStats[] = Object.values(USERS).map((user) => {
    const userClockIns = allClockIns.filter((c) => c.userId === user.id);
    const todayClockIn = userClockIns.find((c) => c.date === today);
    const clockInDates = new Set(userClockIns.map((c) => c.date));

    const userFirstTracked = user.joinDate ?? FIRST_TRACKED_LECTURE;
    const userCompletedLectures = completedLectures.filter((d) => d >= userFirstTracked);
    const attended = userCompletedLectures.filter((d) => clockInDates.has(d)).length;
    const absences = userCompletedLectures.filter((d) => !clockInDates.has(d)).length;

    const latenesses = userClockIns.map((c) => getLatenessMinutes(c.correctedTimestamp ?? c.timestamp));

    // Average includes absence penalty
    const allForAvg = [...latenesses, ...Array(absences).fill(ABSENCE_PENALTY_MINUTES)];

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
      averageLateness: allForAvg.length
        ? allForAvg.reduce((a, b) => a + b, 0) / allForAvg.length
        : null,
      bestLateness: latenesses.length ? Math.min(...latenesses) : null,
      worstLateness: latenesses.length ? Math.max(...latenesses) : null,
      onTimeRate: allForAvg.length
        ? (allForAvg.filter((l) => l <= 5).length / allForAvg.length) * 100
        : null,
      lastClockIn: userClockIns.length
        ? (userClockIns[userClockIns.length - 1].correctedTimestamp ?? userClockIns[userClockIns.length - 1].timestamp).toISOString()
        : null,
      todayClockedIn: !!todayClockIn,
      todayLateness,
      attended,
      absences,
      totalTracked: userCompletedLectures.length,
    };
  });

  const serialClockIns: SerialClockIn[] = allClockIns.map((c) => ({
    id: c._id.toString(),
    userId: c.userId,
    timestamp: c.timestamp.toISOString(),
    date: c.date,
    effectiveTimestamp: (c.correctedTimestamp ?? c.timestamp).toISOString(),
    location: c.location?.lat != null ? { lat: c.location.lat, lng: c.location.lng } : null,
    latenessMinutes: getLatenessMinutes(c.correctedTimestamp ?? c.timestamp),
  }));

  const serialCorrections: SerialCorrection[] = allCorrections.map((r) => ({
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

  return { stats, clockIns: serialClockIns, corrections: serialCorrections, today, classIsOver, usersWithoutPassword, devMode };
}

// ── Action ───────────────────────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  await connectDB();
  const fd = await request.formData();
  const intent = fd.get("intent") as string;
  const devMode = fd.get("devMode") === "1";

  if (intent === "clockin") {
    const userId = fd.get("userId") as string;
    const password = fd.get("password") as string;
    const lat = fd.get("lat") ? parseFloat(fd.get("lat") as string) : null;
    const lng = fd.get("lng") ? parseFloat(fd.get("lng") as string) : null;
    const bypassLocation = devMode && fd.get("bypassLocation") === "1";
    const mockTimeRaw = devMode ? (fd.get("mockTime") as string | null) : null;

    if (!await validateUser(userId, password)) {
      return data({ error: "Wrong password. Try again." }, { status: 401 });
    }

    if (!bypassLocation) {
      if (lat === null || lng === null) {
        return data({ error: "Location is required to clock in." }, { status: 403 });
      }
      const dx = lat - 34.073471;
      const dy = lng - -118.440165;
      const approxKm = Math.sqrt(dx * dx + dy * dy) * 111;
      if (approxKm > 0.05) {
        return data({ error: "You need to be at Perloff Hall to clock in." }, { status: 403 });
      }
    }

    const now = mockTimeRaw ? new Date(mockTimeRaw) : new Date();

    // Block clock-in outside the window: 9:40 AM – 11:50 AM PT
    const nowLA = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const minutesSinceMidnight = nowLA.getHours() * 60 + nowLA.getMinutes();
    if (minutesSinceMidnight < 9 * 60 + 40) {
      return data({ error: "Clock-in opens at 9:40 AM." }, { status: 400 });
    }
    if (minutesSinceMidnight >= 11 * 60 + 50) {
      return data({ error: "Class has ended." }, { status: 400 });
    }

    const date = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    const existing = await ClockIn.findOne({ userId, date });
    if (existing) {
      const lateness = getLatenessMinutes(existing.correctedTimestamp ?? existing.timestamp);
      return data({ alreadyClockedIn: true, lateness, quip: getLatenessQuip(lateness), latenessStr: formatLateness(lateness) });
    }

    const clockIn = await ClockIn.create({
      userId,
      timestamp: now,
      date,
      location: lat != null && lng != null ? { lat, lng } : null,
    });

    const lateness = getLatenessMinutes(clockIn.timestamp);
    return data({ success: true, lateness, quip: getLatenessQuip(lateness), latenessStr: formatLateness(lateness) });
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

    if (!await validateUser(approverId, approverPassword)) {
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

    await ClockIn.findByIdAndUpdate(correction.clockInId, { correctedTimestamp: correction.requestedTimestamp });
    return data({ success: true, message: "Correction approved!" });
  }

  if (intent === "reject-correction") {
    const approverId = fd.get("approverId") as string;
    const approverPassword = fd.get("approverPassword") as string;
    const correctionId = fd.get("correctionId") as string;

    if (!await validateUser(approverId, approverPassword)) {
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

  if (intent === "dev-delete-clockin" && devMode) {
    const userId = fd.get("userId") as string;
    const mockDate = fd.get("mockDate") as string | null;
    const date = mockDate ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    await ClockIn.deleteOne({ userId, date });
    return data({ success: true });
  }

  if (intent === "dev-clear-db" && devMode) {
    await ClockIn.deleteMany({});
    await CorrectionRequest.deleteMany({});
    return data({ success: true });
  }

  if (intent === "add-missed-clockin") {
    const userId = fd.get("userId") as string;
    const password = fd.get("password") as string;
    const date = fd.get("date") as string;
    const arrivalTimeISO = fd.get("arrivalTimeISO") as string;

    if (!await validateUser(userId, password)) {
      return data({ error: "Wrong password." }, { status: 401 });
    }

    const isValidLecture = LECTURE_SCHEDULE.some(
      (l) => l.date === date && l.date >= FIRST_TRACKED_LECTURE
    );
    if (!isValidLecture) {
      return data({ error: "Invalid lecture date." }, { status: 400 });
    }

    const realTodayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const mockDateParam = devMode ? (fd.get("mockDate") as string | null) : null;
    const effectiveToday = mockDateParam ?? realTodayLA;
    // Allow today only if class has ended — client passes classIsOver from loader
    const classIsOverParam = fd.get("classIsOver") === "1";
    if (date > effectiveToday || (date === effectiveToday && !classIsOverParam)) {
      return data({ error: "Can only add missed clock-ins after class ends." }, { status: 400 });
    }

    const existing = await ClockIn.findOne({ userId, date });
    if (existing) {
      return data({ error: "Already have a clock-in for this lecture." }, { status: 409 });
    }

    const arrivalTime = new Date(arrivalTimeISO);
    await ClockIn.create({ userId, timestamp: arrivalTime, date });
    return data({ success: true, message: "Clock-in added!" });
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

const PERLOFF_LAT = 34.073471;
const PERLOFF_LNG = -118.440165;
const AT_LECTURE_RADIUS_KM = 0.15;

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


function ClockInSection({ today, usersWithoutPassword, isLectureDay, nextLecture, devMode, mockTime, setMockTime }: {
  today: string;
  usersWithoutPassword: string[];
  isLectureDay: boolean;
  nextLecture: { week: number; date: string } | null;
  devMode: boolean;
  mockTime: string;
  setMockTime: (v: string) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();
  const clearFetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();

  const [selectedUser, setSelectedUser] = useState<string>("");
  const [password, setPassword] = useState("");
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<"idle" | "requesting" | "granted" | "denied">("idle");
  const [bypassLocation, setBypassLocation] = useState(true);

  const prevSubmitting = useRef(false);

  // Revalidate after successful clock-in or delete
  useEffect(() => {
    const wasSubmitting = prevSubmitting.current;
    const isNowIdle = fetcher.state === "idle";
    if (wasSubmitting && isNowIdle && fetcher.data && !("error" in fetcher.data)) {
      setPassword("");
      revalidate();
    }
    prevSubmitting.current = fetcher.state === "submitting";
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (locationStatus === "idle") {
      setLocationStatus("requesting");
      navigator.geolocation.getCurrentPosition(
        (pos) => { setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLocationStatus("granted"); },
        () => setLocationStatus("denied")
      );
    }
  }, []);

  const atLecture = devMode && bypassLocation
    ? true
    : locationStatus === "denied"
    ? false
    : locationStatus === "granted" && location
    ? distanceKm(location.lat, location.lng, PERLOFF_LAT, PERLOFF_LNG) <= AT_LECTURE_RADIUS_KM
    : null; // still requesting

  // Compute time-window state using mockTime if set, else real LA time
  const effectiveTimeLA = mockTime
    ? new Date(new Date(mockTime).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    : new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const minutesSinceMidnight = effectiveTimeLA.getHours() * 60 + effectiveTimeLA.getMinutes();
  const tooEarly = minutesSinceMidnight < 9 * 60 + 40;
  const classEnded = minutesSinceMidnight >= 11 * 60 + 50;

  const responseData = fetcher.data as Record<string, unknown> | undefined;
  const error = responseData?.error as string | undefined;
  const success = responseData?.success as boolean | undefined;
  const alreadyClockedIn = responseData?.alreadyClockedIn as boolean | undefined;
  const quip = responseData?.quip as string | undefined;
  const latenessStr = responseData?.latenessStr as string | undefined;

  const headerRight = isLectureDay
    ? new Date(today + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) + " · 10:00 AM"
    : nextLecture
    ? "Next lecture: " + new Date(nextLecture.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : "No upcoming lectures";

  const nextLectureLabel = nextLecture
    ? "Next lecture: " + new Date(nextLecture.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : null;

  const buttonDisabled = !selectedUser || !password || fetcher.state === "submitting" || atLecture === false || classEnded || tooEarly;
  const buttonLabel = fetcher.state === "submitting" ? "Clocking in..."
    : tooEarly ? "Opens at 9:40 AM"
    : classEnded ? (nextLectureLabel ?? "Class ended")
    : locationStatus === "denied" ? "📍 Enable location"
    : atLecture === false ? "🚫 Not in Perloff"
    : "🕙 CLOCK IN";

  // Sync mockTime date to URL so the whole page updates
  const mockDateForURL = mockTime ? mockTime.slice(0, 10) : null;
  const mockTimeForURL = mockTime ? mockTime.slice(11, 16) : null; // HH:MM
  const applyMockDate = () => {
    if (mockDateForURL) {
      const timeParam = mockTimeForURL ? `&mockTime=${mockTimeForURL}` : "";
      navigate(`?dev=1&mockDate=${mockDateForURL}${timeParam}`, { replace: true });
    }
  };

  return (
    <div className="glass rounded-2xl p-6 animate-slide-up">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold">Clock In</h2>
        <div className="text-sm font-mono" style={{ color: "#6b7280" }}>{headerRight}</div>
      </div>

      {/* Success feedback */}
      {fetcher.state === "idle" && success && !alreadyClockedIn && (
        <div className="mb-4 p-4 rounded-xl text-center" style={{ background: "rgba(52,211,153,0.12)", border: "1px solid rgba(52,211,153,0.3)" }}>
          <div className="text-2xl mb-1">{quip?.split(" ")[0]}</div>
          <div className="font-bold text-lg" style={{ color: "#34d399" }}>{latenessStr}</div>
        </div>
      )}

      {fetcher.state === "idle" && alreadyClockedIn && (
        <div className="mb-4 p-4 rounded-xl text-center" style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)" }}>
          <div className="font-semibold" style={{ color: "#fbbf24" }}>Already clocked in — {latenessStr}</div>
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
        {devMode && <input type="hidden" name="devMode" value="1" />}
        {devMode && bypassLocation && <input type="hidden" name="bypassLocation" value="1" />}
        {devMode && mockTime && <input type="hidden" name="mockTime" value={new Date(mockTime).toISOString()} />}
        {location && (
          <>
            <input type="hidden" name="lat" value={location.lat} />
            <input type="hidden" name="lng" value={location.lng} />
          </>
        )}

        {/* User selection */}
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "#9ca3af" }}>Who are you?</label>
          <div className="grid grid-cols-4 gap-3">
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
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontFamily: "JetBrains Mono, monospace" }}
          />
        </div>

        {/* Dev overrides */}
        {devMode && (
          <div className="space-y-3 p-3 rounded-xl" style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)" }}>
            <div className="text-xs font-semibold" style={{ color: "#fbbf24" }}>Dev overrides</div>
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: "#9ca3af" }}>
              <input type="checkbox" checked={bypassLocation} onChange={(e) => setBypassLocation(e.target.checked)} className="accent-yellow-400" />
              Simulate being in Perloff Hall
            </label>
            <div>
              <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Mock date/time (affects whole page)</label>
              <div className="flex gap-2">
                <input
                  type="datetime-local"
                  value={mockTime}
                  onChange={(e) => setMockTime(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", colorScheme: "dark" }}
                />
                <button
                  type="button"
                  onClick={applyMockDate}
                  disabled={!mockDateForURL}
                  className="px-3 py-2 rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={buttonDisabled}
          className="btn-clockin w-full py-4 rounded-xl font-bold text-lg text-white transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none relative overflow-hidden"
        >
          <span className="relative z-10">{buttonLabel}</span>
        </button>
      </fetcher.Form>

      {/* Dev: delete clock-ins + clear db */}
      {devMode && (
        <div className="mt-4 pt-4 border-t space-y-3" style={{ borderColor: "rgba(251,191,36,0.15)" }}>
          <div>
            <div className="text-xs font-semibold mb-2" style={{ color: "#fbbf24" }}>Delete today's clock-in</div>
            <div className="flex gap-2">
              {Object.values(USERS).map((user) => (
                <deleteFetcher.Form key={user.id} method="post" className="flex-1" onSubmit={() => setTimeout(revalidate, 150)}>
                  <input type="hidden" name="intent" value="dev-delete-clockin" />
                  <input type="hidden" name="devMode" value="1" />
                  <input type="hidden" name="userId" value={user.id} />
                  {mockDateForURL && <input type="hidden" name="mockDate" value={mockDateForURL} />}
                  <button type="submit" className="w-full py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
                    {user.emoji} {user.name}
                  </button>
                </deleteFetcher.Form>
              ))}
            </div>
          </div>
          <clearFetcher.Form method="post" onSubmit={() => setTimeout(revalidate, 150)}>
            <input type="hidden" name="intent" value="dev-clear-db" />
            <input type="hidden" name="devMode" value="1" />
            <button type="submit" className="w-full py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{ background: "rgba(239,68,68,0.06)", color: "#9ca3af", border: "1px solid rgba(239,68,68,0.15)" }}>
              ☠ Clear entire database
            </button>
          </clearFetcher.Form>
        </div>
      )}
    </div>
  );
}

function Leaderboard({ stats }: { stats: UserStats[] }) {
  const ranked = [...stats]
    .filter((s) => s.averageLateness !== null)
    .sort((a, b) => (a.averageLateness ?? 0) - (b.averageLateness ?? 0));
  const unranked = stats.filter((s) => s.averageLateness === null);
  const allRanked = [...ranked, ...unranked];

  const rankLabels = ["🥇", "🥈", "🥉"];
  const rankTitles = ["Most Punctual", "Second Best", "Room to Grow"];
  const rankStyles = ["rank-1", "rank-2", "rank-3"];

  return (
    <div className="glass rounded-2xl p-6 animate-slide-up" style={{ animationDelay: "0.1s" }}>
      <h2 className="text-xl font-bold mb-5">Leaderboard</h2>
      <div className="space-y-3">
        {allRanked.map((user, i) => (
          <div key={user.userId} className="flex items-center gap-4 p-4 rounded-xl transition-all"
            style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.06)"}` }}>
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
                {user.totalTracked > 0
                  ? `${user.attended}/${user.totalTracked} present${user.absences > 0 ? ` · ${user.absences} absent` : ""}`
                  : `${user.totalClockIns} clock-in${user.totalClockIns !== 1 ? "s" : ""}`}
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
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map((user, i) => (
        <div key={user.userId} className="glass rounded-2xl p-5 animate-slide-up"
          style={{ animationDelay: `${i * 0.08}s`, borderColor: user.color + "33" }}>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl"
              style={{ background: user.color + "22", boxShadow: `0 0 16px ${user.glow}` }}>
              {user.emoji}
            </div>
            <div>
              <div className="font-bold text-base" style={{ color: user.color }}>{user.name}</div>
              <div className="text-xs" style={{ color: "#6b7280" }}>{user.totalClockIns} clock-ins</div>
            </div>
            {user.todayClockedIn && (
              <div className="ml-auto">
                <div className="text-xs px-2 py-1 rounded-full font-medium"
                  style={{ background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.2)" }}>
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
              {user.totalTracked > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-xs" style={{ color: "#6b7280" }}>Attendance</span>
                  <span className="text-xs font-mono" style={{ color: user.absences > 0 ? "#ef4444" : "#34d399" }}>
                    {user.attended}/{user.totalTracked}
                    {user.absences > 0 && ` (${user.absences} absent)`}
                  </span>
                </div>
              )}
              {user.onTimeRate !== null && (
                <div>
                  <div className="flex justify-between text-xs mb-1" style={{ color: "#6b7280" }}>
                    <span>On-time rate</span>
                    <span style={{ color: user.color }}>{user.onTimeRate.toFixed(0)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${user.onTimeRate}%`, background: `linear-gradient(90deg, ${user.color}, ${user.color}88)` }} />
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
            <div className="text-center py-4 text-sm" style={{ color: "#4b5563" }}>No lectures recorded yet</div>
          )}
        </div>
      ))}
    </div>
  );
}

function CorrectionsSection({ clockIns, corrections, today, classIsOver, devMode }: { clockIns: SerialClockIn[]; corrections: SerialCorrection[]; today: string; classIsOver: boolean; devMode: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const { revalidate } = useRevalidator();
  const [mode, setMode] = useState<"request" | "approve" | "add-missed" | null>(null);
  const [selectedClockIn, setSelectedClockIn] = useState("");
  const [requestedTime, setRequestedTime] = useState("");
  const [reason, setReason] = useState("");
  const [requestUserId, setRequestUserId] = useState("");
  const [requestPassword, setRequestPassword] = useState("");
  const [approverId, setApproverId] = useState("");
  const [approverPassword, setApproverPassword] = useState("");
  const [selectedCorrectionId, setSelectedCorrectionId] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [addDate, setAddDate] = useState("");
  const [addTime, setAddTime] = useState("10:00");
  const [addPassword, setAddPassword] = useState("");
  const prevSubmitting = useRef(false);

  useEffect(() => {
    const wasSubmitting = prevSubmitting.current;
    const isNowIdle = fetcher.state === "idle";
    if (wasSubmitting && isNowIdle && fetcher.data && !("error" in (fetcher.data as object))) {
      revalidate();
      setMode(null);
      setSelectedClockIn(""); setRequestedTime(""); setReason("");
      setRequestUserId(""); setRequestPassword("");
      setApproverId(""); setApproverPassword(""); setSelectedCorrectionId("");
      setAddUserId(""); setAddDate(""); setAddTime("10:00"); setAddPassword("");
    }
    prevSubmitting.current = fetcher.state === "submitting";
  }, [fetcher.state, fetcher.data]);

  const responseData = fetcher.data as Record<string, unknown> | undefined;
  const error = responseData?.error as string | undefined;
  const successMsg = responseData?.message as string | undefined;

  const myClockIns = clockIns.filter((c) => c.userId === requestUserId);
  const pending = corrections.filter((c) => c.status === "pending");

  const missedLectures = (userId: string) => {
    if (!userId) return [];
    const userDates = new Set(clockIns.filter((c) => c.userId === userId).map((c) => c.date));
    return LECTURE_SCHEDULE.filter(
      (l) => l.date >= FIRST_TRACKED_LECTURE &&
        (l.date < today || (l.date === today && classIsOver)) &&
        !userDates.has(l.date)
    );
  };

  const statusStyle = (status: string) => {
    if (status === "approved") return { background: "rgba(52,211,153,0.1)", color: "#34d399" };
    if (status === "rejected") return { background: "rgba(239,68,68,0.1)", color: "#ef4444" };
    return { background: "rgba(251,191,36,0.1)", color: "#fbbf24" };
  };

  return (
    <div className="glass rounded-2xl p-6 animate-slide-up" style={{ animationDelay: "0.2s" }}>
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-xl font-bold">Corrections</h2>
        <div className="flex gap-2">
          <button onClick={() => setMode(mode === "add-missed" ? null : "add-missed")}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: mode === "add-missed" ? "rgba(52,211,153,0.2)" : "rgba(255,255,255,0.05)",
              color: mode === "add-missed" ? "#34d399" : "#9ca3af",
              border: `1px solid ${mode === "add-missed" ? "rgba(52,211,153,0.3)" : "rgba(255,255,255,0.08)"}`,
            }}>
            + Add
          </button>
          <button onClick={() => setMode(mode === "request" ? null : "request")}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: mode === "request" ? "rgba(167,139,250,0.2)" : "rgba(255,255,255,0.05)",
              color: mode === "request" ? "#a78bfa" : "#9ca3af",
              border: `1px solid ${mode === "request" ? "rgba(167,139,250,0.3)" : "rgba(255,255,255,0.08)"}`,
            }}>
            ± Request
          </button>
          {pending.length > 0 && (
            <button onClick={() => setMode(mode === "approve" ? null : "approve")}
              className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{
                background: mode === "approve" ? "rgba(251,191,36,0.2)" : "rgba(255,255,255,0.05)",
                color: mode === "approve" ? "#fbbf24" : "#9ca3af",
                border: `1px solid ${mode === "approve" ? "rgba(251,191,36,0.3)" : "rgba(255,255,255,0.08)"}`,
              }}>
              ✓ Approve ({pending.length})
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

      {mode === "request" && (
        <fetcher.Form method="post" className="space-y-4 mb-5 p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }} onSubmit={() => setMode(null)}>
          <input type="hidden" name="intent" value="request-correction" />
          <div className="text-sm font-semibold mb-3" style={{ color: "#a78bfa" }}>Request a Correction</div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Your name</label>
            <select name="userId" value={requestUserId} onChange={(e) => setRequestUserId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}>
              <option value="">Select...</option>
              {Object.values(USERS).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          {requestUserId && myClockIns.length > 0 && (
            <div>
              <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Clock-in to correct</label>
              <select name="clockInId" value={selectedClockIn} onChange={(e) => setSelectedClockIn(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}>
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
            <input type="datetime-local" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", colorScheme: "dark" }} />
            <input type="hidden" name="requestedTimestamp" value={requestedTime ? new Date(requestedTime).toISOString() : ""} />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Reason</label>
            <input type="text" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Phone died, forgot to clock in, etc."
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }} />
          </div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Your password</label>
            <input type="password" name="password" value={requestPassword} onChange={(e) => setRequestPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontFamily: "JetBrains Mono, monospace" }} />
          </div>
          <button type="submit"
            disabled={!selectedClockIn || !requestedTime || !requestPassword || !requestUserId || fetcher.state === "submitting"}
            className="w-full py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "rgba(167,139,250,0.2)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.3)" }}>
            {fetcher.state === "submitting" ? "Submitting..." : "Submit Request"}
          </button>
        </fetcher.Form>
      )}

      {mode === "add-missed" && (
        <fetcher.Form method="post" className="space-y-4 mb-5 p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }} onSubmit={() => setMode(null)}>
          <input type="hidden" name="intent" value="add-missed-clockin" />
          {devMode && <input type="hidden" name="devMode" value="1" />}
          {devMode && <input type="hidden" name="mockDate" value={today} />}
          <input type="hidden" name="classIsOver" value={classIsOver ? "1" : "0"} />
          <div className="text-sm font-semibold mb-3" style={{ color: "#34d399" }}>Add Missed Clock-In</div>
          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Who attended?</label>
            <select value={addUserId} onChange={(e) => { setAddUserId(e.target.value); setAddDate(""); }}
              name="userId"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}>
              <option value="">Select...</option>
              {Object.values(USERS).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          {addUserId && (
            missedLectures(addUserId).length > 0 ? (
              <div>
                <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Lecture date</label>
                <select value={addDate} onChange={(e) => setAddDate(e.target.value)}
                  name="date"
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}>
                  <option value="">Select lecture...</option>
                  {missedLectures(addUserId).map((l) => (
                    <option key={l.date} value={l.date}>
                      {new Date(l.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })} (Week {l.week})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="text-sm" style={{ color: "#6b7280" }}>No missed lectures to add.</div>
            )
          )}
          {addDate && (
            <div>
              <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Arrival time</label>
              <input
                type="time"
                value={addTime}
                onChange={(e) => setAddTime(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", colorScheme: "dark" }}
              />
              <input type="hidden" name="arrivalTimeISO" value={addDate && addTime ? new Date(`${addDate}T${addTime}`).toISOString() : ""} />
            </div>
          )}
          <div>
            <label className="block text-xs mb-1" style={{ color: "#6b7280" }}>Your password</label>
            <input type="password" name="password" value={addPassword} onChange={(e) => setAddPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontFamily: "JetBrains Mono, monospace" }} />
          </div>
          <button type="submit"
            disabled={!addUserId || !addDate || !addTime || !addPassword || fetcher.state === "submitting"}
            className="w-full py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "rgba(52,211,153,0.15)", color: "#34d399", border: "1px solid rgba(52,211,153,0.3)" }}>
            {fetcher.state === "submitting" ? "Adding..." : "Add Clock-In"}
          </button>
        </fetcher.Form>
      )}

      {corrections.length > 0 ? (
        <div className="space-y-3">
          {corrections.map((c) => {
            const user = Object.values(USERS).find((u) => u.id === c.clockInUserId);
            const originalLateness = getLatenessMinutes(c.originalTimestamp);
            const requestedLateness = getLatenessMinutes(c.requestedTimestamp);
            const approver = c.approvedBy ? USERS[c.approvedBy as keyof typeof USERS]?.name : null;

            return (
              <div key={c.id} className="p-4 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span style={{ color: user?.color }}>{user?.emoji} {user?.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full" style={statusStyle(c.status)}>{c.status}</span>
                    </div>
                    <div className="text-xs space-y-0.5" style={{ color: "#9ca3af" }}>
                      <div>
                        {formatDate(c.originalTimestamp)}: <span style={{ color: latenessColor(originalLateness) }}>{formatTime(c.originalTimestamp)}</span>
                        {" → "}
                        <span style={{ color: latenessColor(requestedLateness) }}>{formatTime(c.requestedTimestamp)}</span>
                      </div>
                      {c.reason && <div className="italic">&ldquo;{c.reason}&rdquo;</div>}
                      <div style={{ color: "#4b5563" }}>
                        Requested by {USERS[c.requestedBy as keyof typeof USERS]?.name ?? c.requestedBy}
                        {approver && ` · ${c.status === "approved" ? "approved" : "rejected"} by ${approver}`}
                      </div>
                    </div>
                  </div>
                </div>

                {mode === "approve" && c.status === "pending" && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
                    <div className="flex gap-2 mb-2">
                      <select value={selectedCorrectionId === c.id ? approverId : ""}
                        onChange={(e) => { setApproverId(e.target.value); setSelectedCorrectionId(c.id); }}
                        className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}>
                        <option value="">Approver...</option>
                        {Object.values(USERS).filter((u) => u.id !== c.requestedBy).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      <input type="password" placeholder="Password"
                        value={selectedCorrectionId === c.id ? approverPassword : ""}
                        onChange={(e) => { setApproverPassword(e.target.value); setSelectedCorrectionId(c.id); }}
                        className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "white", fontFamily: "JetBrains Mono" }} />
                    </div>
                    <div className="flex gap-2">
                      <fetcher.Form method="post" className="flex-1">
                        <input type="hidden" name="intent" value="approve-correction" />
                        <input type="hidden" name="correctionId" value={c.id} />
                        <input type="hidden" name="approverId" value={selectedCorrectionId === c.id ? approverId : ""} />
                        <input type="hidden" name="approverPassword" value={selectedCorrectionId === c.id ? approverPassword : ""} />
                        <button type="submit"
                          disabled={selectedCorrectionId !== c.id || !approverId || !approverPassword || fetcher.state === "submitting"}
                          className="w-full py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ background: "rgba(52,211,153,0.15)", color: "#34d399", border: "1px solid rgba(52,211,153,0.3)" }}>
                          ✓ Approve
                        </button>
                      </fetcher.Form>
                      <fetcher.Form method="post" className="flex-1">
                        <input type="hidden" name="intent" value="reject-correction" />
                        <input type="hidden" name="correctionId" value={c.id} />
                        <input type="hidden" name="approverId" value={selectedCorrectionId === c.id ? approverId : ""} />
                        <input type="hidden" name="approverPassword" value={selectedCorrectionId === c.id ? approverPassword : ""} />
                        <button type="submit"
                          disabled={selectedCorrectionId !== c.id || !approverId || !approverPassword || fetcher.state === "submitting"}
                          className="w-full py-1.5 rounded-lg text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ background: "rgba(239,68,68,0.1)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.2)" }}>
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
        <div className="text-center py-6 text-sm" style={{ color: "#4b5563" }}>No corrections yet</div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Index() {
  const { stats, clockIns, corrections, today, classIsOver, usersWithoutPassword, devMode } = useLoaderData<typeof loader>();
  const [tab, setTab] = useState<"dashboard" | "clockin" | "corrections">("clockin");
  const [mockTime, setMockTime] = useState("");

  // Use mock time if set, else real LA time
  const nowLA = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const effectiveLA = mockTime
    ? new Date(new Date(mockTime).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))
    : nowLA;
  const isClassTime = effectiveLA.getHours() >= 9 && (effectiveLA.getHours() < 11 || (effectiveLA.getHours() === 11 && effectiveLA.getMinutes() < 50));
  const classOver = effectiveLA.getHours() > 11 || (effectiveLA.getHours() === 11 && effectiveLA.getMinutes() >= 50);
  const isLectureDay = LECTURE_SCHEDULE.some((l) => l.date === today) && !classOver;
  const currentWeek = getCurrentWeek(today);
  const nextLecture = getNextLecture(today);
  const pendingCount = corrections.filter((c) => c.status === "pending").length;

  const tabs = [
    { id: "clockin", label: "Clock In", badge: null },
    { id: "dashboard", label: "Dashboard", badge: null },
    { id: "corrections", label: "Corrections", badge: pendingCount > 0 ? pendingCount : null },
  ] as const;

  return (
    <div className="min-h-screen" style={{ background: "#07070f" }}>
      <div className="border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="max-w-3xl mx-auto px-4 py-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-black tracking-tight gradient-text">CS 188 Tracker</h1>
                {devMode && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-bold"
                    style={{ background: "rgba(251,191,36,0.15)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}>
                    dev mode
                  </span>
                )}
              </div>
              <p className="text-xs mt-0.5" style={{ color: "#4b5563" }}>
                Human-AI Interaction · Week {currentWeek} of 10
                {nextLecture && !isLectureDay && (
                  <span> · Next lecture: {new Date(nextLecture.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })}</span>
                )}
              </p>
            </div>
            <div className="text-right">
              <div className="text-sm font-mono" style={{ color: "#6b7280" }}>
                {new Date(today + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
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

      <div className="border-b sticky top-0 z-10" style={{ borderColor: "rgba(255,255,255,0.06)", background: "rgba(7,7,15,0.95)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-3xl mx-auto px-4">
          <div className="flex">
            {tabs.map(({ id, label, badge }) => (
              <button key={id} onClick={() => setTab(id)}
                className="px-5 py-3.5 text-sm font-medium transition-all relative"
                style={{ color: tab === id ? "white" : "#6b7280" }}>
                {label}
                {badge && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold"
                    style={{ background: "rgba(251,191,36,0.2)", color: "#fbbf24" }}>
                    {badge}
                  </span>
                )}
                {tab === id && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                    style={{ background: "linear-gradient(90deg, #a78bfa, #60a5fa)" }} />
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {tab === "clockin" && (
          <ClockInSection
            today={today}
            usersWithoutPassword={usersWithoutPassword}
            isLectureDay={isLectureDay}
            nextLecture={nextLecture}
            devMode={devMode}
            mockTime={mockTime}
            setMockTime={setMockTime}
          />
        )}
        {tab === "dashboard" && (
          <>
            <Leaderboard stats={stats} />
            <StatsCards stats={stats} />
          </>
        )}
        {tab === "corrections" && (
          <CorrectionsSection clockIns={clockIns} corrections={corrections} today={today} classIsOver={classIsOver} devMode={devMode} />
        )}
      </div>

      <div className="text-center py-8 text-xs" style={{ color: "#1f2937" }}>
        built in 15 minutes for CS 188 · vibe coded
      </div>
    </div>
  );
}
