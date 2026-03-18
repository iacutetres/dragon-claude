# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Start the server
npm start
# or
node server.js
```

The server runs HTTP on port **3080** and WebSocket on port **3081**. Access the UI at `http://localhost:3080`.

No build step, no tests, no linting configured.

## Architecture Overview

Dragon Claude is a **parallel Claude Code agent orchestrator** with a retro Dragon Ball Z theme. It manages multiple Claude Code instances running concurrently in terminal windows, tracks their progress in real time, and provides a ticket queue UI.

### Backend: `server.js`

Single Express file (~800 lines). Key responsibilities:

1. **Agent launching** — `launchPromptInTerminal()` uses macOS `osascript` to open Terminal windows running `claude --session-id {uuid} --permission-mode acceptEdits`. Each agent gets a Dragon Ball character persona (Goku, Vegeta, etc.).

2. **Progress tracking** — `startSessionWatcher()` uses Chokidar to watch `.claude/projects/{folder}/{uuid}.jsonl` files that Claude Code writes during sessions. `parseLine()` parses the JSON-L stream; tool invocations (Read, Write, Edit, Bash) are mapped to human-readable agent states.

3. **Ticket tag extraction** — Agents must emit `[TICKET_START]`, `[TICKET_OK]`, or `[TICKET_FAIL][FAIL]reason[/FAIL]` tags in their output. `extractTicketEvents()` parses these to track completion.

4. **WebSocket broadcast** — All connected frontend clients receive live `{agentId, feature, state, task, done, total, pct, error}` objects via port 3081.

5. **Persistence** — Per-project data lives in `projects/{name}/`:
   - `settings.json` — active config + pending ticket queue
   - `ticket-history.log` — append-only newline-delimited JSON audit log

Key API endpoints: `GET/POST /settings`, `GET /history`, `POST /launch`, `POST /improve`, `GET /sessions`, `POST /archive-tickets`.

### Frontend: `public/js/app.js`

Vanilla JavaScript (~1300 lines), no framework. State is kept in module-level variables. UI is re-rendered by explicit `render*Pane()` calls. Four tabs: **Settings**, **Tickets**, **Working**, **History**.

The WebSocket client connects to `ws://localhost:3081` and updates `liveAgentStatus` on every message, then re-renders the Working pane.

`CHAR_DATA` array defines the 12 Dragon Ball characters available as agents, including their pixel art sprite functions from `sprites.js`.

### Agent Protocol

Agents are launched with a prompt that includes:
- Their character identity and project-specific role (e.g., Goku = auth module)
- The ticket text to implement
- Mandatory instructions to emit the ticket tracking tags verbatim

The optional **Guardian-Agent** (Shenron) monitors `.claude/tasks/shared-queue.md` to coordinate changes to shared files across concurrent agents.

### macOS Dependency

`launchPromptInTerminal()` calls `osascript` to open macOS Terminal windows. The launcher scripts (`scripts/kame-kame.sh`, `scripts/kame-kame.ps1`) handle platform setup. The app is primarily designed for macOS.
