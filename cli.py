#!/usr/bin/env python3
"""
CLI tool for monitoring and controlling the endless pool.

Usage:
    python cli.py monitor                  # Listen for broadcasts and display status
    python cli.py send start               # Start the pool
    python cli.py send stop                # Stop the pool
    python cli.py send speed <value>       # Set speed (0-255, higher=slower)
    python cli.py send timer <seconds>     # Set timer in seconds
    python cli.py send pace <M:SS>         # Set speed by pace (e.g. 2:00 for 2:00/100m)
"""

import argparse
import socket
import sys

from protocol import constants as C
from protocol.decoder import (
    build_command,
    format_pace,
    format_timer,
    pace_to_speed_param,
    parse_broadcast,
    speed_param_to_pace,
)


def create_udp_listener() -> socket.socket:
    """Create a UDP socket that listens for broadcast packets on CLIENT_PORT."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("", C.CLIENT_PORT))
    sock.settimeout(2.0)
    return sock


def create_udp_sender() -> socket.socket:
    """Create a UDP socket for sending commands to the pool."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    return sock


def monitor(args):
    """Listen for pool broadcasts and display status in real-time."""
    sock = create_udp_listener()
    print(f"Listening for pool broadcasts on UDP port {C.CLIENT_PORT}...")
    print(f"Pool expected at {C.POOL_IP}\n")

    last_raw = None
    count = 0

    try:
        while True:
            try:
                data, addr = sock.recvfrom(1024)
            except socket.timeout:
                continue

            # Only process packets from pool IP (or any broadcast of right size)
            if len(data) != C.BC_PACKET_SIZE:
                continue

            status = parse_broadcast(data)
            if status is None:
                continue

            # Deduplicate (pool sends each packet twice)
            if data == last_raw:
                continue
            last_raw = data
            count += 1

            # Clear screen and print status
            print("\033[2J\033[H", end="")  # ANSI clear screen
            print(f"=== Endless Pool Monitor === (packet #{count} from {addr[0]})")
            print(f"  Device:       {status.device_name}")
            print(f"  State:        {'RUNNING' if status.is_running else 'STOPPED'}")
            print(f"  Speed:        {status.current_speed} / {status.target_speed}"
                  f"  (param: {status.speed_param})")

            if status.current_speed > 1:
                from protocol.decoder import speed_level_to_pace
                pace = speed_level_to_pace(status.current_speed)
                if pace:
                    print(f"  Pace:         ~{format_pace(pace)}/100m")

            print(f"  Timer:        {format_timer(status.remaining_timer)}"
                  f" / {format_timer(status.set_timer)}")
            print(f"  Seg Distance: {status.segment_distance:.1f} m")
            print(f"  Tot Distance: {status.total_distance:.1f} m")
            print(f"  Timestamp:    {status.timestamp}")
            print("\n  Press Ctrl+C to exit")

    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        sock.close()


def send_command(args):
    """Send a command to the pool."""
    sock = create_udp_sender()

    action = args.action
    if action == "start":
        cmd = build_command(C.CMD_START)
        desc = "START"
    elif action == "stop":
        cmd = build_command(C.CMD_STOP)
        desc = "STOP"
    elif action == "speed":
        value = int(args.value)
        if not 0 <= value <= 255:
            print("Error: Speed must be 0-255")
            sys.exit(1)
        cmd = build_command(C.CMD_SET_SPEED, value)
        pace = speed_param_to_pace(value)
        desc = f"SET SPEED {value} (~{format_pace(pace)}/100m)"
    elif action == "timer":
        value = int(args.value)
        if value <= 0:
            print("Error: Timer must be positive")
            sys.exit(1)
        cmd = build_command(C.CMD_SET_TIMER, value)
        desc = f"SET TIMER {format_timer(value)} ({value}s)"
    elif action == "pace":
        pace_str = args.value
        parts = pace_str.split(":")
        if len(parts) != 2:
            print("Error: Pace must be in M:SS format (e.g. 2:00)")
            sys.exit(1)
        pace_sec = int(parts[0]) * 60 + int(parts[1])
        param = pace_to_speed_param(pace_sec)
        cmd = build_command(C.CMD_SET_SPEED, param)
        desc = f"SET PACE {pace_str}/100m (param={param})"
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)

    target = (C.POOL_IP, C.POOL_PORT)
    sock.sendto(cmd, target)
    print(f"Sent {desc} to {target[0]}:{target[1]}")
    print(f"  Packet: {cmd.hex()}")
    sock.close()


def main():
    parser = argparse.ArgumentParser(
        description="Endless Pool CLI - monitor and control",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("monitor", help="Listen for broadcasts and display pool status")

    send_parser = sub.add_parser("send", help="Send a command to the pool")
    send_parser.add_argument(
        "action",
        choices=["start", "stop", "speed", "timer", "pace"],
        help="Command to send",
    )
    send_parser.add_argument(
        "value",
        nargs="?",
        default=None,
        help="Value for speed (0-255), timer (seconds), or pace (M:SS)",
    )

    args = parser.parse_args()

    if args.command == "monitor":
        monitor(args)
    elif args.command == "send":
        if args.action in ("speed", "timer", "pace") and args.value is None:
            print(f"Error: {args.action} requires a value")
            sys.exit(1)
        send_command(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
