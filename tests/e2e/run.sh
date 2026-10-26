#!/usr/bin/env bash
# Starts the harness server, runs the headless-browser UI test, stops the server.
set -u
cd "$(dirname "$0")/../.."
OUT="${1:-/tmp/e2e-out}"
node tests/e2e/server.mjs > /tmp/e2e-server.log 2>&1 &
SRV=$!
for i in $(seq 1 40); do grep -q PORT= /tmp/e2e-server.log && break; sleep 0.25; done
PORT=$(grep -o 'PORT=[0-9]*' /tmp/e2e-server.log | cut -d= -f2)
(cd tests/e2e && python3 ui.py "$PORT" "$OUT")
RC=$?
kill $SRV 2>/dev/null
exit $RC
