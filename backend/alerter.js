/**
 * Solar Farm SCADA - Telegram Alerter
 * Polls Prometheus every 60s and sends alerts to Telegram on:
 *   - Inverter fault (status = 0)
 *   - Low production during daylight hours
 *   - Inverter recovery (status back to 1)
 *   - Daily energy summary (sent at 7pm)
 */

const fetch = require("node-fetch");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const CHECK_INTERVAL_MS = 60 * 1000; // every 60 seconds
const DAILY_SUMMARY_HOUR = 19; // 7pm local time

// Track state to avoid repeated alerts
const faultedInverters = new Set();
let dailySummarySentToday = false;
let lastSummaryDate = -1;

// ── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram not configured — skipping alert");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
    const json = await res.json();
    if (!json.ok) console.error("Telegram error:", json.description);
    else console.log("Telegram alert sent:", message.slice(0, 60));
  } catch (err) {
    console.error("Failed to send Telegram alert:", err.message);
  }
}

// ── Prometheus query ──────────────────────────────────────────────
async function query(expr) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status !== "success") return [];
  return json.data.result;
}

function val(results, defaultVal = 0) {
  if (!results || results.length === 0) return defaultVal;
  return parseFloat(results[0].value[1]) || defaultVal;
}

// ── Solar factor (is it daytime?) ────────────────────────────────
function isDaytime() {
  const hour = new Date().getHours();
  return hour >= 6 && hour <= 19;
}

// ── Alert checks ─────────────────────────────────────────────────

async function checkInverterFaults() {
  const results = await query("solar_inverter_status");

  for (const r of results) {
    const invId = r.metric.inverter;
    const status = parseFloat(r.value[1]);

    if (status === 0 && !faultedInverters.has(invId)) {
      // New fault
      faultedInverters.add(invId);
      await sendTelegram(
        `🔴 <b>INVERTER FAULT</b>\n\n` +
        `Inverter <b>${invId}</b> has stopped producing power.\n` +
        `⏰ Time: ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
        `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
      );
    } else if (status === 1 && faultedInverters.has(invId)) {
      // Recovery
      faultedInverters.delete(invId);
      await sendTelegram(
        `✅ <b>INVERTER RECOVERED</b>\n\n` +
        `Inverter <b>${invId}</b> is back online and producing power.\n` +
        `⏰ Time: ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`
      );
    }
  }
}

async function checkLowProduction() {
  if (!isDaytime()) return;

  const [totalPower, irradiance] = await Promise.all([
    query("solar_farm_total_power_watts"),
    query("solar_irradiance_wm2"),
  ]);

  const power = val(totalPower);
  const irr = val(irradiance);

  // If irradiance is good (>300 W/m²) but power is very low (<5kW), something is wrong
  if (irr > 300 && power < 5000) {
    await sendTelegram(
      `⚠️ <b>LOW PRODUCTION WARNING</b>\n\n` +
      `Farm output is only <b>${(power / 1000).toFixed(1)} kW</b> ` +
      `despite good irradiance (${irr.toFixed(0)} W/m²).\n` +
      `⏰ Time: ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}\n` +
      `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
    );
  }
}

async function sendDailySummary() {
  const now = new Date();
  const hour = now.getHours();
  const today = now.getDate();

  // Send once at DAILY_SUMMARY_HOUR
  if (hour !== DAILY_SUMMARY_HOUR) return;
  if (lastSummaryDate === today) return;
  lastSummaryDate = today;

  const [energy, totalPower, activeInverters] = await Promise.all([
    query("solar_farm_daily_energy_kwh"),
    query("solar_farm_total_power_watts"),
    query("solar_inverter_status"),
  ]);

  const energyKwh = val(energy);
  const powerKw = (val(totalPower) / 1000).toFixed(1);
  const active = activeInverters.filter(r => parseFloat(r.value[1]) === 1).length;
  const total = activeInverters.length;
  const dateStr = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric", month: "long", year: "numeric"
  });

  await sendTelegram(
    `☀️ <b>Daily Solar Farm Summary</b>\n` +
    `📅 ${dateStr}\n\n` +
    `⚡ Energy Generated: <b>${energyKwh.toFixed(1)} kWh</b>\n` +
    `🔋 Current Output: <b>${powerKw} kW</b>\n` +
    `✅ Active Inverters: <b>${active}/${total}</b>\n\n` +
    `📍 Full report: https://backend-dark-paper-3650.fly.dev`
  );
}

// ── Main loop ─────────────────────────────────────────────────────
async function runChecks() {
  console.log(`[${new Date().toISOString()}] Running alert checks...`);
  try {
    await checkInverterFaults();
    await checkLowProduction();
    await sendDailySummary();
  } catch (err) {
    console.error("Alert check error:", err.message);
  }
}

function startAlerter() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠ TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set — alerting disabled");
    return;
  }
  console.log("✅ Telegram alerter started");
  console.log(`   Chat ID: ${TELEGRAM_CHAT_ID}`);
  console.log(`   Check interval: ${CHECK_INTERVAL_MS / 1000}s`);

  // Send startup message
  sendTelegram(
    `🟢 <b>Solar Farm SCADA Online</b>\n\n` +
    `Monitoring started. You will receive alerts for:\n` +
    `• 🔴 Inverter faults\n` +
    `• ⚠️ Low production warnings\n` +
    `• ✅ Inverter recoveries\n` +
    `• ☀️ Daily energy summary at 7pm\n\n` +
    `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
  );

  // Run immediately then every interval
  runChecks();
  setInterval(runChecks, CHECK_INTERVAL_MS);
}

module.exports = { startAlerter };
