# Endless Pool Web Controller

A mobile-friendly web app to control an endless pool (FS FORTH-SYSTEME controller) over WiFi, with multi-user support, training programs, workout tracking, and Strava upload.

## Features

- **Real-time pool control**: Start/stop, speed (pace), timer, distance display
- **Multi-user**: Simple name + 4-digit PIN login, per-user data
- **Training programs**: USMS-style structured workouts (warm-up/main/cool-down with intervals), 4 built-in programs, create your own
- **Workout tracking**: Auto-records sessions, displays history
- **Export**: Download workouts as TCX files (Garmin Connect, TrainingPeaks compatible)
- **Strava upload**: Direct upload via OAuth2

## Quick Start

```bash
pip install -r requirements.txt
python server.py
```

Open `http://localhost:8000` on your phone (must be on the same WiFi network as the pool).

## CLI Tool

Monitor pool status:
```bash
python cli.py monitor
```

Send commands:
```bash
python cli.py send start
python cli.py send stop
python cli.py send speed 162        # Raw speed parameter (0-255)
python cli.py send pace 2:00        # Set pace to 2:00/100m
python cli.py send timer 1800       # Set timer to 30 minutes
```

## Protocol

The pool controller (FS FORTH-SYSTEME) communicates via UDP:
- **Broadcasts** status on port 9750→45654 every ~500ms (111 bytes)
- **Accepts** commands on port 45654→9750 (44 bytes)
- Both use `0x0AF0` magic header and CRC32 checksums

Speed range: 4:03 min/100m (slowest) to 1:14 min/100m (fastest).

## Home Assistant (HAOS) Deployment

Run the Endless Pool Controller as a Home Assistant add-on on your Raspberry Pi.

### Prerequisites

- Home Assistant OS (HAOS) running on a Raspberry Pi
- The Pi must be on the same network as the pool controller (default IP: `192.168.50.232`)

### Installation

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**
2. Click the **three dots** menu (top-right) > **Repositories**
3. Paste this URL and click **Add**:
   ```
   https://github.com/smash0190/endlesspool
   ```
4. Close the dialog, then **reload** the page
5. Find **Endless Pool Controller** in the store > click **Install**
6. Go to the **Configuration** tab to set your pool's IP address if it differs from the default
7. Click **Start**
8. Access the web UI at `http://homeassistant.local:8000`

### Configuration

The pool IP address can be changed in the add-on's Configuration tab in Home Assistant (default: `192.168.50.232`).

All user data (accounts, workouts, Strava tokens) is stored persistently and survives add-on rebuilds.

### Notes

- The add-on uses **host networking** to communicate with the pool via UDP broadcasts
- Logs are viewable in the add-on's **Log** tab in Home Assistant
- The add-on auto-starts on boot and auto-restarts on crash
- To update the add-on after pushing changes to GitHub, go to the add-on page and click **Rebuild**

## Strava Setup

1. Create a free Strava API app at https://www.strava.com/settings/api
2. Set callback domain to `localhost`
3. Enter Client ID and Secret in the app's Settings tab
4. Click "Connect to Strava"
