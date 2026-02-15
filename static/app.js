/* ===== Endless Pool Controller - Frontend ===== */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentUser = null;    // {id, name}
let ws = null;             // WebSocket
let poolStatus = null;     // Latest pool status from server
let programs = [];         // User's programs
let workouts = [];         // User's workouts
let editingProgram = null; // Program being edited
let runningProgram = null; // Program execution state
let runnerTimer = null;    // setInterval for runner countdown

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    const saved = localStorage.getItem('ep_user');
    if (saved) {
        try {
            currentUser = JSON.parse(saved);
            showApp();
        } catch {
            localStorage.removeItem('ep_user');
            loadUsers();
        }
    } else {
        loadUsers();
    }
});

// ---------------------------------------------------------------------------
// Login / Users
// ---------------------------------------------------------------------------
async function loadUsers() {
    try {
        const resp = await fetch('/api/users');
        const users = await resp.json();
        renderUserGrid(users);
    } catch {
        renderUserGrid([]);
    }
}

function renderUserGrid(users) {
    const grid = document.getElementById('user-grid');
    grid.innerHTML = users.map(u => `
        <div class="user-card" onclick="showPinEntry('${u.id}', '${esc(u.name)}')">
            <div class="user-avatar">${u.name.charAt(0).toUpperCase()}</div>
            <span>${esc(u.name)}</span>
        </div>
    `).join('');
}

let pinUserId = '';
let pinBuffer = '';

function showPinEntry(userId, name) {
    pinUserId = userId;
    pinBuffer = '';
    document.getElementById('pin-user-name').textContent = name;
    document.getElementById('pin-error').classList.add('hidden');
    updatePinDots();
    document.getElementById('pin-overlay').classList.remove('hidden');
}

function closePinOverlay() {
    document.getElementById('pin-overlay').classList.add('hidden');
    pinBuffer = '';
}

function pinInput(digit) {
    if (pinBuffer.length >= 4) return;
    pinBuffer += digit;
    updatePinDots();
    if (pinBuffer.length === 4) {
        attemptLogin(pinUserId, pinBuffer);
    }
}

function pinDelete() {
    pinBuffer = pinBuffer.slice(0, -1);
    document.getElementById('pin-error').classList.add('hidden');
    updatePinDots();
}

function updatePinDots() {
    document.querySelectorAll('.pin-dots .dot').forEach((dot, i) => {
        dot.classList.toggle('filled', i < pinBuffer.length);
    });
}

async function attemptLogin(userId, pin) {
    try {
        const resp = await fetch(`/api/users/${userId}/login`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({pin}),
        });
        if (resp.ok) {
            const user = await resp.json();
            currentUser = user;
            localStorage.setItem('ep_user', JSON.stringify(user));
            closePinOverlay();
            showApp();
        } else {
            document.getElementById('pin-error').classList.remove('hidden');
            pinBuffer = '';
            updatePinDots();
        }
    } catch {
        document.getElementById('pin-error').classList.remove('hidden');
        pinBuffer = '';
        updatePinDots();
    }
}

function showCreateUser() {
    document.getElementById('new-user-name').value = '';
    document.getElementById('new-user-pin').value = '';
    document.getElementById('create-error').classList.add('hidden');
    document.getElementById('create-overlay').classList.remove('hidden');
}

function closeCreateOverlay() {
    document.getElementById('create-overlay').classList.add('hidden');
}

async function createUser() {
    const name = document.getElementById('new-user-name').value.trim();
    const pin = document.getElementById('new-user-pin').value;
    const errEl = document.getElementById('create-error');

    if (!name) { errEl.textContent = 'Name is required'; errEl.classList.remove('hidden'); return; }
    if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) {
        errEl.textContent = 'PIN must be 4 digits'; errEl.classList.remove('hidden'); return;
    }

    try {
        const resp = await fetch('/api/users', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, pin}),
        });
        if (resp.ok) {
            const user = await resp.json();
            currentUser = user;
            localStorage.setItem('ep_user', JSON.stringify(user));
            closeCreateOverlay();
            showApp();
        } else {
            const err = await resp.json();
            errEl.textContent = err.detail || 'Error creating user';
            errEl.classList.remove('hidden');
        }
    } catch {
        errEl.textContent = 'Connection error';
        errEl.classList.remove('hidden');
    }
}

function logout() {
    localStorage.removeItem('ep_user');
    currentUser = null;
    if (ws) { ws.close(); ws = null; }
    stopProgram();
    document.getElementById('app-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
    loadUsers();
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
function showApp() {
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    document.getElementById('header-greeting').textContent = `Hi, ${currentUser.name}`;

    connectWebSocket();
    loadPrograms();
    loadWorkouts();
    loadSettings();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket() {
    if (ws) ws.close();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        document.querySelector('.status-dot').classList.add('connected');
        document.getElementById('status-text').textContent = 'Connected';
        // Tell server which user is active
        ws.send(JSON.stringify({type: 'set_user', user_id: currentUser.id}));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') {
            poolStatus = msg.data;
            updateControlUI(msg.data, msg.recording);
        }
    };

    ws.onclose = () => {
        document.querySelector('.status-dot').classList.remove('connected', 'running');
        document.getElementById('status-text').textContent = 'Disconnected';
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => ws.close();
}

function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-content').forEach(t =>
        t.classList.toggle('active', t.id === `tab-${tab}`));

    if (tab === 'workouts') loadWorkouts();
}

// ---------------------------------------------------------------------------
// Control Tab UI
// ---------------------------------------------------------------------------
function updateControlUI(s, recording) {
    const dot = document.querySelector('.status-dot');
    const state = s.pool_state || (s.is_running ? 'running' : 'idle');

    // Status dot & text
    dot.classList.toggle('running', s.is_running);
    dot.classList.toggle('transitioning',
        ['starting', 'stopping', 'changing', 'ready'].includes(state));
    const stateLabels = {
        idle: 'Stopped', ready: 'Ready', starting: 'Starting\u2026',
        running: 'Running', stopping: 'Stopping\u2026', changing: 'Changing\u2026',
    };
    document.getElementById('status-text').textContent = stateLabels[state] || 'Stopped';

    // Timer
    document.getElementById('timer-remaining').textContent = fmtTimer(s.remaining_timer);
    document.getElementById('timer-set').textContent = fmtTimer(s.set_timer);

    // Distance
    document.getElementById('stat-segment').textContent = `${s.segment_distance.toFixed(1)} m`;
    document.getElementById('stat-total').textContent = `${s.total_distance.toFixed(1)} m`;

    // Pace — prefer commanded_pace (from speed_param), fall back to current_pace (from level)
    const pace = s.commanded_pace || s.current_pace;
    document.getElementById('stat-pace').textContent = pace ? fmtPace(pace) + '/100m' : '--:--';

    // Start/Stop button — use pool_state so transient states (changing speed,
    // starting, stopping) don't flip the button.  Only "idle" and "ready"
    // mean the pool is truly stopped and the user can START.
    const poolActive = !['idle', 'ready'].includes(state);
    const btn = document.getElementById('start-stop-btn');
    btn.textContent = poolActive ? 'STOP' : 'START';
    btn.classList.toggle('running', poolActive);

    // Recording badge
    document.getElementById('recording-badge').classList.toggle('hidden', !recording);

    // Debug / raw values
    updateDebugPanel(s);
}

function updateDebugPanel(s) {
    const el = (id) => document.getElementById(id);
    el('dbg-speed-param').textContent = s.speed_param;
    el('dbg-current-speed').textContent = s.current_speed;
    el('dbg-target-speed').textContent = s.target_speed;
    el('dbg-status-flags').textContent = '0x' + (s.status_flags || 0).toString(16).padStart(2, '0');
    el('dbg-running-flag').textContent = s.is_running ? '0x21 (RUN)' : '0x61 (STOP)';
    el('dbg-state-id').textContent = s.state_id;
    el('dbg-pool-state').textContent = s.pool_state || '-';
    el('dbg-commanded-pace').textContent = s.commanded_pace ? fmtPace(s.commanded_pace) + '/100m (' + s.commanded_pace.toFixed(1) + 's)' : '-';
    el('dbg-current-pace').textContent = s.current_pace ? fmtPace(s.current_pace) + '/100m (' + s.current_pace.toFixed(1) + 's)' : '-';
    el('dbg-target-pace').textContent = s.target_pace ? fmtPace(s.target_pace) + '/100m (' + s.target_pace.toFixed(1) + 's)' : '-';
}

function toggleStartStop() {
    const state = (poolStatus && poolStatus.pool_state) || 'idle';
    const poolActive = !['idle', 'ready'].includes(state);
    if (poolActive) {
        wsSend({type: 'command', cmd: 'stop'});
    } else {
        wsSend({type: 'command', cmd: 'start'});
    }
}

function sendTimer() {
    const val = parseInt(document.getElementById('timer-input').value) || 1800;
    wsSend({type: 'command', cmd: 'timer', value: val});
}

function adjustTimer(delta) {
    const inp = document.getElementById('timer-input');
    let val = (parseInt(inp.value) || 1800) + delta;
    val = Math.max(60, Math.min(5400, val));
    inp.value = val;
}

function sendSpeed() {
    const paceSec = parseInt(document.getElementById('speed-slider').value);
    const param = paceToParam(paceSec);
    wsSend({type: 'command', cmd: 'speed', value: param});
}

function updatePaceDisplay(val) {
    document.getElementById('pace-display').textContent = fmtPace(parseFloat(val)) + '/100m';
}

// ---------------------------------------------------------------------------
// Pace <-> Param conversion
// ---------------------------------------------------------------------------
// speed_param IS pace in seconds per 100m — identity mapping.
// Range: 74 (1:14, fastest) to 243 (4:03, slowest).

function paceToParam(paceSec) {
    return Math.max(74, Math.min(243, Math.round(paceSec)));
}

function paramToPace(param) {
    return param;  // identity
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------
async function loadPrograms() {
    if (!currentUser) return;
    try {
        const resp = await fetch(`/api/users/${currentUser.id}/programs`);
        programs = await resp.json();
    } catch { programs = []; }
    renderPrograms();
}

function renderPrograms() {
    const list = document.getElementById('programs-list');
    if (!programs.length) {
        list.innerHTML = '<p style="color:var(--text-muted)">No programs yet. Create one or they will appear after first login.</p>';
        return;
    }
    list.innerHTML = programs.map(p => {
        const totalTime = calcProgramTime(p);
        const sets = countSets(p);
        return `
        <div class="program-card">
            <h3>${esc(p.name)}</h3>
            <p>${esc(p.description || '')}</p>
            <div class="program-meta">
                <span>${fmtTimer(totalTime)} total</span>
                <span>${sets} intervals</span>
            </div>
            <div class="btn-row">
                <button class="btn btn-text btn-sm" onclick="deleteProgram('${p.id}')">Delete</button>
                <button class="btn btn-outline btn-sm" onclick="editProgram('${p.id}')">Edit</button>
                <button class="btn btn-primary btn-sm" onclick="runProgram('${p.id}')">Run</button>
            </div>
        </div>`;
    }).join('');
}

function calcProgramTime(p) {
    let total = 0;
    for (const sec of (p.sections || [])) {
        for (const s of (sec.sets || [])) {
            total += (s.duration + s.rest) * s.repeats;
        }
    }
    return total;
}

function countSets(p) {
    let n = 0;
    for (const sec of (p.sections || [])) {
        for (const s of (sec.sets || [])) n += s.repeats;
    }
    return n;
}

async function deleteProgram(id) {
    if (!confirm('Delete this program?')) return;
    await fetch(`/api/users/${currentUser.id}/programs/${id}`, {method: 'DELETE'});
    loadPrograms();
}

// --- Program Editor ---
function showProgramEditor(prog) {
    editingProgram = prog || {id: '', name: '', description: '', sections: [
        {name: 'Warm-up', sets: [{repeats: 1, duration: 300, pace: 180, rest: 0, description: 'Easy'}]},
        {name: 'Main Set', sets: [{repeats: 4, duration: 120, pace: 120, rest: 30, description: ''}]},
        {name: 'Cool-down', sets: [{repeats: 1, duration: 300, pace: 180, rest: 0, description: 'Easy'}]},
    ]};

    document.getElementById('editor-title').textContent = prog ? 'Edit Program' : 'New Program';
    document.getElementById('prog-name').value = editingProgram.name;
    document.getElementById('prog-desc').value = editingProgram.description || '';
    renderEditorSections();
    document.getElementById('editor-overlay').classList.remove('hidden');
}

function editProgram(id) {
    const prog = programs.find(p => p.id === id);
    if (prog) showProgramEditor(JSON.parse(JSON.stringify(prog)));
}

function closeEditor() {
    document.getElementById('editor-overlay').classList.add('hidden');
    editingProgram = null;
}

function renderEditorSections() {
    const container = document.getElementById('editor-sections');
    container.innerHTML = editingProgram.sections.map((sec, si) => `
        <div class="editor-section">
            <h4>
                <input type="text" value="${esc(sec.name)}" style="width:120px;font-size:0.85rem"
                       onchange="editingProgram.sections[${si}].name=this.value">
                <button class="btn btn-text btn-sm" onclick="removeSection(${si})">Remove</button>
            </h4>
            ${sec.sets.map((s, i) => `
                <div class="set-row">
                    <div><label>Reps</label><input type="number" min="1" max="50" value="${s.repeats}"
                        onchange="editingProgram.sections[${si}].sets[${i}].repeats=+this.value"></div>
                    <div><label>Dur (s)</label><input type="number" min="10" max="3600" value="${s.duration}"
                        onchange="editingProgram.sections[${si}].sets[${i}].duration=+this.value"></div>
                    <div><label>Pace/100</label><input type="number" min="74" max="243" value="${s.pace}"
                        onchange="editingProgram.sections[${si}].sets[${i}].pace=+this.value"></div>
                    <div><label>Rest (s)</label><input type="number" min="0" max="300" value="${s.rest}"
                        onchange="editingProgram.sections[${si}].sets[${i}].rest=+this.value"></div>
                    <div><label>Note</label><input type="text" value="${esc(s.description||'')}" style="font-size:0.75rem"
                        onchange="editingProgram.sections[${si}].sets[${i}].description=this.value"></div>
                </div>
            `).join('')}
            <button class="btn btn-text btn-sm" onclick="addSet(${si})">+ Add Set</button>
        </div>
    `).join('');
}

function addEditorSection() {
    editingProgram.sections.push({name: 'Section', sets: [{repeats: 1, duration: 60, pace: 120, rest: 0, description: ''}]});
    renderEditorSections();
}

function removeSection(si) {
    editingProgram.sections.splice(si, 1);
    renderEditorSections();
}

function addSet(si) {
    editingProgram.sections[si].sets.push({repeats: 1, duration: 60, pace: 120, rest: 0, description: ''});
    renderEditorSections();
}

async function saveProgram() {
    editingProgram.name = document.getElementById('prog-name').value.trim() || 'Untitled';
    editingProgram.description = document.getElementById('prog-desc').value.trim();

    await fetch(`/api/users/${currentUser.id}/programs`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(editingProgram),
    });

    closeEditor();
    loadPrograms();
}

// --- Program Runner ---
function runProgram(id) {
    const prog = programs.find(p => p.id === id);
    if (!prog) return;

    // Build flat list of steps: {type, duration, pace, description, section}
    const steps = [];
    for (const sec of prog.sections) {
        for (const s of sec.sets) {
            for (let r = 0; r < s.repeats; r++) {
                steps.push({
                    type: 'swim', duration: s.duration, pace: s.pace,
                    description: s.description || `${fmtPace(s.pace)}/100m`,
                    section: sec.name,
                });
                if (s.rest > 0) {
                    steps.push({
                        type: 'rest', duration: s.rest, pace: 0,
                        description: 'Rest', section: sec.name,
                    });
                }
            }
        }
    }

    runningProgram = {prog, steps, currentStep: 0, timeLeft: 0, totalTime: steps.reduce((a, s) => a + s.duration, 0), elapsed: 0};

    document.getElementById('runner-program-name').textContent = prog.name;
    document.getElementById('runner-overlay').classList.remove('hidden');

    advanceRunner();
}

function advanceRunner() {
    if (!runningProgram) return;
    const rp = runningProgram;

    if (rp.currentStep >= rp.steps.length) {
        stopProgram();
        return;
    }

    const step = rp.steps[rp.currentStep];
    rp.timeLeft = step.duration;

    document.getElementById('runner-section').textContent = step.section;
    document.getElementById('runner-interval').textContent =
        step.type === 'rest' ? 'Rest' : `${step.description} for ${fmtTimer(step.duration)}`;

    if (step.type === 'swim') {
        const param = paceToParam(step.pace);
        wsSend({type: 'command', cmd: 'speed', value: param});
        wsSend({type: 'command', cmd: 'timer', value: step.duration});
        setTimeout(() => wsSend({type: 'command', cmd: 'start'}), 300);
    } else {
        wsSend({type: 'command', cmd: 'stop'});
    }

    if (runnerTimer) clearInterval(runnerTimer);
    runnerTimer = setInterval(runnerTick, 1000);
}

function runnerTick() {
    if (!runningProgram) return;
    const rp = runningProgram;
    rp.timeLeft--;
    rp.elapsed++;

    document.getElementById('runner-countdown').textContent = fmtTimer(Math.max(0, rp.timeLeft));

    // Progress bar
    const pct = Math.min(100, (rp.elapsed / rp.totalTime) * 100);
    let bar = document.querySelector('.runner-bar-fill');
    if (!bar) {
        document.getElementById('runner-progress').innerHTML =
            '<div class="runner-bar"><div class="runner-bar-fill" style="width:0%"></div></div>';
        bar = document.querySelector('.runner-bar-fill');
    }
    bar.style.width = pct + '%';

    if (rp.timeLeft <= 0) {
        rp.currentStep++;
        advanceRunner();
    }
}

function stopProgram() {
    if (runnerTimer) { clearInterval(runnerTimer); runnerTimer = null; }
    runningProgram = null;
    document.getElementById('runner-overlay').classList.add('hidden');
    wsSend({type: 'command', cmd: 'stop'});
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------
async function loadWorkouts() {
    if (!currentUser) return;
    try {
        const resp = await fetch(`/api/users/${currentUser.id}/workouts`);
        workouts = await resp.json();
    } catch { workouts = []; }
    renderWorkouts();
}

function renderWorkouts() {
    const list = document.getElementById('workouts-list');
    if (!workouts.length) {
        list.innerHTML = '<p style="color:var(--text-muted)">No workouts recorded yet. Start swimming!</p>';
        return;
    }

    list.innerHTML = workouts.slice().reverse().map(w => {
        const date = new Date(w.start_time).toLocaleDateString(undefined, {
            weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        return `
        <div class="workout-card">
            <h3>${date}</h3>
            <div class="workout-meta">
                <span>${w.total_distance?.toFixed(0) || 0} m</span>
                <span>${fmtTimer(w.total_time || 0)}</span>
                <span>${w.intervals?.length || 0} intervals</span>
            </div>
            <div class="btn-row">
                <button class="btn btn-text btn-sm" onclick="deleteWorkout('${w.id}')">Delete</button>
                <button class="btn btn-outline btn-sm" onclick="exportWorkout('${w.id}')">Export TCX</button>
                <button class="btn btn-primary btn-sm" onclick="uploadStrava('${w.id}')">Strava</button>
            </div>
        </div>`;
    }).join('');
}

async function deleteWorkout(id) {
    if (!confirm('Delete this workout?')) return;
    await fetch(`/api/users/${currentUser.id}/workouts/${id}`, {method: 'DELETE'});
    loadWorkouts();
}

function exportWorkout(id) {
    window.open(`/api/users/${currentUser.id}/workouts/${id}/export`, '_blank');
}

async function uploadStrava(id) {
    try {
        const resp = await fetch(`/api/users/${currentUser.id}/workouts/${id}/strava`, {method: 'POST'});
        const result = await resp.json();
        if (result.url) {
            alert('Uploaded to Strava!\n' + result.url);
        } else if (result.status === 'processing') {
            alert('Upload submitted. It may take a moment to appear on Strava.');
        } else {
            alert('Upload issue: ' + JSON.stringify(result));
        }
    } catch (e) {
        alert('Upload failed: ' + e.message);
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function loadSettings() {
    if (!currentUser) return;
    try {
        const resp = await fetch(`/api/users/${currentUser.id}/settings`);
        const settings = await resp.json();
        document.getElementById('strava-client-id').value = settings.strava_client_id || '';
        document.getElementById('strava-status').textContent =
            settings.strava_connected ? 'Connected to Strava' : 'Not connected';
        document.getElementById('strava-status').style.color =
            settings.strava_connected ? 'var(--success)' : 'var(--text-dim)';
    } catch {}
}

async function saveStravaSettings() {
    const clientId = document.getElementById('strava-client-id').value.trim();
    const clientSecret = document.getElementById('strava-client-secret').value.trim();

    await fetch(`/api/users/${currentUser.id}/settings`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({strava_client_id: clientId, strava_client_secret: clientSecret}),
    });
    alert('Strava credentials saved.');
}

async function connectStrava() {
    try {
        const resp = await fetch(`/api/users/${currentUser.id}/strava/auth`);
        const data = await resp.json();
        if (data.url) {
            window.open(data.url, '_blank');
        } else {
            alert(data.detail || 'Could not generate auth URL. Save credentials first.');
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtTimer(sec) {
    if (sec == null || sec < 0) return '--:--';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtPace(secPer100) {
    if (!secPer100 || secPer100 <= 0) return '--:--';
    const m = Math.floor(secPer100 / 60);
    const s = Math.round(secPer100 % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}
