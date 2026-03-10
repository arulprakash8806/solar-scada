#!/usr/bin/env python3
"""Solar Farm SCADA - Prometheus Exporter

Simulates a solar farm with 5 inverters, each with 4 strings of 20 panels.
Metrics vary realistically with time-of-day using sine-wave solar irradiance.
"""

import math
import random
import socket
import threading
import time
from datetime import datetime
from wsgiref.simple_server import WSGIServer, make_server

from prometheus_client import Gauge, make_wsgi_app


# IPv6-capable server so Fly.io internal networking works
class _IPv6WSGIServer(WSGIServer):
    address_family = socket.AF_INET6

def start_http_server(port):
    app = make_wsgi_app()
    httpd = make_server('::', port, app, server_class=_IPv6WSGIServer)
    t = threading.Thread(target=httpd.serve_forever)
    t.daemon = True
    t.start()

# --- Metric definitions ---

panel_voltage = Gauge(
    "solar_panel_voltage_volts",
    "Panel string voltage",
    ["inverter", "string"],
)
panel_current = Gauge(
    "solar_panel_current_amps",
    "Panel string current",
    ["inverter", "string"],
)
panel_power = Gauge(
    "solar_panel_power_watts",
    "Panel string power",
    ["inverter", "string"],
)
inverter_output_power = Gauge(
    "solar_inverter_output_power_watts",
    "Inverter total output power",
    ["inverter"],
)
inverter_efficiency = Gauge(
    "solar_inverter_efficiency_percent",
    "Inverter conversion efficiency",
    ["inverter"],
)
inverter_ac_voltage = Gauge(
    "solar_inverter_ac_voltage_volts",
    "Inverter AC output voltage",
    ["inverter"],
)
inverter_temperature = Gauge(
    "solar_inverter_temperature_celsius",
    "Inverter temperature",
    ["inverter"],
)
inverter_status = Gauge(
    "solar_inverter_status",
    "Inverter status (1=OK, 0=FAULT)",
    ["inverter"],
)
farm_total_power = Gauge(
    "solar_farm_total_power_watts",
    "Total farm power output",
)
farm_daily_energy = Gauge(
    "solar_farm_daily_energy_kwh",
    "Accumulated daily energy production",
)
irradiance = Gauge(
    "solar_irradiance_wm2",
    "Solar irradiance in W/m²",
)
ambient_temp = Gauge(
    "solar_ambient_temperature_celsius",
    "Ambient temperature",
)
panel_temp = Gauge(
    "solar_panel_temperature_celsius",
    "Panel surface temperature",
)

# --- Configuration ---

NUM_INVERTERS = 5
STRINGS_PER_INVERTER = 4
PANELS_PER_STRING = 20
INVERTER_IDS = [f"INV_{i+1:02d}" for i in range(NUM_INVERTERS)]
STRING_IDS = [f"STR_{j+1:02d}" for j in range(STRINGS_PER_INVERTER)]

# Track daily energy accumulation
daily_energy_kwh = 0.0
last_day = datetime.now().day
last_update = time.time()


def solar_factor():
    """Return a 0-1 factor based on time of day (sunrise ~6, sunset ~18)."""
    now = datetime.now()
    hour = now.hour + now.minute / 60.0
    if hour < 5 or hour > 19:
        return 0.0
    # Sine curve peaking at solar noon (~12:30)
    factor = math.sin(math.pi * (hour - 5) / 14)
    return max(0.0, factor)


def cloud_noise():
    """Small random fluctuation simulating cloud cover."""
    return random.uniform(0.85, 1.0)


def update_metrics():
    global daily_energy_kwh, last_day, last_update

    now = datetime.now()
    sf = solar_factor()
    cn = cloud_noise()
    effective_sun = sf * cn

    # Reset daily energy at midnight
    if now.day != last_day:
        daily_energy_kwh = 0.0
        last_day = now.day

    dt_hours = (time.time() - last_update) / 3600.0
    last_update = time.time()

    # Irradiance
    irr = effective_sun * 1000.0 + random.uniform(-10, 10)
    irr = max(0.0, irr)
    irradiance.set(round(irr, 1))

    # Ambient temperature (higher midday)
    amb = 20 + 15 * sf + random.uniform(-1, 1)
    ambient_temp.set(round(amb, 1))

    # Panel temperature
    pt = amb + effective_sun * 25 + random.uniform(-2, 2)
    panel_temp.set(round(pt, 1))

    total_farm_power = 0.0

    for inv_id in INVERTER_IDS:
        # Per-inverter randomness
        inv_factor = random.uniform(0.97, 1.03)

        # Inverter status — ~1% chance of fault
        status = 0 if random.random() < 0.01 else 1
        inverter_status.labels(inverter=inv_id).set(status)

        if status == 0:
            # Faulted inverter produces nothing
            inverter_output_power.labels(inverter=inv_id).set(0)
            inverter_efficiency.labels(inverter=inv_id).set(0)
            inverter_ac_voltage.labels(inverter=inv_id).set(0)
            inverter_temperature.labels(inverter=inv_id).set(round(amb + 5, 1))
            for str_id in STRING_IDS:
                panel_voltage.labels(inverter=inv_id, string=str_id).set(0)
                panel_current.labels(inverter=inv_id, string=str_id).set(0)
                panel_power.labels(inverter=inv_id, string=str_id).set(0)
            continue

        inv_total = 0.0
        for str_id in STRING_IDS:
            # Voltage: ~380-420V
            v = 400 + random.uniform(-20, 20) if effective_sun > 0.01 else 0
            # Current: 0-8A proportional to sun
            c = effective_sun * 8.0 * inv_factor + random.uniform(-0.2, 0.2)
            c = max(0.0, c)
            p = v * c

            panel_voltage.labels(inverter=inv_id, string=str_id).set(round(v, 1))
            panel_current.labels(inverter=inv_id, string=str_id).set(round(c, 2))
            panel_power.labels(inverter=inv_id, string=str_id).set(round(p, 1))
            inv_total += p

        # Efficiency 94-97%
        eff = random.uniform(94, 97)
        inverter_efficiency.labels(inverter=inv_id).set(round(eff, 1))

        # AC voltage ~230V
        ac_v = 230 + random.uniform(-3, 3)
        inverter_ac_voltage.labels(inverter=inv_id).set(round(ac_v, 1))

        # Temperature: higher when producing power
        temp = amb + effective_sun * 25 * inv_factor + random.uniform(-2, 2)
        inverter_temperature.labels(inverter=inv_id).set(round(temp, 1))

        output = inv_total * eff / 100.0
        inverter_output_power.labels(inverter=inv_id).set(round(output, 1))
        total_farm_power += output

    farm_total_power.set(round(total_farm_power, 1))

    # Accumulate daily energy
    daily_energy_kwh += (total_farm_power / 1000.0) * dt_hours
    farm_daily_energy.set(round(daily_energy_kwh, 2))


if __name__ == "__main__":
    print("Starting Solar Farm SCADA Exporter on port 8000...")
    start_http_server(8000)
    while True:
        update_metrics()
        time.sleep(15)
