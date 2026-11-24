# Token Monitor

Local dashboard showing token usage and estimated cost of AI coding agents (Claude Code, Antigravity, Codex), read from their local log files.

## Run

Requires Node.js (no npm install needed).

- Windows: double-click `start.bat` (opens http://localhost:8787). Close the window or run `stop.bat` to stop.
- Any OS: `npm start`

## Config

Edit `config.json`: port, THB/USD rate, daily budget, log paths, and pricing per model (USD per 1M tokens, first regex match wins).

Note: for Claude, `in` counts only non-cached input; real input = `in + cache read + cache write`.
