# Solar Farm SCADA System

A complete Solar Farm Supervisory Control and Data Acquisition (SCADA) system built with Docker. Simulates a 5-inverter solar farm with realistic time-of-day metrics, live dashboards, and alerting.

## Quick Start

```bash
docker-compose up --build
```

## URLs

| Service           | URL                        | Notes                          |
|-------------------|----------------------------|--------------------------------|
| Custom Dashboard  | http://localhost:3000       | Live SCADA web UI              |
| Grafana           | http://localhost:3001       | Pre-built solar dashboard      |
| Prometheus        | http://localhost:9090       | Metrics query interface        |
| Exporter (raw)    | http://localhost:8000       | Raw Prometheus metrics         |

Grafana credentials: `admin` / `solar123` (anonymous viewing enabled).

## Architecture

```
+------------------+       +------------------+       +------------------+
|  Solar Exporter  | ----> |   Prometheus     | ----> |    Grafana       |
|  (Python :8000)  |       |   (:9090)        |       |    (:3001)       |
+------------------+       +------------------+       +------------------+
                                   |
                                   v
                           +------------------+       +------------------+
                           |  Node.js API     | ----> |  Web Dashboard   |
                           |  (:3000)         |       |  (served by API) |
                           +------------------+       +------------------+
```

## Simulated Farm

- 5 Inverters (INV_01 to INV_05)
- 4 strings per inverter, 20 panels per string
- Day/night cycle based on sine-wave irradiance (sunrise ~06:00, sunset ~19:00)
- Random cloud cover fluctuations
- ~1% random inverter fault probability

## Metrics Reference

| Metric | Description | Labels |
|--------|-------------|--------|
| `solar_panel_voltage_volts` | String voltage (~380-420V) | inverter, string |
| `solar_panel_current_amps` | String current (0-8A, day/night) | inverter, string |
| `solar_panel_power_watts` | String power (V * I) | inverter, string |
| `solar_inverter_output_power_watts` | Inverter total output | inverter |
| `solar_inverter_efficiency_percent` | Conversion efficiency (94-97%) | inverter |
| `solar_inverter_ac_voltage_volts` | AC output voltage (~230V) | inverter |
| `solar_inverter_temperature_celsius` | Inverter temp (35-65C) | inverter |
| `solar_inverter_status` | 1=OK, 0=FAULT | inverter |
| `solar_farm_total_power_watts` | Sum of all inverter output | — |
| `solar_farm_daily_energy_kwh` | Accumulated daily energy | — |
| `solar_irradiance_wm2` | Solar irradiance (0-1000 W/m2) | — |
| `solar_ambient_temperature_celsius` | Ambient temperature (20-40C) | — |
| `solar_panel_temperature_celsius` | Panel surface temperature | — |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/metrics` | All current metrics from Prometheus |
| `GET /api/inverters` | Per-inverter summary |
| `GET /api/farm` | Farm-level totals |
| `GET /api/alerts` | Active faults (inverter status = 0) |

## Stopping

```bash
docker-compose down -v
```
