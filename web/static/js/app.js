let ws = null;
let currentChannelID = null;
let isMuted = false;
let reconnectAttempts = 0;

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        reconnectAttempts = 0;
        document.getElementById('connection-status').textContent = 'Connected';
        document.getElementById('connection-status').className = 'text-xs text-vc-green';
    };

    ws.onclose = () => {
        document.getElementById('connection-status').textContent = 'Reconnecting...';
        document.getElementById('connection-status').className = 'text-xs text-vc-yellow';
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        setTimeout(connectWS, delay);
    };

    ws.onerror = () => {
        ws.close();
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
    };
}

function handleWSMessage(msg) {
    switch (msg.type) {
        case 'channel_users':
            updateChannelUsers(msg.channel_id, msg.users || []);
            break;
        case 'presence':
            updatePresence(msg.channels || {});
            break;
    }
}

function updateChannelUsers(channelID, users) {
    const container = document.getElementById(`ch-users-${channelID}`);
    const countEl = document.getElementById(`ch-count-${channelID}`);
    if (!container) return;

    if (countEl) {
        countEl.textContent = users.length > 0 ? `${users.length} connected` : '';
    }

    container.innerHTML = users.map(u => `
        <div class="flex items-center gap-2 px-2 py-1 rounded text-sm fade-in">
            <div class="relative">
                <div class="w-6 h-6 rounded-full ${u.Speaking ? 'bg-vc-accent speaking-ring' : 'bg-vc-channel'} flex items-center justify-center text-xs font-bold text-white">
                    ${u.Username.charAt(0).toUpperCase()}
                </div>
            </div>
            <span class="${u.Muted ? 'text-vc-muted line-through' : 'text-vc-text'}">${u.Username}</span>
            ${u.Muted ? '<svg class="w-3 h-3 text-vc-red ml-auto" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>' : ''}
            ${u.Speaking ? '<div class="ml-auto flex gap-0.5"><div class="w-1 h-3 bg-vc-accent rounded-full animate-pulse"></div><div class="w-1 h-4 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.1s"></div><div class="w-1 h-2 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.2s"></div></div>' : ''}
        </div>
    `).join('');

    // Update main content if this is the current channel
    if (channelID === currentChannelID) {
        updateMainContent(channelID, users);
    }
}

function updatePresence(channels) {
    for (const [chID, users] of Object.entries(channels)) {
        updateChannelUsers(parseInt(chID), users || []);
    }
}

function joinChannel(channelID, channelName) {
    if (currentChannelID === channelID) return;

    // Highlight active channel
    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });
    const item = document.querySelector(`[data-channel-id="${channelID}"]`);
    if (item) item.classList.add('bg-vc-hover/50');

    currentChannelID = channelID;
    sendWS({ type: 'join_channel', payload: { channel_id: channelID } });

    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        <div class="w-full h-full flex flex-col">
            <div class="px-6 py-4 border-b border-vc-border flex items-center gap-3">
                <svg class="w-6 h-6 text-vc-accent" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
                </svg>
                <h2 class="text-xl font-bold">${channelName}</h2>
                <button onclick="leaveChannel()" class="ml-auto px-4 py-1.5 bg-vc-red/20 hover:bg-vc-red/30 text-vc-red text-sm font-medium rounded-lg transition">
                    Leave Channel
                </button>
            </div>
            <div class="flex-1 flex items-center justify-center p-8" id="channel-view-users">
                <div class="text-center text-vc-muted">
                    <p>Joining channel...</p>
                </div>
            </div>
            <div class="px-6 py-3 border-t border-vc-border bg-vc-sidebar/50 flex items-center justify-center gap-4">
                <button onclick="toggleMute()" id="main-mute-btn"
                    class="flex items-center gap-2 px-4 py-2 rounded-lg bg-vc-channel hover:bg-vc-hover transition">
                    <svg class="w-5 h-5" id="main-icon-mic" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                        <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                    </svg>
                    <span id="main-mute-text">${isMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                <div class="text-xs text-vc-muted">Voice chat ready (WebRTC coming soon)</div>
            </div>
        </div>
    `;
}

function updateMainContent(channelID, users) {
    const container = document.getElementById('channel-view-users');
    if (!container) return;

    if (users.length === 0) {
        container.innerHTML = `
            <div class="text-center text-vc-muted">
                <p class="text-lg font-medium">Nobody here yet</p>
                <p class="text-sm mt-1">Invite your friends to join!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6">
            ${users.map(u => `
                <div class="flex flex-col items-center gap-3 p-4 rounded-xl bg-vc-sidebar/50 border border-vc-border fade-in">
                    <div class="relative">
                        <div class="w-16 h-16 rounded-full ${u.Speaking ? 'bg-vc-accent speaking-ring' : 'bg-vc-channel'} flex items-center justify-center text-2xl font-bold text-white transition-all">
                            ${u.Username.charAt(0).toUpperCase()}
                        </div>
                        ${u.Muted ? '<div class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-vc-red flex items-center justify-center"><svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg></div>' : ''}
                    </div>
                    <span class="text-sm font-medium ${u.Muted ? 'text-vc-muted' : 'text-vc-text'}">${u.Username}</span>
                    ${u.Speaking ? '<div class="flex gap-1"><div class="w-1.5 h-3 bg-vc-accent rounded-full animate-pulse"></div><div class="w-1.5 h-5 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.15s"></div><div class="w-1.5 h-3 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.3s"></div></div>' : '<div class="h-5"></div>'}
                </div>
            `).join('')}
        </div>
    `;
}

function leaveChannel() {
    if (!currentChannelID) return;
    sendWS({ type: 'leave_channel' });
    currentChannelID = null;

    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });

    document.getElementById('main-content').innerHTML = `
        <div class="text-center text-vc-muted">
            <svg class="w-20 h-20 mx-auto mb-4 opacity-20" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <p class="text-lg font-medium">Select a voice channel</p>
            <p class="text-sm mt-1">Click a channel to join and start talking</p>
        </div>
    `;
}

function toggleMute() {
    isMuted = !isMuted;
    sendWS({ type: 'mute', payload: { muted: isMuted } });

    // Update sidebar icons
    document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
    document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);

    // Update main content button if exists
    const mainBtn = document.getElementById('main-mute-text');
    if (mainBtn) mainBtn.textContent = isMuted ? 'Unmute' : 'Mute';
}

function sendWS(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// Init
connectWS();
