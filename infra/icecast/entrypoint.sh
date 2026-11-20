#!/bin/sh
set -eu

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD is required}"
: "${ICECAST_ADMIN_PASSWORD:?ICECAST_ADMIN_PASSWORD is required}"
export ICECAST_RELAY_PASSWORD="${ICECAST_RELAY_PASSWORD:-$ICECAST_SOURCE_PASSWORD}"
export ICECAST_ADMIN_USER="${ICECAST_ADMIN_USER:-admin}"
export ICECAST_HOSTNAME="${ICECAST_HOSTNAME:-localhost}"
export ICECAST_MAX_LISTENERS="${ICECAST_MAX_LISTENERS:-500}"
export ICECAST_LOCATION="${ICECAST_LOCATION:-Earth}"
export ICECAST_ADMIN_EMAIL="${ICECAST_ADMIN_EMAIL:-admin@localhost}"

envsubst < /etc/icecast/icecast.xml.template > /tmp/icecast.xml
exec icecast -c /tmp/icecast.xml
