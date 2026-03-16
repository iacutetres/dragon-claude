import express from 'express';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join, basename, resolve } from 'path';
import { randomUUID } from 'crypto';
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
const STALL_APPROVAL_MS = Number(process.env.STALL_APPROVAL_MS || 25000);
const GUARDIAN_AGENT_ID = 'guardian-agent';
const GUARDIAN_FEATURE = 'shared-queue';

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
  const ticketBlocks = tickets
    .map((t, i) => {
      const text = String(t.execText || t.rawText || '').trim();
      return [
        `## Ticket ${i + 1}`,
        '',
        `### Objetivo`,
        text,
        '',
        `### Ejecucion`,
        `- Implementa solo este ticket.`,
        `- Si necesitas comandos, ejecutalos.`,
        `- Si falla algo, reporta fallo y detente.`,
      ].join('\n');
    })
    .join('\n\n');



  return [
    header,
    '',
    'Tienes que completar estos tickets en orden, uno por uno:',
    '',
    ticketBlocks,
    ''
  ].join('\n');
}

function buildGuardianPrompt() {
  return [
    `Usa ${GUARDIAN_AGENT_ID}.`
  ].join('\n');
}

function launchPromptInTerminal(projectPath, uuid, prompt) {
  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  const permissionMode = process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits';
  const cdCmd = `cd ${shellEscape(safePath)}`;
  const claudeCmd = `claude --session-id ${uuid} --permission-mode ${permissionMode} ${shellEscape(prompt)}`;
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

function launchAgentInTerminal(projectPath, feature, uuid, tickets) {
  const prompt = buildLaunchPrompt(feature, tickets);
  launchPromptInTerminal(projectPath, uuid, prompt);
}

function launchGuardianInTerminal(projectPath, uuid) {
  launchPromptInTerminal(projectPath, uuid, buildGuardianPrompt());
}

function calcPct(session) {
  if (!session || !session.total) return 0;
  return Math.round((session.done / session.total) * 100);
}

function normalizeTicketTagText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractTagValues(text, tag) {
  const values = [];
  const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = normalizeTicketTagText(m[1]);
    if (value) values.push(value);
  }
  return values;
}

function extractTicketEvents(text) {
  const events = [];
  const re = /\[(TICKET_START|TICKET_OK|TICKET_FAIL)\]([\s\S]*?)\[\/\1\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = String(m[1] || '').toUpperCase();
    const value = normalizeTicketTagText(m[2]);
    if (value) events.push({ tag, value });
  }
  return events;
}

function hasApprovalSignal(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const type = String(obj.type || '').toLowerCase();
  if (type.includes('permission') || type.includes('approval')) return true;
  const dataType = String(obj.data?.type || '').toLowerCase();
  if (dataType.includes('permission') || dataType.includes('approval')) return true;
  const eventType = String(obj.data?.event?.type || '').toLowerCase();
  if (eventType.includes('permission') || eventType.includes('approval')) return true;

  const serialized = JSON.stringify(obj).toLowerCase();
  const mentionsPermission = serialized.includes('permission') || serialized.includes('approval');
  const mentionsRequest = serialized.includes('request') || serialized.includes('approve') || serialized.includes('allow');
  return mentionsPermission && mentionsRequest;
}

function hasApprovalPromptText(text) {
  const value = String(text || '');
  if (!value) return false;
  const hasYesNo = /\b(yes\/no|y\/n)\b/i.test(value);
  const hasPermissionWords = /\b(permission|approve|approval|allow)\b/i.test(value);
  return hasYesNo || hasPermissionWords;
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
  session.lastActivityAt = Date.now();
  session.stallNotified = false;

  let obj;
  try { obj = JSON.parse(line); } catch { return; }

  if (hasApprovalSignal(obj)) {
    session.state = 'awaiting-approval';
    session.task = 'Esperando aprobación en Terminal (yes/no)';
    broadcast({
      agentId: session.agentId,
      feature: session.feature,
      state: session.state,
      task: session.task,
      done: session.done,
      total: session.total,
      pct: calcPct(session),
      error: session.error || null,
    });
  }

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
        if (hasApprovalPromptText(text)) {
          session.state = 'awaiting-approval';
          session.task = 'Esperando aprobación en Terminal (yes/no)';
          broadcast({
            agentId: session.agentId,
            feature: session.feature,
            state: session.state,
            task: session.task,
            done: session.done,
            total: session.total,
            pct: calcPct(session),
            error: session.error || null,
          });
        }
        const events = extractTicketEvents(text);
        const failReasons = extractTagValues(text, 'FAIL');

        for (const event of events) {
          if (event.tag === 'TICKET_START') {
            session.state = 'building';
            session.task = event.value;
            session.openTicket = event.value;
            broadcast({
              agentId: session.agentId,
              feature: session.feature,
              state: 'building',
              task: session.task,
              done: session.done,
              total: session.total,
              pct: calcPct(session),
            });
            continue;
          }

          if (event.tag === 'TICKET_OK') {
            if (!session.openTicket) {
              console.log(`[ticket-tag] Ignorado TICKET_OK sin TICKET_START previo (${session.agentId}): ${event.value}`);
              continue;
            }
            session.done = Math.min(session.done + 1, session.total);
            session.openTicket = '';
            session.pct = calcPct(session);
            broadcast({
              agentId: session.agentId,
              feature: session.feature,
              state: 'working',
              task: event.value,
              done: session.done,
              total: session.total,
              pct: session.pct,
            });
            continue;
          }

          if (event.tag === 'TICKET_FAIL') {
            const failReason = failReasons.shift() || 'Error desconocido';
            session.state = 'done-fail';
            session.task = event.value;
            session.openTicket = '';
            session.error = {
              ticket: event.value,
              motivo: failReason,
              timestamp: new Date().toISOString(),
            };
            session.pct = calcPct(session);
            broadcast({
              agentId: session.agentId,
              feature: session.feature,
              state: 'done-fail',
              task: event.value,
              error: session.error,
              done: session.done,
              total: session.total,
              pct: session.pct,
            });
            finalizeSession(uuid, 'done-fail');
          }
        }
      }
    });
  }

  if (assistantMsg?.stop_reason === 'end_turn' && !session.isGuardian && session.done === session.total) {
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
  const { projectPath, claudeFolder, sprintNum, agents, useGuardianAgent } = req.body;
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
  const guardianEnabled = typeof useGuardianAgent === 'boolean'
    ? useGuardianAgent
    : (settings.options?.useGuardianAgent !== false);
  const guardianUuid = guardianEnabled ? randomUUID() : null;

  try {
    launchAgents.forEach(a => {
      sessions[a.uuid] = {
        agentId: a.agentId,
        feature: a.feature,
        total: a.tickets.length,
        done: 0,
        state: 'idle',
        task: '',
        openTicket: '',
        lastActivityAt: Date.now(),
        stallNotified: false,
        isGuardian: false,
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

    if (guardianEnabled && guardianUuid) {
      sessions[guardianUuid] = {
        agentId: GUARDIAN_AGENT_ID,
        feature: GUARDIAN_FEATURE,
        total: 0,
        done: 0,
        state: 'working',
        task: 'Vigilando .claude/tasks/shared-queue.md',
        openTicket: '',
        lastActivityAt: Date.now(),
        stallNotified: false,
        isGuardian: true,
      };
      console.log(`[launch] agente=${GUARDIAN_AGENT_ID} feature=${GUARDIAN_FEATURE} tickets=0 uuid=${guardianUuid}`);
      launchGuardianInTerminal(projectPath, guardianUuid);
      startSessionWatcher(claudeFolder || pathToClaudeFolder(projectPath), guardianUuid, projectPath);
      broadcast({
        agentId: GUARDIAN_AGENT_ID,
        feature: GUARDIAN_FEATURE,
        state: 'working',
        task: 'Vigilando .claude/tasks/shared-queue.md',
        done: 0,
        total: 0,
        pct: 0,
      });
    }
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
    launchedAgents: launchAgents.length + (guardianEnabled ? 1 : 0),
    launchedTickets: historyItems.length,
    nextSprint: settings.sprintNum,
    guardian: guardianEnabled && guardianUuid ? { agentId: GUARDIAN_AGENT_ID, uuid: guardianUuid } : null,
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

setInterval(() => {
  const now = Date.now();
  Object.entries(sessions).forEach(([uuid, session]) => {
    if (!session) return;
    if (session.state === 'done-ok' || session.state === 'done-fail') return;
    if ((session.done || 0) >= (session.total || 0)) return;
    if (session.stallNotified) return;
    if (!session.lastActivityAt) return;
    const elapsed = now - Number(session.lastActivityAt);
    if (elapsed < STALL_APPROVAL_MS) return;

    session.state = 'awaiting-approval';
    session.task = 'Pausa larga sin eventos. Revisa Terminal por prompt yes/no';
    session.stallNotified = true;
    broadcast({
      agentId: session.agentId,
      feature: session.feature,
      state: session.state,
      task: session.task,
      done: session.done,
      total: session.total,
      pct: calcPct(session),
      error: session.error || null,
    });
    console.log(`[watch:stall] uuid=${uuid} agente=${session.agentId} elapsedMs=${elapsed}`);
  });
}, 5000);

app.listen(PORT, () => {
  const permissionMode = process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits';
  console.log(`Dragon Claude server corriendo en http://localhost:${PORT}`);
  console.log(`WebSocket corriendo en ws://localhost:${WS_PORT}`);
  console.log(`Claude permission mode: ${permissionMode}`);
  console.log(`Stall approval detector: ${STALL_APPROVAL_MS}ms`);
  console.log(`Proyectos en: ${PROJECTS_DIR}/`);
});
