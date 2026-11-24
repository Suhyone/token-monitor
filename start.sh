#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node --expose-gc --max-semi-space-size=1 --optimize-for-size --jitless server.js "$@"
