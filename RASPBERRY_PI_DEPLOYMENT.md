# Raspberry Pi — Real Deployment Guide

This guide covers the end-to-end flow for connecting a real solar farm to the SCADA system using a Raspberry Pi as the on-site edge device.

---

## End-to-End Architecture

```
SOLAR FARM SITE                          CLOUD (Fly.io)
─────────────────────────────────────    ────────────────────────────────────

  ┌─────────────┐  Modbus TCP/RTU        ┌─────────────────┐
  │  Inverter 1 │◄──┐                    │  Prometheus     │
  └─────────────┘   │                    │  (metrics store)│
                    │                    └────────┬────────┘
  ┌─────────────┐   │  ┌──────────────┐           │
  │  Inverter 2 │◄──┼──│ Raspberry Pi │           │ query
  └─────────────┘   │  │              │           │
                    │  │ solar_       │  HTTPS    ▼
  ┌─────────────┐   │  │ exporter.py  │──────►┌─────────────────┐
  │  Inverter 3 │◄──┘  │              │       │  Node.js API    │
  └─────────────┘      │ :8000/metrics│       │  + Dashboard    │
                       └──────────────┘       └─────────────────┘
  ┌─────────────┐            │
  │  Router /   │            │ (optional)
  │  4G SIM     │◄───────────┘            ┌─────────────────┐
  └─────────────┘  internet               │  Grafana        │
                                          │  Dashboards     │
                                          └─────────────────┘

                                          ┌─────────────────┐
                                          │  Your Browser / │
                                          │  Mobile App     │
                                          └─────────────────┘
```

---

## Hardware You Need

| Item | Recommended | Approx Cost |
|------|------------|-------------|
| Raspberry Pi 4 (2GB RAM) | Raspberry Pi 4 Model B | ₹5,500 |
| MicroSD Card (32GB) | SanDisk Endurance | ₹800 |
| Power Supply | Official Pi 4 PSU (3A) | ₹600 |
| Case | Aluminium heatsink case | ₹500 |
| USB-to-RS485 adapter | For Modbus RTU inverters | ₹500 |
| Ethernet cable | Cat5e / Cat6 | ₹200 |
| UPS / backup power | Ensure Pi stays on at night | ₹2,000+ |

*Total: ~₹10,000*

> If your inverters support Modbus TCP (ethernet), you don't need the RS485 adapter.

---

## Step 1 — Set Up Raspberry Pi

### Flash the OS
1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
2. Flash *Raspberry Pi OS Lite (64-bit)* — no desktop needed
3. Before flashing, click ⚙️ Settings and set:
   - Hostname: `solar-pi`
   - Enable SSH: ✅
   - Username: `pi`
   - Password: (your choice)
   - WiFi: (optional, ethernet preferred)

### First Boot
```bash
# SSH into the Pi (find its IP from your router)
ssh pi@solar-pi.local

# Update the OS
sudo apt update && sudo apt upgrade -y

# Install Python and pip
sudo apt install -y python3 python3-pip git

# Install project dependencies
pip3 install pymodbus prometheus_client
```

---

## Step 2 — Connect Inverters

### Option A — Modbus TCP (Ethernet — Most Modern Inverters)

```
Inverter ──[LAN cable]──► Router/Switch ──[LAN cable]──► Raspberry Pi
```

Each inverter gets a static IP on your LAN (e.g., `192.168.1.101`, `192.168.1.102`).
Check your inverter manual for how to set the IP and enable Modbus TCP.

### Option B — Modbus RTU (RS-485 Serial — Older Inverters)

```
Inverter ──[RS-485 cable]──► USB-RS485 Adapter ──[USB]──► Raspberry Pi
```

Inverters are daisy-chained on one RS-485 bus. Each gets a unique Modbus address (1, 2, 3...).

```bash
# Check the adapter is detected
ls /dev/ttyUSB*
# Should show: /dev/ttyUSB0
```

---

## Step 3 — Install the Real Exporter

Replace the simulator with the real Modbus exporter on the Pi:

```bash
# On the Raspberry Pi
git clone https://github.com/arulprakash8806/solar-scada.git
cd solar-scada/exporter
```

Replace `solar_exporter.py` with the real version (see inverter-specific section below).

### Modbus TCP Exporter Example (SunSpec-compatible inverters)

```python
#!/usr/bin/env python3
"""
Solar Farm SCADA - Real Modbus TCP Exporter
Reads data from SunSpec-compatible inverters over Modbus TCP.
"""

import time
import socket
import threading
from wsgiref.simple_server import WSGIServer, make_server
from pymodbus.client import ModbusTcpClient
from prometheus_client import Gauge, make_wsgi_app

# ── Prometheus metrics ────────────────────────────────────────────
inverter_power   = Gauge('solar_inverter_output_power_watts', 'Inverter AC power', ['inverter'])
inverter_voltage = Gauge('solar_inverter_ac_voltage_volts',   'Inverter AC voltage', ['inverter'])
inverter_current = Gauge('solar_inverter_ac_current_amps',    'Inverter AC current', ['inverter'])
inverter_temp    = Gauge('solar_inverter_temperature_celsius', 'Inverter temperature', ['inverter'])
inverter_status  = Gauge('solar_inverter_status',              '1=OK 0=FAULT', ['inverter'])
farm_total_power = Gauge('solar_farm_total_power_watts',       'Total farm power')

# ── Inverter config ───────────────────────────────────────────────
# Add all your inverter IPs here
INVERTERS = [
    {'id': 'INV_01', 'host': '192.168.1.101', 'port': 502},
    {'id': 'INV_02', 'host': '192.168.1.102', 'port': 502},
    {'id': 'INV_03', 'host': '192.168.1.103', 'port': 502},
]

# SunSpec register map (adjust for your inverter brand)
REG_AC_POWER   = 40083  # Watts
REG_AC_VOLTAGE = 40079  # Volts (scale factor at 40082)
REG_TEMP       = 40103  # Celsius (scale factor at 40106)
REG_STATUS     = 40107  # Operating state

def read_inverter(inv):
    client = ModbusTcpClient(inv['host'], port=inv['port'], timeout=5)
    try:
        if not client.connect():
            inverter_status.labels(inverter=inv['id']).set(0)
            inverter_power.labels(inverter=inv['id']).set(0)
            return 0

        # Read power (single register, signed)
        result = client.read_holding_registers(REG_AC_POWER, 2, slave=1)
        power = result.registers[0] if not result.isError() else 0

        # Read voltage
        result = client.read_holding_registers(REG_AC_VOLTAGE, 4, slave=1)
        voltage = result.registers[0] if not result.isError() else 0

        # Read temperature
        result = client.read_holding_registers(REG_TEMP, 4, slave=1)
        temp = result.registers[0] / 100 if not result.isError() else 0

        # Read status
        result = client.read_holding_registers(REG_STATUS, 1, slave=1)
        status = 1 if (not result.isError() and result.registers[0] in [4, 5]) else 0

        inverter_power.labels(inverter=inv['id']).set(power)
        inverter_voltage.labels(inverter=inv['id']).set(voltage)
        inverter_temp.labels(inverter=inv['id']).set(temp)
        inverter_status.labels(inverter=inv['id']).set(status)

        return power

    except Exception as e:
        print(f"Error reading {inv['id']}: {e}")
        inverter_status.labels(inverter=inv['id']).set(0)
        return 0
    finally:
        client.close()

# ── IPv6 server for Fly.io internal networking ────────────────────
class IPv6WSGIServer(WSGIServer):
    address_family = socket.AF_INET6

def start_metrics_server(port=8000):
    app = make_wsgi_app()
    httpd = make_server('::', port, app, server_class=IPv6WSGIServer)
    t = threading.Thread(target=httpd.serve_forever)
    t.daemon = True
    t.start()
    print(f"Metrics server started on port {port}")

if __name__ == '__main__':
    start_metrics_server(8000)
    print("Polling inverters every 15 seconds...")
    while True:
        total = sum(read_inverter(inv) for inv in INVERTERS)
        farm_total_power.set(total)
        print(f"Total farm power: {total:.0f}W")
        time.sleep(15)
```

---

## Step 4 — Run the Exporter as a Service

Make the exporter start automatically on boot:

```bash
# Create a systemd service
sudo nano /etc/systemd/system/solar-exporter.service
```

Paste this:
```ini
[Unit]
Description=Solar Farm SCADA Exporter
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/solar-scada/exporter
ExecStart=/usr/bin/python3 solar_exporter.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable solar-exporter
sudo systemctl start solar-exporter

# Check status
sudo systemctl status solar-exporter

# View live logs
journalctl -u solar-exporter -f
```

Verify it's running locally:
```bash
curl http://localhost:8000/metrics
# Should print Prometheus metrics
```

---

## Step 5 — Connect Pi to the Cloud (Fly.io)

### Option A — Open Port (Simplest)

Configure your site router to forward port 8000 from the internet to the Pi's local IP:

```
Router NAT rule:
  External: <your-public-IP>:8000 → 192.168.1.x:8000
```

Then update `prometheus/prometheus.yml` to scrape the Pi's public IP:
```yaml
scrape_configs:
  - job_name: 'solar_farm'
    static_configs:
      - targets: ['<your-public-IP>:8000']
```

### Option B — Tailscale VPN (Recommended — More Secure)

No open firewall ports. Tailscale creates an encrypted tunnel between the Pi and Prometheus.

```bash
# On Raspberry Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Note the Tailscale IP (e.g., 100.x.x.x)
```

Then update prometheus.yml:
```yaml
scrape_configs:
  - job_name: 'solar_farm'
    static_configs:
      - targets: ['100.x.x.x:8000']   # Tailscale IP of the Pi
```

### Option C — 4G SIM Card (Remote Sites Without Internet)

If the solar farm has no broadband:
1. Insert a 4G SIM into a router connected to the Pi
2. Use Tailscale (Option B) over 4G — works the same way
3. Data usage: ~50MB/month at 15s scrape interval

---

## Step 6 — Update Prometheus Config and Redeploy

After choosing your connectivity option, update the scrape target and redeploy:

```bash
# On your Windows laptop
cd solar-scada/prometheus
# Edit prometheus.yml — change target to Pi's IP or Tailscale IP
fly deploy
```

---

## Step 7 — Verify End-to-End

Check each layer:

```
1. Pi exporter     → curl http://<pi-ip>:8000/metrics        ✅ shows metrics
2. Prometheus      → https://prometheus-long-frost-4688.fly.dev/targets  ✅ State: UP
3. Backend API     → https://backend-dark-paper-3650.fly.dev/api/farm    ✅ shows real power
4. Dashboard       → https://backend-dark-paper-3650.fly.dev             ✅ live charts
5. Grafana         → https://grafana-lingering-wave-5682.fly.dev         ✅ panels show data
```

---

## Inverter-Specific Notes

### Huawei SUN2000
- Protocol: Modbus TCP, port 6607 (not 502)
- Register map: [Huawei SUN2000 Modbus Interface](https://support.huawei.com/enterprise/en/doc/EDOC1100136813)
- Recommended library: `huawei-solar` (pip install huawei-solar)

### SMA Sunny Boy / Tripower
- Protocol: Modbus TCP, port 502, slave ID 3
- Alternative: SMA REST API (no Pi needed)
- Tool: `pysma` library

### Fronius Symo / Primo
- Protocol: Fronius Solar API v1 (REST, no Modbus needed)
- URL: `http://<inverter-ip>/solar_api/v1/GetInverterRealtimeData.cgi`
- No special adapter required

### Growatt
- Protocol: Modbus RTU (RS-485) or Modbus TCP
- Library: `growattServer` or direct pymodbus
- Default slave address: 1

### Generic SunSpec (Most modern inverters)
- Start register: 40000 or 0
- SunSpec ID at 40000 = 0x5375 (decimal 21365)
- Library: `sunspec` (pip install sunspec2)

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| Can't connect to inverter | Ping inverter IP from Pi, check Modbus TCP enabled in inverter settings |
| RS-485 not detected | `ls /dev/ttyUSB*`, check wiring polarity (A/B/GND) |
| Prometheus shows DOWN | Check firewall, Pi's port 8000 reachable, check systemd service |
| All metrics are 0 | Modbus register addresses — check inverter manual |
| Service crashes on Pi | `journalctl -u solar-exporter -n 50` to see error logs |
| Wrong power readings | Check scale factors in SunSpec registers (SF registers) |

---

## Security Checklist for Production

- [ ] Change default Grafana password (`solar123` → strong password)
- [ ] Use Tailscale instead of open firewall ports
- [ ] Set up Grafana alerting (email/Telegram on inverter fault)
- [ ] Enable Prometheus authentication (basic auth + TLS)
- [ ] Store secrets with `fly secrets set` instead of env vars
- [ ] Set up daily backup of Prometheus data volume
- [ ] Monitor Pi health (CPU temp, disk space) — add as metrics
