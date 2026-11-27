#!/bin/sh
# Generate config.json from env and exec xray (VLESS + WS, no TLS inside
# the container — TLS is terminated by the platform's HTTPS domain /
# reverse proxy in the VLESS+WS+TLS deployment shape).
set -eu
PORT="${PORT:-8080}"
WS_PATH="${WS_PATH:-/ws}"
case "$WS_PATH" in
  /*) : ;;
  *) WS_PATH="/$WS_PATH" ;;
esac
if [ -n "${XRAY_BIN:-}" ] && [ -x "${XRAY_BIN}" ]; then
  BIN="$XRAY_BIN"
elif [ -x /usr/local/bin/xray ]; then
  BIN="/usr/local/bin/xray"
elif [ -x ./xray ]; then
  BIN="./xray"
elif command -v xray >/dev/null 2>&1; then
  BIN="$(command -v xray)"
else
  echo "[entrypoint] xray binary not found; use runtime-wrapper.sh (Route A) or the Dockerfile (Route B)" >&2
  exit 1
fi
if [ -z "${UUID:-}" ]; then
  if UUID="$("$BIN" uuid 2>/dev/null)" && [ -n "$UUID" ]; then
    :
  else
    UUID="$(cat /proc/sys/kernel/random/uuid)"
  fi
  echo "[entrypoint] UUID not set via env; generated for this run: $UUID" >&2
  echo "[entrypoint] Persist this UUID in the local credential file (0600) if you need a stable node." >&2
fi
CONFIG="${XRAY_CONFIG:-/tmp/config.json}"
cat > "$CONFIG" <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": $PORT,
      "protocol": "vless",
      "settings": {
        "clients": [ { "id": "$UUID", "flow": "" } ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "ws",
        "security": "none",
        "wsSettings": { "path": "$WS_PATH" }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls", "quic"]
      }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct",
      "settings": { "domainStrategy": "UseIPv4" } },
    { "protocol": "blackhole", "tag": "blocked" }
  ]
}
EOF
echo "[entrypoint] xray VLESS+WS listening on 0.0.0.0:$PORT path=$WS_PATH" >&2
exec "$BIN" run -config "$CONFIG"
