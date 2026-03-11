const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const { startAlerter } = require("./alerter");

const app = express();
const PORT = 3000;
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";

app.use(cors());
app.use(express.static(path.join(__dirname, "dashboard")));

async function queryPrometheus(query) {
  const url = `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(`Prometheus query failed: ${data.error}`);
  }
  return data.data.result;
}

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

// Fallback: serve dashboard
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard/index.html"));
});

app.listen(PORT, () => {
  console.log(`Solar SCADA API running on port ${PORT}`);
  startAlerter();
});
