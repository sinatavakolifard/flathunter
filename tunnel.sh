#!/usr/bin/env bash
# Start the Cloudflare tunnel that publishes the flathunter web interface at
# https://flathunter.sinacodes.de.
#
# The web UI must already be listening on 127.0.0.1:8080 (run ./web.sh in
# another terminal first). The tunnel makes an OUTBOUND connection to
# Cloudflare — no router ports are opened, and your home IP stays hidden.
#
# Config + credentials live in ~/.cloudflared/ (flathunter.yml, <tunnel-id>.json).
# This is a separate tunnel from the easy-german one, so restarting either
# site never takes the other down.
set -euo pipefail
exec cloudflared tunnel --config "$HOME/.cloudflared/flathunter.yml" run flathunter
