/**
 * Solar Farm SCADA - Telegram Alerter
 * Polls Prometheus every 60s and sends alerts to Telegram on:
 *   - Inverter fault (status = 0)
 *   - Low production during daylight hours
 *   - Inverter recovery (status back to 1)
 *   - Daily energy summary (sent at 7pm)
 *
 * Predictive checks run every 15 minutes:
 *   - Efficiency degradation trend (predict_linear)
 *   - Per-inverter power imbalance vs fleet average
 *   - Inverter temperature creep toward overheating
 */

const fetch    = require("node-fetch");
const reporter = require("./reporter");

const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const PROMETHEUS_URL    = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const CHECK_INTERVAL_MS = 60 * 1000;        // fault checks: every 60s
const PREDICT_INTERVAL_MS = 15 * 60 * 1000; // predictive checks: every 15min
const DAILY_SUMMARY_HOUR  = 19;              // 7pm IST

// ── State tracking ────────────────────────────────────────────────
const faultedInverters = new Set();
let dailySummarySentToday = false;
let lastSummaryDate = -1;

// Predictive alert cooldowns — prevents same warning re-firing for 2 hours
// key: "check_type:inverter_id", value: timestamp of last alert
const predictiveCooldowns = new Map();
const PREDICT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

function isOnCooldown(key) {
  const last = predictiveCooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < PREDICT_COOLDOWN_MS;
}
function setCooldown(key) {
  predictiveCooldowns.set(key, Date.now());
}

// ── Telegram ──────────────────────────────────────────────────────
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

// ── Prometheus helpers ────────────────────────────────────────────
async function query(expr) {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== "success") return [];
    return json.data.result;
  } catch (err) {
    console.error("Prometheus query error:", err.message);
    return [];
  }
}

function val(results, defaultVal = 0) {
  if (!results || results.length === 0) return defaultVal;
  return parseFloat(results[0].value[1]) || defaultVal;
}

function isDaytime() {
  const hour = new Date().getHours();
  return hour >= 6 && hour <= 19;
}

function timeIST() {
  return new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ── Reactive alert checks (every 60s) ────────────────────────────

async function checkInverterFaults() {
  const results = await query("solar_inverter_status");
  for (const r of results) {
    const invId  = r.metric.inverter;
    const status = parseFloat(r.value[1]);

    if (status === 0 && !faultedInverters.has(invId)) {
      faultedInverters.add(invId);
      await sendTelegram(
        `🔴 <b>INVERTER FAULT</b>\n\n` +
        `Inverter <b>${invId}</b> has stopped producing power.\n` +
        `⏰ Time: ${timeIST()}\n` +
        `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
      );
    } else if (status === 1 && faultedInverters.has(invId)) {
      faultedInverters.delete(invId);
      await sendTelegram(
        `✅ <b>INVERTER RECOVERED</b>\n\n` +
        `Inverter <b>${invId}</b> is back online and producing power.\n` +
        `⏰ Time: ${timeIST()}`
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
  const irr   = val(irradiance);
  if (irr > 300 && power < 5000) {
    await sendTelegram(
      `⚠️ <b>LOW PRODUCTION WARNING</b>\n\n` +
      `Farm output is only <b>${(power / 1000).toFixed(1)} kW</b> ` +
      `despite good irradiance (${irr.toFixed(0)} W/m²).\n` +
      `⏰ Time: ${timeIST()}\n` +
      `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
    );
  }
}

async function sendDailyReport() {
  const now   = new Date();
  const hour  = now.getHours();
  const today = now.getDate();
  if (hour !== DAILY_SUMMARY_HOUR) return;
  if (lastSummaryDate === today) return;
  lastSummaryDate = today;

  try {
    // Sunday (0) = send weekly report instead of / in addition to daily
    const isSunday = now.getDay() === 0;

    const { text: dailyText } = await reporter.generateDailyReport();
    await sendTelegram(dailyText);

    if (isSunday) {
      // Small delay so messages don't arrive at the same second
      await new Promise(r => setTimeout(r, 3000));
      const { text: weeklyText } = await reporter.generateWeeklyReport();
      await sendTelegram(weeklyText);
    }
  } catch (err) {
    console.error("Report generation error:", err.message);
  }
}

// ── Predictive checks (every 15 min) ─────────────────────────────

/**
 * Check 1: Efficiency degradation trend
 * Uses Prometheus predict_linear() to forecast each inverter's efficiency
 * 1 hour into the future based on the last 3 hours of data.
 * Fires if predicted efficiency < 85% AND hasn't fired in last 2h.
 */
async function checkEfficiencyTrend() {
  if (!isDaytime()) return;

  // predict_linear extrapolates the trend over the next 3600 seconds (1 hour)
  const predicted = await query(
    `predict_linear(solar_inverter_efficiency_percent[3h], 3600)`
  );
  const current = await query(`solar_inverter_efficiency_percent`);

  for (const r of predicted) {
    const invId        = r.metric.inverter;
    const predictedEff = parseFloat(r.value[1]);
    const currentEff   = parseFloat(
      (current.find(c => c.metric.inverter === invId) || { value: [0, "0"] }).value[1]
    );
    const cooldownKey = `efficiency:${invId}`;

    if (predictedEff < 85 && currentEff > predictedEff && !isOnCooldown(cooldownKey)) {
      const dropRate = (currentEff - predictedEff).toFixed(1);
      setCooldown(cooldownKey);
      await sendTelegram(
        `🔮 <b>PREDICTIVE ALERT — Efficiency Degrading</b>\n\n` +
        `Inverter <b>${invId}</b> efficiency is trending down.\n` +
        `📉 Current: <b>${currentEff.toFixed(1)}%</b> → Predicted in 1h: <b>${predictedEff.toFixed(1)}%</b>\n` +
        `⬇️ Drop rate: ~${dropRate}% per hour\n` +
        `⏰ Time: ${timeIST()}\n\n` +
        `💡 <i>Action: Check for soiling, shading, or connection issues on ${invId}.</i>\n` +
        `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
      );
    }
  }
}

/**
 * Check 2: Power imbalance — one inverter lagging the fleet
 * Compares each inverter's 30-min average output against the fleet average.
 * If one inverter is >35% below fleet average during good irradiance, warn.
 * This catches partial shading, soiled panels, or failing strings.
 */
async function checkPowerImbalance() {
  if (!isDaytime()) return;

  const [inverterPowers, irradiance] = await Promise.all([
    query(`avg_over_time(solar_inverter_output_power_watts[30m])`),
    query(`solar_irradiance_wm2`),
  ]);

  const irr = val(irradiance);
  if (irr < 300) return; // not enough sun to judge

  if (inverterPowers.length < 2) return;

  const powers = inverterPowers.map(r => ({
    id:    r.metric.inverter,
    power: parseFloat(r.value[1]),
  }));

  const fleetAvg = powers.reduce((sum, p) => sum + p.power, 0) / powers.length;
  if (fleetAvg < 2000) return; // farm barely producing, not meaningful

  for (const { id, power } of powers) {
    const deviation   = ((fleetAvg - power) / fleetAvg) * 100;
    const cooldownKey = `imbalance:${id}`;

    if (deviation > 35 && !isOnCooldown(cooldownKey)) {
      setCooldown(cooldownKey);
      await sendTelegram(
        `🔮 <b>PREDICTIVE ALERT — Power Imbalance Detected</b>\n\n` +
        `Inverter <b>${id}</b> is underperforming vs the fleet.\n` +
        `📊 ${id} (30min avg): <b>${(power / 1000).toFixed(2)} kW</b>\n` +
        `📊 Fleet average: <b>${(fleetAvg / 1000).toFixed(2)} kW</b>\n` +
        `⬇️ Deviation: <b>${deviation.toFixed(1)}% below peers</b>\n` +
        `☀️ Irradiance: ${irr.toFixed(0)} W/m²\n` +
        `⏰ Time: ${timeIST()}\n\n` +
        `💡 <i>Action: Check ${id} for soiling, shading, or string fuse issues.</i>\n` +
        `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
      );
    }
  }
}

/**
 * Check 3: Inverter temperature creep
 * Uses predict_linear() to forecast inverter temp 1 hour ahead.
 * Warns if trending toward >75°C (thermal throttling / shutdown risk).
 */
async function checkTemperatureTrend() {
  const predicted = await query(
    `predict_linear(solar_inverter_temperature_celsius[1h], 3600)`
  );
  const current = await query(`solar_inverter_temperature_celsius`);

  for (const r of predicted) {
    const invId       = r.metric.inverter;
    const predictedT  = parseFloat(r.value[1]);
    const currentT    = parseFloat(
      (current.find(c => c.metric.inverter === invId) || { value: [0, "0"] }).value[1]
    );
    const cooldownKey = `temperature:${invId}`;

    // Warn if trending toward >75°C and temperature is actually rising
    if (predictedT > 75 && predictedT > currentT && !isOnCooldown(cooldownKey)) {
      const riseRate = (predictedT - currentT).toFixed(1);
      setCooldown(cooldownKey);
      await sendTelegram(
        `🔮 <b>PREDICTIVE ALERT — Temperature Rising</b>\n\n` +
        `Inverter <b>${invId}</b> temperature is trending up.\n` +
        `🌡️ Current: <b>${currentT.toFixed(1)}°C</b> → Predicted in 1h: <b>${predictedT.toFixed(1)}°C</b>\n` +
        `⬆️ Rise rate: ~${riseRate}°C per hour\n` +
        `⚠️ Risk: Thermal throttling above 75°C, shutdown above 85°C\n` +
        `⏰ Time: ${timeIST()}\n\n` +
        `💡 <i>Action: Check ${invId} ventilation and cooling fans.</i>\n` +
        `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
      );
    }
  }
}

// ── Main loops ────────────────────────────────────────────────────

async function runChecks() {
  console.log(`[${new Date().toISOString()}] Running reactive checks...`);
  try {
    await checkInverterFaults();
    await checkLowProduction();
    await sendDailyReport();
  } catch (err) {
    console.error("Reactive check error:", err.message);
  }
}

async function runPredictiveChecks() {
  console.log(`[${new Date().toISOString()}] Running predictive checks...`);
  try {
    await checkEfficiencyTrend();
    await checkPowerImbalance();
    await checkTemperatureTrend();
  } catch (err) {
    console.error("Predictive check error:", err.message);
  }
}

function startAlerter() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠ TELEGRAM_TOKEN or TELEGRAM_CHAT_ID not set — alerting disabled");
    return;
  }
  console.log("✅ Telegram alerter started");
  console.log(`   Chat ID: ${TELEGRAM_CHAT_ID}`);
  console.log(`   Reactive checks: every ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`   Predictive checks: every ${PREDICT_INTERVAL_MS / 60000}min`);

  sendTelegram(
    `🟢 <b>Solar Farm SCADA Online</b>\n\n` +
    `Monitoring started. You will receive alerts for:\n` +
    `• 🔴 Inverter faults\n` +
    `• ⚠️ Low production warnings\n` +
    `• ✅ Inverter recoveries\n` +
    `• 🔮 Predictive: efficiency drop, power imbalance, temp creep\n` +
    `• ☀️ Daily energy report at 7pm (weekly on Sundays)\n\n` +
    `📍 Dashboard: https://backend-dark-paper-3650.fly.dev`
  );

  // Reactive: every 60s
  runChecks();
  setInterval(runChecks, CHECK_INTERVAL_MS);

  // Predictive: every 15min (start after 1 min so Prometheus has initial data)
  setTimeout(() => {
    runPredictiveChecks();
    setInterval(runPredictiveChecks, PREDICT_INTERVAL_MS);
  }, 60 * 1000);
}

module.exports = { startAlerter, sendTelegram, runPredictiveChecks };
