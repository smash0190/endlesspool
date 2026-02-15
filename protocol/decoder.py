"""
Packet parser and command builder for the FS FORTH-SYSTEME endless pool protocol.

Broadcast packets (111 bytes, pool → broadcast):
  [0-1]   0x0AF0 magic
  [2]     State ID (echoes last command)
  [3]     Status flags
  [4]     Running flag: 0x21=running, 0x61=stopped
  [5]     Current motor speed level (ramps toward target)
  [6]     Target motor speed level
  [7]     Pace in seconds per 100m (= speed_param from command, identity)
  [9-10]  Set timer (LE uint16, seconds)
  [11-12] Remaining timer (LE uint16, seconds)
  [23-26] Segment distance (LE float32, meters)
  [27-30] Total distance (LE float32, meters)
  [71-74] Timestamp (LE uint32, unix epoch)
  [79-91] Device name ASCII
  [107-110] CRC32

Command packets (44 bytes, client → pool):
  [0-1]   0x0AF0 magic
  [2]     Transaction ID (random)
  [3]     Command type
  [4-5]   Parameter (LE uint16)
  [6-31]  Zeros
  [32-35] Timestamp (LE uint32, unix epoch)
  [36-39] Constant 0x0000019C
  [40-43] CRC32 of bytes 0-39
"""

import binascii
import random
import struct
import time
from dataclasses import dataclass, asdict
from typing import Optional

from . import constants as C


@dataclass
class PoolStatus:
    """Parsed broadcast packet from the pool."""
    state_id: int
    status_flags: int
    is_running: bool
    current_speed: int
    target_speed: int
    speed_param: int
    set_timer: int          # seconds
    remaining_timer: int    # seconds
    segment_distance: float # meters
    total_distance: float   # meters
    timestamp: int          # unix epoch
    device_name: str
    raw: Optional[bytes] = None

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict (excludes raw bytes)."""
        d = asdict(self)
        d.pop("raw", None)
        d["current_pace"] = speed_level_to_pace(self.current_speed) if self.current_speed > 1 else None
        d["target_pace"] = speed_level_to_pace(self.target_speed) if self.target_speed > 1 else None
        # Commanded pace from the speed_param (byte 7) — most reliable
        d["commanded_pace"] = speed_param_to_pace(self.speed_param) if self.speed_param > 0 else None
        # Pool state string
        d["pool_state"] = self._derive_state()
        return d

    def _derive_state(self) -> str:
        """Derive a human-readable pool state from status_flags + running flag."""
        flags = self.status_flags
        running = self.is_running
        lower = flags & 0x0F
        transitioning = bool(flags & 0x40)

        if running and not transitioning:
            return "running"         # 0x0f / 0x21 — steady state
        if running and transitioning:
            return "running"         # 0x4f / 0x21 — just reached speed
        if not running and not transitioning and lower == 0x08:
            return "idle"            # 0x08 / 0x61 — fully stopped
        if not running and transitioning:
            if lower in (0x08,):
                return "ready"       # 0x48 / 0x61 — settings set, awaiting start
            if lower in (0x09, 0x0b):
                return "starting"    # 0x49, 0x4b / 0x61 — ramping up
            if lower == 0x0a:
                return "stopping"    # 0x4a / 0x61 — decelerating
            if lower == 0x0f:
                return "changing"    # 0x4f / 0x61 — speed change in progress
        return "idle"


def parse_broadcast(data: bytes) -> Optional[PoolStatus]:
    """Parse a 111-byte broadcast packet from the pool. Returns None if invalid."""
    if len(data) != C.BC_PACKET_SIZE:
        return None
    if data[0:2] != C.MAGIC:
        return None

    # Verify CRC32
    expected_crc = struct.unpack_from("<I", data, C.BC_CRC_OFFSET)[0]
    actual_crc = binascii.crc32(data[: C.BC_CRC_OFFSET]) & 0xFFFFFFFF
    if actual_crc != expected_crc:
        return None

    is_running = (data[C.BC_RUNNING_FLAG_OFFSET] & 0x40) == 0

    set_timer = struct.unpack_from("<H", data, C.BC_SET_TIMER_OFFSET)[0]
    rem_timer = struct.unpack_from("<H", data, C.BC_REM_TIMER_OFFSET)[0]
    seg_dist = struct.unpack_from("<f", data, C.BC_SEGMENT_DIST_OFFSET)[0]
    tot_dist = struct.unpack_from("<f", data, C.BC_TOTAL_DIST_OFFSET)[0]
    timestamp = struct.unpack_from("<I", data, C.BC_TIMESTAMP_OFFSET)[0]

    name_bytes = data[C.BC_DEVICE_NAME_OFFSET : C.BC_DEVICE_NAME_OFFSET + 13]
    device_name = name_bytes.split(b"\x00")[0].decode("ascii", errors="replace")

    return PoolStatus(
        state_id=data[C.BC_STATE_ID_OFFSET],
        status_flags=data[C.BC_STATUS_FLAGS_OFFSET],
        is_running=is_running,
        current_speed=data[C.BC_CURRENT_SPEED_OFFSET],
        target_speed=data[C.BC_TARGET_SPEED_OFFSET],
        speed_param=data[C.BC_SPEED_PARAM_OFFSET],
        set_timer=set_timer,
        remaining_timer=rem_timer,
        segment_distance=round(seg_dist, 2),
        total_distance=round(tot_dist, 2),
        timestamp=timestamp,
        device_name=device_name,
        raw=data,
    )


def build_command(cmd_type: int, param: int = 0) -> bytes:
    """
    Build a 44-byte command packet.

    Args:
        cmd_type: One of CMD_START, CMD_STOP, CMD_SET_SPEED, CMD_SET_TIMER
        param: Parameter value (timer in seconds, or pace in seconds/100m for speed)

    Returns:
        44-byte command packet ready to send via UDP.
    """
    buf = bytearray(C.CMD_PACKET_SIZE)

    # Magic header
    buf[0:2] = C.MAGIC

    # Transaction ID (random byte, pool echoes it in broadcasts)
    buf[2] = random.randint(0, 255)

    # Command type
    buf[3] = cmd_type

    # Parameter (LE uint16)
    struct.pack_into("<H", buf, 4, param & 0xFFFF)

    # Bytes 6-31: zeros (already zero from bytearray)

    # Timestamp
    struct.pack_into("<I", buf, C.CMD_TIMESTAMP_OFFSET, int(time.time()))

    # Constant
    struct.pack_into("<I", buf, C.CMD_CONSTANT_OFFSET, C.CMD_CONSTANT_VALUE)

    # CRC32 of bytes 0-39
    crc = binascii.crc32(bytes(buf[: C.CMD_CRC_OFFSET])) & 0xFFFFFFFF
    struct.pack_into("<I", buf, C.CMD_CRC_OFFSET, crc)

    return bytes(buf)


# ---------------------------------------------------------------------------
# Speed / Pace conversion
# ---------------------------------------------------------------------------
# KEY DISCOVERY: speed_param (byte 7) IS the pace in seconds per 100m.
# No calibration / interpolation needed — it's a direct 1:1 identity mapping.
# Valid range: 74 (1:14, fastest) to 243 (4:03, slowest).
#
# The motor speed level (bytes 5/6) is a separate physical value representing
# motor RPM / propeller speed.  The mapping from motor level to pace is
# non-linear but can be approximated with piecewise interpolation.

def speed_param_to_pace(param: int) -> float:
    """speed_param IS pace in seconds per 100m — identity."""
    return float(param)


def pace_to_speed_param(pace_sec: float) -> int:
    """Pace in seconds per 100m → speed_param — identity, clamped to 74-243."""
    return max(C.PACE_FASTEST_SEC, min(C.PACE_SLOWEST_SEC, int(round(pace_sec))))


def speed_level_to_pace(level: int) -> Optional[float]:
    """
    Estimate pace from the internal motor speed level (bytes 5/6).
    This is a physical measurement — higher level = faster motor = lower pace.

    Calibration data (from pcap + manufacturer app):
        level  40 → 243 s/100m  (4:03)
        level  45 → 219 s/100m  (3:39)   [pcap]
        level  51 → 194 s/100m  (3:14)
        level  61 → 162 s/100m  (2:42)   [pcap]
        level  67 → 148 s/100m  (2:28)
        level  77 → 129 s/100m  (2:09)
        level  91 → 109 s/100m  (1:49)   [pcap]
        level 180 → 74  s/100m  (1:14)
    """
    if level <= 1:
        return None

    cal = [
        (40, 243.0), (45, 219.0), (51, 194.0), (61, 162.0),
        (67, 148.0), (77, 129.0), (91, 109.0), (180, 74.0),
    ]

    if level <= cal[0][0]:
        slope = (cal[1][1] - cal[0][1]) / (cal[1][0] - cal[0][0])
        return round(cal[0][1] + slope * (level - cal[0][0]), 1)
    if level >= cal[-1][0]:
        slope = (cal[-1][1] - cal[-2][1]) / (cal[-1][0] - cal[-2][0])
        return round(cal[-1][1] + slope * (level - cal[-1][0]), 1)

    for i in range(len(cal) - 1):
        l1, p1 = cal[i]
        l2, p2 = cal[i + 1]
        if l1 <= level <= l2:
            t = (level - l1) / (l2 - l1) if l2 != l1 else 0
            return round(p1 + t * (p2 - p1), 1)

    return None


def format_pace(seconds_per_100m: float) -> str:
    """Format pace as M:SS string."""
    if seconds_per_100m is None or seconds_per_100m <= 0:
        return "--:--"
    minutes = int(seconds_per_100m) // 60
    secs = int(seconds_per_100m) % 60
    return f"{minutes}:{secs:02d}"


def format_timer(seconds: int) -> str:
    """Format timer as MM:SS string."""
    minutes = seconds // 60
    secs = seconds % 60
    return f"{minutes:02d}:{secs:02d}"
