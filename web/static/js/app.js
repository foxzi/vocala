let ws = null;
let currentChannelID = null;
let isMuted = false;
let reconnectAttempts = 0;

// WebRTC state
let peerConnection = null;
let localStream = null;
let micReady = false;
let pushToTalk = false;
let pttActive = false;

// VAD state
let audioContext = null;
let analyser = null;
let vadInterval = null;
let isSpeaking = false;

// ─── WebSocket ────────────────────────────────────────────────

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
        reconnectAttempts = 0;
        setConnectionStatus('connected');
    };

    ws.onclose = () => {
        setConnectionStatus('reconnecting');
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
        case 'webrtc_answer':
            handleWebRTCAnswer(msg.payload);
            break;
        case 'webrtc_offer':
            handleWebRTCOffer(msg.payload);
            break;
        case 'ice_candidate':
            handleRemoteICECandidate(msg.payload);
            break;
    }
}

function setConnectionStatus(state) {
    const el = document.getElementById('connection-status');
    const rtcEl = document.getElementById('rtc-status');
    if (state === 'connected') {
        el.textContent = 'Connected';
        el.className = 'text-xs text-vc-green';
    } else if (state === 'reconnecting') {
        el.textContent = 'Reconnecting...';
        el.className = 'text-xs text-vc-yellow';
    }
    if (rtcEl) updateRTCStatus();
}

function sendWS(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// ─── Channel Users UI ─────────────────────────────────────────

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

    if (channelID === currentChannelID) {
        updateMainContent(channelID, users);
    }
}

function updatePresence(channels) {
    for (const [chID, users] of Object.entries(channels)) {
        updateChannelUsers(parseInt(chID), users || []);
    }
}

// ─── Channel Join/Leave ───────────────────────────────────────

function joinChannel(channelID, channelName) {
    if (currentChannelID === channelID) return;

    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });
    const item = document.querySelector(`[data-channel-id="${channelID}"]`);
    if (item) item.classList.add('bg-vc-hover/50');

    // Cleanup previous WebRTC
    cleanupWebRTC();

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
                <div id="rtc-status" class="flex items-center gap-1.5 ml-4">
                    <div class="w-2 h-2 rounded-full bg-vc-yellow animate-pulse"></div>
                    <span class="text-xs text-vc-yellow">Connecting...</span>
                </div>
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
                    class="flex items-center gap-2 px-4 py-2 rounded-lg ${isMuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel hover:bg-vc-hover text-vc-text'} transition">
                    <svg class="w-5 h-5" id="main-icon-mic" fill="currentColor" viewBox="0 0 24 24">
                        ${isMuted ?
                            '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>' :
                            '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>'}
                    </svg>
                    <span id="main-mute-text">${isMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button onclick="togglePTT()" id="ptt-btn"
                    class="flex items-center gap-2 px-4 py-2 rounded-lg ${pushToTalk ? 'bg-vc-accent/20 text-vc-accent' : 'bg-vc-channel hover:bg-vc-hover text-vc-muted'} transition text-sm">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
                    </svg>
                    PTT ${pushToTalk ? 'ON' : 'OFF'}
                </button>
                <div class="text-xs text-vc-muted" id="ptt-hint">${pushToTalk ? 'Hold Space to talk' : ''}</div>
            </div>
        </div>
    `;

    // Start WebRTC
    startWebRTC();
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
                <div class="flex flex-col items-center gap-3 p-4 rounded-xl bg-vc-sidebar/50 border ${u.Speaking ? 'border-vc-green shadow-lg shadow-vc-green/20' : 'border-vc-border'} fade-in transition-all duration-200">
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
    cleanupWebRTC();

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

// ─── Mute / PTT ───────────────────────────────────────────────

function toggleMute() {
    isMuted = !isMuted;
    sendWS({ type: 'mute', payload: { muted: isMuted } });

    // Mute/unmute the actual audio track
    if (localStream) {
        localStream.getAudioTracks().forEach(t => {
            t.enabled = !isMuted;
        });
    }

    // Update sidebar icons
    document.getElementById('icon-mic').classList.toggle('hidden', isMuted);
    document.getElementById('icon-mic-off').classList.toggle('hidden', !isMuted);

    // Update main content button
    const mainBtn = document.getElementById('main-mute-btn');
    const mainText = document.getElementById('main-mute-text');
    const mainIcon = document.getElementById('main-icon-mic');
    if (mainBtn) {
        mainBtn.className = `flex items-center gap-2 px-4 py-2 rounded-lg ${isMuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel hover:bg-vc-hover text-vc-text'} transition`;
    }
    if (mainText) mainText.textContent = isMuted ? 'Unmute' : 'Mute';
    if (mainIcon) {
        mainIcon.innerHTML = isMuted ?
            '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>' :
            '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>';
    }
}

function togglePTT() {
    pushToTalk = !pushToTalk;
    const btn = document.getElementById('ptt-btn');
    const hint = document.getElementById('ptt-hint');
    if (btn) {
        btn.className = `flex items-center gap-2 px-4 py-2 rounded-lg ${pushToTalk ? 'bg-vc-accent/20 text-vc-accent' : 'bg-vc-channel hover:bg-vc-hover text-vc-muted'} transition text-sm`;
        btn.innerHTML = `
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>
            PTT ${pushToTalk ? 'ON' : 'OFF'}`;
    }
    if (hint) hint.textContent = pushToTalk ? 'Hold Space to talk' : '';

    if (pushToTalk) {
        // In PTT mode, mute by default
        if (localStream) {
            localStream.getAudioTracks().forEach(t => { t.enabled = false; });
        }
    } else {
        // Open mic mode - respect mute state
        if (localStream) {
            localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
        }
    }
}

// ─── WebRTC ───────────────────────────────────────────────────

async function startWebRTC() {
    try {
        // Get microphone access
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });

        // Apply mute state
        localStream.getAudioTracks().forEach(t => {
            t.enabled = pushToTalk ? false : !isMuted;
        });

        // Setup VAD
        setupVAD(localStream);

        // Create peer connection
        peerConnection = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ],
        });

        // Add audio track
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });

        // Handle remote tracks (audio from other peers)
        peerConnection.ontrack = (event) => {
            const audio = new Audio();
            audio.srcObject = event.streams[0];
            audio.autoplay = true;
            audio.play().catch(() => {});
        };

        // ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendWS({
                    type: 'ice_candidate',
                    payload: { candidate: event.candidate.toJSON() },
                });
            }
        };

        // Connection state
        peerConnection.onconnectionstatechange = () => {
            updateRTCStatus();
        };

        peerConnection.oniceconnectionstatechange = () => {
            updateRTCStatus();
        };

        // Create and send offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        sendWS({
            type: 'webrtc_offer',
            payload: { sdp: offer.sdp },
        });

    } catch (err) {
        console.error('WebRTC setup failed:', err);
        updateRTCStatusText('error', 'Mic access denied');
    }
}

function handleWebRTCAnswer(payload) {
    if (!peerConnection) return;
    peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: payload.sdp })
    ).catch(err => console.error('Failed to set remote description:', err));
}

async function handleWebRTCOffer(payload) {
    // Server-initiated renegotiation (new peer joined with audio)
    if (!peerConnection) return;

    await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp: payload.sdp })
    );

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendWS({
        type: 'webrtc_answer',
        payload: { sdp: answer.sdp },
    });
}

function handleRemoteICECandidate(payload) {
    if (!peerConnection) return;
    peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate))
        .catch(err => console.error('Failed to add ICE candidate:', err));
}

function cleanupWebRTC() {
    if (vadInterval) {
        clearInterval(vadInterval);
        vadInterval = null;
    }
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
        analyser = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    isSpeaking = false;
}

function updateRTCStatus() {
    if (!peerConnection) return;
    const state = peerConnection.connectionState || peerConnection.iceConnectionState;
    switch (state) {
        case 'connected':
        case 'completed':
            updateRTCStatusText('connected', 'Voice connected');
            break;
        case 'connecting':
        case 'checking':
        case 'new':
            updateRTCStatusText('connecting', 'Connecting...');
            break;
        case 'disconnected':
            updateRTCStatusText('warning', 'Disconnected');
            break;
        case 'failed':
            updateRTCStatusText('error', 'Connection failed');
            break;
        case 'closed':
            updateRTCStatusText('error', 'Closed');
            break;
    }
}

function updateRTCStatusText(state, text) {
    const el = document.getElementById('rtc-status');
    if (!el) return;

    const colors = {
        connected: { dot: 'bg-vc-green', text: 'text-vc-green', pulse: '' },
        connecting: { dot: 'bg-vc-yellow', text: 'text-vc-yellow', pulse: 'animate-pulse' },
        warning: { dot: 'bg-vc-yellow', text: 'text-vc-yellow', pulse: '' },
        error: { dot: 'bg-vc-red', text: 'text-vc-red', pulse: '' },
    };
    const c = colors[state] || colors.error;
    el.innerHTML = `
        <div class="w-2 h-2 rounded-full ${c.dot} ${c.pulse}"></div>
        <span class="text-xs ${c.text}">${text}</span>
    `;
}

// ─── Voice Activity Detection ─────────────────────────────────

function setupVAD(stream) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const THRESHOLD = 25;
    let silenceCount = 0;
    const SILENCE_DELAY = 5; // ~250ms at 50ms intervals

    vadInterval = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        const avg = sum / dataArray.length;

        // Check if track is actually enabled (not muted, and not PTT-inactive)
        const trackEnabled = localStream && localStream.getAudioTracks()[0]?.enabled;

        if (avg > THRESHOLD && trackEnabled) {
            silenceCount = 0;
            if (!isSpeaking) {
                isSpeaking = true;
                sendWS({ type: 'speaking', payload: { speaking: true } });
            }
        } else {
            silenceCount++;
            if (silenceCount >= SILENCE_DELAY && isSpeaking) {
                isSpeaking = false;
                sendWS({ type: 'speaking', payload: { speaking: false } });
            }
        }
    }, 50);
}

// ─── Push-to-Talk Keyboard ────────────────────────────────────

document.addEventListener('keydown', (e) => {
    if (!pushToTalk || !localStream) return;
    if (e.code === 'Space' && !e.repeat && !isInputFocused()) {
        e.preventDefault();
        pttActive = true;
        localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    }
});

document.addEventListener('keyup', (e) => {
    if (!pushToTalk || !localStream) return;
    if (e.code === 'Space' && !isInputFocused()) {
        e.preventDefault();
        pttActive = false;
        localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    }
});

function isInputFocused() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.contentEditable === 'true');
}

// ─── Init ─────────────────────────────────────────────────────

connectWS();
