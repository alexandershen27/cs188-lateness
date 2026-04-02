import mongoose from "mongoose";

declare global {
  // eslint-disable-next-line no-var
  var __dbConn: typeof mongoose | undefined;
}

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  if (global.__dbConn && mongoose.connection.readyState === 1) {
    return global.__dbConn;
  }

  await mongoose.connect(uri, { dbName: "lecture-tracker" });
  global.__dbConn = mongoose;
  return mongoose;
}
