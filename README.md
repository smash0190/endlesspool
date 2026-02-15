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

## Strava Setup

1. Create a free Strava API app at https://www.strava.com/settings/api
2. Set callback domain to `localhost`
3. Enter Client ID and Secret in the app's Settings tab
4. Click "Connect to Strava"
