# Solar Farm SCADA — Architecture Guide

## Overview

This is a cloud-native Solar Farm Supervisory Control and Data Acquisition (SCADA) system deployed on Fly.io. It simulates a real solar farm with 5 inverters, collects metrics via Prometheus, visualises them in Grafana and a custom dashboard, and exposes a REST API for integration.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        PUBLIC INTERNET                          │
│                                                                 │
│   Browser ──► https://backend-dark-paper-3650.fly.dev          │
│   Browser ──► https://grafana-lingering-wave-5682.fly.dev      │
│   Browser ──► https://prometheus-long-frost-4688.fly.dev       │
│   Browser ──► https://exporter.fly.dev/metrics                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (Fly.io proxy)
┌──────────────────────────▼──────────────────────────────────────┐
│                   FLY.IO PRIVATE NETWORK (IPv6)                 │
│                                                                 │
│  ┌─────────────────┐     scrape      ┌──────────────────────┐  │
│  │  Solar Exporter │◄────────────────│     Prometheus       │  │
│  │  (Python)       │  every 15s      │                      │  │
│  │  :8000          │  exporter       │  :9090               │  │
│  │                 │  .internal:8000 │  prometheus-long-    │  │
│  │  app: exporter  │                 │  frost-4688          │  │
│  └─────────────────┘                 └──────────┬───────────┘  │
│                                                 │              │
│                                    query        │  query       │
│                                                 │              │
│  ┌─────────────────┐                ┌──────────▼───────────┐  │
│  │  Custom SCADA   │◄───────────────│   Node.js Backend    │  │
│  │  Dashboard      │   REST API     │                      │  │
│  │  (HTML/JS)      │   /api/*       │  :3000               │  │
│  │                 │                │  backend-dark-       │  │
│  │  served by      │                │  paper-3650          │  │
│  │  backend        │                └──────────────────────┘  │
│  └─────────────────┘                                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Grafana                                                │   │
│  │  :3000  (public port 3000)                              │   │
│  │  grafana-lingering-wave-5682                            │   │
│  │  Datasource: prometheus-long-frost-4688.internal:9090   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Solar Exporter (Python)
**App:** `exporter` | **Port:** 8000 | **Region:** bom (Mumbai)

The heart of the simulation. A Python process that generates realistic solar farm metrics and exposes them in Prometheus format.

*Simulated Farm:*
- 5 Inverters: `INV_01` to `INV_05`
- 4 strings per inverter: `STR_01` to `STR_04`
- 20 panels per string (100 panels per inverter, 500 total)
- Peak farm capacity: ~64 kW

*Solar Irradiance Simulation:*
```python
# Sine-wave curve peaking at solar noon (~12:30 local time)
factor = sin(π × (hour - 5) / 14)   # 0 at 5am, peak at 12:30, 0 at 7pm
irradiance = factor × 1000 W/m²     # Max 1000 W/m² at clear noon
```

*Metrics exposed at `/metrics`:*

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `solar_panel_voltage_volts` | Gauge | inverter, string | String voltage (380–420V) |
| `solar_panel_current_amps` | Gauge | inverter, string | String current (0–8A) |
| `solar_panel_power_watts` | Gauge | inverter, string | String power (V × I) |
| `solar_inverter_output_power_watts` | Gauge | inverter | Inverter output after losses |
| `solar_inverter_efficiency_percent` | Gauge | inverter | DC→AC conversion (94–97%) |
| `solar_inverter_ac_voltage_volts` | Gauge | inverter | AC output voltage (~230V) |
| `solar_inverter_temperature_celsius` | Gauge | inverter | Thermal reading |
| `solar_inverter_status` | Gauge | inverter | 1=OK, 0=FAULT |
| `solar_farm_total_power_watts` | Gauge | — | Sum of all inverter outputs |
| `solar_farm_daily_energy_kwh` | Gauge | — | Accumulated energy since midnight |
| `solar_irradiance_wm2` | Gauge | — | Solar irradiance (W/m²) |
| `solar_ambient_temperature_celsius` | Gauge | — | Ambient temperature |
| `solar_panel_temperature_celsius` | Gauge | — | Panel surface temperature |

*Fault simulation:* Each inverter has ~1% chance of fault per scrape cycle. Faulted inverters report 0W output and `status=0`.

---

### 2. Prometheus
**App:** `prometheus-long-frost-4688` | **Port:** 9090 | **Region:** bom

Time-series database that scrapes the exporter every 15 seconds and stores all metrics for 7 days.

*Scrape configuration:*
```yaml
scrape_configs:
  - job_name: 'solar_farm'
    scrape_interval: 15s
    static_configs:
      - targets: ['exporter.internal:8000']
```

*Key URLs:*
- `/targets` — scrape status for all jobs
- `/graph` — ad-hoc PromQL query interface
- `/api/v1/query?query=<expr>` — instant query API used by backend

*Example PromQL queries:*
```
# Total farm power in kW
solar_farm_total_power_watts / 1000

# Faulted inverters
solar_inverter_status == 0

# Average inverter efficiency
avg(solar_inverter_efficiency_percent)

# Power over last 1 hour
solar_farm_total_power_watts[1h]
```

---

### 3. Node.js Backend API
**App:** `backend-dark-paper-3650` | **Port:** 3000 | **Region:** bom

Express.js server that proxies Prometheus queries and serves them as clean JSON REST endpoints. Also serves the static SCADA dashboard HTML.

*Environment variables:*
```
PROMETHEUS_URL=http://prometheus-long-frost-4688.internal:9090
```

*API Endpoints:*

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/farm` | GET | Farm-level totals: power, energy, irradiance, temps |
| `GET /api/inverters` | GET | Per-inverter summary: power, efficiency, temp, status |
| `GET /api/metrics` | GET | Full snapshot of all metrics |
| `GET /api/alerts` | GET | Active faults (inverters with status=0) |
| `GET /` | GET | Serves the SCADA dashboard HTML |

*Sample `/api/farm` response:*
```json
{
  "farm": {
    "total_power_watts": 47234.5,
    "daily_energy_kwh": 142.7,
    "irradiance_wm2": 823.1,
    "ambient_temp_celsius": 34.2,
    "panel_temp_celsius": 58.6
  }
}
```

---

### 4. SCADA Dashboard (HTML/JS)
**Served by:** backend | **URL:** https://backend-dark-paper-3650.fly.dev

Dark-themed single-page application built with vanilla JavaScript and Chart.js. Polls the backend API every 5 seconds.

*Features:*
- 6 live KPI cards (Total Power, Daily Energy, Irradiance, Temps, Active Inverters)
- 4 live Chart.js line charts (Power trend, Irradiance, Temperature, Per-inverter power)
- 5 inverter status cards with power bar and OK/FAULT badge
- Active alerts panel with critical/warning severity

---

### 5. Grafana
**App:** `grafana-lingering-wave-5682` | **Port:** 3000 | **Region:** bom

Pre-provisioned Grafana instance with Prometheus as the default datasource and a pre-built solar farm dashboard.

*Credentials:* `admin` / `solar123`

*Provisioned datasource (`datasources/prometheus.yml`):*
```yaml
datasources:
  - name: Prometheus
    type: prometheus
    url: http://prometheus-long-frost-4688.internal:9090
    isDefault: true
```

*Pre-built dashboard panels:*
1. Total Farm Power (stat)
2. Daily Energy (stat)
3. Solar Irradiance (stat)
4. Per-inverter power (time series)
5. Inverter efficiency (gauge)
6. Farm temperatures (time series)
7. Inverter status heatmap
8. String-level power breakdown
9. Alert annotations
10. Daily energy accumulation

---

## Network & Deployment

### Fly.io Internal Networking
All 4 apps are deployed in the `bom` (Mumbai) region and communicate over Fly.io's private WireGuard mesh network using IPv6:

| Service | Internal DNS | Port |
|---------|-------------|------|
| Exporter | `exporter.internal` | 8000 |
| Prometheus | `prometheus-long-frost-4688.internal` | 9090 |
| Grafana | `grafana-lingering-wave-5682.internal` | 3000 |
| Backend | `backend-dark-paper-3650.internal` | 3000 |

> **Important:** Fly.io internal DNS resolves to IPv6 addresses. The Python exporter is configured to bind to `::` (all IPv6 interfaces) using a custom `AF_INET6` WSGI server.

### Machine Configuration
All machines are configured to stay always-on:
```toml
auto_stop_machines = false
min_machines_running = 1
```
This is critical — Prometheus needs the exporter to be continuously available for scraping.

---

## Data Flow

```
Every 15 seconds:
  solar_exporter.py
    └── generates metrics based on time-of-day sine wave
    └── exposes at exporter.internal:8000/metrics

  Prometheus
    └── scrapes exporter.internal:8000/metrics
    └── stores time-series in /prometheus volume

Every 5 seconds (browser):
  Dashboard JS
    └── fetch /api/farm → backend → Prometheus query
    └── fetch /api/inverters → backend → Prometheus query
    └── fetch /api/alerts → backend → Prometheus query
    └── updates KPI cards, charts, inverter cards, alerts
```

---

## Local Development

Run locally with Docker Compose:
```bash
docker-compose up --build
```

| Service | Local URL |
|---------|-----------|
| Dashboard | http://localhost:3000 |
| Grafana | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Exporter | http://localhost:8000/metrics |

---

## Deployment

Deploy all services to Fly.io using the provided script:
```powershell
# Windows
.\deploy.ps1
```

Or manually, deploying in dependency order:
```bash
cd exporter   && fly deploy && cd ..
cd prometheus && fly deploy && cd ..
cd grafana    && fly deploy && cd ..
cd backend    && fly deploy && cd ..
```

---

## Repository Structure

```
solar-scada/
├── exporter/
│   ├── solar_exporter.py     # Python Prometheus exporter (simulation)
│   ├── requirements.txt      # prometheus_client
│   ├── Dockerfile
│   └── fly.toml              # app: exporter
├── prometheus/
│   ├── prometheus.yml        # Scrape config
│   ├── Dockerfile
│   └── fly.toml              # app: prometheus-long-frost-4688
├── grafana/
│   ├── Dockerfile
│   ├── fly.toml              # app: grafana-lingering-wave-5682
│   └── provisioning/
│       ├── datasources/
│       │   └── prometheus.yml
│       └── dashboards/
│           ├── dashboard.yml
│           └── solar_farm.json
├── backend/
│   ├── server.js             # Express API + static dashboard server
│   ├── package.json
│   ├── Dockerfile
│   ├── fly.toml              # app: backend-dark-paper-3650
│   └── dashboard/
│       └── index.html        # SCADA UI (Chart.js, live polling)
├── docker-compose.yml        # Local development
├── deploy.ps1                # One-click Fly.io deployment (Windows)
└── ARCHITECTURE.md           # This file
```
