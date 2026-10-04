#!/bin/sh
# Static, local preflight only; never a complete report-quality approval.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$script_dir/scripts/html_preflight.py" "$@"
