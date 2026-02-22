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
let wakeLock = null;       // Screen Wake Lock sentinel
let paceOffset = 0;        // Seconds added to each swim step's pace (+slower, -faster)
let liveCalories = 0;      // Real-time calorie accumulator for current session
let liveCalLastTs = null;   // Timestamp of last calorie tick
let liveCalWasActive = false; // Was pool active on last status update

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

    // Real-time calorie accumulation
    updateLiveCalories(state, s.speed_param || 0);
    const calDisplay = Math.round(liveCalories);
    document.getElementById('stat-calories').textContent = calDisplay;
    const runnerCalEl = document.getElementById('runner-calories');
    if (runnerCalEl) runnerCalEl.textContent = calDisplay + ' kcal';

    // Start/Stop button — use pool_state so transient states (changing speed,
    // starting, stopping) don't flip the button.  Only "idle" and "ready"
    // mean the pool is truly stopped and the user can START.
    const poolActive = !['idle', 'ready'].includes(state);
    const btn = document.getElementById('start-stop-btn');
    btn.textContent = poolActive ? 'STOP' : 'START';
    btn.classList.toggle('running', poolActive);
    btn.disabled = false;

    // Recording badge
    document.getElementById('recording-badge').classList.toggle('hidden', !recording);

    // Restore "Set" buttons once broadcast confirms values
    const timerBtn = document.querySelector('[onclick="sendTimer()"]');
    if (timerBtn && timerBtn.disabled) { timerBtn.textContent = 'Set'; timerBtn.disabled = false; }
    const paceBtn = document.querySelector('[onclick="sendSpeed()"]');
    if (paceBtn && paceBtn.disabled) { paceBtn.textContent = 'Set Pace'; paceBtn.disabled = false; }

    // Program runner: sync swim steps to pool's remaining_timer
    updateRunnerFromBroadcast(s);

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
    const btn = document.getElementById('start-stop-btn');
    if (poolActive) {
        btn.textContent = 'Stopping\u2026'; btn.disabled = true;
        wsSend({type: 'command', cmd: 'stop'});
        releaseWakeLock();
    } else {
        btn.textContent = 'Starting\u2026'; btn.disabled = true;
        wsSend({type: 'command', cmd: 'start'});
        requestWakeLock();
    }
}

function sendTimer() {
    const val = parseInt(document.getElementById('timer-input').value) || 1800;
    const btn = document.querySelector('[onclick="sendTimer()"]');
    if (btn) { btn.textContent = 'Setting\u2026'; btn.disabled = true; }
    wsSend({type: 'command', cmd: 'timer', value: val});
    // Re-enable after broadcast confirms (or timeout)
    setTimeout(() => { if (btn) { btn.textContent = 'Set'; btn.disabled = false; } }, 6000);
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
    const btn = document.querySelector('[onclick="sendSpeed()"]');
    if (btn) { btn.textContent = 'Setting\u2026'; btn.disabled = true; }
    wsSend({type: 'command', cmd: 'speed', value: param});
    setTimeout(() => { if (btn) { btn.textContent = 'Set Pace'; btn.disabled = false; } }, 6000);
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
        const icon = p.icon ? p.icon + ' ' : '';
        return `
        <div class="program-card">
            <h3>${icon}${esc(p.name)}</h3>
            <p>${esc(p.description || '')}</p>
            <div class="program-meta">
                <span>${fmtTimer(totalTime)} total</span>
                <span>${sets} intervals</span>
            </div>
            <div class="btn-row">
                <button class="btn btn-text btn-sm" onclick="deleteProgram('${p.id}')">Delete</button>
                <button class="btn btn-text btn-sm" onclick="duplicateProgram('${p.id}')">Duplicate</button>
                <button class="btn btn-outline btn-sm" onclick="editProgram('${p.id}')">Edit</button>
                <button class="btn btn-primary btn-sm" onclick="runProgram('${p.id}')">Run</button>
            </div>
        </div>`;
    }).join('');
}

function calcProgramTime(p) {
    let total = 0;
    const sections = p.sections || [];
    for (let si = 0; si < sections.length; si++) {
        const sec = sections[si];
        for (const s of (sec.sets || [])) {
            total += (s.duration + s.rest) * s.repeats;
        }
        if ((sec.pause || 0) > 0 && si < sections.length - 1) {
            total += sec.pause;
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
    if (!id || !confirm('Delete this program?')) return;
    await fetch(`/api/users/${currentUser.id}/programs/${id}`, {method: 'DELETE'});
    await loadPrograms();
}

async function duplicateProgram(id) {
    const prog = programs.find(p => p.id === id);
    if (!prog) return;
    const copy = JSON.parse(JSON.stringify(prog));
    copy.id = '';
    copy.name = (copy.name || 'Program') + ' (copy)';
    await fetch(`/api/users/${currentUser.id}/programs`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(copy),
    });
    await loadPrograms();
}

// --- Program Editor ---
function showProgramEditor(prog) {
    editingProgram = prog || {id: '', name: '', icon: '', description: '', sections: [
        {name: 'Warm-up', pause: 20, sets: [{repeats: 1, duration: 300, pace: 180, rest: 0, description: 'Easy'}]},
        {name: 'Main Set', pause: 20, sets: [{repeats: 4, duration: 120, pace: 120, rest: 30, description: ''}]},
        {name: 'Cool-down', pause: 0, sets: [{repeats: 1, duration: 300, pace: 180, rest: 0, description: 'Easy'}]},
    ]};

    document.getElementById('editor-title').textContent = prog ? 'Edit Program' : 'New Program';
    document.getElementById('prog-icon').value = editingProgram.icon || '';
    document.getElementById('prog-name').value = editingProgram.name;
    document.getElementById('prog-desc').value = editingProgram.description || '';
    renderEditorSections();
    updateEditorTotal();
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
                    <div><label>Reps</label><input type="number" inputmode="numeric" pattern="[0-9]*" min="1" max="50" value="${s.repeats}"
                        onchange="editingProgram.sections[${si}].sets[${i}].repeats=+this.value;updateEditorTotal()"></div>
                    <div><label>Dur (s)</label><input type="number" inputmode="numeric" pattern="[0-9]*" min="10" max="3600" value="${s.duration}"
                        onchange="editingProgram.sections[${si}].sets[${i}].duration=+this.value;updateEditorTotal()"></div>
                    <div><label>Pace/100</label><input type="number" inputmode="numeric" pattern="[0-9]*" min="74" max="243" value="${s.pace}"
                        onchange="editingProgram.sections[${si}].sets[${i}].pace=+this.value"></div>
                    <div><label>Rest (s)</label><input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="300" value="${s.rest}"
                        onchange="editingProgram.sections[${si}].sets[${i}].rest=+this.value;updateEditorTotal()"></div>
                    <div><label>Note</label><input type="text" value="${esc(s.description||'')}" style="font-size:0.75rem"
                        onchange="editingProgram.sections[${si}].sets[${i}].description=this.value"></div>
                    ${sec.sets.length > 1 ? `<button class="set-remove-btn" onclick="removeSet(${si},${i})">&times;</button>` : ''}
                </div>
            `).join('')}
            <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
                <button class="btn btn-text btn-sm" onclick="addSet(${si})">+ Add Set</button>
                <label style="margin-left:auto;font-size:0.75rem">Pause after section (s)</label>
                <input type="number" inputmode="numeric" pattern="[0-9]*" min="0" max="300" value="${sec.pause || 0}" style="width:56px"
                    onchange="editingProgram.sections[${si}].pause=+this.value;updateEditorTotal()">
            </div>
        </div>
    `).join('');
}

function updateEditorTotal() {
    if (!editingProgram) return;
    const el = document.getElementById('editor-total');
    if (!el) return;
    let swimTime = 0, restTime = 0, pauseTime = 0;
    const sections = editingProgram.sections || [];
    for (let si = 0; si < sections.length; si++) {
        const sec = sections[si];
        for (const s of (sec.sets || [])) {
            swimTime += s.duration * s.repeats;
            restTime += s.rest * s.repeats;
        }
        if ((sec.pause || 0) > 0 && si < sections.length - 1) {
            pauseTime += sec.pause;
        }
    }
    const total = swimTime + restTime + pauseTime;
    let parts = [`${fmtTimer(swimTime)} swim`];
    if (restTime > 0) parts.push(`${fmtTimer(restTime)} rest`);
    if (pauseTime > 0) parts.push(`${fmtTimer(pauseTime)} pause`);
    el.textContent = `Total: ${fmtTimer(total)} (${parts.join(' + ')})`;
}

function addEditorSection() {
    editingProgram.sections.push({name: 'Section', pause: 0, sets: [{repeats: 1, duration: 60, pace: 120, rest: 0, description: ''}]});
    renderEditorSections();
    updateEditorTotal();
}

function removeSection(si) {
    editingProgram.sections.splice(si, 1);
    renderEditorSections();
    updateEditorTotal();
}

function addSet(si) {
    editingProgram.sections[si].sets.push({repeats: 1, duration: 60, pace: 120, rest: 0, description: ''});
    renderEditorSections();
    updateEditorTotal();
}

function removeSet(si, setIdx) {
    const sets = editingProgram.sections[si].sets;
    if (sets.length <= 1) return;
    sets.splice(setIdx, 1);
    renderEditorSections();
    updateEditorTotal();
}

async function saveProgram() {
    editingProgram.icon = document.getElementById('prog-icon').value.trim();
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

// --- Wake Lock ---
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* user denied or not supported */ }
}
function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (runningProgram || (poolStatus && !['idle','ready'].includes(poolStatus.pool_state)))) {
        requestWakeLock();
    }
});

// --- Program Runner ---
const SLOWEST_PACE = 243;  // 4:03/100m — used for rest/pause steps

function runProgram(id) {
    const prog = programs.find(p => p.id === id);
    if (!prog) return;

    // Build flat list of steps.  Rest/pause steps run at slowest pace
    // so the pool never stops mid-workout.
    const steps = [];
    const sections = prog.sections || [];
    for (let si = 0; si < sections.length; si++) {
        const sec = sections[si];
        for (const s of sec.sets) {
            for (let r = 0; r < s.repeats; r++) {
                steps.push({
                    type: 'swim', duration: s.duration, pace: s.pace,
                    description: s.description || `${fmtPace(s.pace)}/100m`,
                    section: sec.name,
                });
                if (s.rest > 0) {
                    steps.push({
                        type: 'rest', duration: s.rest, pace: SLOWEST_PACE,
                        description: 'Recovery', section: sec.name,
                    });
                }
            }
        }
        // Section pause (between sections, not after the last one)
        const pause = sec.pause || 0;
        if (pause > 0 && si < sections.length - 1) {
            steps.push({
                type: 'rest', duration: pause, pace: SLOWEST_PACE,
                description: 'Pause', section: sec.name,
            });
        }
    }

    const totalTime = steps.reduce((a, s) => a + s.duration, 0);
    runningProgram = {prog, steps, currentStep: 0, timeLeft: 0, totalTime, elapsed: 0, workoutStarted: false};

    paceOffset = 0;
    updatePaceOffsetDisplay();

    document.getElementById('runner-program-name').textContent =
        (prog.icon ? prog.icon + ' ' : '') + prog.name;
    document.getElementById('runner-overlay').classList.remove('hidden');

    wsSend({type: 'command', cmd: 'set_program_meta', icon: prog.icon || '', name: prog.name || ''});
    requestWakeLock();
    advanceRunner();
}

function updateRunnerStepUI() {
    const rp = runningProgram;
    if (!rp) return;
    const step = rp.steps[rp.currentStep];
    if (!step) return;

    const isRest = step.type === 'rest';
    const effectivePace = isRest
        ? SLOWEST_PACE
        : paceToParam(step.pace + paceOffset);

    let label;
    if (isRest) {
        label = step.description || 'Recovery';
    } else {
        const desc = step.description || fmtPace(step.pace);
        const offsetStr = paceOffset !== 0
            ? ` (${paceOffset > 0 ? '+' : ''}${paceOffset}s \u2192 ${fmtPace(effectivePace)})`
            : '';
        label = `${desc}${offsetStr}`;
    }

    document.getElementById('runner-section').textContent = step.section;
    document.getElementById('runner-interval').textContent =
        `${label} for ${fmtTimer(step.duration)}`;
    document.getElementById('runner-countdown').textContent = fmtTimer(step.duration);
}

function advanceRunner() {
    if (!runningProgram) return;
    const rp = runningProgram;

    if (rp.currentStep >= rp.steps.length) {
        stopProgram();
        return;
    }

    const step = rp.steps[rp.currentStep];
    const isRest = step.type === 'rest';
    const effectivePace = isRest
        ? SLOWEST_PACE
        : paceToParam(step.pace + paceOffset);

    updateRunnerStepUI();

    if (!rp.workoutStarted) {
        // First step: set the pool timer to the TOTAL workout time so the
        // pool never stops mid-workout, then set speed and start.
        rp.workoutStarted = true;
        rp.waitingForPool = true;
        rp.poolAckedStep = false;
        rp.stepSentAt = Date.now();

        wsSend({
            type: 'command', cmd: 'program_step',
            pace: effectivePace,
            duration: rp.totalTime,
        });
    } else {
        // Subsequent steps: pool is already running with total-time timer.
        // Only change the speed — no timer reset, no start/stop.
        wsSend({type: 'command', cmd: 'speed', value: effectivePace});
    }
}

function adjustPaceOffset(delta) {
    paceOffset += delta;
    // Clamp so effective pace stays in the valid 74-243 range even at extremes
    paceOffset = Math.max(-60, Math.min(120, paceOffset));
    updatePaceOffsetDisplay();

    if (runningProgram) {
        const step = runningProgram.steps[runningProgram.currentStep];
        if (step && step.type === 'swim') {
            const effectivePace = paceToParam(step.pace + paceOffset);
            wsSend({type: 'command', cmd: 'speed', value: effectivePace});

            const desc = step.description || fmtPace(step.pace);
            const offsetStr = paceOffset !== 0
                ? ` (${paceOffset > 0 ? '+' : ''}${paceOffset}s \u2192 ${fmtPace(effectivePace)})`
                : '';
            document.getElementById('runner-interval').textContent =
                `${desc}${offsetStr} for ${fmtTimer(runningProgram.timeLeft)}`;
        }
    }
}

function updatePaceOffsetDisplay() {
    const el = document.getElementById('pace-offset-value');
    if (!el) return;
    const sign = paceOffset > 0 ? '+' : '';
    el.textContent = `${sign}${paceOffset} s`;
    el.style.color = paceOffset < 0 ? 'var(--success)' : paceOffset > 0 ? 'var(--danger)' : 'var(--text)';
}

function updateRunnerFromBroadcast(s) {
    if (!runningProgram) return;
    const rp = runningProgram;
    if (!rp.waitingForPool) return;

    const poolRemaining = s.remaining_timer || 0;
    const poolState = s.pool_state || 'idle';
    const poolActive = ['running', 'starting', 'changing'].includes(poolState);

    // Wait for the pool to actually be running before tracking elapsed time.
    // Using poolActive (not just remaining_timer > 0) prevents a stale timer
    // from a previous session from causing workoutElapsed to jump.
    if (!rp.poolAckedStep) {
        if (poolActive && poolRemaining > 0) {
            rp.poolAckedStep = true;
            rp.poolTimerStart = poolRemaining;
        } else {
            const waitSec = Math.round((Date.now() - (rp.stepSentAt || Date.now())) / 1000);
            document.getElementById('runner-countdown').textContent =
                `Starting\u2026 ${waitSec}s`;
            return;
        }
    }

    // Derive workout elapsed from the pool's countdown relative to when it
    // first started.  poolTimerStart ≈ totalTime but may differ by a few
    // seconds of setup time — using it avoids jumps from stale timer values.
    const workoutElapsed = Math.max(0, rp.poolTimerStart - poolRemaining);
    rp.elapsed = workoutElapsed;

    // Determine which step we should be on based on elapsed time.
    let cumulative = 0;
    let targetStep = rp.steps.length;
    for (let i = 0; i < rp.steps.length; i++) {
        cumulative += rp.steps[i].duration;
        if (workoutElapsed < cumulative) {
            targetStep = i;
            break;
        }
    }

    // Advance to the correct step if needed (sends only a speed change).
    if (targetStep > rp.currentStep && targetStep < rp.steps.length) {
        rp.currentStep = targetStep;
        advanceRunner();
    }

    // Per-step countdown
    const step = rp.steps[rp.currentStep];
    if (!step) return;
    const stepStart = rp.steps.slice(0, rp.currentStep).reduce((a, st) => a + st.duration, 0);
    const stepTimeLeft = Math.max(0, (stepStart + step.duration) - workoutElapsed);
    rp.timeLeft = stepTimeLeft;

    document.getElementById('runner-countdown').textContent = fmtTimer(Math.round(stepTimeLeft));
    const totalLeft = Math.max(0, rp.totalTime - workoutElapsed);
    document.getElementById('runner-total-remaining').textContent =
        'Total: ' + fmtTimer(Math.round(totalLeft));
    updateRunnerProgress();

    // Workout complete: all steps elapsed OR pool timer expired
    if (targetStep >= rp.steps.length || (poolRemaining <= 0 && !poolActive)) {
        stopProgram();
    }
}

function updateRunnerProgress() {
    if (!runningProgram) return;
    const rp = runningProgram;
    const pct = Math.min(100, Math.max(0, (rp.elapsed / rp.totalTime) * 100));
    let bar = document.querySelector('.runner-bar-fill');
    if (!bar) {
        document.getElementById('runner-progress').innerHTML =
            '<div class="runner-bar"><div class="runner-bar-fill" style="width:0%"></div></div>';
        bar = document.querySelector('.runner-bar-fill');
    }
    bar.style.width = pct + '%';
}

function stopProgram() {
    runningProgram = null;
    paceOffset = 0;
    document.getElementById('runner-overlay').classList.add('hidden');
    wsSend({type: 'command', cmd: 'stop'});
    releaseWakeLock();
}

// ---------------------------------------------------------------------------
// Real-time calorie tracking
// ---------------------------------------------------------------------------
function updateLiveCalories(state, speedParam) {
    const now = Date.now();
    const active = !['idle', 'ready'].includes(state);

    if (active && liveCalWasActive && liveCalLastTs) {
        // Accumulate: kcal = MET * weight_kg * hours
        const dtHours = (now - liveCalLastTs) / 3600000;
        const met = metForPace(speedParam || 150);
        liveCalories += met * (userWeightKg || 75) * dtHours;
    }

    if (!active && liveCalWasActive) {
        // Pool just stopped — round the total but keep it (reset on next start)
    }
    if (active && !liveCalWasActive) {
        // Pool just started — reset accumulator for a new session
        liveCalories = 0;
    }

    liveCalLastTs = now;
    liveCalWasActive = active;
}

// ---------------------------------------------------------------------------
// Calorie estimation (client-side, for older workouts without server-side data)
// ---------------------------------------------------------------------------
const MET_TABLE = [[74,10],[100,8.5],[130,7],[160,5.8],[200,4.5],[243,3.5]];

function metForPace(pace) {
    if (pace <= MET_TABLE[0][0]) return MET_TABLE[0][1];
    if (pace >= MET_TABLE[MET_TABLE.length-1][0]) return MET_TABLE[MET_TABLE.length-1][1];
    for (let i = 0; i < MET_TABLE.length - 1; i++) {
        const [p1,m1] = MET_TABLE[i], [p2,m2] = MET_TABLE[i+1];
        if (pace >= p1 && pace <= p2) {
            const t = (pace - p1) / (p2 - p1);
            return m1 + t * (m2 - m1);
        }
    }
    return 5;
}

function estimateWorkoutCalories(w) {
    if (w.total_calories) return w.total_calories;
    let total = 0;
    const kg = userWeightKg || 75;
    for (const iv of (w.intervals || [])) {
        const met = metForPace(iv.speed_param || 150);
        total += met * kg * (iv.duration / 3600);
    }
    return Math.round(total);
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
        const wIcon = w.icon ? w.icon + ' ' : '';
        return `
        <div class="workout-card">
            <h3>${wIcon}${date}</h3>
            <div class="workout-meta">
                <span>${w.total_distance?.toFixed(0) || 0} m</span>
                <span>${fmtTimer(w.total_time || 0)}</span>
                <span>${w.intervals?.length || 0} intervals</span>
                <span>${estimateWorkoutCalories(w)} kcal</span>
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
let userWeightKg = 75;

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
        userWeightKg = settings.weight_kg || 75;
        document.getElementById('weight-input').value = userWeightKg;
    } catch {}
}

async function saveWeight() {
    const w = parseFloat(document.getElementById('weight-input').value) || 75;
    userWeightKg = w;
    await fetch(`/api/users/${currentUser.id}/settings`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({weight_kg: w}),
    });
    // Re-render workouts with updated calorie estimates
    renderWorkouts();
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
