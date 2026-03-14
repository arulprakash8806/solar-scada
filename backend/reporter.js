/**
 * Solar Farm Energy Reporter
 * Generates rich daily and weekly Telegram reports from Prometheus data.
 *
 * Daily report  — sent at 7pm every day via alerter.js
 * Weekly report — sent at 7pm every Sunday via alerter.js
 * On-demand     — GET /api/report/daily  and  GET /api/report/weekly
 */

const fetch = require("node-fetch");

const PROMETHEUS_URL  = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const TARIFF_PER_KWH  = parseFloat(process.env.TARIFF_PER_KWH || "4.50"); // ₹/kWh
const DASHBOARD_URL   = "https://backend-dark-paper-3650.fly.dev";
const DIVIDER         = "─".repeat(30);

// ── Prometheus helpers ────────────────────────────────────────────

async function queryInstant(expr) {
  try {
    const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const res  = await fetch(url);
    const json = await res.json();
    if (json.status !== "success") return [];
    return json.data.result;
  } catch (err) {
    console.error("Reporter Prometheus error:", err.message);
    return [];
  }
}

function val(results, defaultVal = 0) {
  if (!results || results.length === 0) return defaultVal;
  return parseFloat(results[0].value[1]) || defaultVal;
}

function pct(n) { return `${n.toFixed(1)}%`; }
function kw(watts) { return `${(watts / 1000).toFixed(1)} kW`; }
function rupees(n) { return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }

// ── Daily Report ──────────────────────────────────────────────────

async function generateDailyReport() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Look back across today's daylight hours
  const window = "14h";

  const [
    energy,
    peakPower,
    currentPower,
    invStatus,
    invEffAvg,
    invUptime,
    peakIrr,
    avgIrr,
    avgPanelTemp,
    avgAmbientTemp,
  ] = await Promise.all([
    queryInstant("solar_farm_daily_energy_kwh"),
    queryInstant(`max_over_time(solar_farm_total_power_watts[${window}])`),
    queryInstant("solar_farm_total_power_watts"),
    queryInstant("solar_inverter_status"),
    queryInstant(`avg_over_time(solar_inverter_efficiency_percent[${window}])`),
    queryInstant(`avg_over_time(solar_inverter_status[${window}])`),
    queryInstant(`max_over_time(solar_irradiance_wm2[${window}])`),
    queryInstant(`avg_over_time(solar_irradiance_wm2[${window}])`),
    queryInstant(`avg_over_time(solar_panel_temperature_celsius[${window}])`),
    queryInstant(`avg_over_time(solar_ambient_temperature_celsius[${window}])`),
  ]);

  const totalEnergy  = val(energy);
  const peakKw       = val(peakPower) / 1000;
  const currentKw    = val(currentPower) / 1000;
  const active       = invStatus.filter(r => parseFloat(r.value[1]) === 1).length;
  const totalInv     = invStatus.length || 5;
  const peakIrrVal   = val(peakIrr);
  const avgIrrVal    = val(avgIrr);
  const panelTempVal = val(avgPanelTemp);
  const ambTempVal   = val(avgAmbientTemp);
  const revenue      = totalEnergy * TARIFF_PER_KWH;

  // Build efficiency map and uptime map per inverter
  const effMap    = {};
  invEffAvg.forEach(r  => { effMap[r.metric.inverter]    = parseFloat(r.value[1]); });
  const uptimeMap = {};
  invUptime.forEach(r  => { uptimeMap[r.metric.inverter] = parseFloat(r.value[1]) * 100; });

  const invLines = Object.keys(effMap).sort().map(id => {
    const eff    = effMap[id]?.toFixed(1)    ?? "--";
    const uptime = uptimeMap[id]?.toFixed(0) ?? "--";
    const icon   = (uptimeMap[id] ?? 0) >= 95 ? "✅"
                 : (uptimeMap[id] ?? 0) >= 80 ? "⚠️" : "🔴";
    return `  ${icon} <b>${id}</b>: ${eff}% eff | ${uptime}% uptime`;
  });

  // Fleet average efficiency
  const effs    = Object.values(effMap);
  const avgEff  = effs.length ? (effs.reduce((a, b) => a + b, 0) / effs.length) : 0;

  const text =
    `☀️ <b>Daily Solar Farm Report</b>\n` +
    `📅 ${dateStr}\n` +
    `${DIVIDER}\n\n` +
    `⚡ <b>ENERGY</b>\n` +
    `  Generated today:  <b>${totalEnergy.toFixed(1)} kWh</b>\n` +
    `  Peak output:      <b>${peakKw.toFixed(1)} kW</b>\n` +
    `  Current output:   <b>${currentKw.toFixed(1)} kW</b>\n` +
    `  Fleet avg eff:    <b>${pct(avgEff)}</b>\n\n` +
    `🔧 <b>INVERTERS</b>  (${active}/${totalInv} active)\n` +
    (invLines.length ? invLines.join("\n") : "  No inverter data") + `\n\n` +
    `🌤️ <b>CONDITIONS</b>\n` +
    `  Peak irradiance:  <b>${peakIrrVal.toFixed(0)} W/m²</b>\n` +
    `  Avg irradiance:   <b>${avgIrrVal.toFixed(0)} W/m²</b>\n` +
    `  Avg panel temp:   <b>${panelTempVal.toFixed(1)}°C</b>\n` +
    `  Ambient temp:     <b>${ambTempVal.toFixed(1)}°C</b>\n\n` +
    `💰 <b>ESTIMATED YIELD</b>\n` +
    `  Rate:   ₹${TARIFF_PER_KWH.toFixed(2)}/kWh\n` +
    `  Today:  <b>${rupees(revenue)}</b>\n\n` +
    `📍 <a href="${DASHBOARD_URL}">Open Dashboard</a>`;

  const data = {
    date: dateStr,
    totalEnergy,
    peakKw,
    currentKw,
    avgEff,
    active,
    totalInv,
    peakIrrVal,
    avgIrrVal,
    panelTempVal,
    ambTempVal,
    revenue,
    tariff: TARIFF_PER_KWH,
    inverters: Object.keys(effMap).sort().map(id => ({
      id,
      efficiency: effMap[id],
      uptime: uptimeMap[id],
    })),
  };

  return { text, data };
}

// ── Weekly Report ─────────────────────────────────────────────────

async function generateWeeklyReport() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric", month: "long", year: "numeric",
  });

  const [
    todayEnergy,
    weekPeakPower,
    avgDailyEnergy,
    avgWeekEff,
    invStatus,
    avgWeekUptime,
    weekPeakIrr,
  ] = await Promise.all([
    queryInstant("solar_farm_daily_energy_kwh"),
    queryInstant("max_over_time(solar_farm_total_power_watts[7d])"),
    queryInstant("avg_over_time(solar_farm_daily_energy_kwh[7d])"),
    queryInstant("avg_over_time(solar_inverter_efficiency_percent[7d])"),
    queryInstant("solar_inverter_status"),
    queryInstant("avg_over_time(solar_inverter_status[7d])"),
    queryInstant("max_over_time(solar_irradiance_wm2[7d])"),
  ]);

  const todayKwh      = val(todayEnergy);
  const peakKw        = val(weekPeakPower) / 1000;
  const avgDaily      = val(avgDailyEnergy);
  const weekTotal     = avgDaily * 7;
  const weekRevenue   = weekTotal * TARIFF_PER_KWH;
  const active        = invStatus.filter(r => parseFloat(r.value[1]) === 1).length;
  const totalInv      = invStatus.length || 5;
  const peakIrrVal    = val(weekPeakIrr);

  // Fleet avg efficiency & uptime over 7d
  const effs      = avgWeekEff.map(r => parseFloat(r.value[1]));
  const weekAvgEff= effs.length ? (effs.reduce((a, b) => a + b, 0) / effs.length) : 0;
  const uptimes   = avgWeekUptime.map(r => parseFloat(r.value[1]) * 100);
  const weekAvgUp = uptimes.length ? (uptimes.reduce((a, b) => a + b, 0) / uptimes.length) : 0;

  const text =
    `📊 <b>Weekly Solar Farm Report</b>\n` +
    `📅 Week ending ${dateStr}\n` +
    `${DIVIDER}\n\n` +
    `⚡ <b>ENERGY THIS WEEK</b>\n` +
    `  Est. total:    <b>${weekTotal.toFixed(0)} kWh</b>\n` +
    `  Daily average: <b>${avgDaily.toFixed(1)} kWh/day</b>\n` +
    `  Today so far:  <b>${todayKwh.toFixed(1)} kWh</b>\n` +
    `  Peak output:   <b>${peakKw.toFixed(1)} kW</b>\n` +
    `  Peak irrad.:   <b>${peakIrrVal.toFixed(0)} W/m²</b>\n\n` +
    `🔧 <b>FLEET HEALTH</b>\n` +
    `  Active now:    <b>${active}/${totalInv} inverters</b>\n` +
    `  Avg efficiency:<b>${pct(weekAvgEff)}</b>\n` +
    `  Avg uptime:    <b>${pct(weekAvgUp)}</b>\n\n` +
    `💰 <b>ESTIMATED WEEKLY YIELD</b>\n` +
    `  Rate:          ₹${TARIFF_PER_KWH.toFixed(2)}/kWh\n` +
    `  This week:     <b>${rupees(weekRevenue)}</b>\n` +
    `  Monthly est.:  <b>${rupees(weekRevenue * 4.3)}</b>\n\n` +
    `📍 <a href="${DASHBOARD_URL}">Open Dashboard</a>`;

  const data = {
    weekEndDate: dateStr,
    weekTotal,
    avgDaily,
    todayKwh,
    peakKw,
    weekRevenue,
    weekAvgEff,
    weekAvgUp,
    active,
    totalInv,
    tariff: TARIFF_PER_KWH,
  };

  return { text, data };
}

module.exports = { generateDailyReport, generateWeeklyReport };
