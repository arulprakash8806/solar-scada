const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { startAlerter } = require("./alerter");

const app = express();
const PORT = 3000;
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const API_KEY = process.env.API_KEY;

// ── Security middleware ───────────────────────────────────────────────────────

// Helmet: sets secure HTTP headers (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({
  contentSecurityPolicy: false, // disabled so the dashboard SPA loads fine
}));

// CORS: only allow requests from our own frontend + localhost for dev
const allowedOrigins = [
  "https://backend-dark-paper-3650.fly.dev",
  "https://grafana-lingering-wave-5682.fly.dev",
  "http://localhost:3000",
];
app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (curl, mobile apps, Postman)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("CORS: origin not allowed"));
  },
}));

// Rate limiter: 100 requests per 15 minutes per IP for general API
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Too many requests, slow down." },
});

// Stricter limiter for simulate endpoints: 10 per 15 minutes per IP
const simulateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "error", message: "Simulate rate limit exceeded." },
});

app.use("/api", generalLimiter);

// API key middleware — only enforced if API_KEY env var is set
// GET routes (dashboard data) are read-only and exempt.
// Only POST routes (simulate) require a key to prevent abuse.
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ status: "error", message: "Invalid or missing API key. Pass X-Api-Key header." });
  }
  next();
}

// ── Static dashboard (no auth needed — it's the UI) ──────────────────────────
app.use(express.static(path.join(__dirname, "dashboard")));

// ── Helpers ───────────────────────────────────────────────────────────────────
async function queryPrometheus(query) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(`Prometheus query failed: ${data.error}`);
  }
  return data.data.result;
}

// ── API Routes (all require API key) ─────────────────────────────────────────

// GET /api/health — public health check (no auth)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// GET /api/metrics — all current metrics
app.get("/api/metrics", async (req, res) => {
  try {
    const queries = {
      farm_total_power: "solar_farm_total_power_watts",
      daily_energy: "solar_farm_daily_energy_kwh",
      irradiance: "solar_irradiance_wm2",
      ambient_temp: "solar_ambient_temperature_celsius",
      panel_temp: "solar_panel_temperature_celsius",
      inverter_power: "solar_inverter_output_power_watts",
      inverter_efficiency: "solar_inverter_efficiency_percent",
      inverter_temperature: "solar_inverter_temperature_celsius",
      inverter_ac_voltage: "solar_inverter_ac_voltage_volts",
      inverter_status: "solar_inverter_status",
      string_voltage: "solar_panel_voltage_volts",
      string_current: "solar_panel_current_amps",
      string_power: "solar_panel_power_watts",
    };

    const results = {};
    const entries = Object.entries(queries);
    const responses = await Promise.all(
      entries.map(([, q]) => queryPrometheus(q))
    );
    entries.forEach(([key], i) => {
      results[key] = responses[i];
    });

    res.json({ status: "ok", timestamp: new Date().toISOString(), data: results });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// GET /api/inverters — per-inverter summary
app.get("/api/inverters", async (req, res) => {
  try {
    const [power, efficiency, temperature, status, acVoltage] = await Promise.all([
      queryPrometheus("solar_inverter_output_power_watts"),
      queryPrometheus("solar_inverter_efficiency_percent"),
      queryPrometheus("solar_inverter_temperature_celsius"),
      queryPrometheus("solar_inverter_status"),
      queryPrometheus("solar_inverter_ac_voltage_volts"),
    ]);

    const inverters = {};
    const merge = (arr, field) => {
      arr.forEach((item) => {
        const id = item.metric.inverter;
        if (!inverters[id]) inverters[id] = { id };
        inverters[id][field] = parseFloat(item.value[1]);
      });
    };
    merge(power, "power_watts");
    merge(efficiency, "efficiency_percent");
    merge(temperature, "temperature_celsius");
    merge(status, "status");
    merge(acVoltage, "ac_voltage_volts");

    res.json({ status: "ok", inverters: Object.values(inverters) });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// GET /api/farm — farm totals
app.get("/api/farm", async (req, res) => {
  try {
    const [totalPower, dailyEnergy, irradiance, ambientTemp, panelTemp] =
      await Promise.all([
        queryPrometheus("solar_farm_total_power_watts"),
        queryPrometheus("solar_farm_daily_energy_kwh"),
        queryPrometheus("solar_irradiance_wm2"),
        queryPrometheus("solar_ambient_temperature_celsius"),
        queryPrometheus("solar_panel_temperature_celsius"),
      ]);

    const val = (arr) => (arr.length > 0 ? parseFloat(arr[0].value[1]) : 0);

    res.json({
      status: "ok",
      farm: {
        total_power_watts: val(totalPower),
        daily_energy_kwh: val(dailyEnergy),
        irradiance_wm2: val(irradiance),
        ambient_temp_celsius: val(ambientTemp),
        panel_temp_celsius: val(panelTemp),
      },
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// GET /api/alerts — inverters with faults
app.get("/api/alerts", async (req, res) => {
  try {
    const statusResults = await queryPrometheus("solar_inverter_status == 0");
    const faults = statusResults.map((item) => ({
      inverter: item.metric.inverter,
      status: "FAULT",
      timestamp: new Date(item.value[0] * 1000).toISOString(),
    }));
    res.json({ status: "ok", alerts: faults, count: faults.length });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// POST /api/simulate/:scenario — trigger test Telegram alerts
// Requires API key + stricter rate limit
app.post("/api/simulate/:scenario", simulateLimiter, requireApiKey, async (req, res) => {
  const { sendTelegram } = require("./alerter");
  const scenario = req.params.scenario;
  const inv = req.query.inverter || "INV_01";
  const timeStr = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  const dateStr = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" });

  const scenarios = {
    fault: () => sendTelegram(
      `🔴 <b>[TEST] INVERTER FAULT</b>\n\n` +
      `Inverter <b>${inv}</b> has stopped producing power.\n` +
      `⏰ Time: ${timeStr}\n` +
      `📍 Dashboard: https://backend-dark-paper-3650.fly.dev\n\n` +
      `<i>This is a simulated test alert.</i>`
    ),
    recovery: () => sendTelegram(
      `✅ <b>[TEST] INVERTER RECOVERED</b>\n\n` +
      `Inverter <b>${inv}</b> is back online and producing power.\n` +
      `⏰ Time: ${timeStr}\n\n` +
      `<i>This is a simulated test alert.</i>`
    ),
    lowpower: () => sendTelegram(
      `⚠️ <b>[TEST] LOW PRODUCTION WARNING</b>\n\n` +
      `Farm output is only <b>2.3 kW</b> despite good irradiance (750 W/m²).\n` +
      `⏰ Time: ${timeStr}\n` +
      `📍 Dashboard: https://backend-dark-paper-3650.fly.dev\n\n` +
      `<i>This is a simulated test alert.</i>`
    ),
    summary: () => sendTelegram(
      `☀️ <b>[TEST] Daily Solar Farm Summary</b>\n` +
      `📅 ${dateStr}\n\n` +
      `⚡ Energy Generated: <b>142.5 kWh</b>\n` +
      `🔋 Current Output: <b>47.2 kW</b>\n` +
      `✅ Active Inverters: <b>5/5</b>\n\n` +
      `📍 Full report: https://backend-dark-paper-3650.fly.dev\n\n` +
      `<i>This is a simulated test alert.</i>`
    ),
  };

  if (!scenarios[scenario]) {
    return res.status(400).json({
      status: "error",
      message: `Unknown scenario. Valid options: ${Object.keys(scenarios).join(", ")}`,
    });
  }

  try {
    await scenarios[scenario]();
    res.json({ status: "ok", message: `${scenario} alert sent to Telegram` });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Fallback: serve dashboard
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard/index.html"));
});

app.listen(PORT, () => {
  console.log(`Solar SCADA API running on port ${PORT}`);
  if (API_KEY) {
    console.log("🔐 API key authentication enabled");
  } else {
    console.log("⚠️  API_KEY not set — authentication disabled");
  }
  startAlerter();
});
