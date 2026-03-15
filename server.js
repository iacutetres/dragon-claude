import express from 'express';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import cors from 'cors';
import dotenv from 'dotenv';
import chokidar from 'chokidar';
import { WebSocketServer } from 'ws';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PROJECTS_DIR = './projects';
if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR);

const sessions = {};
const wsClients = new Set();
const watchersByUuid = {};
const linesReadByUuid = {};

// ── Helpers ────────────────────────────────────────────────

function projectName(projectPath) {
  return basename(String(projectPath || '').replace(/\/$/, ''));
}

function pathToClaudeFolder(projectPath) {
  return String(projectPath || '').replace(/\//g, '-').replace(/_/g, '-');
}

function projectDirPath(projectPath) {
  return join(PROJECTS_DIR, projectName(projectPath));
}

function settingsFilePath(projectPath) {
  return join(projectDirPath(projectPath), 'settings.json');
}

function ticketHistoryFilePath(projectPath) {
  return join(projectDirPath(projectPath), 'ticket-history.log');
}

function ensureProjectDir(projectPath) {
  const dir = projectDirPath(projectPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSettings(projectPath) {
  const file = settingsFilePath(projectPath);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveSettings(settings) {
  ensureProjectDir(settings.projectPath);
  writeFileSync(settingsFilePath(settings.projectPath), JSON.stringify(settings, null, 2), 'utf8');
}

function appendTicketHistory(projectPath, tickets) {
  ensureProjectDir(projectPath);
  const file = ticketHistoryFilePath(projectPath);
  const lines = tickets.map(t => JSON.stringify({
    date: typeof t.date === 'string' && t.date ? t.date : new Date().toISOString(),
    sprint: Number.isFinite(Number(t.sprint)) ? Number(t.sprint) : null,
    agentId: t.agentId || '',
    feature: t.feature || '',
    ticketId: Number.isFinite(Number(t.ticketId)) ? Number(t.ticketId) : null,
    sessionUUID: t.sessionUUID || '',
    ticket: t.ticket || '',
  }));
  if (lines.length > 0) {
    appendFileSync(file, lines.join('\n') + '\n', 'utf8');
    console.log(`[archive] ${lines.length} tickets -> ${file}`);
  }
}

function loadTicketHistory(projectPath) {
  const file = ticketHistoryFilePath(projectPath);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function shellEscape(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function appleScriptEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildLaunchPrompt(agentFeature, tickets) {
  const header = `Usa ${agentFeature}-agent.`;
  const list = tickets
    .map((t, i) => `${i + 1}. ${String(t.execText || t.rawText || '').trim()}`)
    .join('\n');
  const rules = [
    'Reglas:',
    '- Cuando vayas a empezar un ticket escribe exactamente: [TICKET_START]nombre del ticket[/TICKET_START]',
    '- Cuando termines un ticket escribe exactamente: [TICKET_OK]nombre del ticket[/TICKET_OK]',
    '- Si algo falla escribe exactamente: [TICKET_FAIL]nombre del ticket[/TICKET_FAIL][FAIL]motivo del fallo[/FAIL]',
    '- Si hay un fallo para de trabajar y no sigas con el siguiente ticket',
  ].join('\n');

  return [
    header,
    '',
    'Tienes que completar estos tickets en orden, uno a uno:',
    '',
    list,
    '',
    rules,
  ].join('\n');
}

function launchAgentInTerminal(projectPath, feature, uuid, tickets) {
  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  const prompt = buildLaunchPrompt(feature, tickets);
  const cdCmd = `cd ${shellEscape(safePath)}`;
  const claudeCmd = `claude --session-id ${uuid} ${shellEscape(prompt)}`;
  const script = [
    'tell application "Terminal"',
    '  activate',
    `  set w to do script "${appleScriptEscape(cdCmd)}"`,
    '  delay 1',
    `  do script "${appleScriptEscape(claudeCmd)}" in w`,
    'end tell',
  ].join('\n');
  execFileSync('osascript', ['-e', script], { encoding: 'utf8' });
}

function calcPct(session) {
  if (!session || !session.total) return 0;
  return Math.round((session.done / session.total) * 100);
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  if (data?.agentId && data?.state) {
    console.log(`[ws] ${data.agentId} ${data.state} ${data.done ?? 0}/${data.total ?? 0} ${data.task ? '- ' + data.task : ''}`);
  }
  wsClients.forEach(client => {
    if (client.readyState !== 1) return;
    try { client.send(payload); } catch (_) {}
  });
}

function finalizeSession(uuid, finalState) {
  const session = sessions[uuid];
  if (!session) return;
  session.state = finalState;
  if (finalState === 'done-ok') session.done = session.total;
  if (finalState === 'done-ok') session.pct = 100;
  if (finalState !== 'done-ok') session.pct = calcPct(session);
  broadcast({
    agentId: session.agentId,
    feature: session.feature,
    state: session.state,
    task: session.task || '',
    done: session.done,
    total: session.total,
    pct: session.pct,
    error: session.error || null,
  });
  if (watchersByUuid[uuid]) {
    try { watchersByUuid[uuid].close(); } catch (_) {}
    delete watchersByUuid[uuid];
  }
}

function parseLine(uuid, line) {
  const session = sessions[uuid];
  if (!session) return;

  let obj;
  try { obj = JSON.parse(line); } catch { return; }

  // Support both legacy lines (type=assistant) and current progress envelope format.
  let assistantMsg = null;
  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    assistantMsg = obj.message;
  } else if (obj.type === 'progress') {
    const progressEnvelope = obj.data?.message?.message;
    if (progressEnvelope?.type === 'assistant' && Array.isArray(progressEnvelope.message?.content)) {
      assistantMsg = progressEnvelope.message;
    } else if (progressEnvelope?.role === 'assistant' && Array.isArray(progressEnvelope.content)) {
      assistantMsg = progressEnvelope;
    }
  }

  if (assistantMsg && Array.isArray(assistantMsg.content)) {
    assistantMsg.content.forEach(block => {
      if (block.type === 'tool_use') {
        const name = block.name;
        const input = block.input || {};

        if (name === 'Read')  { session.state = 'thinking';  session.task = `Leyendo -> ${basename(input.file_path || '')}`; }
        if (name === 'Edit')  { session.state = 'building';  session.task = `Editando -> ${basename(input.file_path || '')}`; }
        if (name === 'Write') { session.state = 'building';  session.task = `Escribiendo -> ${basename(input.file_path || '')}`; }
        if (name === 'Glob')  { session.state = 'thinking';  session.task = 'Buscando archivos...'; }
        if (name === 'Bash')  {
          const cmd = String(input.command || '');
          session.state = cmd.includes('gradlew') ? 'compiling' : 'building';
          session.task = `Bash -> ${cmd.substring(0, 40)}`;
        }

        broadcast({
          agentId: session.agentId,
          feature: session.feature,
          state: session.state,
          task: session.task,
          done: session.done,
          total: session.total,
          pct: calcPct(session),
        });
      }

      if (block.type === 'text') {
        const text = String(block.text || '');

        const startMatch = text.match(/\[TICKET_START\](.*?)\[\/TICKET_START\]/);
        if (startMatch) {
          session.state = 'building';
          session.task = startMatch[1];
          broadcast({
            agentId: session.agentId,
            feature: session.feature,
            state: 'building',
            task: session.task,
            done: session.done,
            total: session.total,
            pct: calcPct(session),
          });
        }

        const okMatch = text.match(/\[TICKET_OK\](.*?)\[\/TICKET_OK\]/);
        if (okMatch) {
          session.done = Math.min(session.done + 1, session.total);
          session.pct = calcPct(session);
          broadcast({
            agentId: session.agentId,
            feature: session.feature,
            state: 'working',
            task: okMatch[1],
            done: session.done,
            total: session.total,
            pct: session.pct,
          });
        }

        const failMatch = text.match(/\[TICKET_FAIL\](.*?)\[\/TICKET_FAIL\]/);
        const failMotivo = text.match(/\[FAIL\](.*?)\[\/FAIL\]/);
        if (failMatch) {
          session.state = 'done-fail';
          session.task = failMatch[1];
          session.error = {
            ticket: failMatch[1],
            motivo: failMotivo?.[1] || 'Error desconocido',
            timestamp: new Date().toISOString(),
          };
          session.pct = calcPct(session);
          broadcast({
            agentId: session.agentId,
            feature: session.feature,
            state: 'done-fail',
            task: failMatch[1],
            error: session.error,
            done: session.done,
            total: session.total,
            pct: session.pct,
          });
          finalizeSession(uuid, 'done-fail');
        }
      }
    });
  }

  if (assistantMsg?.stop_reason === 'end_turn' && session.done === session.total) {
    finalizeSession(uuid, 'done-ok');
  }
}

function processJsonlDelta(uuid, jsonlPath) {
  if (!existsSync(jsonlPath)) return;
  const content = readFileSync(jsonlPath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const linesRead = linesReadByUuid[uuid] || 0;
  const newLines = lines.slice(linesRead);
  linesReadByUuid[uuid] = lines.length;
  newLines.forEach(line => parseLine(uuid, line));
}

function startSessionWatcher(claudeFolder, uuid, projectPath) {
  const home = process.env.HOME || '';
  const base = `${home}/.claude/projects`;
  const candidates = Array.from(new Set([
    claudeFolder || '',
    pathToClaudeFolder(projectPath),
    String(claudeFolder || '').replace(/_/g, '-'),
    String(claudeFolder || '').replace(/-/g, '_'),
  ].filter(Boolean))).map(folder => `${base}/${folder}/${uuid}.jsonl`);

  if (watchersByUuid[uuid]) {
    try { watchersByUuid[uuid].close(); } catch (_) {}
  }
  // Start from EOF if a previous session file already exists, to avoid replaying old events.
  let baselinePath = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      baselinePath = p;
      break;
    }
  }
  if (baselinePath) {
    const baselineLines = readFileSync(baselinePath, 'utf8').split('\n').filter(Boolean).length;
    linesReadByUuid[uuid] = baselineLines;
  } else {
    linesReadByUuid[uuid] = 0;
  }

  const watcher = chokidar.watch(candidates, { persistent: true, ignoreInitial: true });
  watcher.on('add', (path) => {
    if (!linesReadByUuid[uuid]) {
      const count = readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
      linesReadByUuid[uuid] = count;
    }
  });
  watcher.on('change', (path) => processJsonlDelta(uuid, path));
  watchersByUuid[uuid] = watcher;
  console.log(`[watch] uuid=${uuid} baseline=${linesReadByUuid[uuid] || 0} paths=${candidates.join(' | ')}`);
}

function listProjects() {
  return readdirSync(PROJECTS_DIR)
    .map(name => {
      try {
        const dir = join(PROJECTS_DIR, name);
        const settingsPath = join(dir, 'settings.json');
        if (!existsSync(settingsPath)) return null;
        const data = JSON.parse(readFileSync(settingsPath, 'utf8'));
        return { name, projectPath: data.projectPath };
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

function countSettingsTickets(settingsTickets) {
  if (!Array.isArray(settingsTickets)) return 0;
  return settingsTickets.reduce((acc, group) => {
    const arr = Array.isArray(group?.tickets) ? group.tickets : [];
    return acc + arr.length;
  }, 0);
}

function removeLaunchedTicketsFromSettings(settingsTickets, approvedTickets) {
  if (!Array.isArray(settingsTickets)) return [];
  const launchedKeys = new Set(
    approvedTickets
      .map(t => {
        const createdAt = Number(t?.createdAt);
        if (!t?.agentId || !Number.isFinite(createdAt)) return null;
        return `${t.agentId}::${createdAt}`;
      })
      .filter(Boolean)
  );

  return settingsTickets
    .map(group => {
      const agentId = group?.agentId || '';
      const arr = Array.isArray(group?.tickets) ? group.tickets : [];
      const remaining = arr.filter(t => {
        const createdAt = Number(t?.createdAt);
        if (!agentId || !Number.isFinite(createdAt)) return true;
        return !launchedKeys.has(`${agentId}::${createdAt}`);
      });
      return { ...group, tickets: remaining };
    })
    .filter(group => Array.isArray(group.tickets) && group.tickets.length > 0);
}

// ── GET /projects ──────────────────────────────────────────
app.get('/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

// ── GET /settings ──────────────────────────────────────────
app.get('/settings', (req, res) => {
  const { projectPath } = req.query;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });
  console.log(`[settings:get] proyecto=${projectName(projectPath)}`);

  const settings = loadSettings(projectPath);
  if (!settings) return res.status(404).json({ error: 'Proyecto no encontrado' });

  console.log(`[settings:get] cargado -> ${settingsFilePath(projectPath)}`);
  res.json(settings);
});

// ── GET /history ─────────────────────────────────────────
app.get('/history', (req, res) => {
  const { projectPath } = req.query;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });
  const history = loadTicketHistory(projectPath);
  res.json({ history });
});

// ── GET /sessions ────────────────────────────────────────
app.get('/sessions', (_req, res) => {
  const list = Object.values(sessions).map(s => ({
    agentId: s.agentId || '',
    feature: s.feature || '',
    state: s.state || 'idle',
    task: s.task || '',
    done: Number.isFinite(Number(s.done)) ? Number(s.done) : 0,
    total: Number.isFinite(Number(s.total)) ? Number(s.total) : 0,
    pct: Number.isFinite(Number(s.pct)) ? Number(s.pct) : calcPct(s),
    error: s.error || null,
  }));
  res.json({ sessions: list });
});

// ── POST /settings ─────────────────────────────────────────
app.post('/settings', (req, res) => {
  const { projectPath, baseBranch, gradleTask, options, agents, tickets, sprintNum, claudeFolder } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });

  const settings = {
    projectPath,
    claudeFolder: claudeFolder || pathToClaudeFolder(projectPath),
    baseBranch: baseBranch || 'main',
    gradleTask:  gradleTask || 'compileDebugKotlin',
    options:     options    || {},
    agents:      agents     || [],
    tickets:     tickets    || {},
    sprintNum:   Number.isFinite(Number(sprintNum)) ? Number(sprintNum) : 1,
    updatedAt:   new Date().toISOString(),
  };

  saveSettings(settings);
  console.log(
    `[settings:save] ${projectName(projectPath)} -> ${settingsFilePath(projectPath)} ` +
    `(agents=${settings.agents.length}, tickets=${countSettingsTickets(settings.tickets)}, sprint=${settings.sprintNum})`
  );
  res.json({ ok: true, dir: projectName(projectPath), file: 'settings.json' });
});

// ── POST /archive-tickets ─────────────────────────────────
app.post('/archive-tickets', (req, res) => {
  const { projectPath, tickets } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });
  if (!Array.isArray(tickets)) return res.status(400).json({ error: 'Falta tickets[]' });

  console.log(`[archive] proyecto=${projectName(projectPath)} tickets=${tickets.length}`);
  appendTicketHistory(projectPath, tickets);
  res.json({ ok: true, archived: tickets.length, file: 'ticket-history.log' });
});

// ── POST /launch ──────────────────────────────────────────
app.post('/launch', (req, res) => {
  const { projectPath, claudeFolder, sprintNum, agents } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });
  if (!Array.isArray(agents) || agents.length === 0) {
    return res.status(400).json({ error: 'Faltan agents[]' });
  }
  if (process.platform !== 'darwin') {
    return res.status(400).json({ error: 'El launch por Terminal está soportado en macOS (osascript)' });
  }

  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  if (!existsSync(safePath)) {
    return res.status(400).json({ error: 'projectPath no existe' });
  }

  const settings = loadSettings(projectPath);
  if (!settings) {
    return res.status(404).json({ error: 'No existe settings.json para ese proyecto' });
  }

  const launchAgents = agents
    .filter(a => a && a.agentId && a.feature && a.uuid)
    .map(a => {
      const approved = Array.isArray(a.tickets)
        ? a.tickets.filter(t => t && t.approved)
        : [];
      return {
        agentId: a.agentId,
        feature: a.feature,
        uuid: a.uuid,
        tickets: approved.map(t => ({
          rawText: t.raw || '',
          execText: (t.improved || t.raw || '').trim(),
          createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now(),
        })),
      };
    })
    .filter(a => a.tickets.length > 0);
  if (launchAgents.length === 0) {
    return res.status(400).json({ error: 'No hay tickets aprobados para lanzar' });
  }

  try {
    launchAgents.forEach(a => {
      sessions[a.uuid] = {
        agentId: a.agentId,
        feature: a.feature,
        total: a.tickets.length,
        done: 0,
        state: 'idle',
        task: '',
      };

      console.log(`[launch] agente=${a.agentId} feature=${a.feature} tickets=${a.tickets.length} uuid=${a.uuid}`);
      launchAgentInTerminal(projectPath, a.feature, a.uuid, a.tickets);
      startSessionWatcher(claudeFolder || pathToClaudeFolder(projectPath), a.uuid, projectPath);

      broadcast({
        agentId: a.agentId,
        feature: a.feature,
        state: 'idle',
        task: '',
        done: 0,
        total: a.tickets.length,
        pct: 0,
      });
    });
  } catch (err) {
    console.error('[launch:error] no se pudo abrir Terminal:', err.message);
    return res.status(500).json({ error: `No se pudo lanzar agentes: ${err.message}` });
  }

  const historyItems = launchAgents.flatMap(a =>
    a.tickets.map(t => ({
      date: new Date().toISOString(),
      sprint: Number.isFinite(Number(sprintNum)) ? Number(sprintNum) : null,
      agentId: a.agentId,
      feature: a.feature,
      ticketId: null,
      sessionUUID: a.uuid,
      ticket: t.rawText || '',
    }))
  );
  appendTicketHistory(projectPath, historyItems);

  const launchedForClean = launchAgents.flatMap(a =>
    a.tickets.map(t => ({ agentId: a.agentId, createdAt: t.createdAt }))
  );
  settings.tickets = removeLaunchedTicketsFromSettings(settings.tickets, launchedForClean);
  settings.sprintNum = Number.isFinite(Number(sprintNum)) ? Number(sprintNum) + 1 : (settings.sprintNum || 1) + 1;
  settings.updatedAt = new Date().toISOString();
  saveSettings(settings);

  return res.json({
    ok: true,
    launchedAgents: launchAgents.length,
    launchedTickets: historyItems.length,
    nextSprint: settings.sprintNum,
  });
});

// ── POST /improve ──────────────────────────────────────────
// execFileSync evita command injection — el prompt va como
// argumento separado, nunca interpolado en un string de shell.
app.post('/improve', (req, res) => {
  const { projectPath, feature, ticket } = req.body;
  if (!projectPath || !feature || !ticket) {
    return res.status(400).json({ error: 'Faltan projectPath, feature o ticket' });
  }
  const ticketPreview = String(ticket).replace(/\s+/g, ' ').trim().slice(0, 120);
  console.log(`[improve] proyecto=${projectName(projectPath)} feature=${feature} ticket="${ticketPreview}"`);

  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  if (!existsSync(safePath)) {
    console.log(`[improve:error] projectPath no existe -> ${safePath}`);
    return res.status(400).json({ error: 'projectPath no existe' });
  }

  const prompt =
`Sos el agente encargado de la feature "${feature}" en un proyecto Android con Kotlin y Jetpack Compose.
Te paso el siguiente ticket en lenguaje natural:

${ticket}

Reescribilo como un ticket técnico claro y accionable para un desarrollador Android.
Sin introducción, sin explicaciones. Solo el ticket mejorado.`;

  try {
    console.log(`[improve] ejecutando claude en ${safePath}`);
    const output = execFileSync('claude', ['--print', prompt], {
      cwd:       safePath,
      timeout:   60000,
      encoding:  'utf8',
      maxBuffer: 1024 * 1024,
    });
    console.log(`[improve] completado feature=${feature}`);
    res.json({ result: output.trim() });
  } catch (err) {
    console.error('[improve:error] Error ejecutando claude:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /health ────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3080;
const WS_PORT = Number(process.env.WS_PORT || 3081);

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', ws => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

app.listen(PORT, () => {
  console.log(`Dragon Claude server corriendo en http://localhost:${PORT}`);
  console.log(`WebSocket corriendo en ws://localhost:${WS_PORT}`);
  console.log(`Proyectos en: ${PROJECTS_DIR}/`);
});
