#!/usr/bin/env bash
# Run flathunter with the local virtualenv.
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python flathunt.py --config config.yaml "$@"
