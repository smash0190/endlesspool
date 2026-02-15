"""
TCX (Training Center XML) file generator for swimming workouts.

Generates TCX v2 files compatible with Garmin Connect, Strava, and TrainingPeaks.
"""

import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from typing import Dict, Any


def generate_tcx(workout: Dict[str, Any]) -> str:
    """
    Generate a TCX XML string from a workout record.

    Workout format:
    {
        "id": "...",
        "user_id": "...",
        "start_time": "2024-02-15T10:30:00Z",  # ISO format
        "total_distance": 500.0,    # meters
        "total_time": 1800,         # seconds
        "intervals": [
            {
                "start_time": "2024-02-15T10:30:00Z",
                "duration": 300,        # seconds
                "distance": 150.0,      # meters
                "speed_param": 162,
                "avg_pace": 120.0,      # sec/100m
                "type": "swim"          # "swim" or "rest"
            },
            ...
        ]
    }
    """
    ns = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
    ET.register_namespace("", ns)

    root = ET.Element("TrainingCenterDatabase")
    root.set("xmlns", ns)
    root.set("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")
    root.set("xsi:schemaLocation",
             f"{ns} http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd")

    activities = ET.SubElement(root, "Activities")
    activity = ET.SubElement(activities, "Activity")
    activity.set("Sport", "Other")  # Stationary pool swimming

    start_time = workout.get("start_time", datetime.now(timezone.utc).isoformat())
    if isinstance(start_time, str):
        try:
            start_dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        except ValueError:
            start_dt = datetime.now(timezone.utc)
    else:
        start_dt = start_time

    ET.SubElement(activity, "Id").text = start_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    intervals = workout.get("intervals", [])

    if not intervals:
        # Single lap for the whole workout
        _add_lap(activity, start_dt, workout.get("total_time", 0),
                 workout.get("total_distance", 0.0))
    else:
        cumulative_dist = 0.0
        for interval in intervals:
            if interval.get("type") == "rest":
                continue

            duration = interval.get("duration", 0)
            distance = interval.get("distance", 0.0)

            int_start_str = interval.get("start_time", start_dt.isoformat())
            if isinstance(int_start_str, str):
                try:
                    int_start = datetime.fromisoformat(
                        int_start_str.replace("Z", "+00:00"))
                except ValueError:
                    int_start = start_dt
            else:
                int_start = int_start_str

            _add_lap(activity, int_start, duration, distance,
                     cumulative_dist_start=cumulative_dist)
            cumulative_dist += distance

    # Creator
    creator = ET.SubElement(activity, "Creator")
    creator.set("xsi:type", "Device_t")
    ET.SubElement(creator, "Name").text = "Endless Pool Controller"
    ET.SubElement(creator, "UnitId").text = "0"
    ET.SubElement(creator, "ProductID").text = "0"
    version = ET.SubElement(creator, "Version")
    ET.SubElement(version, "VersionMajor").text = "1"
    ET.SubElement(version, "VersionMinor").text = "0"

    tree = ET.ElementTree(root)
    import io
    buf = io.BytesIO()
    tree.write(buf, encoding="utf-8", xml_declaration=True)
    return buf.getvalue().decode("utf-8")


def _add_lap(activity: ET.Element, start_dt: datetime, duration: int,
             distance: float, cumulative_dist_start: float = 0.0):
    """Add a Lap element with trackpoints."""
    lap = ET.SubElement(activity, "Lap")
    lap.set("StartTime", start_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z"))

    ET.SubElement(lap, "TotalTimeSeconds").text = str(duration)
    ET.SubElement(lap, "DistanceMeters").text = f"{distance:.1f}"

    if duration > 0 and distance > 0:
        max_speed = distance / duration  # m/s
        ET.SubElement(lap, "MaximumSpeed").text = f"{max_speed:.3f}"

    # Rough calorie estimate: ~7 cal/min for moderate swimming
    calories = int(duration / 60 * 7)
    ET.SubElement(lap, "Calories").text = str(calories)

    ET.SubElement(lap, "Intensity").text = "Active"
    ET.SubElement(lap, "TriggerMethod").text = "Manual"

    # Generate trackpoints every 5 seconds
    track = ET.SubElement(lap, "Track")
    num_points = max(2, duration // 5 + 1)
    for i in range(num_points):
        t = min(i * 5, duration)
        tp = ET.SubElement(track, "Trackpoint")
        tp_time = start_dt + timedelta(seconds=t)
        ET.SubElement(tp, "Time").text = tp_time.strftime("%Y-%m-%dT%H:%M:%S.000Z")

        # Cumulative distance at this trackpoint
        if duration > 0:
            frac = t / duration
        else:
            frac = 0
        cum_dist = cumulative_dist_start + distance * frac
        ET.SubElement(tp, "DistanceMeters").text = f"{cum_dist:.1f}"
