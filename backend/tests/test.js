/**
 * Solar Farm SCADA — Automated Test Suite
 *
 * Tests all API endpoints and simulates Telegram alert scenarios.
 * Run with: node tests/test.js [BASE_URL]
 *
 * Examples:
 *   node tests/test.js                                         # local (port 3000)
 *   node tests/test.js https://backend-dark-paper-3650.fly.dev # production
 */

const fetch = require("node-fetch");

const BASE_URL = process.argv[2] || "http://localhost:3000";
let passed = 0;
let failed = 0;

// ── Helpers ───────────────────────────────────────────────────────

function log(icon, label, msg = "") {
  console.log(`${icon} ${label}${msg ? ": " + msg : ""}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    log("✅", name);
  } catch (err) {
    failed++;
    log("❌", name, err.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const json = await res.json();
  return { status: res.status, body: json };
}

async function post(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST" });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ── Test suites ───────────────────────────────────────────────────

async function testHealthEndpoints() {
  console.log("\n📡 API Health Checks");
  console.log("─────────────────────────────────────");

  await test("Dashboard HTML loads (GET /)", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes("Solar Farm SCADA"), "Dashboard HTML missing title");
  });

  await test("GET /api/farm returns farm data", async () => {
    const { status, body } = await get("/api/farm");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", `Expected status ok, got ${body.status}`);
    assert(typeof body.farm === "object", "Missing farm object");
    assert(typeof body.farm.total_power_watts === "number", "Missing total_power_watts");
    assert(typeof body.farm.daily_energy_kwh === "number", "Missing daily_energy_kwh");
    assert(typeof body.farm.irradiance_wm2 === "number", "Missing irradiance_wm2");
    assert(typeof body.farm.ambient_temp_celsius === "number", "Missing ambient_temp_celsius");
    assert(typeof body.farm.panel_temp_celsius === "number", "Missing panel_temp_celsius");
  });

  await test("GET /api/inverters returns inverter list", async () => {
    const { status, body } = await get("/api/inverters");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", `Expected status ok`);
    assert(Array.isArray(body.inverters), "inverters should be an array");
    assert(body.inverters.length === 5, `Expected 5 inverters, got ${body.inverters.length}`);
    const inv = body.inverters[0];
    assert(typeof inv.id === "string", "Inverter missing id");
    assert(typeof inv.power_watts === "number", "Inverter missing power_watts");
    assert(typeof inv.status === "number", "Inverter missing status");
  });

  await test("GET /api/alerts returns alerts array", async () => {
    const { status, body } = await get("/api/alerts");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", "Expected status ok");
    assert(Array.isArray(body.alerts), "alerts should be an array");
    assert(typeof body.count === "number", "Missing count field");
  });

  await test("GET /api/metrics returns all metrics", async () => {
    const { status, body } = await get("/api/metrics");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", "Expected status ok");
    assert(typeof body.data === "object", "Missing data object");
    assert(Array.isArray(body.data.farm_total_power), "Missing farm_total_power");
    assert(Array.isArray(body.data.inverter_status), "Missing inverter_status");
  });
}

async function testDataValidity() {
  console.log("\n📊 Data Validity Checks");
  console.log("─────────────────────────────────────");

  await test("Farm total power is non-negative", async () => {
    const { body } = await get("/api/farm");
    assert(body.farm.total_power_watts >= 0, `Negative power: ${body.farm.total_power_watts}`);
  });

  await test("Daily energy is non-negative", async () => {
    const { body } = await get("/api/farm");
    assert(body.farm.daily_energy_kwh >= 0, `Negative energy: ${body.farm.daily_energy_kwh}`);
  });

  await test("Irradiance is between 0 and 1200 W/m²", async () => {
    const { body } = await get("/api/farm");
    const irr = body.farm.irradiance_wm2;
    assert(irr >= 0 && irr <= 1200, `Irradiance out of range: ${irr}`);
  });

  await test("All inverters have valid status (0 or 1)", async () => {
    const { body } = await get("/api/inverters");
    for (const inv of body.inverters) {
      assert(
        inv.status === 0 || inv.status === 1,
        `${inv.id} has invalid status: ${inv.status}`
      );
    }
  });

  await test("All inverter IDs match expected format INV_XX", async () => {
    const { body } = await get("/api/inverters");
    for (const inv of body.inverters) {
      assert(/^INV_\d{2}$/.test(inv.id), `Unexpected inverter ID format: ${inv.id}`);
    }
  });

  await test("Faulted inverters appear in /api/alerts", async () => {
    const [invRes, alertRes] = await Promise.all([get("/api/inverters"), get("/api/alerts")]);
    const faultedInvs = invRes.body.inverters
      .filter(i => i.status === 0)
      .map(i => i.id)
      .sort();
    const alertedInvs = alertRes.body.alerts
      .map(a => a.inverter)
      .sort();
    assert(
      JSON.stringify(faultedInvs) === JSON.stringify(alertedInvs),
      `Mismatch: faulted=${faultedInvs}, alerted=${alertedInvs}`
    );
  });
}

async function testSimulationEndpoints() {
  console.log("\n🔔 Telegram Alert Simulation");
  console.log("─────────────────────────────────────");

  await test("POST /api/simulate/fault sends fault alert", async () => {
    const { status, body } = await post("/api/simulate/fault?inverter=INV_01");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", `Expected ok, got: ${JSON.stringify(body)}`);
  });

  await test("POST /api/simulate/recovery sends recovery alert", async () => {
    const { status, body } = await post("/api/simulate/recovery?inverter=INV_01");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", `Expected ok`);
  });

  await test("POST /api/simulate/lowpower sends low power alert", async () => {
    const { status, body } = await post("/api/simulate/lowpower");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", `Expected ok`);
  });

  await test("POST /api/simulate/summary sends daily summary", async () => {
    const { status, body } = await post("/api/simulate/summary");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(body.status === "ok", `Expected ok`);
  });

  await test("POST /api/simulate/invalid returns 400", async () => {
    const { status } = await post("/api/simulate/doesnotexist");
    assert(status === 400, `Expected 400, got ${status}`);
  });
}

async function testErrorHandling() {
  console.log("\n🛡 Error Handling");
  console.log("─────────────────────────────────────");

  await test("Unknown route returns dashboard HTML (not 404 JSON)", async () => {
    const res = await fetch(`${BASE_URL}/unknown-route-xyz`);
    assert(res.status === 200, `Expected 200 (SPA fallback), got ${res.status}`);
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════╗");
  console.log("║  Solar Farm SCADA — Automated Tests   ║");
  console.log("╚═══════════════════════════════════════╝");
  console.log(`🌐 Target: ${BASE_URL}`);

  await testHealthEndpoints();
  await testDataValidity();
  await testSimulationEndpoints();
  await testErrorHandling();

  console.log("\n═══════════════════════════════════════");
  console.log(`Results: ✅ ${passed} passed  ❌ ${failed} failed`);
  console.log("═══════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
