#!/usr/bin/env bash
# Adapter: only chooses a language. Public UI and workflow live in setup.sh.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if (( $# == 0 )); then set -- menu; fi
exec bash "$here/setup.sh" "$1" --language nodejs "${@:2}"
