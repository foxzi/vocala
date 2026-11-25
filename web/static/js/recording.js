// Call recording UI: the record button, the "being recorded" indicator that
// every participant sees, and the list of a channel's recordings.
// See docs/adr/0001-recording-and-transcription.md.

let recordingState = { active: false };
let recordingTicker = null;

function recordingEnabled() {
    return !!window.VOCALA_RECORDING;
}

function recordingKeptFor() {
    const days = Number(window.VOCALA_RECORDING_DAYS) || 0;
    return days > 0 ? ` and is kept for ${days} days` : '';
}

function recordButtonHTML() {
    if (!recordingEnabled()) return '';
    return `<button onclick="toggleRecording()" id="record-btn" title="Start recording"
        class="flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition">
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"/>
            <circle id="record-btn-dot" cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>
        </svg>
    </button>`;
}

function recordingIndicatorHTML() {
    if (!recordingEnabled()) return '';
    return `<div id="rec-indicator" class="hidden items-center gap-1.5 ml-1 px-2 py-0.5 rounded-full bg-vc-red/15 text-vc-red text-xs font-medium flex-shrink-0">
        <span class="w-2 h-2 rounded-full bg-vc-red animate-pulse"></span>
        <span>REC</span>
        <span id="rec-elapsed" class="tabular-nums">0:00</span>
    </div>`;
}

function recordingsButtonHTML(channelID) {
    if (!recordingEnabled() || window.VOCALA_GUEST_CHANNEL) return '';
    return `<button onclick="openRecordings(${Number(channelID)})" title="Recordings of this channel"
        class="px-3 py-1.5 bg-vc-channel hover:bg-vc-hover text-vc-muted hover:text-vc-text text-xs md:text-sm rounded-lg transition flex-shrink-0 border border-vc-border">
        Recordings
    </button>`;
}

async function toggleRecording() {
    if (recordingState.active) {
        const ok = await confirmModal('Stop recording for everyone in the call?', { okText: 'Stop recording', danger: true });
        if (ok) sendWS({ type: 'recording_stop' });
        return;
    }
    const ok = await confirmModal(
        `Start recording this call?\nEveryone in the call will see that it is being recorded. The recording is available to the channel members${recordingKeptFor()}.`,
        { okText: 'Start recording' });
    if (ok) sendWS({ type: 'recording_start' });
}

// The server sends recording_state when a recording starts or stops, and
// to every participant who joins the call.
function handleRecordingState(msg) {
    if (msg.channel_id !== activeCallChannelID) return;
    // A "stopped" of an earlier recording can arrive after the next one
    // started; it must not hide the indicator of the running one.
    if (!msg.active && msg.recording_id && recordingState.active &&
        msg.recording_id !== recordingState.recording_id) return;
    const wasActive = recordingState.active;
    recordingState = msg;
    renderRecordingState();
    if (msg.active && !wasActive) {
        showRecordingNotice(`This call is being recorded (started by ${msg.started_by})`);
    } else if (!msg.active && wasActive) {
        showRecordingNotice('Recording stopped. It is available in Recordings.');
    }
}

// Runs fn (a WebRTC teardown that is not leaving the call) without losing
// the recording indicator: the server only resends the state on join.
function preservingRecordingState(fn) {
    const saved = recordingState;
    try {
        fn();
    } finally {
        recordingState = saved;
        renderRecordingState();
    }
}

// Called when the client leaves the call.
function resetRecordingState() {
    recordingState = { active: false };
    renderRecordingState();
    const notice = document.getElementById('recording-notice');
    if (notice) notice.remove();
}

function renderRecordingState() {
    const active = !!recordingState.active;
    const indicator = document.getElementById('rec-indicator');
    if (indicator) {
        indicator.classList.toggle('hidden', !active);
        indicator.classList.toggle('flex', active);
        indicator.title = active ? `Recording started by ${recordingState.started_by}` : '';
    }
    const btn = document.getElementById('record-btn');
    if (btn) {
        btn.title = active ? 'Stop recording' : 'Start recording';
        btn.classList.toggle('bg-vc-red/20', active);
        btn.classList.toggle('text-vc-red', active);
        btn.classList.toggle('bg-vc-channel', !active);
        btn.classList.toggle('text-vc-text', !active);
    }
    clearInterval(recordingTicker);
    recordingTicker = null;
    if (active) {
        updateRecordingElapsed();
        recordingTicker = setInterval(updateRecordingElapsed, 1000);
    }
}

function updateRecordingElapsed() {
    const el = document.getElementById('rec-elapsed');
    if (el && recordingState.started_at) {
        el.textContent = formatRecordingDuration(Date.now() - recordingState.started_at);
    }
}

function showRecordingNotice(text) {
    const old = document.getElementById('recording-notice');
    if (old) old.remove();
    const notice = document.createElement('div');
    notice.id = 'recording-notice';
    notice.className = 'fixed top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg bg-vc-sidebar border border-vc-red/50 text-vc-text shadow-lg text-sm max-w-[calc(100vw-2rem)]';
    notice.innerHTML = `<span class="w-2 h-2 rounded-full bg-vc-red flex-shrink-0"></span><span></span>`;
    notice.lastChild.textContent = text;
    document.body.appendChild(notice);
    setTimeout(() => notice.remove(), 6000);
}

function formatRecordingDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// --- Recordings list ---

async function openRecordings(channelID) {
    const existing = document.getElementById('recordings-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'recordings-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4';
    modal.innerHTML = `
        <div class="bg-vc-sidebar border border-vc-border rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div class="px-5 py-3 border-b border-vc-border flex items-center">
                <h3 class="font-semibold text-vc-text">Recordings</h3>
                <button data-act="close" class="ml-auto text-vc-muted hover:text-vc-text transition" title="Close">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
            <div id="recordings-body" class="overflow-y-auto p-4 space-y-3 text-sm text-vc-muted">Loading…</div>
        </div>
    `;
    const close = () => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    modal.querySelector('[data-act="close"]').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);

    const body = modal.querySelector('#recordings-body');
    try {
        const res = await fetch(`/api/recordings?channel_id=${encodeURIComponent(channelID)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        renderRecordingsList(body, await res.json());
    } catch (err) {
        console.error('Failed to load recordings:', err);
        body.textContent = 'Failed to load recordings.';
    }
}

function renderRecordingsList(body, recordings) {
    if (!recordings.length) {
        body.textContent = 'No recordings yet. Start one with the record button in a call.';
        return;
    }
    body.innerHTML = '';
    for (const rec of recordings) {
        body.appendChild(renderRecording(rec));
    }
}

function renderRecording(rec) {
    const card = document.createElement('div');
    card.className = 'border border-vc-border rounded-lg p-3 bg-vc-bg/40';

    const started = new Date(rec.started_at);
    const duration = rec.ended_at ? formatRecordingDuration(rec.ended_at - rec.started_at) : '';
    const statusBadge = {
        recording: '<span class="px-1.5 py-0.5 rounded bg-vc-red/20 text-vc-red text-[11px]">recording…</span>',
        failed: '<span class="px-1.5 py-0.5 rounded bg-vc-yellow/20 text-vc-yellow text-[11px]" title="Some audio could not be saved">partly saved</span>',
    }[rec.status] || '';

    card.innerHTML = `
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="font-medium text-vc-text">${escapeHTML(started.toLocaleString())}</span>
            ${duration ? `<span class="text-xs">${duration}</span>` : ''}
            ${statusBadge}
            <span class="text-xs ml-auto">started by ${escapeHTML(rec.started_by)}</span>
        </div>
        <div class="mt-2 space-y-2" data-segments></div>
    `;
    const list = card.querySelector('[data-segments]');
    if (rec.status === 'recording') {
        list.innerHTML = '<div class="text-xs">The call is still being recorded.</div>';
    } else if (!rec.segments.length) {
        list.innerHTML = '<div class="text-xs">No audio was captured.</div>';
    }
    if (rec.status !== 'recording') {
        for (const seg of rec.segments) {
            list.appendChild(renderSegment(rec, seg));
        }
    }
    return card;
}

function renderSegment(rec, seg) {
    const src = `/api/recordings/audio?recording_id=${rec.id}&segment_id=${seg.id}`;
    const row = document.createElement('div');
    row.className = 'flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3';
    row.innerHTML = `
        <div class="sm:w-40 flex-shrink-0 min-w-0">
            <div class="text-vc-text truncate">${escapeHTML(seg.name)}</div>
            <div class="text-[11px]">from ${formatRecordingDuration(seg.started_at - rec.started_at)} · ${formatRecordingDuration(seg.duration_ms)}</div>
        </div>
        <audio controls preload="none" class="w-full h-9 min-w-0" src="${src}"></audio>
        <a href="${src}" download class="text-xs text-vc-accent hover:underline flex-shrink-0">Download</a>
    `;
    return row;
}
