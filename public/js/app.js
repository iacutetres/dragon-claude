// agent state
let agentCount = 5;
let agentConfig = CHAR_DATA.map((c,i) => ({
  ...c,
  feature: c.defaultFeature,
  enabled: i < 5,
}));

let tickets = {}; // charId -> [{ id, raw, improved, approved, createdAt }]
let selectedChar = null;
let selectedTicketId = null;
let ticketSeq = 1;
let improveModalState = null; // { charId, ticketId }
let sprintNum = 1;
const DEFAULT_HTTP_PORT = 3080;
const DEFAULT_WS_PORT = 3081;
const API_BASE = (window.location.protocol === 'file:' ? `http://localhost:${DEFAULT_HTTP_PORT}` : '');
const DEFAULT_BASE_BRANCH = 'main';
const DEFAULT_GRADLE_TASK = 'compileDebugKotlin';
const DEFAULT_AGENT_COUNT = 5;
let settingsLoadSeq = 0;
let savedProjects = [];
let autoSaveTimer = null;
let healthTimer = null;
let ws = null;
let wsRetryTimer = null;
let sessionPollTimer = null;
const liveAgentStatus = {};
const agentErrors = {};
let historyEntries = [];

// ══════════════════════════════════════════════
//  TABS
// ══════════════════════════════════════════════
function switchTab(name) {
  closeImproveModal();
  closeAgentErrorModal();
  document.querySelectorAll('.tab').forEach((t,i)=>{
    const tabName = t.getAttribute('data-tab') || ['settings','tickets','working','history'][i];
    t.classList.toggle('active', tabName === name);
  });
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`pane-${name}`).classList.add('active');
  if (name === 'tickets') renderTicketsPane();
  if (name === 'working') renderWorkingPane();
  if (name === 'history') {
    renderHistoryPane();
    loadHistory();
  }
}

function setHealthDot(ok) {
  const dot = document.getElementById('healthDot');
  if (!dot) return;
  dot.classList.toggle('is-online', ok);
  dot.classList.toggle('is-offline', !ok);
  dot.title = ok ? 'API online (/health)' : 'API offline (/health)';
}

function updateSprintBadge() {
  const badge = document.getElementById('sprintBadge');
  if (!badge) return;
  badge.textContent = `SPRINT #${sprintNum}`;
}

function updateServerHostBadge() {
  const el = document.getElementById('serverHostLabel');
  if (!el) return;
  if (window.location.protocol === 'file:') {
    el.textContent = `localhost:${DEFAULT_HTTP_PORT}`;
    return;
  }
  const host = window.location.hostname || 'localhost';
  const port = window.location.port || String(DEFAULT_HTTP_PORT);
  el.textContent = `${host}:${port}`;
}

function formatHistoryDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function groupHistory(entries) {
  const sprints = new Map();
  entries.forEach(item => {
    const sprintKey = Number.isFinite(Number(item.sprint)) ? Number(item.sprint) : 0;
    if (!sprints.has(sprintKey)) {
      sprints.set(sprintKey, { sprint: sprintKey, date: item.date, byAgent: new Map() });
    }
    const sprint = sprints.get(sprintKey);
    if (!sprint.date && item.date) sprint.date = item.date;
    const agentKey = `${item.agentId || 'unknown'}::${item.feature || ''}`;
    if (!sprint.byAgent.has(agentKey)) {
      sprint.byAgent.set(agentKey, {
        agentId: item.agentId || 'unknown',
        feature: item.feature || '',
        tickets: [],
      });
    }
    sprint.byAgent.get(agentKey).tickets.push(item.ticket || '');
  });

  return Array.from(sprints.values())
    .sort((a, b) => b.sprint - a.sprint)
    .map(s => ({
      ...s,
      agents: Array.from(s.byAgent.values()).sort((a, b) => a.agentId.localeCompare(b.agentId)),
    }));
}

function renderHistoryPane() {
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  if (!list || !empty) return;
  list.querySelectorAll('.h-sprint').forEach(el => el.remove());

  if (!historyEntries.length) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const grouped = groupHistory(historyEntries);
  grouped.forEach(s => {
    const box = document.createElement('div');
    box.className = 'h-sprint';
    box.innerHTML = `
      <div class="h-sprint-head">
        <div class="h-sprint-title">SPRINT #${s.sprint || '?'}</div>
        <div class="h-sprint-date">${formatHistoryDate(s.date)}</div>
      </div>
    `;
    s.agents.forEach(a => {
      const agent = document.createElement('div');
      agent.className = 'h-agent';
      agent.innerHTML = `
        <div class="h-agent-title">${a.agentId.toUpperCase()} · ${a.feature || 'sin-feature'} (${a.tickets.length})</div>
      `;
      a.tickets.forEach(t => {
        const row = document.createElement('div');
        row.className = 'h-ticket';
        row.textContent = `• ${t || '(vacío)'}`;
        agent.appendChild(row);
      });
      box.appendChild(agent);
    });
    list.appendChild(box);
  });
}

async function loadHistory(force = false) {
  const projectPath = document.getElementById('projectPath').value.trim();
  if (!projectPath) {
    historyEntries = [];
    renderHistoryPane();
    return;
  }
  if (!force && historyEntries.length && !document.getElementById('pane-history').classList.contains('active')) {
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/history?projectPath=${encodeURIComponent(projectPath)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    historyEntries = Array.isArray(data.history) ? data.history : [];
    renderHistoryPane();
  } catch (err) {
    console.error('No se pudo cargar /history:', err);
  }
}

function connectWorkingSocket() {
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsHost = (window.location.hostname || 'localhost');
  const wsPort = DEFAULT_WS_PORT;
  const wsUrl = `${wsProto}://${wsHost}:${wsPort}`;
  clearTimeout(wsRetryTimer);

  try { if (ws) ws.close(); } catch (_) {}

  try {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      clearTimeout(wsRetryTimer);
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        updateAgentCard(data);
      } catch (_) {}
    };
    ws.onclose = () => {
      wsRetryTimer = setTimeout(connectWorkingSocket, 2000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch (_) {}
    };
  } catch (err) {
    console.error('No se pudo conectar WebSocket:', err);
    wsRetryTimer = setTimeout(connectWorkingSocket, 2000);
  }
}

function upsertSessionStatusFromSnapshot(item) {
  if (!item || !item.agentId) return;
  const prev = liveAgentStatus[item.agentId] || {};
  liveAgentStatus[item.agentId] = {
    state: item.state || prev.state || 'idle',
    task: item.task || prev.task || '',
    done: Number.isFinite(Number(item.done)) ? Number(item.done) : (prev.done || 0),
    total: Number.isFinite(Number(item.total)) ? Number(item.total) : (prev.total || 0),
    pct: Number.isFinite(Number(item.pct)) ? Number(item.pct) : (prev.pct || 0),
    error: item.error || prev.error || null,
    updatedAt: Date.now(),
  };
}

async function loadSessionsSnapshot() {
  try {
    const res = await fetch(`${API_BASE}/sessions`);
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data.sessions) ? data.sessions : [];
    list.forEach(upsertSessionStatusFromSnapshot);
    if (list.length > 0) renderWorkingPane();
  } catch (_) {}
}

function startSessionsPolling() {
  loadSessionsSnapshot();
  clearInterval(sessionPollTimer);
  sessionPollTimer = setInterval(loadSessionsSnapshot, 5000);
}

function updateAgentCard(data) {
  if (!data || !data.agentId) return;
  if (data.error) agentErrors[data.agentId] = data.error;
  liveAgentStatus[data.agentId] = {
    state: data.state || 'idle',
    task: data.task || '',
    done: Number.isFinite(Number(data.done)) ? Number(data.done) : 0,
    total: Number.isFinite(Number(data.total)) ? Number(data.total) : 0,
    pct: Number.isFinite(Number(data.pct)) ? Number(data.pct) : 0,
    error: data.error || agentErrors[data.agentId] || null,
    updatedAt: Date.now(),
  };
  renderWorkingPane();
}

function closeAgentErrorModal() {
  const modal = document.getElementById('agentErrorModal');
  if (modal) modal.classList.remove('visible');
}

function openAgentErrorModal(agent) {
  const st = liveAgentStatus[agent.id];
  const err = agentErrors[agent.id] || st?.error;
  if (!err) return;
  document.getElementById('errTicket').textContent = err.ticket || '—';
  document.getElementById('errMotivo').textContent = err.motivo || 'Error desconocido';
  document.getElementById('errTimestamp').textContent = err.timestamp || '—';
  document.getElementById('errAgent').textContent = agent.name || agent.id;
  document.getElementById('errFeature').textContent = agent.feature || '—';
  document.getElementById('errDoneTotal').textContent = `${st?.done || 0} / ${st?.total || 0}`;
  document.getElementById('agentErrorModal').classList.add('visible');
}

async function checkApiHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: controller.signal });
    setHealthDot(!!res.ok);
  } catch (_) {
    setHealthDot(false);
  } finally {
    clearTimeout(timer);
  }
}

function startHealthPolling() {
  checkApiHealth();
  clearInterval(healthTimer);
  healthTimer = setInterval(checkApiHealth, 10000);
}

// ══════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════
function setAgentCount(n) {
  n = Math.max(1, Math.min(12, n));
  agentCount = n;
  document.getElementById('agentCountInput').value = n;
  agentConfig.forEach((a,i) => a.enabled = i < n);
  renderAssignGrid();
}

function toggleOpt(id) {
  const el = document.getElementById(`tog-${id}`);
  if (!el || el.classList.contains('is-disabled') || el.getAttribute('aria-disabled') === 'true') return;
  el.classList.toggle('on');
  el.nextElementSibling.textContent = el.classList.contains('on') ? 'ON' : 'OFF';
}

function isToggleOn(id) {
  return document.getElementById(id).classList.contains('on');
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  const enabled = !!on;
  el.classList.toggle('on', enabled);
  el.nextElementSibling.textContent = enabled ? 'ON' : 'OFF';
}

function defaultAgentConfig() {
  return CHAR_DATA.map((c, i) => ({
    ...c,
    feature: c.defaultFeature,
    enabled: i < DEFAULT_AGENT_COUNT,
  }));
}

function pathToClaudeFolder(projectPath) {
  return String(projectPath || '').replace(/\//g, '-').replace(/_/g, '-');
}

function generateTicketUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function getOrCreateTicketGroup(agentId, feature = '') {
  if (!tickets[agentId] || typeof tickets[agentId] !== 'object' || Array.isArray(tickets[agentId])) {
    tickets[agentId] = {
      agentId,
      feature: feature || '',
      uuid: generateTicketUUID(),
      tickets: [],
    };
  }
  if (!tickets[agentId].uuid) tickets[agentId].uuid = generateTicketUUID();
  if (feature) tickets[agentId].feature = feature;
  return tickets[agentId];
}

function resetSettingsToDefaults(keepProjectPath = true) {
  const projectInput = document.getElementById('projectPath');
  const existingPath = projectInput.value;

  if (!keepProjectPath) {
    projectInput.value = '';
  } else {
    projectInput.value = existingPath;
  }

  document.getElementById('baseBranch').value = DEFAULT_BASE_BRANCH;
  document.getElementById('gradleTask').value = DEFAULT_GRADLE_TASK;
  setToggle('tog-push', true);
  setToggle('tog-pr', true);
  setToggle('tog-stop', true);
  setToggle('tog-core', true);

  agentConfig = defaultAgentConfig();
  tickets = {};
  recomputeTicketSeq();
  sprintNum = 1;
  updateSprintBadge();
  selectedChar = null;
  selectedTicketId = null;
  historyEntries = [];
  agentCount = DEFAULT_AGENT_COUNT;
  document.getElementById('agentCountInput').value = agentCount;
  syncSavedProjectSelect(projectInput.value.trim());
  renderAssignGrid();
  renderTicketsPane();
  renderWorkingPane();
}

function renderSavedProjectsSelect(projects) {
  const select = document.getElementById('savedProjectsSelect');
  const currentValue = select.value;
  select.innerHTML = '';

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Sin seleccionar --';
  select.appendChild(emptyOpt);

  projects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.projectPath || '';
    opt.textContent = p.name || p.projectPath || '(sin nombre)';
    select.appendChild(opt);
  });

  select.value = projects.some(p => p.projectPath === currentValue) ? currentValue : '';
}

function syncSavedProjectSelect(projectPath) {
  const select = document.getElementById('savedProjectsSelect');
  const exists = savedProjects.some(p => p.projectPath === projectPath);
  select.value = exists ? projectPath : '';
}

async function loadProjectsList(preferredPath = '') {
  try {
    const res = await fetch(`${API_BASE}/projects`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    savedProjects = Array.isArray(data.projects) ? data.projects : [];
    renderSavedProjectsSelect(savedProjects);
    syncSavedProjectSelect(preferredPath || document.getElementById('projectPath').value.trim());
  } catch (err) {
    console.error('No se pudo cargar /projects:', err);
  }
}

function buildSettingsPayload() {
  const projectPath = document.getElementById('projectPath').value.trim();
  const settingsTickets = Object.values(tickets)
    .filter(group => group && typeof group === 'object')
    .map(group => {
      const agent = agentConfig.find(a => a.id === group.agentId);
      const feature = (agent?.feature || group.feature || '').trim();
      const arr = Array.isArray(group.tickets) ? group.tickets : [];
      return {
        feature,
        agentId: group.agentId,
        uuid: group.uuid || generateTicketUUID(),
        tickets: arr.map(t => ({
          raw: t.raw || '',
          improved: t.improved || '',
          approved: !!t.approved,
          createdAt: Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now(),
        })),
      };
    })
    .filter(group => group.tickets.length > 0);

  return {
    projectPath,
    claudeFolder: pathToClaudeFolder(projectPath),
    baseBranch: document.getElementById('baseBranch').value.trim() || DEFAULT_BASE_BRANCH,
    gradleTask: document.getElementById('gradleTask').value.trim() || DEFAULT_GRADLE_TASK,
    options: {
      autoPush: isToggleOn('tog-push'),
      autoPR: isToggleOn('tog-pr'),
      stopOnError: isToggleOn('tog-stop'),
      protectCore: isToggleOn('tog-core'),
    },
    agents: agentConfig.map(a => ({
      id: a.id,
      name: a.name,
      feature: (a.feature || '').trim(),
      enabled: !!a.enabled,
    })),
    tickets: settingsTickets,
    sprintNum,
  };
}

function normalizeTicketsMap(rawTickets) {
  if (!rawTickets) return {};
  const out = {};

  if (Array.isArray(rawTickets)) {
    rawTickets.forEach(group => {
      if (!group || typeof group !== 'object' || !group.agentId) return;
      const arr = Array.isArray(group.tickets) ? group.tickets : [];
      out[group.agentId] = {
        agentId: group.agentId,
        feature: typeof group.feature === 'string' ? group.feature : '',
        uuid: (typeof group.uuid === 'string' && group.uuid) ? group.uuid : generateTicketUUID(),
        tickets: arr
          .filter(t => t && typeof t === 'object')
          .map((t, idx) => {
            const createdAt = Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now() + idx;
            return {
              id: Number.isFinite(Number(t.id)) ? Number(t.id) : createdAt,
              raw: typeof t.raw === 'string' ? t.raw : '',
              improved: typeof t.improved === 'string' ? t.improved : '',
              approved: !!t.approved,
              createdAt,
            };
          }),
      };
    });
    return out;
  }

  // fallback legacy structure: { agentId: [tickets] }
  if (typeof rawTickets === 'object') {
    Object.entries(rawTickets).forEach(([charId, arr]) => {
      if (!Array.isArray(arr)) return;
      out[charId] = {
        agentId: charId,
        feature: '',
        uuid: generateTicketUUID(),
        tickets: arr
          .filter(t => t && typeof t === 'object')
          .map((t, idx) => {
            const createdAt = Number.isFinite(Number(t.createdAt)) ? Number(t.createdAt) : Date.now() + idx;
            return {
              id: Number.isFinite(Number(t.id)) ? Number(t.id) : createdAt,
              raw: typeof t.raw === 'string' ? t.raw : '',
              improved: typeof t.improved === 'string' ? t.improved : '',
              approved: !!t.approved,
              createdAt,
            };
          }),
      };
    });
  }

  return out;
}

function recomputeTicketSeq() {
  const maxId = Object.values(tickets)
    .flatMap(group => Array.isArray(group?.tickets) ? group.tickets : [])
    .reduce((mx, t) => Math.max(mx, Number(t.id) || 0), 0);
  ticketSeq = maxId + 1;
}

async function persistSettingsSilently(throwOnError = false) {
  const payload = buildSettingsPayload();
  if (!payload.projectPath) return;
  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('No se pudo guardar estado automáticamente:', err);
    if (throwOnError) throw err;
  }
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    persistSettingsSilently();
  }, 500);
}

function applyLoadedSettings(settings) {
  if (settings.projectPath) document.getElementById('projectPath').value = settings.projectPath;
  if (settings.baseBranch) document.getElementById('baseBranch').value = settings.baseBranch;
  if (settings.gradleTask) document.getElementById('gradleTask').value = settings.gradleTask;

  const options = settings.options || {};
  setToggle('tog-push', options.autoPush !== false);
  setToggle('tog-pr', options.autoPR !== false);
  setToggle('tog-stop', options.stopOnError !== false);
  setToggle('tog-core', options.protectCore !== false);

  const savedAgents = new Map((settings.agents || []).map(a => [a.id, a]));
  if (savedAgents.size > 0) {
    agentConfig = CHAR_DATA.map(char => {
      const saved = savedAgents.get(char.id);
      return {
        ...char,
        feature: saved && typeof saved.feature === 'string' ? saved.feature : char.defaultFeature,
        enabled: saved ? !!saved.enabled : false,
      };
    });
  }

  tickets = normalizeTicketsMap(settings.tickets);
  sprintNum = Number.isFinite(Number(settings.sprintNum)) && Number(settings.sprintNum) > 0
    ? Number(settings.sprintNum)
    : 1;
  updateSprintBadge();
  recomputeTicketSeq();
  selectedChar = null;
  selectedTicketId = null;
  loadHistory(true);

  agentCount = agentConfig.filter(a => a.enabled).length;
  document.getElementById('agentCountInput').value = agentCount;
  syncSavedProjectSelect(document.getElementById('projectPath').value.trim());
  renderAssignGrid();
  renderTicketsPane();
  renderWorkingPane();
}

async function loadSettingsOnStart() {
  await loadSettingsByProjectPath(document.getElementById('projectPath').value.trim());
}

async function loadSettingsByProjectPath(projectPath) {
  const reqSeq = ++settingsLoadSeq;
  if (!projectPath) {
    resetSettingsToDefaults(true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/settings?projectPath=${encodeURIComponent(projectPath)}`);
    if (reqSeq !== settingsLoadSeq) return;
    if (res.status === 404) {
      resetSettingsToDefaults(true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const settings = await res.json();
    if (reqSeq !== settingsLoadSeq) return;
    applyLoadedSettings(settings);
  } catch (err) {
    console.error('No se pudo cargar /settings:', err);
  }
}

function bindProjectPathLoadHandlers() {
  const input = document.getElementById('projectPath');
  input.addEventListener('blur', () => {
    loadSettingsByProjectPath(input.value.trim());
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    input.blur();
  });
}

function bindSavedProjectsSelectHandler() {
  const select = document.getElementById('savedProjectsSelect');
  select.addEventListener('change', () => {
    const projectPath = select.value.trim();
    if (!projectPath) return;
    document.getElementById('projectPath').value = projectPath;
    loadSettingsByProjectPath(projectPath);
  });
}

function renderAssignGrid() {
  const grid = document.getElementById('agentsAssignGrid');
  grid.innerHTML = '';
  agentConfig.forEach((a, i) => {
    const card = document.createElement('div');
    card.className = 'agent-assign-card' + (a.enabled ? ' enabled' : '');
    card.style.setProperty('--card-col', a.col);
    card.style.setProperty('--card-glow', a.glow);
    card.innerHTML = `
      <div class="aac-main">
        <div class="aac-left">
          <svg class="aac-sprite" viewBox="0 0 16 16"><use href="#${a.sprite}"/></svg>
        </div>
        <div class="aac-right">
          <span class="aac-name">${a.name}</span>
          <input class="aac-feature" placeholder="feature name" value="${a.feature}"
            oninput="agentConfig[${i}].feature=this.value">
          <div class="toggle-wrap">
            <div class="toggle ${a.enabled?'on':''}" onclick="toggleAgent(${i})"></div>
            <span class="toggle-label">${a.enabled?'ACTIVO':'OFF'}</span>
          </div>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function toggleAgent(i) {
  agentConfig[i].enabled = !agentConfig[i].enabled;
  agentCount = agentConfig.filter(a=>a.enabled).length;
  document.getElementById('agentCountInput').value = agentCount;
  renderAssignGrid();
}

async function saveSettings() {
  const btn = document.querySelector('.btn-save');
  const originalText = '▶ GUARDAR CONFIG';
  const payload = buildSettingsPayload();

  if (!payload.projectPath) {
    btn.textContent = '✗ FALTA RUTA';
    btn.style.color = 'var(--red)';
    btn.style.borderColor = 'var(--red)';
    setTimeout(() => { btn.textContent = originalText; btn.style.color = ''; btn.style.borderColor = ''; }, 1800);
    return;
  }

  btn.disabled = true;
  btn.textContent = 'GUARDANDO...';

  try {
    await persistSettingsSilently(true);
    await loadProjectsList(payload.projectPath);

    btn.textContent = '✓ GUARDADO';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
  } catch (err) {
    console.error('No se pudo guardar /settings:', err);
    btn.textContent = '✗ ERROR';
    btn.style.color = 'var(--red)';
    btn.style.borderColor = 'var(--red)';
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 2000);
  }
}

// ══════════════════════════════════════════════
//  TICKETS PANE
// ══════════════════════════════════════════════
function getActiveAgents() {
  return agentConfig.filter(a => a.enabled && a.feature);
}

function getAgentTickets(charId) {
  return getOrCreateTicketGroup(charId).tickets;
}

function findTicket(charId, ticketId) {
  return getAgentTickets(charId).find(t => t.id === ticketId) || null;
}

function getAllTickets(agents = getActiveAgents()) {
  return agents.flatMap(a => getAgentTickets(a.id));
}

function getApprovedTickets(agents = getActiveAgents()) {
  return getAllTickets(agents).filter(t => t.approved);
}

function saveCurrentDraftRaw() {
  if (!selectedChar || !selectedTicketId) return;
  const t = findTicket(selectedChar, selectedTicketId);
  if (!t) return;
  t.raw = document.getElementById('editorTextarea').value.trim();
  scheduleAutoSave();
}

function resetEditorDraft() {
  selectedTicketId = null;
  document.getElementById('editorTextarea').value = '';
}

function ensureSelectedTicket(raw) {
  let t = selectedTicketId ? findTicket(selectedChar, selectedTicketId) : null;
  if (!t) {
    const agent = agentConfig.find(c => c.id === selectedChar);
    const group = getOrCreateTicketGroup(selectedChar, agent?.feature || '');
    t = {
      id: ticketSeq++,
      raw: '',
      improved: '',
      approved: false,
      createdAt: Date.now(),
    };
    group.tickets.push(t);
    selectedTicketId = t.id;
  }
  t.raw = raw;
  scheduleAutoSave();
  return t;
}

function renderTicketsPane() {
  const activeIds = new Set(getActiveAgents().map(a => a.id));
  if (selectedChar && !activeIds.has(selectedChar)) {
    selectedChar = null;
    selectedTicketId = null;
  }
  renderAgentChips();
  renderApprovedList();
  updateLaunchStats();
  if (selectedChar) selectAgent(selectedChar, selectedTicketId);
}

function renderAgentChips() {
  const grid = document.getElementById('ticketAgentsGrid');
  const agents = getActiveAgents();
  grid.innerHTML = '';

  agents.forEach(a => {
    const agentTickets = getAgentTickets(a.id);
    const approvedCount = agentTickets.filter(t => t.approved).length;
    const isApproved = approvedCount > 0;
    const isSelected = selectedChar === a.id;

    const chip = document.createElement('div');
    chip.className = `t-agent-chip${isSelected?' selected':''}${isApproved?' approved':''}`;
    chip.style.setProperty('--chip-col', a.col);
    chip.style.setProperty('--chip-glow', a.glow);
    chip.onclick = () => selectAgent(a.id);
    chip.innerHTML = `
      <svg class="chip-sprite" viewBox="0 0 16 16"><use href="#${a.sprite}"/></svg>
      <span class="chip-name">${a.name}</span>
      <span class="chip-feature">${a.feature} · ${agentTickets.length}</span>
    `;
    grid.appendChild(chip);
  });
}

function selectAgent(charId, ticketId = null) {
  saveCurrentDraftRaw();
  selectedChar = charId;
  selectedTicketId = ticketId;
  const a = agentConfig.find(c=>c.id===charId);
  const t = (ticketId ? findTicket(charId, ticketId) : null) || { raw:'', improved:'', approved:false };

  // update editor
  const editor = document.getElementById('ticketEditor');
  editor.classList.add('visible');
  editor.style.setProperty('--sel-col', a.col);
  editor.style.setProperty('--sel-glow', a.glow);

  const sprite = document.getElementById('editorSprite');
  sprite.innerHTML = `<use href="#${a.sprite}"/>`;

  document.getElementById('editorName').textContent = a.name;
  document.getElementById('editorFeat').textContent = a.feature.toUpperCase();
  document.getElementById('editorTextarea').value = t.raw || '';

  renderAgentChips();
  renderApprovedList();
}

function skipEditor() {
  saveCurrentDraftRaw();
  selectedChar = null;
  selectedTicketId = null;
  document.getElementById('ticketEditor').classList.remove('visible');
  closeImproveModal();
  renderAgentChips();
  renderApprovedList();
}

function newTicket() {
  if (!selectedChar) return;
  resetEditorDraft();
  scheduleAutoSave();
  renderApprovedList();
}

function buildMockPrompt(agent, raw) {
  return [
    'Sos un tech lead Android.',
    `Personaje: ${agent.name}. Feature: ${agent.feature.toUpperCase()}.`,
    'Tarea: Mejorar este ticket para que sea accionable por IA sin inventar alcance.',
    'Devolvé: DESCRIPCION + CRITERIOS DE ACEPTACION (max 5).',
  ].join('\n');
}

async function improveTicket() {
  const raw = document.getElementById('editorTextarea').value.trim();
  if (!raw || !selectedChar) return;

  const projectPath = document.getElementById('projectPath').value.trim();
  if (!projectPath) return;

  const a = agentConfig.find(c=>c.id===selectedChar);
  if (!a || !a.feature) return;

  const t = ensureSelectedTicket(raw);

  const btn = document.getElementById('btnImprove');
  const dots = document.getElementById('improvingDots');

  btn.disabled = true;
  const prevDotsText = dots.textContent;
  dots.textContent = 'Pensando...';
  dots.classList.add('visible');

  try {
    const res = await fetch(`${API_BASE}/improve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath,
        feature: a.feature,
        ticket: raw,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (!data.result || typeof data.result !== 'string') {
      throw new Error('Respuesta inválida del servidor');
    }

    t.improved = data.result.trim();
    scheduleAutoSave();
    openImproveModal(a, t, raw, t.improved);
  } catch (err) {
    console.error('No se pudo ejecutar /improve:', err);
    dots.textContent = 'Error al mejorar';
    setTimeout(() => {
      dots.textContent = prevDotsText;
      dots.classList.remove('visible');
    }, 1400);
    return;
  } finally {
    btn.disabled = false;
  }

  dots.textContent = prevDotsText;
  dots.classList.remove('visible');
}

function openImproveModal(agent, ticket, raw, prompt) {
  improveModalState = { charId: agent.id, ticketId: ticket.id };
  const modal = document.getElementById('improveModal');
  modal.classList.add('visible');
  document.getElementById('modalSprite').innerHTML = `<use href="#${agent.sprite}"/>`;
  document.getElementById('modalCharName').textContent = agent.name;
  document.getElementById('modalCharFeat').textContent = agent.feature.toUpperCase();
  document.getElementById('modalRawText').textContent = raw;
  document.getElementById('modalPromptText').value = prompt;
}

function closeImproveModal() {
  improveModalState = null;
  document.getElementById('improveModal').classList.remove('visible');
}

function approveImproveModal() {
  if (!improveModalState) return;
  const t = findTicket(improveModalState.charId, improveModalState.ticketId);
  if (!t) return;
  t.improved = document.getElementById('modalPromptText').value.trim();
  t.approved = true;
  scheduleAutoSave();
  closeImproveModal();
  renderApprovedList();
  updateLaunchStats();
  renderAgentChips();
  newTicket();
}

function rejectImproveModal() {
  if (!improveModalState) return;
  const t = findTicket(improveModalState.charId, improveModalState.ticketId);
  if (t) t.approved = false;
  scheduleAutoSave();
  closeImproveModal();
  renderApprovedList();
  updateLaunchStats();
  renderAgentChips();
}

function editTicket(charId, ticketId) {
  const a = agentConfig.find(c=>c.id===charId);
  const t = findTicket(charId, ticketId);
  if (!a || !t) return;
  selectAgent(charId, ticketId);
  openImproveModal(a, t, t.raw || '', t.improved || buildMockPrompt(a, t.raw || ''));
}

function deleteTicket(charId, ticketId) {
  const arr = getAgentTickets(charId);
  const idx = arr.findIndex(t => t.id === ticketId);
  if (idx === -1) return;
  arr.splice(idx, 1);
  scheduleAutoSave();
  if (selectedChar === charId && selectedTicketId === ticketId) resetEditorDraft();
  renderApprovedList();
  renderAgentChips();
  updateLaunchStats();
}

function renderApprovedList() {
  const list = document.getElementById('approvedList');
  const empty = document.getElementById('emptyQueue');
  const agents = getActiveAgents();

  // remove old items (keep empty)
  list.querySelectorAll('.queue-group').forEach(el=>el.remove());

  if (getAllTickets(agents).length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  agents.forEach(a => {
    const arr = getAgentTickets(a.id);
    if (!arr.length) return;

    const item = document.createElement('div');
    item.className = 'queue-group';
    item.style.setProperty('--item-col', a.col);
    item.innerHTML = `
      <div class="queue-group-head">
        <svg class="item-sprite" viewBox="0 0 16 16"><use href="#${a.sprite}"/></svg>
        <div class="item-name">${a.name} · ${a.feature.toUpperCase()} (${arr.length})</div>
      </div>
      <div class="queue-ticket-list"></div>
    `;

    const inner = item.querySelector('.queue-ticket-list');
    arr.forEach(t => {
      const row = document.createElement('div');
      row.className = 'queue-ticket-row';
      const text = (t.raw || '(vacío)').replace(/\n/g, ' ');
      row.innerHTML = `
        <div class="queue-ticket-top">
          <span class="queue-ticket-state ${t.approved ? 'ok' : ''}">${t.approved ? 'APROBADO' : 'BORRADOR'}</span>
          <div class="queue-ticket-actions">
            <button class="queue-btn" onclick="editTicket('${a.id}', ${t.id})">EDITAR</button>
            <button class="queue-btn del" onclick="deleteTicket('${a.id}', ${t.id})">BORRAR</button>
          </div>
        </div>
        <div class="queue-ticket-text">${text.substring(0, 180)}</div>
      `;
      inner.appendChild(row);
    });

    list.appendChild(item);
  });
}

function updateLaunchStats() {
  const agents = getActiveAgents();
  const allTickets = getAllTickets(agents);
  const approved = allTickets.filter(t => t.approved).length;
  const total = allTickets.length;
  const pending = total - approved;
  const pct = total ? Math.round(approved/total*100) : 0;

  document.getElementById('statApproved').textContent = approved;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statPending').textContent = pending;
  document.getElementById('launchKiBar').style.width = pct + '%';
  document.getElementById('approvedCountBadge').textContent = `${approved} / ${total}`;

  document.getElementById('btnLaunch').disabled = approved === 0;
}

async function launchSprint() {
  const approved = getApprovedTickets();
  if (!approved.length) return;
  const activeAgents = getActiveAgents();
  const agentsPayload = [];

  activeAgents.forEach(a => {
    const arr = getAgentTickets(a.id);
    const approvedTickets = arr
      .filter(t => t.approved)
      .map(t => ({
        raw: t.raw || '',
        improved: t.improved || '',
        approved: true,
        createdAt: t.createdAt,
      }));
    if (!approvedTickets.length) return;
    const group = getOrCreateTicketGroup(a.id, a.feature);
    agentsPayload.push({
      agentId: a.id,
      feature: a.feature,
      uuid: group.uuid || generateTicketUUID(),
      tickets: approvedTickets,
    });
  });
  if (!agentsPayload.length) return;

  const projectPath = document.getElementById('projectPath').value.trim();
  if (!projectPath) return;

  try {
    const res = await fetch(`${API_BASE}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectPath,
        claudeFolder: pathToClaudeFolder(projectPath),
        sprintNum,
        agents: agentsPayload,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Error en /launch');
    sprintNum = Number.isFinite(Number(data.nextSprint)) ? Number(data.nextSprint) : sprintNum + 1;
    updateSprintBadge();
    await loadHistory(true);
  } catch (err) {
    console.error('No se pudo lanzar sprint:', err);
    return;
  }

  Object.keys(tickets).forEach(charId => {
    const group = tickets[charId];
    const arr = Array.isArray(group?.tickets) ? group.tickets : [];
    if (group && typeof group === 'object') {
      group.tickets = arr.filter(t => !t.approved);
    }
  });

  if (selectedChar && selectedTicketId) {
    const stillExists = findTicket(selectedChar, selectedTicketId);
    if (!stillExists) {
      selectedTicketId = null;
      document.getElementById('editorTextarea').value = '';
    }
  }

  const flash = document.getElementById('flash');
  flash.style.opacity = '.5';
  setTimeout(()=>flash.style.opacity='0', 250);

  scheduleAutoSave();
  renderTicketsPane();
  renderWorkingPane();

  setTimeout(()=>switchTab('working'), 400);
}

// ══════════════════════════════════════════════
//  WORKING PANE
// ══════════════════════════════════════════════
// Demo states
const DEMO_STATES = [
  { status:'working', task:'Implementando ViewModel y Repository pattern', pct:64,  done:4, total:6, stateLabel:'BUILDING' },
  { status:'working', task:'Configurando Hilt dependency injection', pct:31,  done:2, total:5, stateLabel:'THINKING' },
  { status:'done-ok', task:'Pantalla completada y compilada ✓',           pct:100, done:7, total:7, stateLabel:'DONE'     },
  { status:'working', task:'Integrando Stripe SDK en PaymentScreen',      pct:78,  done:5, total:8, stateLabel:'BUILDING' },
  { status:'compiling', task:'Ejecutando ./gradlew compileDebugKotlin',   pct:55,  done:3, total:6, stateLabel:'COMPILING'},
  { status:'idle',    task:'Esperando asignación de tickets',             pct:0,   done:0, total:0, stateLabel:'IDLE'     },
  { status:'done-fail', task:'Error: Unresolved reference en HomeRepo',   pct:42,  done:3, total:7, stateLabel:'KO'       },
  { status:'working', task:'Creando SettingsScreen con PreferencesDataStore', pct:19, done:1, total:4, stateLabel:'THINKING'},
  { status:'working', task:'Añadiendo dark mode toggle + persistencia',   pct:88,  done:6, total:7, stateLabel:'REVIEWING'},
];

function statusLabelFromState(state) {
  if (state === 'thinking') return 'THINKING';
  if (state === 'building') return 'BUILDING';
  if (state === 'compiling') return 'COMPILING';
  if (state === 'working') return 'WORKING';
  if (state === 'done-ok') return 'FINALIZADO';
  if (state === 'done-fail') return 'KO';
  return 'IDLE';
}

function renderWorkingPane() {
  const agents = getActiveAgents();
  const grid = document.getElementById('workingGrid');
  grid.innerHTML = '';

  const states = agents.map((a, idx) => {
    const live = liveAgentStatus[a.id];
    if (live) {
      const isDoneOk = live.state === 'done-ok';
      return {
        status: live.state || 'idle',
        task: isDoneOk
          ? 'Finalizado OK'
          : live.state === 'done-fail' && live.error?.motivo
          ? `${live.task} (${live.error.motivo})`
          : (live.task || 'Trabajando...'),
        pct: live.pct || 0,
        done: live.done || 0,
        total: live.total || 0,
        stateLabel: statusLabelFromState(live.state),
        error: live.error || null,
      };
    }
    const demo = DEMO_STATES[idx % DEMO_STATES.length];
    const agentTickets = getAgentTickets(a.id);
    const approvedCount = agentTickets.filter(t => t.approved).length;
    const hasTicket = approvedCount > 0;
    return hasTicket
      ? { ...demo, done: approvedCount, total: agentTickets.length }
      : { status:'idle', task:'Sin ticket asignado', pct:0, done:0, total:0, stateLabel:'IDLE' };
  });

  const globalDone = states.reduce((acc, st) => acc + (Number(st.done) || 0), 0);
  const globalTotal = states.reduce((acc, st) => acc + (Number(st.total) || 0), 0);
  const totalPct = globalTotal > 0 ? Math.round((globalDone / globalTotal) * 100) : 0;

  document.getElementById('wProgBar').style.width = totalPct + '%';
  document.getElementById('wProgPct').textContent = totalPct + '%';
  document.getElementById('wAgentCount').textContent = agents.length;
  document.getElementById('wSprintNum').textContent = '#' + sprintNum;

  agents.forEach((a, idx) => {
    const st = states[idx];

    const card = document.createElement('div');
    card.className = `w-card ${st.status}`;
    card.style.setProperty('--wc-col', a.col);
    card.style.setProperty('--wc-glow', a.glow);

    card.innerHTML = `
      <div class="wc-sprite-wrap">
        <svg class="wc-sprite" viewBox="0 0 16 16"><use href="#${a.sprite}"/></svg>
      </div>
      <div class="wc-info">
        <div class="wc-top">
          <div>
            <div class="wc-name">${a.name}</div>
            <div class="wc-feature">${a.feature}</div>
          </div>
          <div class="wc-status-wrap">
            <div class="wc-status-badge">${st.stateLabel}</div>
            ${st.status === 'done-fail' && st.error ? '<button class="wc-error-btn" title="Ver error">!</button>' : ''}
          </div>
        </div>
        <div class="wc-task">${st.task}</div>
        <div class="wc-pct">${st.pct}<span style="font-size:12px">%</span></div>
        <div class="wc-tickets-row">
          <span class="wc-tickets"><strong>${st.done}</strong> / ${st.total} tickets</span>
        </div>
        <div class="wc-prog-wrap" style="margin-top:6px">
          <div class="wc-prog" style="width:${st.pct}%"></div>
        </div>
      </div>
    `;
    if (st.status === 'done-fail' && st.error) {
      const btn = card.querySelector('.wc-error-btn');
      if (btn) btn.onclick = () => openAgentErrorModal(a);
    }
    grid.appendChild(card);
  });
}

// ══════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════
installDragonballSprites();
renderAssignGrid();
renderTicketsPane();
renderWorkingPane();
bindProjectPathLoadHandlers();
bindSavedProjectsSelectHandler();
loadProjectsList();
loadSettingsOnStart();
startHealthPolling();
updateSprintBadge();
connectWorkingSocket();
startSessionsPolling();
updateServerHostBadge();
