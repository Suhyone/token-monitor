# Token Monitor

Zero-config local dashboard showing token usage, daily volume, per-question token breakdown, and 7-day request history across AI coding agents.

## Auto-detected AI Providers

Automatically detects local logs when you use:
- **Claude Code** (`~/.claude/projects`, `~/.config/claude/projects`, `$CLAUDE_CONFIG_DIR`)
- **Antigravity** (`~/.gemini/antigravity/brain`, `~/.gemini/jetski/brain`)
- **OpenAI Codex CLI** (`~/.codex/sessions`, `$CODEX_HOME`)
- **Google Gemini CLI** (`~/.gemini/tmp/*/chats/*.json`)
- **OpenCode** (`~/.local/share/opencode/storage/message`)
- **Cline / Roo Code** (VS Code globalStorage)
- **Proxy fallback** (`--proxy=PORT` for any OpenAI/Anthropic/Gemini-compatible tool)

## Run (Zero-Config)

Requires Node.js (no `npm install` needed):

- **Windows**: double-click `start.bat` (opens http://localhost:8787)
- **macOS / Linux**: `./start.sh` or `npm start`

## Features

- **6-Minute Resolution Chart** with hover time window (`HH:MM - HH:MM`), Tokens / Requests / Cost switcher
- **Daily Volume Table** (14 days) with Input / Output / Cache Read / Cache Write breakdown
- **Per-Question Tracking** (groups all tool calls from prompt to final output, merging interrupting follow-up questions)
- **7-Day Request History** with day/provider/search filters and automatic gradual pruning after 7 days
