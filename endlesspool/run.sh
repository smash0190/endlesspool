#!/usr/bin/with-bashio
set -e

# Read pool IP from add-on options
POOL_IP=$(bashio::config 'pool_ip')
export ENDLESSPOOL_POOL_IP="${POOL_IP}"

# Use HA's persistent /data directory for all app data
export ENDLESSPOOL_DATA_DIR="/data"
mkdir -p /data/users

cd /app
exec python3 server.py
