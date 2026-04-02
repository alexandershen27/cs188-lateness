import mongoose, { Types } from "mongoose";

// ── ClockIn ──────────────────────────────────────────────────────────────────
export interface IClockIn {
  _id: Types.ObjectId;
  userId: string;
  timestamp: Date;
  date: string; // YYYY-MM-DD — the lecture day
  correctedTimestamp?: Date;
  location?: { lat: number; lng: number } | null;
  createdAt: Date;
}

const ClockInSchema = new mongoose.Schema<IClockIn>(
  {
    userId: { type: String, required: true, enum: ["keshiv", "alex", "vivek"] },
    timestamp: { type: Date, required: true },
    date: { type: String, required: true },
    correctedTimestamp: { type: Date },
    location: {
      lat: { type: Number },
      lng: { type: Number },
    },
  },
  { timestamps: true }
);

// ── CorrectionRequest ────────────────────────────────────────────────────────
export interface ICorrectionRequest {
  _id: Types.ObjectId;
  clockInId: Types.ObjectId;
  clockInUserId: string;
  requestedBy: string;
  originalTimestamp: Date;
  requestedTimestamp: Date;
  reason: string;
  status: "pending" | "approved" | "rejected";
  approvedBy?: string;
  createdAt: Date;
}

const CorrectionRequestSchema = new mongoose.Schema<ICorrectionRequest>(
  {
    clockInId: { type: mongoose.Schema.Types.ObjectId, ref: "ClockIn", required: true },
    clockInUserId: { type: String, required: true },
    requestedBy: { type: String, required: true },
    originalTimestamp: { type: Date, required: true },
    requestedTimestamp: { type: Date, required: true },
    reason: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    approvedBy: { type: String },
  },
  { timestamps: true }
);

export const ClockIn =
  (mongoose.models.ClockIn as mongoose.Model<IClockIn>) ||
  mongoose.model<IClockIn>("ClockIn", ClockInSchema);

export const CorrectionRequest =
  (mongoose.models.CorrectionRequest as mongoose.Model<ICorrectionRequest>) ||
  mongoose.model<ICorrectionRequest>("CorrectionRequest", CorrectionRequestSchema);

// ── UserPassword ─────────────────────────────────────────────────────────────
export interface IUserPassword {
  userId: string;
  password: string;
}

const UserPasswordSchema = new mongoose.Schema<IUserPassword>({
  userId: { type: String, required: true, unique: true, enum: ["keshiv", "alex", "vivek"] },
  password: { type: String, required: true },
});

export const UserPassword =
  (mongoose.models.UserPassword as mongoose.Model<IUserPassword>) ||
  mongoose.model<IUserPassword>("UserPassword", UserPasswordSchema);
