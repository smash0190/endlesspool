#!/usr/bin/env python3
"""
Endless Pool Web Controller - FastAPI Backend

Handles:
- UDP broadcast listener for pool status
- UDP command sender
- WebSocket for real-time browser communication
- REST API for users, programs, workouts
- Strava OAuth2 integration
- Static file serving for the web UI
"""

import asyncio
import hashlib
import json
import socket
import threading
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import (
    FastAPI, WebSocket, WebSocketDisconnect,
    HTTPException, Request,
)
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from protocol import constants as C
from protocol.decoder import (
    PoolStatus,
    build_command,
    format_timer,
    parse_broadcast,
)
import strava as strava_module
import tcx as tcx_module

# ---------------------------------------------------------------------------
# Data paths
# ---------------------------------------------------------------------------
DATA_DIR = Path("data")
USERS_FILE = DATA_DIR / "users.json"

def user_dir(user_id: str) -> Path:
    return DATA_DIR / "users" / user_id

def ensure_dirs():
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "users").mkdir(exist_ok=True)
    if not USERS_FILE.exists():
        USERS_FILE.write_text("[]")

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
latest_status: Optional[Dict[str, Any]] = None
connected_websockets: List[WebSocket] = []
udp_listener_sock: Optional[socket.socket] = None
udp_sender_sock: Optional[socket.socket] = None
workout_recorder = None  # WorkoutRecorder instance

# ---------------------------------------------------------------------------
# Workout recorder
# ---------------------------------------------------------------------------
class WorkoutRecorder:
    """Automatically records workouts when the pool is running."""

    def __init__(self):
        self.active_user_id: Optional[str] = None
        self.recording = False
        self.workout: Optional[Dict] = None
        self.current_interval_start: Optional[float] = None
        self.current_interval_dist_start: float = 0.0
        self.last_speed_param: int = 0
        self.was_running: bool = False
        self.stopped_at: Optional[float] = None

    def set_user(self, user_id: str):
        self.active_user_id = user_id

    def update(self, status: PoolStatus):
        """Called on each broadcast packet. Manages recording state."""
        now = time.time()

        if status.is_running and not self.was_running:
            self._on_start(status, now)
            self.stopped_at = None
        elif not status.is_running and self.was_running:
            self._on_stop(status, now)
            self.stopped_at = now
        elif status.is_running and self.recording:
            self.stopped_at = None
            # Check for speed change mid-swim
            if status.speed_param != self.last_speed_param and self.last_speed_param != 0:
                self._finish_interval(status, now)
                self._start_interval(status, now)

        self.was_running = status.is_running

    def check_auto_finalize(self) -> Optional[Dict]:
        """Auto-finalize if pool has been stopped for 5+ seconds while recording.

        Speed changes briefly stop the pool (~2s) so we use a 5s threshold
        to distinguish real stops (timer expiry, manual stop from other app)
        from transient speed-change pauses.
        """
        if not self.recording or self.stopped_at is None:
            return None
        if time.time() - self.stopped_at > 5.0:
            return self.finalize()
        return None

    def _on_start(self, status: PoolStatus, now: float):
        if not self.active_user_id:
            return
        if not self.recording:
            self.workout = {
                "id": str(uuid.uuid4()),
                "user_id": self.active_user_id,
                "start_time": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                "total_distance": 0.0,
                "total_time": 0,
                "intervals": [],
            }
            self.recording = True
        self._start_interval(status, now)

    def _start_interval(self, status: PoolStatus, now: float):
        self.current_interval_start = now
        self.current_interval_dist_start = status.total_distance
        self.last_speed_param = status.speed_param

    def _on_stop(self, status: PoolStatus, now: float):
        if self.recording:
            self._finish_interval(status, now)

    def _finish_interval(self, status: PoolStatus, now: float):
        if self.current_interval_start is None or self.workout is None:
            return

        duration = int(now - self.current_interval_start)
        distance = max(0, status.total_distance - self.current_interval_dist_start)

        if duration > 0:
            interval = {
                "start_time": datetime.fromtimestamp(
                    self.current_interval_start, tz=timezone.utc
                ).isoformat(),
                "duration": duration,
                "distance": round(distance, 1),
                "speed_param": self.last_speed_param,
                "avg_pace": round(100 / (distance / duration), 1) if distance > 0 else 0,
                "type": "swim",
            }
            self.workout["intervals"].append(interval)
            self.workout["total_distance"] = round(
                self.workout["total_distance"] + distance, 1
            )
            self.workout["total_time"] += duration

        self.current_interval_start = None

    def finalize(self) -> Optional[Dict]:
        """Finish recording and return the workout, or None."""
        if not self.recording or not self.workout:
            return None
        if not self.workout["intervals"]:
            self.recording = False
            self.workout = None
            return None

        workout = self.workout
        self.recording = False
        self.workout = None
        self.current_interval_start = None
        return workout

    def is_recording(self) -> bool:
        return self.recording


# ---------------------------------------------------------------------------
# UDP threads
# ---------------------------------------------------------------------------
def udp_listener_thread():
    """Background thread: listen for pool broadcasts and update state."""
    global latest_status, udp_listener_sock

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("", C.CLIENT_PORT))
    sock.settimeout(1.0)
    udp_listener_sock = sock

    last_raw = None

    while True:
        try:
            data, addr = sock.recvfrom(1024)
        except socket.timeout:
            continue
        except OSError:
            break

        if len(data) != C.BC_PACKET_SIZE:
            continue

        status = parse_broadcast(data)
        if status is None:
            continue

        # Deduplicate
        if data == last_raw:
            continue
        last_raw = data

        latest_status = status.to_dict()

        # Update workout recorder
        if workout_recorder:
            workout_recorder.update(status)
            auto_workout = workout_recorder.check_auto_finalize()
            if auto_workout:
                _save_workout(auto_workout)


def _ensure_sender_sock():
    """Lazily create the UDP sender socket."""
    global udp_sender_sock
    if udp_sender_sock is None:
        udp_sender_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_sender_sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)


def send_pool_command(cmd_type: int, param: int = 0, repeat: int = 3):
    """Send a UDP command to the pool, repeated for reliability.

    The packet is built once so every retry carries the same
    transaction-ID; the pool can safely deduplicate.
    """
    _ensure_sender_sock()
    cmd = build_command(cmd_type, param)
    for _ in range(repeat):
        udp_sender_sock.sendto(cmd, (C.POOL_IP, C.POOL_PORT))
        if repeat > 1:
            time.sleep(0.05)


def _send_verified(cmd_type: int, param: int, check_fn, timeout: float = 5.0):
    """Send a command and retry until the broadcast confirms success.

    Args:
        cmd_type: Command constant (CMD_START, CMD_STOP, etc.)
        param:    Command parameter.
        check_fn: Callable(latest_status_dict) -> bool that returns True
                  when the broadcast reflects the desired state.
        timeout:  Maximum seconds to keep retrying.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        send_pool_command(cmd_type, param, repeat=2)
        time.sleep(0.6)  # one broadcast cycle (~500ms + margin)
        if latest_status and check_fn(latest_status):
            return
    # Final burst
    send_pool_command(cmd_type, param, repeat=3)


def _send_start_verified():
    _send_verified(C.CMD_START, 0,
                   lambda s: s.get("pool_state") not in ("idle", "ready"))


def _send_stop_verified():
    _send_verified(C.CMD_STOP, 0,
                   lambda s: s.get("pool_state") in ("idle", "stopping"))


def _send_speed_verified(target_pace: int):
    _send_verified(C.CMD_SET_SPEED, target_pace,
                   lambda s: s.get("speed_param") == target_pace)


def _send_timer_verified(seconds: int):
    _send_verified(C.CMD_SET_TIMER, seconds,
                   lambda s: s.get("set_timer") == seconds)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global workout_recorder
    ensure_dirs()
    workout_recorder = WorkoutRecorder()

    # Start UDP listener in background thread
    listener = threading.Thread(target=udp_listener_thread, daemon=True)
    listener.start()

    yield

    # Cleanup
    if udp_listener_sock:
        udp_listener_sock.close()
    if udp_sender_sock:
        udp_sender_sock.close()


app = FastAPI(title="Endless Pool Controller", lifespan=lifespan)

# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_websockets.append(ws)

    # Send status updates and handle commands
    try:
        send_task = asyncio.create_task(_ws_send_status(ws))
        recv_task = asyncio.create_task(_ws_receive_commands(ws))
        done, pending = await asyncio.wait(
            [send_task, recv_task], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        if ws in connected_websockets:
            connected_websockets.remove(ws)


async def _ws_send_status(ws: WebSocket):
    """Push pool status to the WebSocket client every 500ms."""
    while True:
        if latest_status:
            try:
                msg = {
                    "type": "status",
                    "data": latest_status,
                    "recording": workout_recorder.is_recording() if workout_recorder else False,
                }
                await ws.send_json(msg)
            except Exception:
                break
        await asyncio.sleep(0.5)


async def _ws_receive_commands(ws: WebSocket):
    """Receive and execute commands from the WebSocket client."""
    while True:
        try:
            msg = await ws.receive_json()
        except Exception:
            break

        msg_type = msg.get("type")
        if msg_type == "command":
            cmd = msg.get("cmd")
            value = msg.get("value", 0)
            if cmd == "start":
                threading.Thread(
                    target=_send_start_verified, daemon=True
                ).start()
            elif cmd == "stop":
                def _stop_and_finalize():
                    _send_stop_verified()
                    if workout_recorder and workout_recorder.is_recording():
                        workout = workout_recorder.finalize()
                        if workout:
                            _save_workout(workout)
                threading.Thread(
                    target=_stop_and_finalize, daemon=True
                ).start()
            elif cmd == "speed":
                threading.Thread(
                    target=_send_speed_verified,
                    args=(int(value),),
                    daemon=True,
                ).start()
            elif cmd == "timer":
                threading.Thread(
                    target=_send_timer_verified,
                    args=(int(value),),
                    daemon=True,
                ).start()
        elif msg_type == "set_user":
            user_id = msg.get("user_id")
            if workout_recorder and user_id:
                workout_recorder.set_user(user_id)
        elif msg_type == "finish_workout":
            if workout_recorder and workout_recorder.is_recording():
                workout = workout_recorder.finalize()
                if workout:
                    _save_workout(workout)


# ---------------------------------------------------------------------------
# User management helpers
# ---------------------------------------------------------------------------
def _load_users() -> List[Dict]:
    if not USERS_FILE.exists():
        return []
    with open(USERS_FILE) as f:
        return json.load(f)

def _save_users(users: List[Dict]):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)

def _hash_pin(pin: str) -> str:
    return hashlib.sha256(pin.encode()).hexdigest()

# ---------------------------------------------------------------------------
# User REST endpoints
# ---------------------------------------------------------------------------
@app.get("/api/users")
async def list_users():
    users = _load_users()
    return [{"id": u["id"], "name": u["name"], "created": u.get("created")} for u in users]

@app.post("/api/users")
async def create_user(request: Request):
    body = await request.json()
    name = body.get("name", "").strip()
    pin = body.get("pin", "")

    if not name:
        raise HTTPException(400, "Name is required")
    if not pin or len(pin) != 4 or not pin.isdigit():
        raise HTTPException(400, "PIN must be 4 digits")

    users = _load_users()
    if any(u["name"].lower() == name.lower() for u in users):
        raise HTTPException(409, "User name already exists")

    user_id = str(uuid.uuid4())[:8]
    user = {
        "id": user_id,
        "name": name,
        "pin_hash": _hash_pin(pin),
        "created": datetime.now(timezone.utc).isoformat(),
    }
    users.append(user)
    _save_users(users)

    # Create user data directory with defaults
    udir = user_dir(user_id)
    udir.mkdir(parents=True, exist_ok=True)
    (udir / "programs.json").write_text(json.dumps(_default_programs(), indent=2))
    (udir / "workouts.json").write_text("[]")
    (udir / "settings.json").write_text("{}")

    return {"id": user_id, "name": name}

@app.post("/api/users/{user_id}/login")
async def login_user(user_id: str, request: Request):
    body = await request.json()
    pin = body.get("pin", "")

    users = _load_users()
    user = next((u for u in users if u["id"] == user_id), None)
    if not user:
        raise HTTPException(404, "User not found")

    if user["pin_hash"] != _hash_pin(pin):
        raise HTTPException(401, "Invalid PIN")

    return {"id": user["id"], "name": user["name"]}

@app.delete("/api/users/{user_id}")
async def delete_user(user_id: str):
    users = _load_users()
    users = [u for u in users if u["id"] != user_id]
    _save_users(users)

    import shutil
    udir = user_dir(user_id)
    if udir.exists():
        shutil.rmtree(udir)

    return {"ok": True}

# ---------------------------------------------------------------------------
# Programs endpoints
# ---------------------------------------------------------------------------
@app.get("/api/users/{user_id}/programs")
async def get_programs(user_id: str):
    path = user_dir(user_id) / "programs.json"
    if not path.exists():
        return []
    with open(path) as f:
        return json.load(f)

@app.post("/api/users/{user_id}/programs")
async def save_program(user_id: str, request: Request):
    body = await request.json()
    path = user_dir(user_id) / "programs.json"
    path.parent.mkdir(parents=True, exist_ok=True)

    programs = []
    if path.exists():
        with open(path) as f:
            programs = json.load(f)

    # Upsert by id
    prog_id = body.get("id", str(uuid.uuid4())[:8])
    body["id"] = prog_id
    programs = [p for p in programs if p.get("id") != prog_id]
    programs.append(body)

    with open(path, "w") as f:
        json.dump(programs, f, indent=2)

    return body

@app.delete("/api/users/{user_id}/programs/{program_id}")
async def delete_program(user_id: str, program_id: str):
    path = user_dir(user_id) / "programs.json"
    if not path.exists():
        raise HTTPException(404)

    with open(path) as f:
        programs = json.load(f)
    programs = [p for p in programs if p.get("id") != program_id]
    with open(path, "w") as f:
        json.dump(programs, f, indent=2)

    return {"ok": True}

# ---------------------------------------------------------------------------
# Workouts endpoints
# ---------------------------------------------------------------------------
def _load_workouts(user_id: str) -> List[Dict]:
    path = user_dir(user_id) / "workouts.json"
    if not path.exists():
        return []
    with open(path) as f:
        return json.load(f)

def _save_workouts(user_id: str, workouts: List[Dict]):
    path = user_dir(user_id) / "workouts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(workouts, f, indent=2)

def _save_workout(workout: Dict):
    """Save a single workout (append to user's list)."""
    uid = workout.get("user_id")
    if not uid:
        return
    workouts = _load_workouts(uid)
    workouts.append(workout)
    _save_workouts(uid, workouts)

@app.get("/api/users/{user_id}/workouts")
async def get_workouts(user_id: str):
    return _load_workouts(user_id)

@app.delete("/api/users/{user_id}/workouts/{workout_id}")
async def delete_workout(user_id: str, workout_id: str):
    workouts = _load_workouts(user_id)
    workouts = [w for w in workouts if w.get("id") != workout_id]
    _save_workouts(user_id, workouts)
    return {"ok": True}

@app.get("/api/users/{user_id}/workouts/{workout_id}/export")
async def export_workout(user_id: str, workout_id: str):
    workouts = _load_workouts(user_id)
    workout = next((w for w in workouts if w.get("id") == workout_id), None)
    if not workout:
        raise HTTPException(404, "Workout not found")

    tcx_content = tcx_module.generate_tcx(workout)
    return Response(
        content=tcx_content,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="workout_{workout_id}.tcx"'},
    )

# ---------------------------------------------------------------------------
# Strava endpoints
# ---------------------------------------------------------------------------
@app.get("/api/users/{user_id}/settings")
async def get_user_settings(user_id: str):
    settings = strava_module.load_user_settings(user_id)
    # Don't expose the secret
    safe = {
        "strava_client_id": settings.get("strava_client_id", ""),
        "strava_connected": strava_module.is_connected(user_id),
    }
    return safe

@app.post("/api/users/{user_id}/settings")
async def update_user_settings(user_id: str, request: Request):
    body = await request.json()
    settings = strava_module.load_user_settings(user_id)
    if "strava_client_id" in body:
        settings["strava_client_id"] = body["strava_client_id"]
    if "strava_client_secret" in body:
        settings["strava_client_secret"] = body["strava_client_secret"]
    strava_module.save_user_settings(user_id, settings)
    return {"ok": True}

@app.get("/api/users/{user_id}/strava/auth")
async def strava_auth(user_id: str, request: Request):
    base_url = str(request.base_url).rstrip("/")
    redirect_uri = f"{base_url}/api/strava/callback"
    url = strava_module.get_auth_url(user_id, redirect_uri)
    if not url:
        raise HTTPException(400, "Strava client_id not configured. Go to Settings.")
    return {"url": url}

@app.get("/api/strava/callback")
async def strava_callback(code: str, state: str, scope: str = ""):
    """OAuth2 callback from Strava. State contains the user_id."""
    user_id = state
    try:
        await strava_module.exchange_token(user_id, code)
    except Exception as e:
        return HTMLResponse(f"<h2>Strava connection failed</h2><p>{e}</p>")

    return HTMLResponse(
        "<h2>Strava connected successfully!</h2>"
        "<p>You can close this tab and return to the app.</p>"
        "<script>setTimeout(()=>window.close(),2000)</script>"
    )

@app.post("/api/users/{user_id}/workouts/{workout_id}/strava")
async def upload_to_strava(user_id: str, workout_id: str):
    workouts = _load_workouts(user_id)
    workout = next((w for w in workouts if w.get("id") == workout_id), None)
    if not workout:
        raise HTTPException(404, "Workout not found")

    tcx_content = tcx_module.generate_tcx(workout)

    dist = workout.get("total_distance", 0)
    dur = workout.get("total_time", 0)
    name = f"Pool Swim - {dist:.0f}m in {format_timer(dur)}"

    try:
        result = await strava_module.upload_tcx(user_id, tcx_content, name)
    except Exception as e:
        raise HTTPException(500, f"Strava upload failed: {e}")

    activity_id = result.get("activity_id")
    if activity_id:
        return {
            "ok": True,
            "activity_id": activity_id,
            "url": f"https://www.strava.com/activities/{activity_id}",
        }
    elif result.get("error"):
        raise HTTPException(500, f"Strava error: {result['error']}")
    else:
        return {"ok": True, "status": "processing", "upload_id": result.get("id")}

# ---------------------------------------------------------------------------
# Default training programs
# ---------------------------------------------------------------------------
def _default_programs() -> List[Dict]:
    return [
        {
            "id": "endurance",
            "name": "Endurance Builder",
            "description": "Build aerobic base with steady swimming",
            "sections": [
                {
                    "name": "Warm-up",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
                {
                    "name": "Main Set",
                    "sets": [{"repeats": 4, "duration": 180, "pace": 130, "rest": 60, "description": "Moderate effort"}],
                },
                {
                    "name": "Cool-down",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
            ],
        },
        {
            "id": "intervals",
            "name": "Interval Training",
            "description": "Alternating fast and moderate intervals",
            "sections": [
                {
                    "name": "Warm-up",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
                {
                    "name": "Main Set",
                    "sets": [
                        {"repeats": 8, "duration": 60, "pace": 90, "rest": 30, "description": "Fast"},
                        {"repeats": 4, "duration": 120, "pace": 130, "rest": 45, "description": "Moderate"},
                    ],
                },
                {
                    "name": "Cool-down",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
            ],
        },
        {
            "id": "pyramid",
            "name": "Pyramid Workout",
            "description": "Ascending then descending interval durations",
            "sections": [
                {
                    "name": "Warm-up",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
                {
                    "name": "Main Set",
                    "sets": [
                        {"repeats": 1, "duration": 60, "pace": 120, "rest": 30, "description": "1 min"},
                        {"repeats": 1, "duration": 120, "pace": 110, "rest": 30, "description": "2 min"},
                        {"repeats": 1, "duration": 180, "pace": 100, "rest": 30, "description": "3 min"},
                        {"repeats": 1, "duration": 240, "pace": 95, "rest": 60, "description": "4 min (peak)"},
                        {"repeats": 1, "duration": 180, "pace": 100, "rest": 30, "description": "3 min"},
                        {"repeats": 1, "duration": 120, "pace": 110, "rest": 30, "description": "2 min"},
                        {"repeats": 1, "duration": 60, "pace": 120, "rest": 0, "description": "1 min"},
                    ],
                },
                {
                    "name": "Cool-down",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
            ],
        },
        {
            "id": "tempo",
            "name": "Tempo Swim",
            "description": "Sustained threshold pace effort",
            "sections": [
                {
                    "name": "Warm-up",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
                {
                    "name": "Main Set",
                    "sets": [{"repeats": 1, "duration": 1200, "pace": 110, "rest": 0, "description": "Steady threshold"}],
                },
                {
                    "name": "Cool-down",
                    "sets": [{"repeats": 1, "duration": 300, "pace": 180, "rest": 0, "description": "Easy pace"}],
                },
            ],
        },
    ]

# ---------------------------------------------------------------------------
# Static files (must be last)
# ---------------------------------------------------------------------------
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
