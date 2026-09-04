#!/usr/bin/env bash
# Serve the local flathunter web interface at http://127.0.0.1:8080
# Read-only view of listings already collected by ./run.sh
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python main.py --config config.yaml "$@"
