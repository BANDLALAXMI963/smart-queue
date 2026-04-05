// ============================================================
//  MediQueue Backend — server.js (All-in-One)
// ============================================================
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "authorization", "admin-key"]
}));
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────
const MONGO_URI  = process.env.MONGO_URI  || "mongodb+srv://<user>:<pass>@cluster0.mongodb.net/mediqueue";
const JWT_SECRET = process.env.JWT_SECRET || "mediqueue_secret_2024";
const ADMIN_KEY  = process.env.ADMIN_KEY  || "admin123";
const PORT       = process.env.PORT       || 5000;

// ─── MongoDB Connection ───────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

// ============================================================
//  MODELS
// ============================================================

// ── Patient Model ────────────────────────────────────────────
const patientSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  phone:     { type: String, required: true, unique: true, match: /^[0-9]{10}$/ },
  email:     { type: String, required: true, trim: true },
  district:  { type: String, required: true },
  mandal:    { type: String, required: true },
  village:   { type: String, required: true },
  problem:   { type: String, required: true },
  patientId: {
    type: String,
    unique: true,
    default: () => "PAT" + Math.floor(1000 + Math.random() * 9000)
  }
}, { timestamps: true });

const Patient = mongoose.model("Patient", patientSchema);

// ── Queue Model ───────────────────────────────────────────────
const queueSchema = new mongoose.Schema({
  tokenNumber:  { type: Number, required: true },
  patientId:    { type: String, required: true },
  patientName:  { type: String, required: true },
  phone:        { type: String, required: true },
  problem:      { type: String, required: true },
  doctor:       { type: String, required: true },
  hospital:     { type: String, required: true },
  status: {
    type: String,
    enum: ["waiting", "serving", "done"],
    default: "waiting"
  },
  date: {
    type: String,
    default: () => new Date().toISOString().split("T")[0]
  }
}, { timestamps: true });

const Queue = mongoose.model("Queue", queueSchema);

// ============================================================
//  MIDDLEWARE
// ============================================================

// ── JWT Auth Middleware ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(401).json({ message: "No token, access denied" });
  try {
    req.patient = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

// ── Admin Key Middleware ──────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers["admin-key"];
  if (key !== ADMIN_KEY) return res.status(403).json({ message: "Unauthorized. Invalid admin key." });
  next();
}

// ============================================================
//  OTP STORE (in-memory)
// ============================================================
const otpStore = {};

// ============================================================
//  AUTH ROUTES
// ============================================================

// POST /api/auth/send-otp
app.post("/api/auth/send-otp", (req, res) => {
  const { phone } = req.body;

  if (!/^[0-9]{10}$/.test(phone)) {
    return res.status(400).json({ message: "Enter valid 10-digit phone number" });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[phone] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`📱 OTP for ${phone}: ${otp}`);

  res.json({
    message: "OTP sent successfully",
    demoOtp: otp   // ⚠️ Remove in production
  });
});

// POST /api/auth/login
app.post("/api/auth/login", async (req, res) => {
  const { name, phone, email, district, mandal, village, problem, otp } = req.body;

  // Validate OTP
  const stored = otpStore[phone];
  if (!stored)                    return res.status(400).json({ message: "OTP not sent. Request OTP first." });
  if (Date.now() > stored.expiresAt) { delete otpStore[phone]; return res.status(400).json({ message: "OTP expired." }); }
  if (stored.otp !== otp)         return res.status(400).json({ message: "Invalid OTP" });
  delete otpStore[phone];

  try {
    let patient = await Patient.findOne({ phone });

    if (!patient) {
      patient = new Patient({ name, phone, email, district, mandal, village, problem });
      await patient.save();
    } else {
      Object.assign(patient, { name, email, district, mandal, village, problem });
      await patient.save();
    }

    const token = jwt.sign(
      { id: patient._id, patientId: patient.patientId, phone: patient.phone },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      patient: {
        id: patient.patientId,
        name: patient.name,
        email: patient.email,
        phone: patient.phone,
        problem: patient.problem,
        district: patient.district,
        mandal: patient.mandal,
        village: patient.village
      }
    });

  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================================================
//  QUEUE ROUTES
// ============================================================

// POST /api/queue/generate
app.post("/api/queue/generate", authMiddleware, async (req, res) => {
  const { doctor, hospital } = req.body;
  const { patientId, phone } = req.patient;
  const today = new Date().toISOString().split("T")[0];

  try {
    const existing = await Queue.findOne({ phone, date: today, status: { $ne: "done" } });
    if (existing) {
      return res.status(400).json({ message: "You already have a token today", token: existing.tokenNumber });
    }

    const lastToken = await Queue.findOne({ date: today }).sort({ tokenNumber: -1 });
    const tokenNumber = lastToken ? lastToken.tokenNumber + 1 : 1;

    const patient = await Patient.findOne({ phone });

    const entry = new Queue({
      tokenNumber,
      patientId,
      patientName: patient.name,
      phone,
      problem: patient.problem,
      doctor,
      hospital,
      date: today
    });
    await entry.save();

    const fullQueue = await Queue.find({ date: today, status: { $ne: "done" } }).sort({ tokenNumber: 1 });
    io.emit("queueUpdated", fullQueue);

    res.json({ message: "Token generated successfully", tokenNumber, position: fullQueue.length });

  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/queue/today
app.get("/api/queue/today", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    const queue = await Queue.find({ date: today, status: { $ne: "done" } }).sort({ tokenNumber: 1 });
    const current = queue.find(q => q.status === "serving") || queue[0];
    res.json({ queue, currentToken: current ? current.tokenNumber : null, totalWaiting: queue.length });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/queue/my-status
app.get("/api/queue/my-status", authMiddleware, async (req, res) => {
  const { phone } = req.patient;
  const today = new Date().toISOString().split("T")[0];

  try {
    const myEntry = await Queue.findOne({ phone, date: today, status: { $ne: "done" } });
    if (!myEntry) return res.json({ hasToken: false });

    const queue = await Queue.find({ date: today, status: { $ne: "done" } }).sort({ tokenNumber: 1 });
    const myPosition = queue.findIndex(q => q.phone === phone) + 1;
    const current = queue[0];
    const ahead = myPosition - 1;

    res.json({
      hasToken: true,
      tokenNumber: myEntry.tokenNumber,
      position: myPosition,
      ahead,
      currentToken: current ? current.tokenNumber : null,
      status: myEntry.status
    });

  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================================================
//  ADMIN ROUTES
// ============================================================

// GET /api/admin/queue
app.get("/api/admin/queue", adminAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    const waiting = await Queue.find({ date: today, status: "waiting" }).sort({ tokenNumber: 1 });
    const serving = await Queue.find({ date: today, status: "serving" });
    const done    = await Queue.find({ date: today, status: "done" }).sort({ tokenNumber: 1 });

    res.json({
      waiting, serving, done,
      stats: {
        totalWaiting: waiting.length,
        totalServed: done.length,
        nowServing: serving[0] ? serving[0].tokenNumber : null
      }
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// POST /api/admin/next
app.post("/api/admin/next", adminAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    await Queue.updateMany({ date: today, status: "serving" }, { status: "done" });

    const next = await Queue.findOne({ date: today, status: "waiting" }).sort({ tokenNumber: 1 });
    if (!next) {
      io.emit("queueUpdated", []);
      return res.json({ message: "Queue is empty. No more patients today." });
    }

    next.status = "serving";
    await next.save();

    const fullQueue = await Queue.find({ date: today, status: { $ne: "done" } }).sort({ tokenNumber: 1 });
    io.emit("queueUpdated", fullQueue);
    io.emit("nowServing", { tokenNumber: next.tokenNumber, patientName: next.patientName });

    res.json({
      message: "Next patient called",
      nowServing: {
        tokenNumber: next.tokenNumber,
        patientName: next.patientName,
        problem: next.problem,
        doctor: next.doctor
      }
    });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// POST /api/admin/reset
app.post("/api/admin/reset", adminAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    await Queue.deleteMany({ date: today });
    io.emit("queueUpdated", []);
    res.json({ message: "Queue reset successfully for today." });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /api/admin/stats
app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    const totalToday = await Queue.countDocuments({ date: today });
    const served     = await Queue.countDocuments({ date: today, status: "done" });
    const waiting    = await Queue.countDocuments({ date: today, status: "waiting" });
    const serving    = await Queue.findOne({ date: today, status: "serving" });

    res.json({ date: today, totalToday, served, waiting, nowServing: serving ? serving.tokenNumber : null });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

// ============================================================
//  SOCKET.IO
// ============================================================
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);
  socket.on("disconnect", () => console.log("🔌 Disconnected:", socket.id));
});

// ─── Health Check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "🏥 MediQueue API is running!" });
});

// ─── Start Server ─────────────────────────────────────────────
server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));