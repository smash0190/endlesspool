#!/bin/bash
set -e

# Read pool IP from add-on options
POOL_IP=$(jq -r '.pool_ip // empty' /data/options.json 2>/dev/null || true)
if [ -n "$POOL_IP" ]; then
    export ENDLESSPOOL_POOL_IP="${POOL_IP}"
fi

# Use HA's persistent /data directory for all app data
export ENDLESSPOOL_DATA_DIR="/data"
mkdir -p /data/users

cd /app
exec python3 server.py
