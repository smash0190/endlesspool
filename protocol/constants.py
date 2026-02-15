"""
Protocol constants for the FS FORTH-SYSTEME endless pool controller.

The pool broadcasts UDP status packets every ~500ms and accepts UDP command packets.
Both packet types share a common 0x0AF0 magic header and use CRC32 checksums.
"""

# Network
POOL_IP = "192.168.50.232"
BROADCAST_IP = "255.255.255.255"
POOL_PORT = 9750        # Pool listens on this port
CLIENT_PORT = 45654     # Client sends from / listens on this port

# Packet magic header
MAGIC = bytes([0x0A, 0xF0])

# Command types (byte 3 of command packet)
CMD_START = 0x1F
CMD_STOP = 0x21
CMD_SET_SPEED = 0x24
CMD_SET_TIMER = 0x25

# Command packet structure (44 bytes total)
CMD_PACKET_SIZE = 44
CMD_TIMESTAMP_OFFSET = 32
CMD_CONSTANT_OFFSET = 36
CMD_CONSTANT_VALUE = 0x0000019C  # 412
CMD_CRC_OFFSET = 40

# Broadcast packet structure (111 bytes total)
BC_PACKET_SIZE = 111
BC_STATE_ID_OFFSET = 2
BC_STATUS_FLAGS_OFFSET = 3
BC_RUNNING_FLAG_OFFSET = 4
BC_CURRENT_SPEED_OFFSET = 5
BC_TARGET_SPEED_OFFSET = 6
BC_SPEED_PARAM_OFFSET = 7
BC_SET_TIMER_OFFSET = 9      # LE uint16
BC_REM_TIMER_OFFSET = 11     # LE uint16
BC_DEVICE_ID_OFFSET = 19     # 4 bytes constant
BC_SEGMENT_DIST_OFFSET = 23  # LE float32
BC_TOTAL_DIST_OFFSET = 27    # LE float32
BC_TIMESTAMP_OFFSET = 71     # LE uint32
BC_DEVICE_NAME_OFFSET = 79   # 13 bytes ASCII
BC_CRC_OFFSET = 107          # LE uint32

# Running flag values (byte 4)
RUNNING_FLAG_ACTIVE = 0x21    # Bit 6 clear = running
RUNNING_FLAG_STOPPED = 0x61   # Bit 6 set = stopped/transitioning

# Speed / Pace
# The speed parameter (byte 7) IS the pace in seconds per 100m — direct identity.
# Range: 74 (1:14/100m, fastest) to 243 (4:03/100m, slowest).
PACE_FASTEST_SEC = 74     # 1:14 per 100m in seconds
PACE_SLOWEST_SEC = 243    # 4:03 per 100m in seconds
