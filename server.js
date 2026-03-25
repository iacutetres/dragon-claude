import express from 'express';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, rmSync } from 'fs';
import { join, basename, resolve } from 'path';
import { tmpdir } from 'os';
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
    type: 'launch',
    date: typeof t.date === 'string' && t.date ? t.date : new Date().toISOString(),
    sprint: Number.isFinite(Number(t.sprint)) ? Number(t.sprint) : null,
    agentId: t.agentId || '',
    feature: t.feature || '',
    ticketId: Number.isFinite(Number(t.ticketId)) ? Number(t.ticketId) : null,
    ticketIndex: Number.isFinite(Number(t.ticketIndex)) ? Number(t.ticketIndex) : null,
    sessionUUID: t.sessionUUID || '',
    ticket: t.ticket || '',
    raw: t.raw || '',
    improved: t.improved || '',
    approved: typeof t.approved === 'boolean' ? t.approved : null,
    createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : null,
    improveUsage: t.improveUsage || null,
  }));
  if (lines.length > 0) {
    appendFileSync(file, lines.join('\n') + '\n', 'utf8');
    console.log(`[archive] ${lines.length} tickets -> ${file}`);
  }
}

function appendCompletionRecord(projectPath, sessionUUID, ticketIndex, agentUsage) {
  if (!projectPath) return;
  ensureProjectDir(projectPath);
  const file = ticketHistoryFilePath(projectPath);
  const record = JSON.stringify({
    type: 'completion',
    date: new Date().toISOString(),
    sessionUUID,
    ticketIndex,
    agentUsage,
  });
  appendFileSync(file, record + '\n', 'utf8');
}

function appendGuardianRecord(projectPath, sprintNum, agentUsage) {
  if (!projectPath) return;
  ensureProjectDir(projectPath);
  const file = ticketHistoryFilePath(projectPath);
  const record = JSON.stringify({
    type: 'guardian',
    date: new Date().toISOString(),
    sprint: sprintNum,
    agentUsage,
  });
  appendFileSync(file, record + '\n', 'utf8');
  console.log(`[guardian] sprint=${sprintNum} usage written`);
}

function loadTicketHistory(projectPath) {
  const file = ticketHistoryFilePath(projectPath);
  if (!existsSync(file)) return { tickets: [], guardianSprints: {} };
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const all = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

  // Build map: sessionUUID::ticketIndex -> agentUsage
  const completionMap = new Map();
  all.forEach(r => {
    if (r.type === 'completion' && r.sessionUUID && Number.isFinite(r.ticketIndex)) {
      completionMap.set(`${r.sessionUUID}::${r.ticketIndex}`, r.agentUsage || null);
    }
  });

  // Build guardian map: sprintNum -> agentUsage
  const guardianMap = new Map();
  all.forEach(r => {
    if (r.type === 'guardian' && Number.isFinite(r.sprint)) {
      // Accumulate if multiple guardian records for same sprint (e.g. multiple runs)
      const existing = guardianMap.get(r.sprint);
      if (existing && r.agentUsage) {
        existing.inputTokens  = (existing.inputTokens  || 0) + (r.agentUsage.inputTokens  || 0);
        existing.outputTokens = (existing.outputTokens || 0) + (r.agentUsage.outputTokens || 0);
        existing.cacheRead    = (existing.cacheRead    || 0) + (r.agentUsage.cacheRead    || 0);
      } else if (r.agentUsage) {
        guardianMap.set(r.sprint, { ...r.agentUsage });
      }
    }
  });

  // Return only launch/legacy records enriched with agentUsage, plus guardianSprints map
  const tickets = all
    .filter(r => r.type !== 'completion' && r.type !== 'guardian')
    .map(r => {
      const key = r.sessionUUID && Number.isFinite(r.ticketIndex) ? `${r.sessionUUID}::${r.ticketIndex}` : null;
      return { ...r, agentUsage: key ? (completionMap.get(key) || null) : null };
    });

  return { tickets, guardianSprints: Object.fromEntries(guardianMap) };
}

function shellEscape(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function appleScriptEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildLaunchPrompt(agentFeature, tickets) {
  const header = [
    `Usa el subagente \`${agentFeature}-agent\` definido en \`.claude/agents\`.`,
    `No uses ninguna skill llamada \`${agentFeature}-agent\`.`,
    `Si el subagente no existe, indícalo de forma explícita y detente.`,
  ].join('\n');

  const tagProtocol = [
    '## PROTOCOLO DE TAGS — OBLIGATORIO',
    '',
    'Para CADA ticket debes emitir estos tags en tu respuesta de texto, sin excepción:',
    '',
    'Al EMPEZAR el ticket:',
    `[TICKET_START]nombre exacto del ticket[/TICKET_START]`,
    '',
    'Al TERMINAR con éxito:',
    `[TICKET_OK]nombre exacto del ticket[/TICKET_OK]`,
    '',
    'Si FALLA:',
    `[TICKET_FAIL]nombre exacto del ticket[/TICKET_FAIL][FAIL]motivo concreto[/FAIL]`,
    '',
    'IMPORTANTE: emite los tags como texto plano en tu respuesta, NO dentro de bloques de código.',
    'El sistema de tracking depende de estos tags para saber el estado de cada ticket.',
  ].join('\n');

  const ticketBlocks = tickets
    .map((t, i) => {
      const text = String(t.execText || t.rawText || '').trim();
      const name = text.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 80);
      return [
        `## Ticket ${i + 1}`,
        '',
        `### Objetivo`,
        text,
        '',
        `### Ejecucion`,
        `- Emite [TICKET_START]${name}[/TICKET_START] antes de empezar.`,
        `- Implementa solo este ticket.`,
        `- Si necesitas comandos, ejecutalos.`,
        `- Si falla algo, emite [TICKET_FAIL]${name}[/TICKET_FAIL][FAIL]motivo[/FAIL] y detente.`,
        `- Al terminar con éxito, emite [TICKET_OK]${name}[/TICKET_OK].`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    header,
    '',
    tagProtocol,
    '',
    '---',
    '',
    'Completa estos tickets en orden, uno por uno:',
    '',
    ticketBlocks,
    ''
  ].join('\n');
}

function buildGuardianPrompt() {
  return [
    `Usa el subagente \`${GUARDIAN_AGENT_ID}\` definido en \`.claude/agents\`.`,
    `No uses ninguna skill llamada \`${GUARDIAN_AGENT_ID}\`.`,
    `Si el subagente no existe, indícalo de forma explícita y detente.`,
  ].join('\n');
}

function launchPromptInTerminal(projectPath, uuid, prompt) {
  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  const permissionMode = process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits';
  const launchCmd =
    `cd ${shellEscape(safePath)} && ` +
    `claude --session-id ${uuid} --permission-mode ${permissionMode} ${shellEscape(prompt)}`;
  const script = [
    'tell application "Terminal"',
    '  activate',
    `  do script "${appleScriptEscape(launchCmd)}"`,
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

function extractTicketPayload(text) {
  const events = [];
  const failReasons = [];
  let lastIndex = 0;

  const eventRe = /\[(TICKET_START|TICKET_OK|TICKET_FAIL)\]([\s\S]*?)\[\/\1\]/gi;
  let m;
  while ((m = eventRe.exec(text)) !== null) {
    const tag = String(m[1] || '').toUpperCase();
    const value = normalizeTicketTagText(m[2]);
    if (value) events.push({ tag, value });
    lastIndex = Math.max(lastIndex, eventRe.lastIndex);
  }

  const failRe = /\[FAIL\]([\s\S]*?)\[\/FAIL\]/gi;
  while ((m = failRe.exec(text)) !== null) {
    const value = normalizeTicketTagText(m[1]);
    if (value) failReasons.push(value);
    lastIndex = Math.max(lastIndex, failRe.lastIndex);
  }

  return { events, failReasons, lastIndex };
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
    // Accumulate token usage from each assistant turn (all agents including guardian)
    // usage may be at assistantMsg.usage (inside message object) or obj.usage (top-level envelope)
    const usageSrc = assistantMsg.usage || obj.usage;
    if (usageSrc) {
      session.usageAccum.inputTokens  += Number(usageSrc.input_tokens  || 0);
      session.usageAccum.outputTokens += Number(usageSrc.output_tokens || 0);
      session.usageAccum.cacheRead    += Number(usageSrc.cache_read_input_tokens || 0);
    }

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
        session.tagBuffer = `${session.tagBuffer || ''}${text}`;
        const { events, failReasons, lastIndex } = extractTicketPayload(session.tagBuffer);
        if (lastIndex > 0) {
          session.tagBuffer = session.tagBuffer.slice(lastIndex);
        } else if (session.tagBuffer.length > 4000) {
          session.tagBuffer = session.tagBuffer.slice(-2000);
        }

        for (const event of events) {
          if (event.tag === 'TICKET_START') {
            session.state = 'building';
            session.task = event.value;
            session.openTicket = event.value;
            // Snapshot usage baseline for this ticket
            if (!session.isGuardian) {
              session.ticketUsageBaseline = { ...session.usageAccum };
            }
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
            const ticketIndex = session.done - 1;
            session.openTicket = '';
            session.pct = calcPct(session);
            // Compute token delta for this ticket and persist
            if (!session.isGuardian && session.ticketUsageBaseline) {
              const baseline = session.ticketUsageBaseline;
              const agentUsage = {
                inputTokens:  session.usageAccum.inputTokens  - baseline.inputTokens,
                outputTokens: session.usageAccum.outputTokens - baseline.outputTokens,
                cacheRead:    session.usageAccum.cacheRead    - baseline.cacheRead,
              };
              appendCompletionRecord(session.projectPath, uuid, ticketIndex, agentUsage);
              session.ticketUsageBaseline = { ...session.usageAccum }; // reset for next ticket
            }
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

  if (assistantMsg?.stop_reason === 'end_turn') {
    if (!session.isGuardian && session.done === session.total) {
      finalizeSession(uuid, 'done-ok');
    } else if (session.isGuardian) {
      // Write guardian usage record for this sprint
      const hasTokens = session.usageAccum.inputTokens > 0 || session.usageAccum.outputTokens > 0;
      if (hasTokens && session.projectPath && session.sprintNum !== null) {
        appendGuardianRecord(session.projectPath, session.sprintNum, { ...session.usageAccum });
        session.usageAccum = { inputTokens: 0, outputTokens: 0, cacheRead: 0 }; // reset to avoid duplicates
      }
    }
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

// ── Platform / feature detection helpers ───────────────────

function detectPlatform(safePath) {
  const has = f => existsSync(join(safePath, f));
  if (has('build.gradle') || has('build.gradle.kts') || has('app/build.gradle') || has('app/build.gradle.kts')) {
    let hasCompose = false;
    for (const gf of [
      join(safePath, 'build.gradle'), join(safePath, 'build.gradle.kts'),
      join(safePath, 'app', 'build.gradle'), join(safePath, 'app', 'build.gradle.kts'),
    ]) {
      try { if (existsSync(gf) && readFileSync(gf, 'utf8').toLowerCase().includes('compose')) { hasCompose = true; break; } } catch {}
    }
    return hasCompose ? 'Android (Kotlin + Compose)' : 'Android (Kotlin + XML)';
  }
  if (has('Package.swift')) {
    let hasSwiftUI = false;
    try {
      const search = (dir, depth = 0) => {
        if (depth > 4 || hasSwiftUI) return;
        readdirSync(dir, { withFileTypes: true }).forEach(e => {
          if (hasSwiftUI) return;
          if (e.isDirectory() && !e.name.startsWith('.')) search(join(dir, e.name), depth + 1);
          else if (e.name.endsWith('.swift')) {
            try { if (readFileSync(join(dir, e.name), 'utf8').includes('SwiftUI')) hasSwiftUI = true; } catch {}
          }
        });
      };
      const src = join(safePath, 'Sources');
      search(existsSync(src) ? src : safePath);
    } catch {}
    return hasSwiftUI ? 'iOS (Swift + SwiftUI)' : 'iOS (Swift + UIKit)';
  }
  if (has('angular.json')) return 'Angular';
  if (has('next.config.js') || has('next.config.ts') || has('next.config.mjs')) return 'Next.js';
  if (has('pubspec.yaml')) return 'Flutter';
  if (has('pom.xml')) return 'Spring Boot (Java)';
  if (has('vite.config.js') || has('vite.config.ts')) {
    try {
      const pkg = JSON.parse(readFileSync(join(safePath, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['react'] || deps['react-dom']) return 'React';
      if (deps['vue']) return 'Vue';
    } catch {}
    return 'React';
  }
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(safePath, 'package.json'), 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['@nestjs/core']) return 'NestJS';
      if (deps['next']) return 'Next.js';
      if (deps['react'] || deps['react-dom']) return 'React';
      if (deps['vue']) return 'Vue';
    } catch {}
  }
  return '';
}

function findAndroidJavaRoot(safePath) {
  const javaBase = join(safePath, 'app', 'src', 'main', 'java');
  if (!existsSync(javaBase)) return null;
  let current = javaBase;
  for (let i = 0; i < 5; i++) {
    try {
      const dirs = readdirSync(current, { withFileTypes: true }).filter(e => e.isDirectory());
      if (dirs.length !== 1) return current;
      current = join(current, dirs[0].name);
    } catch { return current; }
  }
  return current;
}

const LAYER_DIRS = new Set(['ui', 'data', 'domain', 'presentation', 'controller', 'service',
  'repository', 'network', 'database', 'di', 'util', 'utils', 'common', 'core', 'infrastructure', 'application']);

function detectProjectStructure(safePath) {
  const featureDirNames = ['features', 'feature', 'modules', 'module'];
  const searchIn = (base) => {
    for (const name of featureDirNames) {
      const p = join(base, name);
      if (!existsSync(p)) continue;
      try {
        const subdirs = readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
        if (subdirs.length > 0) return { isFeatureBased: true, features: subdirs };
      } catch {}
    }
    return null;
  };
  for (const base of [safePath, join(safePath, 'src'), join(safePath, 'lib', 'src')]) {
    const r = searchIn(base); if (r) return r;
  }
  const androidRoot = findAndroidJavaRoot(safePath);
  if (androidRoot) {
    const r = searchIn(androidRoot); if (r) return r;
    try {
      const subdirs = readdirSync(androidRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
      if (subdirs.length > 0 && subdirs.every(d => LAYER_DIRS.has(d))) return { isFeatureBased: false, features: [], isLayerBased: true };
      const nonLayers = subdirs.filter(d => !LAYER_DIRS.has(d));
      if (nonLayers.length > 0) return { isFeatureBased: true, features: nonLayers };
    } catch {}
  }
  try {
    const SKIP = new Set(['node_modules','dist','build','.git','.gradle','gradle','vendor','target','.idea']);
    const topDirs = readdirSync(safePath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map(e => e.name);
    if (topDirs.length > 0 && topDirs.length <= 8 && topDirs.every(d => LAYER_DIRS.has(d)))
      return { isFeatureBased: false, features: [], isLayerBased: true };
  } catch {}
  return { isFeatureBased: false, features: [] };
}

const PLATFORM_STACKS = {
  'Android (Kotlin + Compose)': 'Kotlin, Jetpack Compose, Koin, Retrofit',
  'Android (Kotlin + XML)': 'Kotlin, XML layouts, ViewBinding, Koin, Retrofit',
  'iOS (Swift + SwiftUI)': 'Swift, SwiftUI, Factory/Swinject',
  'iOS (Swift + UIKit)': 'Swift, UIKit, Factory/Swinject',
  'Angular': 'TypeScript, Angular, RxJS',
  'Next.js': 'TypeScript, Next.js, React',
  'React': 'TypeScript, React, Zustand',
  'Vue': 'TypeScript, Vue 3, Pinia',
  'Spring Boot (Java)': 'Java, Spring Boot, JPA, MapStruct',
  'Flutter': 'Dart, Flutter, Riverpod',
  'NestJS': 'TypeScript, NestJS, TypeORM',
};

function buildFeatureAgentMd(feature, characterId, platform) {
  const stack = PLATFORM_STACKS[platform] || '// Define aquí el stack de tu proyecto';
  const charMap = { android17: 'ANDROIDE 17', buu: 'MAJIN BUU' };
  const charName = charMap[characterId] || characterId.toUpperCase();
  return `# ${charName} — Agente de ${feature}

## Identidad
Eres ${charName}, el guerrero encargado de la feature **${feature}**.
Stack: ${stack}

## PROTOCOLO DE TAGS — CRÍTICO

Debes emitir estos tags como **texto plano en tu respuesta**, NO dentro de bloques de código.
El sistema de tracking los parsea en tiempo real: si no los emites, el ticket se queda en estado desconocido.

**Al EMPEZAR cada ticket** (antes de escribir cualquier código):
[TICKET_START]nombre del ticket[/TICKET_START]

**Al TERMINAR con éxito** (después del último cambio):
[TICKET_OK]nombre del ticket[/TICKET_OK]

**Si FALLA por cualquier motivo**:
[TICKET_FAIL]nombre del ticket[/TICKET_FAIL][FAIL]descripción del error[/FAIL]

Reglas:
- Emite SIEMPRE el TICKET_START antes de tocar ningún archivo
- Emite SIEMPRE TICKET_OK o TICKET_FAIL al cerrar cada ticket, nunca dejes un ticket sin cerrar
- El nombre dentro de los tags debe coincidir exactamente entre START y OK/FAIL

## Responsabilidades
- Implementa únicamente los tickets asignados a la feature **${feature}**
- Si necesitas modificar archivos compartidos, añade la tarea a \`.claude/tasks/shared-queue.md\`
- No modifiques código de otras features sin coordinación con Guardian
`;
}

function buildGuardianAgentMdContent(platform) {
  const stack = PLATFORM_STACKS[platform] || '// Define aquí el stack de tu proyecto';
  return `# GUARDIAN-AGENT — Shenron, Guardián del Torneo

## Identidad
Eres SHENRON, el Guardian del Torneo Dragon Claude.
Supervisas los cambios en archivos compartidos entre todos los guerreros del proyecto.
Stack: ${stack}

## Misión
Monitorear y procesar \`.claude/tasks/shared-queue.md\` con tareas sobre archivos compartidos.

## Protocolo
1. Lee \`.claude/tasks/shared-queue.md\`
2. Procesa cada tarea pendiente realizando cambios aditivos en archivos compartidos
3. Marca cada tarea como completada
4. No destruyas código existente ni modifiques features individuales

## Notas
- Operas de forma independiente a los demás agentes
- Solo actúas sobre archivos compartidos, nunca sobre features individuales
- No emites TICKET_START/OK/FAIL — esos tags son solo para los agentes de feature
`;
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
  const { tickets, guardianSprints } = loadTicketHistory(projectPath);
  res.json({ history: tickets, guardianSprints });
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
  const { projectPath, platform, agents, tickets, sprintNum, claudeFolder } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });

  const settings = {
    projectPath,
    claudeFolder: claudeFolder || pathToClaudeFolder(projectPath),
    platform:    platform    || '',
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
          improveUsage: t.improveUsage || null,
        })),
      };
    })
    .filter(a => a.tickets.length > 0);
  if (launchAgents.length === 0) {
    return res.status(400).json({ error: 'No hay tickets aprobados para lanzar' });
  }
  const guardianUuid = randomUUID();

  try {
    launchAgents.forEach(a => {
      sessions[a.uuid] = {
        agentId: a.agentId,
        feature: a.feature,
        projectPath,
        total: a.tickets.length,
        done: 0,
        state: 'idle',
        task: '',
        openTicket: '',
        tagBuffer: '',
        lastActivityAt: Date.now(),
        stallNotified: false,
        isGuardian: false,
        usageAccum: { inputTokens: 0, outputTokens: 0, cacheRead: 0 },
        ticketUsageBaseline: null,
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

    sessions[guardianUuid] = {
      agentId: GUARDIAN_AGENT_ID,
      feature: GUARDIAN_FEATURE,
      projectPath,
      sprintNum: Number.isFinite(Number(sprintNum)) ? Number(sprintNum) : null,
      total: 0,
      done: 0,
      state: 'working',
      task: 'Vigilando .claude/tasks/shared-queue.md',
      openTicket: '',
      tagBuffer: '',
      lastActivityAt: Date.now(),
      stallNotified: false,
      isGuardian: true,
      usageAccum: { inputTokens: 0, outputTokens: 0, cacheRead: 0 },
      ticketUsageBaseline: null,
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
  } catch (err) {
    console.error('[launch:error] no se pudo abrir Terminal:', err.message);
    return res.status(500).json({ error: `No se pudo lanzar agentes: ${err.message}` });
  }

  const historyItems = launchAgents.flatMap(a =>
    a.tickets.map((t, idx) => ({
      date: new Date().toISOString(),
      sprint: Number.isFinite(Number(sprintNum)) ? Number(sprintNum) : null,
      agentId: a.agentId,
      feature: a.feature,
      ticketId: null,
      ticketIndex: idx,
      sessionUUID: a.uuid,
      ticket: t.rawText || '',
      raw: t.rawText || '',
      improved: t.execText || '',
      approved: true,
      createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : null,
      improveUsage: t.improveUsage || null,
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
    launchedAgents: launchAgents.length + 1,
    launchedTickets: historyItems.length,
    nextSprint: settings.sprintNum,
    guardian: { agentId: GUARDIAN_AGENT_ID, uuid: guardianUuid },
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

  const settings = loadSettings(projectPath);
  const platform = settings?.platform || 'mobile';

  const prompt =
`Eres el agente encargado de la feature "${feature}" en un proyecto ${platform}.
Te paso el siguiente ticket en lenguaje natural:

${ticket}

Reescribe el ticket como una especificación técnica breve y accionable para un desarrollador.
Máximo 120 palabras.
Incluye solo:
- objetivo
- cambio esperado
- criterios de aceptación (máximo 3)
No añadas introducción, explicaciones ni contexto extra.`;
  const promptChars = prompt.length;
  const promptLines = prompt.split('\n').length;
  const promptPreview = prompt.replace(/\s+/g, ' ').trim().slice(0, 220);
  console.log(
    `[improve] prompt chars=${promptChars} lines=${promptLines} cwd=${tmpdir()} preview="${promptPreview}"`
  );

  try {
    // Run in tmpdir to avoid loading any project CLAUDE.md context (reduces cache tokens)
    console.log(`[improve] ejecutando claude en tmpdir feature=${feature}`);
    const raw = execFileSync('claude', ['--print', '--output-format', 'json', prompt], {
      cwd:       tmpdir(),
      timeout:   60000,
      encoding:  'utf8',
      maxBuffer: 1024 * 1024,
    });

    let result = raw.trim();
    let usage = null;

    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed.result) result = String(parsed.result).trim();
      const u = parsed.usage || {};
      console.log(`[improve] usage raw=${JSON.stringify(u)}`);
      const inputTokens  = u.input_tokens  ?? u.inputTokens  ?? null;
      const outputTokens = u.output_tokens ?? u.outputTokens ?? null;
      const cacheRead    = u.cache_read_input_tokens ?? null;
      const cacheWrite   = u.cache_creation_input_tokens ?? null;
      const costUsd      = parsed.total_cost_usd ?? parsed.cost_usd ?? null;
      if (inputTokens !== null || outputTokens !== null) {
        usage = { inputTokens, outputTokens, cacheRead, cacheWrite, costUsd };
      }
    } catch {
      // claude devolvió texto plano (versión sin --output-format json)
      result = raw.trim();
    }

    console.log(`[improve] completado feature=${feature} usage=${JSON.stringify(usage)}`);
    res.json({ result, usage });
  } catch (err) {
    console.error('[improve:error] Error ejecutando claude:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /project ───────────────────────────────────────
app.delete('/project', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });

  const dir = projectDirPath(projectPath);
  if (!existsSync(dir)) return res.status(404).json({ error: 'Proyecto no encontrado' });

  const name = projectName(projectPath);
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log(`[delete-project] Borrado ${dir}`);
    res.json({ ok: true, deleted: name });
  } catch (err) {
    console.error('[delete-project:error]', err.message);
    res.status(500).json({ error: `No se pudo borrar: ${err.message}` });
  }
});

// ── POST /analyze-project ──────────────────────────────────
const DIR_SKIP = new Set(['node_modules','.git','build','dist','.gradle','gradle',
  'vendor','target','.idea','Pods','.dart_tool','.pub-cache','__pycache__','.DS_Store',
  'xcuserdata','.symlinks','generated','gen','.fvm']);

function buildDirSnapshot(basePath, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth) return [];
  try {
    const entries = readdirSync(basePath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !DIR_SKIP.has(e.name))
      .slice(0, 25);
    return entries.map(e => ({
      name: e.name,
      children: buildDirSnapshot(join(basePath, e.name), depth + 1, maxDepth),
    }));
  } catch { return []; }
}

app.post('/analyze-project', (req, res) => {
  const { projectPath, featuresPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });

  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  if (!existsSync(safePath)) return res.status(400).json({ error: 'La ruta del proyecto no existe' });

  const platform = detectPlatform(safePath);

  // ── Modo carpeta manual ──────────────────────────────────
  if (featuresPath) {
    const fullFeaturesPath = resolve(join(safePath, featuresPath));
    if (!existsSync(fullFeaturesPath)) {
      return res.status(400).json({ error: `Carpeta no encontrada: ${featuresPath}` });
    }
    let subdirs = [];
    try {
      subdirs = readdirSync(fullFeaturesPath, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && !DIR_SKIP.has(e.name))
        .map(e => e.name);
    } catch {}

    const agentsDir = join(safePath, '.claude', 'agents');
    const existingAgents = new Set();
    if (existsSync(agentsDir)) {
      try { readdirSync(agentsDir).forEach(f => { if (f.endsWith('.md')) existingAgents.add(f.replace('.md', '')); }); } catch {}
    }
    const chars = ['goku','vegeta','gohan','piccolo','krillin','trunks','bulma','frieza','beerus','android17','cell','buu'];
    const features = subdirs.slice(0, 12).map((name, i) => ({
      name,
      hasAgent: existingAgents.has(`${name}-agent`) || existingAgents.has(name),
      assignedCharacter: chars[i % chars.length],
    }));

    console.log(`[analyze-project] featuresPath=${featuresPath} features=${features.length}`);
    return res.json({ platform, isFeatureBased: true, error: null, features, needsHint: false, dirSnapshot: null });
  }

  // ── Detección automática ─────────────────────────────────
  const structure = detectProjectStructure(safePath);

  if (structure.isLayerBased) {
    return res.status(400).json({
      error: 'Este proyecto no puede participar en el Torneo.\nReorganízalo por features primero.',
    });
  }

  const agentsDir = join(safePath, '.claude', 'agents');
  const existingAgents = new Set();
  if (existsSync(agentsDir)) {
    try { readdirSync(agentsDir).forEach(f => { if (f.endsWith('.md')) existingAgents.add(f.replace('.md', '')); }); } catch {}
  }

  const chars = ['goku','vegeta','gohan','piccolo','krillin','trunks','bulma','frieza','beerus','android17','cell','buu'];
  const rawFeatures = structure.features || [];
  const features = rawFeatures.slice(0, 12).map((name, i) => ({
    name,
    hasAgent: existingAgents.has(`${name}-agent`) || existingAgents.has(name),
    assignedCharacter: chars[i % chars.length],
  }));

  const needsHint = features.length <= 2;
  const dirSnapshot = needsHint ? buildDirSnapshot(safePath) : null;

  console.log(`[analyze-project] path=${projectName(projectPath)} platform="${platform}" features=${features.length} needsHint=${needsHint}`);
  res.json({ platform, isFeatureBased: structure.isFeatureBased, error: null, features, needsHint, dirSnapshot });
});

// ── POST /generate-agents ──────────────────────────────────
app.post('/generate-agents', (req, res) => {
  const { projectPath, platform, agents } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'Falta projectPath' });

  const safePath = resolve(projectPath.replace(/^~/, process.env.HOME));
  if (!existsSync(safePath)) return res.status(400).json({ error: 'La ruta del proyecto no existe' });

  const agentsDir = join(safePath, '.claude', 'agents');
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  const generated = [];
  const platformStr = String(platform || '');

  if (Array.isArray(agents)) {
    agents.forEach(({ feature, characterId }) => {
      if (!feature || !characterId) return;
      const content = buildFeatureAgentMd(String(feature), String(characterId), platformStr);
      const fileName = `${feature}-agent.md`;
      writeFileSync(join(agentsDir, fileName), content, 'utf8');
      generated.push(fileName);
      console.log(`[generate-agents] ${fileName}`);
    });
  }

  const guardianContent = buildGuardianAgentMdContent(platformStr);
  writeFileSync(join(agentsDir, 'guardian-agent.md'), guardianContent, 'utf8');
  generated.push('guardian-agent.md');
  console.log(`[generate-agents] guardian-agent.md`);

  res.json({ ok: true, generated });
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
