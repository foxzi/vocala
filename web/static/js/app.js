let ws = null;
let currentChannelID = null;
let isCurrentChannelDM = false;
let isDMHuddleActive = false;
let incomingCallChannelID = null;
let outgoingCallChannelID = null;
let outgoingCalleeUserId = null;
let outgoingCalleeUsername = null;
let activeCallChannelID = null;
let activeCallChannelName = null;
let isMuted = localStorage.getItem('vocala-muted') === 'true';
let reconnectAttempts = 0;
let wsLastOpenAt = 0;
let wsRapidBounceCount = 0;
let wsBouncedOut = false;

// XSS-safe HTML escaping
const SPEAKING_LABELS = ['bzzz', 'oooo', 'aaaa', 'yoho', 'wooo', 'hehe', 'mhm', 'pew', 'rawr', 'meow', 'woof', 'yay', 'huh', 'ohno', 'blah', 'nani', 'eeek', 'gulp', 'zzz', 'bam', 'pow', 'boop', 'nom', 'uwu', 'aha', 'hmm', 'eep', 'oof', 'yip', 'arr'];
function randomSpeakingLabel() {
    return SPEAKING_LABELS[Math.floor(Math.random() * SPEAKING_LABELS.length)];
}

function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- Sound notifications (Web Audio API, no external files) ---

let notifSoundsEnabled = localStorage.getItem('vocala-sounds') !== 'off';

function playTone(freq, duration, type, vol) {
    if (!notifSoundsEnabled) return;
    try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type || 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol || 0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
        setTimeout(() => ctx.close(), (duration + 0.1) * 1000);
    } catch (e) {}
}

function playJoinSound() {
    playTone(520, 0.12, 'sine', 0.12);
    setTimeout(() => playTone(660, 0.12, 'sine', 0.12), 80);
    setTimeout(() => playTone(780, 0.15, 'sine', 0.10), 160);
}

function playLeaveSound() {
    playTone(660, 0.12, 'sine', 0.10);
    setTimeout(() => playTone(520, 0.15, 'sine', 0.08), 100);
}

function playChatSound() {
    playTone(880, 0.08, 'sine', 0.08);
    setTimeout(() => playTone(1100, 0.1, 'sine', 0.06), 60);
}

let _ringtoneTimer = null;
function startRingtone() {
    if (_ringtoneTimer) return;
    const ring = () => {
        playTone(880, 0.18, 'sine', 0.18);
        setTimeout(() => playTone(660, 0.18, 'sine', 0.18), 220);
    };
    ring();
    _ringtoneTimer = setInterval(ring, 2000);
}
function stopRingtone() {
    if (_ringtoneTimer) {
        clearInterval(_ringtoneTimer);
        _ringtoneTimer = null;
    }
}

function toggleSounds() {
    notifSoundsEnabled = !notifSoundsEnabled;
    localStorage.setItem('vocala-sounds', notifSoundsEnabled ? 'on' : 'off');
    return notifSoundsEnabled;
}

function toggleRnnoise() {
    rnnoiseEnabled = !rnnoiseEnabled;
    localStorage.setItem('vocala-rnnoise', rnnoiseEnabled ? '1' : '0');
    return rnnoiseEnabled;
}

function toggleAgc() {
    agcEnabled = !agcEnabled;
    localStorage.setItem('vocala-agc', agcEnabled ? '1' : '0');
    if (localStream) {
        localStream.getAudioTracks().forEach(t => {
            t.applyConstraints({ autoGainControl: agcEnabled }).catch(() => {});
        });
    }
    return agcEnabled;
}

function toggleNoiseSuppression() {
    noiseSuppressionEnabled = !noiseSuppressionEnabled;
    localStorage.setItem('vocala-ns', noiseSuppressionEnabled ? '1' : '0');
    if (localStream) {
        const effective = noiseSuppressionEnabled && !rnnoiseEnabled;
        localStream.getAudioTracks().forEach(t => {
            t.applyConstraints({ noiseSuppression: effective }).catch(() => {});
        });
    }
    return noiseSuppressionEnabled;
}

// --- Browser notifications ---

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

function showNotification(text) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return; // Only when tab is not focused
    try {
        new Notification('Vocala', { body: text, icon: '/static/img/favicon.svg', tag: 'vocala-notif' });
    } catch (e) {}
}

// --- Local mute (per-user, client-side only) ---
const localMutedUsers = new Set(JSON.parse(localStorage.getItem('vocala-local-muted') || '[]'));

function toggleLocalMute(userId) {
    const uid = String(userId);
    if (localMutedUsers.has(uid)) {
        localMutedUsers.delete(uid);
    } else {
        localMutedUsers.add(uid);
    }
    localStorage.setItem('vocala-local-muted', JSON.stringify([...localMutedUsers]));
    // Apply to audio elements
    document.querySelectorAll('audio[data-uid]').forEach(el => {
        if (el.dataset.uid === uid) el.muted = localMutedUsers.has(uid);
    });
}

function isLocalMuted(userId) {
    return localMutedUsers.has(String(userId));
}

function forceMuteUser(userId) {
    sendWS({ type: 'force_mute', payload: { user_id: userId } });
}

// Local pixel-art avatar by username hash
const AVATAR_COUNT = 50;
function avatarURL(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
        hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % AVATAR_COUNT;
    return `/static/img/avatars/pa${idx}.svg`;
}

// WebRTC state
let peerConnection = null;
let localStream = null;
let micReady = false;
let pushToTalk = localStorage.getItem('vocala-ptt') === 'true';
let pttActive = false;

// VAD state
let audioContext = null;
let analyser = null;
let gainNode = null;
let processedStream = null; // audio stream routed through GainNode for VAD control
let vadInterval = null;
let isSpeaking = false;
let vadThreshold = parseInt(localStorage.getItem('vocala-vad-threshold')) || 15;
let currentVadLevel = 0;

// Screen share state
let screenStream = null;
let screenSender = null;
let screenAdaptiveCleanup = null;
let isScreenSharing = false;
let screenPreviewInterval = null;
let latestScreenPreview = null;
let screenShareUsername = null;

// Camera state
let cameraStream = null;
let cameraSender = null;
let cameraAdaptiveCleanup = null;
let isCameraOn = localStorage.getItem('vocala-camera') === 'true';

// Adaptive publisher bitrate tiers (bps). Start at tier 0, step down on
// qualityLimitationReason==='bandwidth', step up after 15s clean.
const CAMERA_BITRATE_TIERS_BPS = [1_200_000, 800_000, 500_000, 300_000, 150_000];
const SCREEN_BITRATE_TIERS_BPS = [2_500_000, 1_500_000, 800_000, 400_000];
let remoteCameras = {}; // userID -> { stream, username }
let lastServerOfferTime = 0;

// ─── WebSocket ────────────────────────────────────────────────

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsParams = '';
    if (window.VOCALA_GUEST_CHANNEL) {
        wsParams = '?guest=1';
        if (window.VOCALA_GUEST_TOKEN) wsParams += '&token=' + encodeURIComponent(window.VOCALA_GUEST_TOKEN);
    }
    ws = new WebSocket(`${proto}//${location.host}/ws${wsParams}`);

    ws.onopen = () => {
        reconnectAttempts = 0;
        wsLastOpenAt = Date.now();
        setConnectionStatus('connected');
        const dbg = document.getElementById('guest-debug');
        if (dbg) dbg.textContent = 'WS connected, joining channel ' + (window.VOCALA_GUEST_CHANNEL || 'none');

        if (currentChannelID) {
            const chID = currentChannelID;
            const pcAlive = peerConnection &&
                peerConnection.connectionState !== 'failed' &&
                peerConnection.connectionState !== 'closed' &&
                peerConnection.connectionState !== 'disconnected';
            if (pcAlive) {
                // PC survived the WS blip — just re-announce presence on the server.
                sendWS({ type: 'join_channel', payload: { channel_id: chID } });
            } else {
                const wasCameraOn = isCameraOn;
                cleanupWebRTC();
                currentChannelID = chID;
                sendWS({ type: 'join_channel', payload: { channel_id: chID } });
                startWebRTC().then(() => {
                    if (wasCameraOn) startCamera();
                });
            }
        } else if (window.VOCALA_GUEST_CHANNEL) {
            // Guest auto-join their assigned channel
            try {
                joinChannel(window.VOCALA_GUEST_CHANNEL, window.VOCALA_GUEST_NAME || 'Channel');
            } catch (e) {
                const dbg2 = document.getElementById('guest-debug');
                if (dbg2) dbg2.textContent = 'joinChannel error: ' + e.message;
                console.error('Guest joinChannel failed:', e);
            }
        } else if (window.VOCALA_AUTO_JOIN) {
            // Auto-join from URL on first connect
            autoJoinFromURL();
        }
    };

    ws.onclose = (e) => {
        console.warn('WS closed: code=' + e.code + ' reason=' + (e.reason || '(none)') + ' wasClean=' + e.wasClean);
        if (wsLastOpenAt > 0 && Date.now() - wsLastOpenAt < 2000) {
            wsRapidBounceCount++;
        } else {
            wsRapidBounceCount = 0;
        }
        if (wsRapidBounceCount >= 3 && !wsBouncedOut) {
            wsBouncedOut = true;
            setConnectionStatus('reconnecting');
            showDoubleLoginBanner();
            return;
        }
        setConnectionStatus('reconnecting');
        const dbg = document.getElementById('guest-debug');
        if (dbg) dbg.textContent = 'WS closed: code=' + e.code + ' reason=' + e.reason;
        const delay = reconnectAttempts === 0 ? 0 : Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
        reconnectAttempts++;
        setTimeout(connectWS, delay);
    };

    ws.onerror = (e) => {
        console.error('WS error', e);
        const dbg = document.getElementById('guest-debug');
        if (dbg) dbg.textContent = 'WS error';
        ws.close();
    };

    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            handleWSMediaFrame(event.data);
            return;
        }
        const msg = JSON.parse(event.data);
        handleWSMessage(msg);
    };
}

function handleWSMessage(msg) {
    switch (msg.type) {
        case 'error':
            if (msg.error === 'access_denied') {
                alert(msg.text || 'Access denied');
            }
            break;
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
        case 'force_muted':
            // Admin force-muted you
            if (!isMuted) {
                isMuted = true;
                localStorage.setItem('vocala-muted', 'true');
                if (gainNode) gainNode.gain.value = 0.0;
                updateMuteUI();
            }
            break;
        case 'camera_on':
            {
                const stale = document.getElementById('remote-cam-camera-' + msg.user_id);
                if (stale) {
                    const v = stale.querySelector('video');
                    if (v) { try { v.pause(); } catch (_) {} v.srcObject = null; }
                    stale.remove();
                    updateGridColumns();
                }
            }
            // Someone turned on camera — check if we see it after delay
            setTimeout(() => {
                const el = document.getElementById('remote-cam-camera-' + msg.user_id);
                if (!el && peerConnection && peerConnection.signalingState === 'stable') {
                    console.log('Camera from user', msg.user_id, 'not received, requesting renegotiation');
                    peerConnection.createOffer().then(offer => {
                        return peerConnection.setLocalDescription(offer);
                    }).then(() => {
                        sendWS({ type: 'webrtc_offer', payload: { sdp: peerConnection.localDescription.sdp } });
                    }).catch(e => console.error('Renegotiation request failed:', e));
                }
            }, 3000);
            break;
        case 'camera_off':
            {
                const camElId = 'remote-cam-camera-' + msg.user_id;
                if (document.getElementById(camElId)) {
                    removeFromCameraGrid(camElId);
                }
            }
            break;
        case 'chat_message':
            appendChatMessage(msg);
            if (typeof loadDMListDebounced === 'function') loadDMListDebounced();
            const selfNameForChat = document.getElementById('self-avatar')?.dataset?.username;
            const fromOther = msg.username !== selfNameForChat;
            if (typeof bumpDMUnread === 'function' && msg.kind !== 'system' && fromOther) {
                bumpDMUnread(msg.channel_id);
            }
            if (fromOther && msg.kind !== 'system' && msg.channel_id === currentChannelID && isInCallChatPanelHidden()) {
                inCallChatUnread++;
                updateChatButtonBadge();
            }
            break;
        case 'chat_history':
            loadChatHistory(msg.messages || [], msg.reactions || []);
            break;
        case 'chat_cleared':
            const chatContainer = document.getElementById('chat-messages');
            if (chatContainer) chatContainer.innerHTML = '';
            break;
        case 'chat_reaction':
            addChatReaction(msg);
            break;
        case 'voice_reaction':
            showVoiceReaction(msg);
            break;
        case 'huddle_invite':
            showHuddleInvite(msg);
            loadDMListDebounced();
            break;
        case 'huddle_started':
            outgoingCallChannelID = msg.channel_id;
            updateCallIndicators();
            if (!(currentChannelID === msg.channel_id && isDMHuddleActive)) {
                currentChannelID = null;
                joinChannel(msg.channel_id, msg.channel_name, { forceHuddle: true });
            }
            loadDMListDebounced();
            loadGroupListDebounced();
            break;
        case 'huddle_declined':
            outgoingCallChannelID = null;
            outgoingCalleeUserId = null;
            outgoingCalleeUsername = null;
            removeOutgoingPhantomCard();
            updateCallIndicators();
            showToast(msg.missed ? (msg.from_name || 'User') + ' missed your call' : (msg.from_name || 'User') + ' declined the huddle');
            break;
        case 'huddle_ended':
            outgoingCallChannelID = null;
            outgoingCalleeUserId = null;
            outgoingCalleeUsername = null;
            removeOutgoingPhantomCard();
            updateCallIndicators();
            if (currentChannelID === msg.channel_id) {
                if (msg.is_dm && isDMHuddleActive && msg.from_user_id !== undefined) {
                    isDMHuddleActive = false;
                    chatOnlyChannelID = msg.channel_id;
                    cleanupWebRTC();
                    const dmRow = document.querySelector(`#dm-list [data-dm-channel="${msg.channel_id}"]`);
                    const otherName = dmRow ? (dmRow.querySelector('.text-vc-text')?.textContent || (msg.from_name || 'Direct message')) : (msg.from_name || 'Direct message');
                    sendWS({ type: 'leave_channel' });
                    renderChannelChatOnly(msg.channel_id, otherName, { isDM: true });
                    sendWS({ type: 'peek_history', payload: { channel_id: msg.channel_id } });
                } else {
                    showToast((msg.from_name || 'Someone') + ' left the huddle');
                }
                loadDMListDebounced();
            }
            break;
        case 'chat_reaction_remove':
            removeChatReaction(msg);
            break;
        case 'screen_preview':
            // Only accept data: URIs to prevent injection via url()
            if (msg.payload.image && msg.payload.image.startsWith('data:image/')) {
                latestScreenPreview = msg.payload.image;
            }
            screenShareUsername = msg.username || null;
            if (!document.getElementById('screen-share-play-overlay') &&
                (!document.getElementById('screen-share-video') || document.getElementById('screen-share-video').classList.contains('hidden'))) {
                // No video playing yet — show a preview container so user sees something is shared
                showScreenPreviewPlaceholder();
            }
            break;
        case 'screen_preview_clear':
            latestScreenPreview = null;
            screenShareUsername = null;
            removeRemoteVideo();
            break;
        case 'screen_off':
            {
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
                const grid = document.getElementById('camera-grid');
                let removed = 0;
                if (grid) {
                    grid.querySelectorAll('[id^="remote-screen-share-"]').forEach(el => {
                        const v = el.querySelector('video');
                        if (v) { try { v.pause(); } catch (_) {} v.srcObject = null; }
                        el.remove();
                        removed++;
                    });
                    updateGridColumns();
                }
                const wasMainGone = expandedCamId && !document.getElementById(expandedCamId);
                if (wasMainGone) {
                    expandedCamId = null;
                    promoteNextMediaToMainStage();
                }
                if (!expandedCamId) {
                    document.body.classList.remove('expanded-tile-mode');
                    clearExpandedUsersRail();
                }
                attachUserPreviewsToCards();
                latestScreenPreview = null;
                screenShareUsername = null;
            }
            break;
    }
}

function setConnectionStatus(state) {
    const el = document.getElementById('connection-status');
    const rtcEl = document.getElementById('rtc-status');
    if (el) {
        if (state === 'connected') {
            el.textContent = 'Connected';
            el.className = 'text-xs text-vc-green';
        } else if (state === 'reconnecting') {
            el.textContent = 'Reconnecting...';
            el.className = 'text-xs text-vc-yellow';
        }
    }
    if (rtcEl) updateRTCStatus();
}

function sendWS(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// ─── Channel Users UI ─────────────────────────────────────────

// Track users per channel for join/leave sound detection and preview
const channelUserSets = {};
const channelUsersData = {}; // channelID -> [{Username, ID, Muted, Speaking}, ...]

function updateChannelUsers(channelID, users) {
    users = (users || []).map(u => u.Muted ? { ...u, Speaking: false } : u);
    const container = document.getElementById(`ch-users-${channelID}`);
    const countEl = document.getElementById(`ch-count-${channelID}`);

    // Store for preview
    channelUsersData[channelID] = users;
    if (outgoingCallChannelID === channelID && outgoingCalleeUserId) {
        const joined = users.some(u => u.ID === outgoingCalleeUserId);
        if (joined) {
            outgoingCallChannelID = null;
            outgoingCalleeUserId = null;
            outgoingCalleeUsername = null;
            if (typeof removeOutgoingPhantomCard === 'function') removeOutgoingPhantomCard();
        }
    }
    if (typeof updateActiveHuddleBadges === 'function') updateActiveHuddleBadges();
    if (typeof updateCallIndicators === 'function') updateCallIndicators();

    // Update preview if currently previewing this channel
    if (previewChannelID === channelID && currentChannelID !== channelID) {
        const previewUsers = document.getElementById('preview-users');
        if (previewUsers) {
            if (users.length > 0) {
                previewUsers.innerHTML = `
                    <div class="text-sm text-vc-muted mb-2">${users.length} user${users.length > 1 ? 's' : ''} in channel:</div>
                    <div class="flex flex-wrap justify-center gap-3 mb-4">
                        ${users.map(u => `
                            <div class="flex items-center gap-2 px-3 py-1.5 bg-vc-channel rounded-lg">
                                <img src="${avatarURL(u.Username)}" class="w-6 h-6 rounded-full">
                                <span class="text-sm text-vc-text">${escapeHTML(u.Username)}</span>
                                ${u.Muted ? '<svg class="w-3 h-3 text-vc-red" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>' : ''}
                                ${u.Speaking ? '<div class="flex gap-0.5"><div class="w-1 h-2 bg-vc-green rounded-full animate-pulse"></div><div class="w-1 h-3 bg-vc-green rounded-full animate-pulse" style="animation-delay:0.1s"></div></div>' : ''}
                            </div>
                        `).join('')}
                    </div>`;
            } else {
                previewUsers.innerHTML = '<div class="text-sm text-vc-muted mb-4">No one in this channel</div>';
            }
        }
    }

    // Detect join/leave in current channel for sounds + notifications
    if (channelID === currentChannelID) {
        const oldSet = channelUserSets[channelID] || new Set();
        const newSet = new Set(users.map(u => u.Username));
        const selfName = document.getElementById('self-avatar')?.dataset?.username;
        for (const name of newSet) {
            if (!oldSet.has(name) && name !== selfName && oldSet.size > 0) {
                playJoinSound();
                showNotification(name + ' joined the channel');
            }
        }
        for (const name of oldSet) {
            if (!newSet.has(name) && name !== selfName) {
                playLeaveSound();
            }
        }
        channelUserSets[channelID] = newSet;
    }

    // Sort for stable order
    users.sort((a, b) => a.Username.localeCompare(b.Username));

    // Update sidebar (may not exist for guests)
    if (container) {
        if (countEl) {
            countEl.textContent = users.length > 0 ? `${users.length} connected` : '';
        }

        const currentUsernames = new Set(users.map(u => u.Username));
        const existingItems = container.querySelectorAll('[data-sidebar-user]');
        const existingMap = {};
        existingItems.forEach(el => { existingMap[el.dataset.sidebarUser] = el; });

        existingItems.forEach(el => {
            if (!currentUsernames.has(el.dataset.sidebarUser)) el.remove();
        });

        users.forEach(u => {
            const existing = existingMap[u.Username];
            if (existing) {
                const avatar = existing.querySelector('.sb-avatar');
                if (avatar) avatar.className = `sb-avatar w-6 h-6 rounded-full ${u.Speaking ? 'ring-2 ring-vc-green/40' : ''} overflow-hidden`;
                const name = existing.querySelector('.sb-name');
                if (name) name.className = `sb-name ${u.Muted ? 'text-vc-muted' : 'text-vc-text'}`;
                const muteIcon = existing.querySelector('.sb-mute');
                if (muteIcon) muteIcon.style.display = u.Muted ? '' : 'none';
                const speakingEl = existing.querySelector('.sb-speaking');
                if (speakingEl) speakingEl.style.display = u.Speaking ? '' : 'none';
            } else {
                const selfName = document.getElementById('self-avatar')?.dataset?.username || window.VOCALA_GUEST_NAME;
                const isSelf = u.Username === selfName;
                const div = document.createElement('div');
                div.dataset.sidebarUser = u.Username;
                div.dataset.userId = u.ID;
                div.className = 'group flex items-center gap-2 px-2 py-1 rounded text-sm fade-in hover:bg-vc-hover/40';
                div.innerHTML = `
                    <div class="relative">
                        <div class="sb-avatar w-6 h-6 rounded-full ${u.Speaking ? 'ring-2 ring-vc-green/40' : ''} overflow-hidden">
                            <img src="${avatarURL(u.Username)}" alt="" class="w-full h-full">
                        </div>
                    </div>
                    <span class="sb-name flex-1 truncate ${u.Muted ? 'text-vc-muted line-through' : 'text-vc-text'}">${escapeHTML(u.Username)}</span>
                    <svg class="sb-mute w-3 h-3 text-vc-red" fill="currentColor" viewBox="0 0 24 24" style="display:${u.Muted ? '' : 'none'}"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                    <div class="sb-speaking flex gap-0.5" style="display:${u.Speaking ? '' : 'none'}"><div class="w-1 h-3 bg-vc-accent rounded-full animate-pulse"></div><div class="w-1 h-4 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.1s"></div><div class="w-1 h-2 bg-vc-accent rounded-full animate-pulse" style="animation-delay:0.2s"></div></div>
                `;
                container.appendChild(div);
            }
        });
    }

    // Update main content user cards
    if (channelID === currentChannelID) {
        updateMainContent(channelID, users);
    }
}

function updatePresence(channels) {
    const seen = new Set();
    for (const [chID, users] of Object.entries(channels)) {
        const id = parseInt(chID);
        seen.add(id);
        updateChannelUsers(id, users || []);
    }
    for (const id of Object.keys(channelUsersData)) {
        const numId = parseInt(id);
        if (!seen.has(numId) && (channelUsersData[numId] || []).length > 0) {
            updateChannelUsers(numId, []);
        }
    }
}

// ─── Mobile Sidebar ───────────────────────────────────────────

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const isOpen = !sidebar.classList.contains('-translate-x-full');
    if (isOpen) {
        sidebar.classList.add('-translate-x-full');
        overlay.classList.add('hidden');
    } else {
        sidebar.classList.remove('-translate-x-full');
        overlay.classList.remove('hidden');
    }
}

let inCallChatUnread = 0;

function toggleMobileChat() {
    const panel = document.getElementById('chat-panel');
    if (!panel) return;
    const wasHidden = panel.classList.contains('hidden') || panel.classList.contains('chat-hidden');
    panel.classList.remove('hidden', 'chat-hidden');
    panel.classList.add('flex');
    if (!wasHidden) {
        panel.classList.add('hidden', 'chat-hidden');
        panel.classList.remove('flex');
        return;
    }
    inCallChatUnread = 0;
    updateChatButtonBadge();
    const msgs = document.getElementById('chat-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
}

function isInCallChatPanelHidden() {
    const panel = document.getElementById('chat-panel');
    if (!panel) return true;
    return panel.classList.contains('hidden') || panel.classList.contains('chat-hidden');
}

function updateChatButtonBadge() {
    const btn = document.getElementById('bar-chat-btn');
    if (!btn) return;
    let badge = btn.querySelector('.chat-unread-badge');
    if (inCallChatUnread > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'chat-unread-badge absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-vc-red text-white text-[10px] font-bold flex items-center justify-center pointer-events-none';
            btn.appendChild(badge);
        }
        badge.textContent = inCallChatUnread > 99 ? '99+' : String(inCallChatUnread);
    } else if (badge) {
        badge.remove();
    }
}

function closeSidebarOnMobile() {
    if (window.innerWidth < 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (sidebar) sidebar.classList.add('-translate-x-full');
        if (overlay) overlay.classList.add('hidden');
    }
}

// ─── Channel Preview & Join ───────────────────────────────────

let previewChannelID = null;

function previewChannel(channelID, channelName, isPrivate) {
    if (currentChannelID === channelID) return;
    joinChannel(channelID, channelName, { chatOnly: true });
}

let chatOnlyChannelID = null;

function joinChannel(channelID, channelName, opts) {
    if (currentChannelID === channelID && !opts?.forceHuddle) return;

    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });
    const item = document.querySelector(`[data-channel-id="${channelID}"]`);
    if (item) item.classList.add('bg-vc-hover/50');

    // Clicking the channel we're already voice-joined to (after peeking
    // elsewhere) just restores the call view — don't rejoin or teardown.
    // This applies even when the click path defaults to chatOnly (DM/group),
    // because the user clearly wants their active call back.
    if (activeCallChannelID === channelID && !opts?.forceHuddle) {
        returnToActiveCall();
        return;
    }

    const isDM = !!opts?.isDM || dmChannelIds.has(channelID) || /^dm-\d+-\d+$/.test(String(channelName || ''));
    const startHuddleNow = !!opts?.forceHuddle;
    const chatOnly = (!!opts?.chatOnly || (isDM && !startHuddleNow)) && !startHuddleNow;

    // If we're already voice-joined to a different channel and the user is
    // just peeking another channel's chat — keep the call alive in the
    // background instead of tearing it down and yanking them out.
    const keepCallAlive = chatOnly && activeCallChannelID && activeCallChannelID !== channelID;
    if (!keepCallAlive) {
        cleanupWebRTC();
    } else {
        stashCallView();
    }

    currentChannelID = channelID;
    isCurrentChannelDM = isDM;
    isDMHuddleActive = isDM && startHuddleNow;
    inCallChatUnread = 0;
    setTimeout(updateChatButtonBadge, 0);
    if (isDM && typeof clearDMUnread === 'function') {
        clearDMUnread(channelID);
    }
    chatOnlyChannelID = chatOnly ? channelID : null;
    if (chatOnly) {
        if (!keepCallAlive) {
            sendWS({ type: 'leave_channel' });
        }
        sendWS({ type: 'peek_history', payload: { channel_id: channelID } });
    } else {
        sendWS({ type: 'join_channel', payload: { channel_id: channelID } });
    }

    // Update URL to permanent link
    if (!window.VOCALA_GUEST_CHANNEL) {
        history.pushState({ channelID, channelName }, '', '/channels/' + encodeURIComponent(channelName));
    }

    // Close sidebar on mobile and update mobile header
    closeSidebarOnMobile();
    const mobileChName = document.getElementById('mobile-channel-name');
    if (mobileChName) mobileChName.textContent = channelName;

    if (chatOnly || (isCurrentChannelDM && !isDMHuddleActive)) {
        try { sessionStorage.removeItem('vocala-in-call'); } catch (_) {}
        renderChannelChatOnly(channelID, channelName, { isDM: isCurrentChannelDM });
        return;
    }

    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        <div class="w-full h-full flex flex-col">
            <div class="px-4 md:px-6 py-3 border-b border-vc-border flex items-center gap-2 md:gap-3">
                <svg class="w-5 h-5 md:w-6 md:h-6 text-vc-accent flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
                </svg>
                <h2 class="text-base md:text-xl font-bold truncate">${escapeHTML(channelName)}</h2>
                <div id="rtc-status" class="flex items-center gap-1.5 ml-2 flex-shrink-0">
                    <div class="w-2 h-2 rounded-full bg-vc-yellow animate-pulse"></div>
                    <span class="text-xs text-vc-yellow">Connecting...</span>
                </div>
                <div class="ml-auto flex items-center gap-2">
                    ${window.VOCALA_GUEST_CHANNEL ? '' : `<button onclick="createGuestLink(${channelID})" class="px-3 py-1.5 bg-vc-channel hover:bg-vc-hover text-vc-muted hover:text-vc-text text-xs md:text-sm rounded-lg transition flex-shrink-0 border border-vc-border" title="Generate guest invite link">
                        Guest Link
                    </button>`}
                </div>
            </div>
            <div class="flex-1 flex flex-col md:flex-row overflow-hidden">
                <!-- Voice/Video area -->
                <div id="voice-area" class="flex-1 flex flex-col overflow-y-auto p-3 md:p-6 min-h-0 relative">
                    <div id="screen-share-anchor"></div>
                    <div class="flex-1 flex items-center justify-center pt-3" id="channel-view-users">
                        <div class="text-center text-vc-muted">
                            <p>Joining channel...</p>
                        </div>
                    </div>
                    <div id="expanded-users-rail"></div>
                </div>
                <!-- Chat panel — hidden by default on all viewports; toggle with the chat button. -->
                <div id="chat-panel" class="w-full md:w-64 border-t md:border-t-0 md:border-l border-vc-border flex-col bg-vc-sidebar/30 max-h-64 md:max-h-none hidden chat-hidden">
                    <div class="px-3 py-2 border-b border-vc-border flex items-center gap-2">
                        <svg class="w-4 h-4 text-vc-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                        </svg>
                        <span class="text-xs font-medium text-vc-muted">Chat</span>
                        <div class="ml-auto flex items-center gap-2">
                            ${window.VOCALA_IS_ADMIN ? `<button onclick="clearChat()" class="text-[10px] text-vc-muted hover:text-vc-red transition" title="Clear chat history">Clear</button>` : ''}
                            <button onclick="toggleMobileChat()" class="flex items-center gap-1 text-[10px] text-vc-muted hover:text-vc-text px-2 py-0.5 rounded border border-vc-border hover:bg-vc-hover transition" title="Hide chat">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                                <span>Hide</span>
                            </button>
                        </div>
                    </div>
                    <div id="chat-messages" class="flex-1 overflow-y-auto p-2 space-y-1 min-h-0"></div>
                    <div class="p-2 border-t border-vc-border">
                        <form onsubmit="sendChatMessage(event)" class="flex gap-1.5">
                            <input type="text" id="chat-input" placeholder="Message..." autocomplete="off"
                                class="flex-1 px-2.5 py-1.5 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                            <button type="submit" class="px-2.5 py-1.5 bg-vc-accent hover:bg-vc-accent/80 text-white rounded-lg transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                                </svg>
                            </button>
                        </form>
                    </div>
                </div>
            </div>
            <div class="channel-controls-bar flex-shrink-0 sticky bottom-0 z-50 px-3 md:px-6 py-2 md:py-3 border-t border-vc-border bg-vc-sidebar" style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 0.5rem);">
                <!-- Row 1: Main buttons -->
                <div class="flex items-center justify-center gap-2 md:gap-3">
                    <button onclick="toggleMute()" id="main-mute-btn" title="${isMuted ? 'Unmute' : 'Mute'}"
                        class="flex items-center justify-center w-10 h-10 rounded-full ${isMuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel hover:bg-vc-hover text-vc-text'} transition">
                        <svg class="w-5 h-5" id="main-icon-mic" fill="currentColor" viewBox="0 0 24 24">
                            ${isMuted ?
                                '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.08c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>' :
                                '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>'}
                        </svg>
                        <span id="main-mute-text" class="sr-only">${isMuted ? 'Unmute' : 'Mute'}</span>
                    </button>
                    <button onclick="toggleCamera()" id="camera-btn" title="Toggle camera"
                        class="flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                        </svg>
                    </button>
                    <button onclick="isScreenSharing ? stopScreenShare() : startScreenShare()" id="screen-share-btn" title="Share screen"
                        class="flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                        </svg>
                    </button>
                    <button onclick="showBarReactionPicker(this)" id="bar-react-btn" title="Send reaction"
                        class="flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                    </button>
                    <button onclick="togglePTT()" id="ptt-btn" title="Push to talk: ${pushToTalk ? 'ON' : 'OFF'}"
                        class="flex items-center justify-center w-10 h-10 rounded-full ${pushToTalk ? 'bg-vc-accent/20 text-vc-accent' : 'bg-vc-channel hover:bg-vc-hover text-vc-muted'} transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
                        </svg>
                    </button>
                    <button id="bar-chat-btn" onclick="toggleMobileChat()" title="Toggle chat"
                        class="relative flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                        </svg>
                    </button>
                    <button onclick="openAddToCallPicker()" title="Add people to the call"
                        class="flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/></svg>
                    </button>
                    <button onclick="hangUp()" title="End call"
                        class="flex items-center justify-center w-10 h-10 rounded-full bg-vc-red hover:bg-vc-red/80 text-white transition">
                        <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.965.965 0 01-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
                        </svg>
                    </button>
                    <div class="text-xs text-vc-muted hidden md:block" id="ptt-hint">${pushToTalk ? 'Hold Space to talk' : ''}</div>
                </div>
                <!-- Row 2: Sensitivity -->
                <div class="flex items-center gap-2 mt-2 justify-center">
                    <span class="text-xs text-vc-muted flex-shrink-0">Sensitivity</span>
                    <input type="range" min="1" max="60" value="${vadThreshold}" oninput="setVadThreshold(this.value)"
                        class="w-20 md:w-36 h-1.5 rounded-full appearance-none bg-vc-border cursor-pointer accent-vc-accent">
                    <div class="relative w-16 h-2 bg-vc-bg rounded-full overflow-hidden border border-vc-border flex-shrink-0">
                        <div id="vad-meter" class="h-full rounded-full bg-vc-muted/50 transition-all duration-75" style="width:0%"></div>
                        <div id="vad-threshold-marker" class="absolute top-0 h-full w-0.5 bg-vc-accent/80" style="left:${Math.min(100, (vadThreshold / 80) * 100)}%"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    try { sessionStorage.setItem('vocala-in-call', String(channelID)); } catch (_) {}
    activeCallChannelID = channelID;
    activeCallChannelName = channelName;

    // Start WebRTC (TCP candidates available for mobile)
    const isRestore = !!opts?.restore;
    startWebRTC().then(() => {
        if (!isRestore) return;
        const wantCamera = localStorage.getItem('vocala-camera') === 'true' && !isCameraOn;
        const wantScreen = localStorage.getItem('vocala-screen') === 'true' && !isScreenSharing;
        if (wantCamera || wantScreen) {
            showResumeMediaBanner({ camera: wantCamera, screen: wantScreen });
        }
    });
}

function showResumeMediaBanner(want) {
    const old = document.getElementById('resume-screen-banner');
    if (old) old.remove();
    const banner = document.createElement('div');
    banner.id = 'resume-screen-banner';
    banner.className = 'fixed top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-lg bg-vc-accent text-white shadow-lg text-sm';
    const parts = [];
    if (want.camera && want.screen) parts.push('Camera and screen were active. Resume?');
    else if (want.camera) parts.push('Camera was active. Resume?');
    else parts.push('Screen share was active. Resume?');
    let btns = '';
    if (want.camera) btns += `<button id="resume-cam-yes" class="px-3 py-1 rounded bg-white/20 hover:bg-white/30 transition">Camera</button>`;
    if (want.screen) btns += `<button id="resume-scr-yes" class="px-3 py-1 rounded bg-white/20 hover:bg-white/30 transition">Screen</button>`;
    btns += `<button id="resume-no" class="px-2 py-1 rounded hover:bg-white/20 transition">Dismiss</button>`;
    banner.innerHTML = `
        <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
        <span>${parts[0]}</span>
        ${btns}
    `;
    document.body.appendChild(banner);
    document.getElementById('resume-cam-yes')?.addEventListener('click', () => {
        if (!isCameraOn) startCamera();
        const el = document.getElementById('resume-cam-yes'); if (el) el.remove();
        if (!document.getElementById('resume-scr-yes')) hideResumeScreenBanner();
    });
    document.getElementById('resume-scr-yes')?.addEventListener('click', () => {
        if (!isScreenSharing) startScreenShare();
        const el = document.getElementById('resume-scr-yes'); if (el) el.remove();
        if (!document.getElementById('resume-cam-yes')) hideResumeScreenBanner();
    });
    document.getElementById('resume-no').addEventListener('click', () => {
        localStorage.setItem('vocala-camera', 'false');
        localStorage.setItem('vocala-screen', 'false');
        hideResumeScreenBanner();
    });
}

function hideResumeScreenBanner() {
    const el = document.getElementById('resume-screen-banner');
    if (el) el.remove();
}

let lastChannelUsers = [];

function setMeetGridColumns(grid, count) {
    let cols;
    if (count <= 1) cols = 1;
    else if (count <= 4) cols = 2;
    else if (count <= 9) cols = 3;
    else if (count <= 16) cols = 4;
    else cols = 5;
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
}

function userHasCameraTile(userID, username) {
    const grid = document.getElementById('camera-grid');
    if (!grid) return false;
    const selfName = document.getElementById('self-avatar')?.dataset?.username;
    if (username === selfName) {
        if (grid.querySelector('#local-camera')) return true;
        if (grid.querySelector('#local-screen-share')) return true;
    }
    const uid = String(userID);
    if (grid.querySelector(`#remote-cam-camera-${uid}`)) return true;
    if (grid.querySelector(`#remote-cam-screen-${uid}`)) return true;
    if (grid.querySelector(`#remote-screen-share-screen-${uid}`)) return true;
    return false;
}

function syncAvatarTileVisibility() {
    const container = document.getElementById('channel-view-users');
    if (!container) return;
    const grid = container.querySelector('.user-grid');
    if (!grid) return;
    // All user cards stay visible; video is shown inside them via attachUserPreviewsToCards().
    setMeetGridColumns(grid, Math.max(1, grid.querySelectorAll('[data-user-id]').length));
}

function updateMainContent(channelID, users) {
    const container = document.getElementById('channel-view-users');
    if (!container) return;
    users = (users || []).map(u => u.Muted ? { ...u, Speaking: false } : u);
    lastChannelUsers = users;
    if (document.body.classList.contains('expanded-tile-mode')) {
        const railUserSig = users.map(u => String(u.ID)).sort().join('|');
        if (railUserSig !== _lastRailUserSignature) {
            _lastRailUserSignature = railUserSig;
            populateExpandedUsersRail();
        } else {
            updateRailSpeakingState();
        }
    }
    setTimeout(() => {
        attachUserPreviewsToCards();
        updateCallIndicators();
        syncAvatarTileVisibility();
    }, 0);

    // Clean up camera grid for users who left
    const cameraGrid = document.getElementById('camera-grid');
    if (cameraGrid) {
        const userIds = new Set(users.map(u => String(u.ID)));
        cameraGrid.querySelectorAll('[id^="remote-cam-camera-"]').forEach(el => {
            // id = "remote-cam-camera-{userID}", extract userID
            const uid = el.id.replace('remote-cam-camera-', '');
            if (!userIds.has(uid)) el.remove();
        });
        updateGridColumns();
    }

    // Sort users consistently by username to prevent reordering
    users.sort((a, b) => a.Username.localeCompare(b.Username));

    if (users.length === 0) {
        container.innerHTML = `
            <div class="text-center text-vc-muted">
                <p class="text-lg font-medium">Nobody here yet</p>
                <p class="text-sm mt-1">Invite your friends to join!</p>
            </div>
        `;
        return;
    }

    // Check if grid already exists — if so, update in place
    let grid = container.querySelector('.user-grid');
    if (!grid) {
        grid = document.createElement('div');
        grid.className = 'user-grid grid gap-3 w-full max-w-5xl mx-auto';
        container.innerHTML = '';
        container.appendChild(grid);
    }
    setMeetGridColumns(grid, users.length);

    const existingCards = grid.querySelectorAll('[data-username]');
    const existingMap = {};
    existingCards.forEach(card => { existingMap[card.dataset.username] = card; });

    const currentUsernames = new Set(users.map(u => u.Username));

    // Remove users no longer present
    existingCards.forEach(card => {
        if (!currentUsernames.has(card.dataset.username)) {
            card.remove();
        }
    });

    // Add or update each user
    users.forEach(u => {
        const existing = existingMap[u.Username];
        if (existing) {
            // Update in place — only change classes/content that differ
            const lmuted = isLocalMuted(u.ID);
            const border = u.Speaking ? 'border-vc-green shadow-lg shadow-vc-green/30' : 'border-vc-border';
            existing.className = `meet-tile relative aspect-video rounded-xl bg-vc-sidebar/60 border-2 ${border} transition-all duration-200 overflow-hidden ${lmuted ? 'opacity-50' : ''}`;
            const lmuteBtn = existing.querySelector('.local-mute-btn');
            if (lmuteBtn) {
                lmuteBtn.textContent = lmuted ? 'Unmute' : 'Mute';
                lmuteBtn.className = `local-mute-btn text-[10px] px-2 py-0.5 rounded ${lmuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel text-vc-muted hover:text-vc-red hover:bg-vc-red/10'} transition`;
            }

            const avatar = existing.querySelector('.avatar-circle');
            if (avatar) {
                avatar.className = `avatar-circle w-20 h-20 md:w-24 md:h-24 rounded-full ${u.Speaking ? 'ring-4 ring-vc-green/40' : ''} overflow-hidden transition-all`;
            }

            const muteIndicator = existing.querySelector('.mute-indicator');
            if (muteIndicator) muteIndicator.style.display = u.Muted ? '' : 'none';

            const nameEl = existing.querySelector('.user-name');
            if (nameEl) nameEl.className = `user-name text-sm font-medium ${u.Muted ? 'text-vc-muted' : 'text-white'}`;

            const speakingIndicator = existing.querySelector('.speaking-indicator');
            if (speakingIndicator) speakingIndicator.style.display = u.Speaking ? '' : 'none';
            const speakingLabel = existing.querySelector('.speaking-label');
            if (speakingLabel) {
                if (u.Speaking) {
                    if (!speakingLabel.dataset.active) {
                        speakingLabel.textContent = randomSpeakingLabel();
                        speakingLabel.dataset.active = '1';
                    }
                } else {
                    delete speakingLabel.dataset.active;
                }
            }
        } else {
            const selfName = document.getElementById('self-avatar')?.dataset?.username || window.VOCALA_GUEST_NAME;
            const isSelf = u.Username === selfName;
            const lmuted = isLocalMuted(u.ID);
            const card = document.createElement('div');
            card.dataset.username = u.Username;
            card.dataset.userId = u.ID;
            card.className = `meet-tile relative aspect-video rounded-xl bg-vc-sidebar/60 border-2 ${u.Speaking ? 'border-vc-green shadow-lg shadow-vc-green/30' : 'border-vc-border'} fade-in transition-all duration-200 overflow-hidden ${lmuted ? 'opacity-50' : ''}`;
            card.innerHTML = `
                <div class="absolute inset-0 flex items-center justify-center">
                    <div class="relative">
                        <div class="avatar-circle w-20 h-20 md:w-24 md:h-24 rounded-full ${u.Speaking ? 'ring-4 ring-vc-green/40' : ''} overflow-hidden transition-all">
                            <img src="${avatarURL(u.Username)}" alt="" class="w-full h-full">
                        </div>
                        <div class="mute-indicator absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-vc-red flex items-center justify-center" style="display:${u.Muted ? '' : 'none'}"><svg class="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg></div>
                    </div>
                </div>
                <div class="absolute bottom-2 left-2 right-2 flex items-center gap-2 z-10">
                    <span class="user-name text-sm font-medium ${u.Muted ? 'text-vc-muted' : 'text-white'} drop-shadow truncate flex-1">${escapeHTML(u.Username)}</span>
                    <div class="speaking-indicator flex items-center gap-1.5" style="display:${u.Speaking ? '' : 'none'}">
                        <div class="flex items-end gap-0.5"><div class="w-1 h-2 bg-vc-green rounded-full animate-pulse"></div><div class="w-1 h-3 bg-vc-green rounded-full animate-pulse" style="animation-delay:0.15s"></div><div class="w-1 h-2 bg-vc-green rounded-full animate-pulse" style="animation-delay:0.3s"></div></div>
                        <span class="speaking-label text-xs text-vc-green font-medium" data-active="${u.Speaking ? '1' : ''}">${u.Speaking ? randomSpeakingLabel() : ''}</span>
                    </div>
                </div>
                ${!isSelf ? `<div class="absolute top-2 right-2 flex gap-1 opacity-0 hover:opacity-100 transition z-10" style="opacity:0" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='0'">
                    <button class="local-mute-btn text-[10px] px-2 py-0.5 rounded ${lmuted ? 'bg-vc-red/20 text-vc-red' : 'bg-black/60 text-white hover:bg-vc-red/40'} transition" onclick="toggleLocalMute(${u.ID}); updateMainContent(currentChannelID, lastChannelUsers);">${lmuted ? 'Unmute' : 'Mute'}</button>
                    ${window.VOCALA_IS_ADMIN && !u.Muted ? `<button class="text-[10px] px-2 py-0.5 rounded bg-black/60 text-white hover:bg-vc-yellow/40 transition" onclick="forceMuteUser(${u.ID})" title="Force mute for everyone">Force</button>` : ''}
                </div>` : ''}
            `;
            grid.appendChild(card);
        }
    });
}

function leaveChannel() {
    if (!currentChannelID) return;
    // If we're just closing a chat-peek of a different channel while an actual
    // call is still alive elsewhere — restore the call view, don't drop voice.
    if (chatOnlyChannelID && activeCallChannelID && activeCallChannelID !== chatOnlyChannelID) {
        chatOnlyChannelID = null;
        returnToActiveCall();
        return;
    }
    sendWS({ type: 'leave_channel' });
    currentChannelID = null;
    isCurrentChannelDM = false;
    isDMHuddleActive = false;
    chatOnlyChannelID = null;
    outgoingCallChannelID = null;
    outgoingCalleeUserId = null;
    outgoingCalleeUsername = null;
    incomingCallChannelID = null;
    removeOutgoingPhantomCard();
    updateCallIndicators();
    try { sessionStorage.removeItem('vocala-in-call'); } catch (_) {}
    localStorage.setItem('vocala-camera', 'false');
    localStorage.setItem('vocala-screen', 'false');
    hideResumeScreenBanner();
    cleanupWebRTC();

    // Reset URL
    history.pushState({}, '', '/');

    document.querySelectorAll('.channel-item').forEach(el => {
        el.classList.remove('bg-vc-hover/50');
    });

    const mobileChName = document.getElementById('mobile-channel-name');
    if (mobileChName) mobileChName.textContent = 'Select a channel';

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

async function deleteChannel(channelId, channelName) {
    if (!confirm('Delete channel "' + channelName + '"? This cannot be undone.')) return;

    const form = new FormData();
    form.append('id', channelId);
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/channels/delete', { method: 'POST', body: form });
        if (!res.ok) {
            alert('Failed to delete channel');
            return;
        }
        // If we're in this channel, leave it
        if (currentChannelID === channelId) {
            leaveChannel();
        }
        // Refresh channel list with HTMX response
        document.getElementById('channel-list').innerHTML = await res.text();
    } catch (err) {
        console.error('Failed to delete channel:', err);
    }
}

function confirmModal(message, { okText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise(resolve => {
        const existing = document.getElementById('confirm-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'confirm-modal';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4';
        modal.innerHTML = `
            <div class="bg-vc-sidebar border border-vc-border rounded-xl shadow-xl p-5 w-full max-w-sm">
                <div class="text-sm text-vc-text mb-5 whitespace-pre-line"></div>
                <div class="flex justify-end gap-2">
                    <button data-act="cancel" class="px-3 py-1.5 rounded-lg bg-vc-channel hover:bg-vc-hover text-vc-text text-sm transition"></button>
                    <button data-act="ok" class="px-3 py-1.5 rounded-lg text-white text-sm font-medium transition"></button>
                </div>
            </div>
        `;
        modal.querySelector('.whitespace-pre-line').textContent = message;
        const okBtn = modal.querySelector('[data-act="ok"]');
        const cancelBtn = modal.querySelector('[data-act="cancel"]');
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;
        okBtn.className += danger
            ? ' bg-vc-red hover:bg-vc-red/80'
            : ' bg-vc-accent hover:bg-vc-accent/80';

        const done = (value) => {
            document.removeEventListener('keydown', onKey);
            modal.remove();
            resolve(value);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') done(false);
            else if (e.key === 'Enter') done(true);
        };
        okBtn.addEventListener('click', () => done(true));
        cancelBtn.addEventListener('click', () => done(false));
        modal.addEventListener('click', (e) => { if (e.target === modal) done(false); });
        document.addEventListener('keydown', onKey);

        document.body.appendChild(modal);
        okBtn.focus();
    });
}

async function toggleChannelPrivacy(channelId, channelName, currentlyPrivate) {
    const next = !currentlyPrivate;
    const verb = next ? 'private' : 'public';
    const ok = await confirmModal('Make channel "' + channelName + '" ' + verb + '?');
    if (!ok) return;

    const form = new FormData();
    form.append('id', channelId);
    form.append('is_private', next ? 'true' : 'false');
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/channels/privacy', { method: 'POST', body: form });
        if (!res.ok) {
            alert('Failed to change channel privacy');
            return;
        }
        document.getElementById('channel-list').innerHTML = await res.text();
    } catch (err) {
        console.error('Failed to toggle channel privacy:', err);
    }
}

// ─── Mute / PTT ───────────────────────────────────────────────

async function toggleMute() {
    if (!localStream) {
        const useWs = (typeof USE_WS_MEDIA !== 'undefined' && USE_WS_MEDIA);
        try {
            if (!useWs && peerConnection) {
                try { cleanupWebRTC(); } catch (_) {}
            }
            if (useWs) {
                await startWSMedia();
            } else {
                await startWebRTC();
            }
        } catch (err) {
            console.error('toggleMute: starter failed', err);
            return;
        }
        if (localStream) {
            isMuted = false;
            localStorage.setItem('vocala-muted', isMuted);
            sendWS({ type: 'mute', payload: { muted: false } });
            if (gainNode) gainNode.gain.value = 1.0;
            updateMuteUI();
        }
        return;
    }

    isMuted = !isMuted;
    localStorage.setItem('vocala-muted', isMuted);
    sendWS({ type: 'mute', payload: { muted: isMuted } });

    // Mute/unmute via GainNode
    if (gainNode) {
        gainNode.gain.value = isMuted ? 0.0 : 1.0;
    }

    updateMuteUI();
}

function togglePTT() {
    pushToTalk = !pushToTalk;
    localStorage.setItem('vocala-ptt', pushToTalk);
    const btn = document.getElementById('ptt-btn');
    const hint = document.getElementById('ptt-hint');
    if (btn) {
        btn.className = `flex items-center justify-center w-10 h-10 rounded-full ${pushToTalk ? 'bg-vc-accent/20 text-vc-accent' : 'bg-vc-channel hover:bg-vc-hover text-vc-muted'} transition`;
        btn.title = 'Push to talk: ' + (pushToTalk ? 'ON' : 'OFF');
        btn.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
            </svg>`;
    }
    if (hint) hint.textContent = pushToTalk ? 'Hold Space to talk' : '';

    if (gainNode) {
        gainNode.gain.value = pushToTalk ? 0.0 : (isMuted ? 0.0 : 1.0);
    }
}

// ─── WebRTC ───────────────────────────────────────────────────

// Loads the RNNoise AudioWorklet (idempotent) and returns a connected node,
// or null if RNNoise is disabled / failed to load.
// Cache: ctx -> Promise<void> for addModule. Different contexts must register separately.
const _rnnoiseRegistered = new WeakMap();
let _rnnoiseBlobUrl = null;

async function _buildRnnoiseBlobUrl() {
    if (_rnnoiseBlobUrl) return _rnnoiseBlobUrl;
    const [wasmJs, workletJs] = await Promise.all([
        fetch('/static/vendor/rnnoise-sync.js').then(r => r.text()),
        fetch('/static/js/rnnoise-worklet.js').then(r => r.text()),
    ]);
    const blob = new Blob([wasmJs, '\n;\n', workletJs], { type: 'application/javascript' });
    _rnnoiseBlobUrl = URL.createObjectURL(blob);
    return _rnnoiseBlobUrl;
}

async function loadRnnoiseNode(ctx) {
    if (!rnnoiseEnabled) return null;
    try {
        if (ctx.sampleRate !== 48000) {
            console.warn('RNNoise: AudioContext sampleRate is', ctx.sampleRate, 'expected 48000, skipping');
            return null;
        }
        let p = _rnnoiseRegistered.get(ctx);
        if (!p) {
            const url = await _buildRnnoiseBlobUrl();
            p = ctx.audioWorklet.addModule(url);
            _rnnoiseRegistered.set(ctx, p);
        }
        await p;
        return new AudioWorkletNode(ctx, 'NoiseSuppressorWorklet', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
            channelCountMode: 'explicit',
        });
    } catch (e) {
        console.error('RNNoise worklet failed to load, falling back to browser NS:', e);
        _rnnoiseRegistered.delete(ctx);
        return null;
    }
}

async function startWebRTC() {
    try {
        const audioConstraints = {
            echoCancellation: true,
            noiseSuppression: !rnnoiseEnabled && noiseSuppressionEnabled,
            autoGainControl: !rnnoiseEnabled && agcEnabled,
        };
        if (selectedMicId) audioConstraints.deviceId = { exact: selectedMicId };
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
            video: false,
        });
        hideGlobalMicWarning();

        audioContext = new AudioContext(rnnoiseEnabled ? { sampleRate: 48000 } : undefined);
        if (audioContext.state === 'suspended') {
            try { await audioContext.resume(); } catch (_) {}
        }
        const rnnoiseNode = await loadRnnoiseNode(audioContext);
        const source = audioContext.createMediaStreamSource(localStream);

        let compressor = null;
        if (rnnoiseEnabled) {
            compressor = audioContext.createDynamicsCompressor();
            compressor.threshold.value = -28;
            compressor.knee.value = 20;
            compressor.ratio.value = 4;
            compressor.attack.value = 0.005;
            compressor.release.value = 0.12;
        }

        gainNode = audioContext.createGain();
        gainNode.gain.value = (pushToTalk || isMuted) ? 0.0 : 1.0;
        const dest = audioContext.createMediaStreamDestination();
        let head = source;
        if (rnnoiseNode) { head.connect(rnnoiseNode); head = rnnoiseNode; }
        if (compressor) { head.connect(compressor); head = compressor; }
        head.connect(gainNode);
        gainNode.connect(dest);
        processedStream = dest.stream;

        // Setup VAD (reads from raw localStream for level detection)
        setupVAD(localStream);

        // Create peer connection with server-provided ICE config (includes TURN if configured)
        const iceServers = window.VOCALA_ICE_SERVERS || [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
        // Force relay on mobile if TURNS is available (carrier NAT drops UDP)
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const hasTurns = iceServers.some(s => {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls || ''];
            return urls.some(u => u.startsWith('turns:'));
        });
        const rtcConfig = { iceServers };
        if (isMobile && hasTurns) {
            rtcConfig.iceTransportPolicy = 'relay';
            console.log('Mobile detected, forcing TURNS relay');
        }
        peerConnection = new RTCPeerConnection(rtcConfig);
        diagLogIceServers(iceServers);

        // Add processed audio track (goes through GainNode)
        processedStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, processedStream);
        });

        // Handle remote tracks
        peerConnection.ontrack = (event) => {
            if (event.track.kind === 'audio') {
                const audio = new Audio();
                audio.srcObject = event.streams[0];
                audio.autoplay = true;
                if (selectedSpkId && audio.setSinkId) {
                    audio.setSinkId(selectedSpkId).catch(() => {});
                }
                // Extract userID from stream.id "audio-{userID}"
                const audioStreamId = event.streams[0]?.id || '';
                const uid = audioStreamId.replace('audio-', '');
                audio.dataset.streamId = audioStreamId;
                audio.dataset.uid = uid;
                // Apply local mute if user was muted
                if (localMutedUsers.has(uid)) audio.muted = true;
                document.body.appendChild(audio);
                audio.play().catch(() => {});
            } else if (event.track.kind === 'video') {
                const stream = event.streams[0] || new MediaStream([event.track]);
                const streamId = stream.id || '';

                if (streamId.startsWith('camera')) {
                    // Remote camera — add to camera grid
                    // Use mid (media line ID) as stable identifier
                    const mid = event.transceiver ? event.transceiver.mid : null;
                    handleRemoteCameraTrack(stream, event.track, mid);
                } else if (streamId.startsWith('screen')) {
                    // Screen share — showRemoteVideo handles dedup by stream.id
                    showRemoteVideo(stream, event.track);
                } else {
                    console.warn('Ignoring video track with unrecognized streamId:', streamId);
                }
            }
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

        // Renegotiation needed (e.g. after addTrack/removeTrack)
        let negoTimeout = null;
        peerConnection.onnegotiationneeded = async () => {
            // Debounce to coalesce multiple track additions
            if (negoTimeout) clearTimeout(negoTimeout);
            negoTimeout = setTimeout(async () => {
                try {
                    if (!peerConnection) return;
                    // Bounded backoff wait for stable; server may be mid-offer.
                    let delay = 200;
                    for (let attempt = 0; attempt < 4; attempt++) {
                        if (peerConnection.signalingState === 'stable') break;
                        await new Promise(r => setTimeout(r, delay));
                        delay *= 2;
                    }
                    if (!peerConnection || peerConnection.signalingState !== 'stable') return;
                    const offer = await peerConnection.createOffer();
                    if (peerConnection.signalingState !== 'stable') return;
                    await peerConnection.setLocalDescription(offer);
                    sendWS({ type: 'webrtc_offer', payload: { sdp: offer.sdp } });
                } catch (err) {
                    console.error('Negotiation failed:', err);
                }
            }, 500);
        };

        // Connection state
        peerConnection.onconnectionstatechange = () => {
            updateRTCStatus();
        };

        peerConnection.oniceconnectionstatechange = () => {
            updateRTCStatus();
            const st = peerConnection.iceConnectionState;
            if (st === 'failed' || st === 'disconnected') {
                console.warn('[vocala-diag] ICE state=' + st + ' — running diagnostic. Tip: run vocalaDiag() in console for details.');
                diagPeerStats();
            }
        };

        // Create and send offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        sendWS({
            type: 'webrtc_offer',
            payload: { sdp: offer.sdp },
        });

        // Restore saved state
        sendWS({ type: 'mute', payload: { muted: isMuted } });
        updateMuteUI();

    } catch (err) {
        console.error('WebRTC mic setup failed, trying receive-only:', err);
        // Create peer connection without microphone (receive-only mode)
        // This allows seeing camera/screen/hearing audio from others
        try {
            const iceServers = window.VOCALA_ICE_SERVERS || [
                { urls: 'stun:stun.l.google.com:19302' },
            ];
            const rtcConfig = { iceServers };
            peerConnection = new RTCPeerConnection(rtcConfig);
            diagLogIceServers(iceServers);

            // Add receive-only audio transceiver
            peerConnection.addTransceiver('audio', { direction: 'recvonly' });

            peerConnection.ontrack = (event) => {
                if (event.track.kind === 'audio') {
                    const audio = new Audio();
                    audio.srcObject = event.streams[0];
                    audio.autoplay = true;
                    if (selectedSpkId && audio.setSinkId) {
                        audio.setSinkId(selectedSpkId).catch(() => {});
                    }
                    const uid = (event.streams[0]?.id || '').replace('audio-', '');
                    audio.dataset.uid = uid;
                    if (localMutedUsers.has(uid)) audio.muted = true;
                    document.body.appendChild(audio);
                    audio.play().catch(() => {});
                } else if (event.track.kind === 'video') {
                    const stream = event.streams[0] || new MediaStream([event.track]);
                    const streamId = stream.id || '';
                    if (streamId.startsWith('camera')) {
                        const mid = event.transceiver ? event.transceiver.mid : null;
                        handleRemoteCameraTrack(stream, event.track, mid);
                    } else if (streamId.startsWith('screen')) {
                        showRemoteVideo(stream, event.track);
                    } else {
                        console.warn('Ignoring video track with unrecognized streamId:', streamId);
                    }
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    sendWS({ type: 'ice_candidate', payload: { candidate: event.candidate } });
                }
            };

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            sendWS({ type: 'webrtc_offer', payload: { sdp: offer.sdp } });
            updateRTCStatusText('connected', 'Listen-only (no mic) — tap mic to enable');
        } catch (err2) {
            console.error('Receive-only WebRTC also failed:', err2);
            updateRTCStatusText('error', 'WebRTC failed');
        }

        if (!isMuted) {
            isMuted = true;
            sendWS({ type: 'mute', payload: { muted: true } });
            updateMuteUI();
        }
    }
}

function updateMuteUI() {
    // Update sidebar icons (may not exist for guests)
    const micIcon = document.getElementById('icon-mic');
    const micOffIcon = document.getElementById('icon-mic-off');
    if (micIcon) micIcon.classList.toggle('hidden', isMuted);
    if (micOffIcon) micOffIcon.classList.toggle('hidden', !isMuted);

    // Update main content button
    const mainBtn = document.getElementById('main-mute-btn');
    const mainText = document.getElementById('main-mute-text');
    const mainIcon = document.getElementById('main-icon-mic');
    if (mainBtn) {
        mainBtn.className = `flex items-center justify-center w-10 h-10 rounded-full ${isMuted ? 'bg-vc-red/20 text-vc-red' : 'bg-vc-channel hover:bg-vc-hover text-vc-text'} transition`;
        mainBtn.title = isMuted ? 'Unmute' : 'Mute';
    }
    if (mainText) mainText.textContent = isMuted ? 'Unmute' : 'Mute';
    if (mainIcon) {
        mainIcon.innerHTML = isMuted ?
            '<path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>' :
            '<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>';
    }
}

// ICE candidates from the server can arrive before we've processed the
// server's SDP answer (pion's OnICECandidate fires inside SetLocalDescription,
// so candidates can be enqueued on the WS before the answer message). We
// buffer them here and flush once a remoteDescription is set.
let pendingIceCandidates = [];

function flushPendingIce() {
    if (!peerConnection) { pendingIceCandidates = []; return; }
    const pending = pendingIceCandidates;
    pendingIceCandidates = [];
    for (const c of pending) {
        peerConnection.addIceCandidate(new RTCIceCandidate(c))
            .catch(err => console.warn('Flushed ICE candidate failed:', err));
    }
}

async function handleWebRTCAnswer(payload) {
    if (!peerConnection) return;
    try {
        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({ type: 'answer', sdp: payload.sdp })
        );
        flushPendingIce();
    } catch (err) {
        console.error('Failed to set remote description:', err);
    }
}

async function handleWebRTCOffer(payload) {
    // Server-initiated renegotiation (new peer joined or tracks changed)
    if (!peerConnection) return;
    lastServerOfferTime = Date.now();

    try {
        // Perfect-negotiation: client is the "polite" peer. If we have our
        // own offer in flight (have-local-offer), rollback and accept the
        // server's offer. The server is "impolite" and drops client offers
        // on glare, so rolling back here is what breaks the deadlock.
        // onnegotiationneeded will fire again after we're stable and resend
        // anything we lost.
        if (peerConnection.signalingState !== 'stable') {
            console.warn('WebRTC offer collision, rolling back local offer');
            await peerConnection.setLocalDescription({ type: 'rollback' });
        }

        await peerConnection.setRemoteDescription(
            new RTCSessionDescription({ type: 'offer', sdp: payload.sdp })
        );
        flushPendingIce();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        sendWS({
            type: 'webrtc_answer',
            payload: { sdp: answer.sdp },
        });
    } catch (err) {
        console.error('Failed to handle WebRTC offer:', err);
    }
}

function handleRemoteICECandidate(payload) {
    if (!peerConnection) return;
    // If remoteDescription isn't set yet, buffer the candidate.
    if (!peerConnection.remoteDescription) {
        pendingIceCandidates.push(payload.candidate);
        return;
    }
    peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate))
        .catch(err => console.error('Failed to add ICE candidate:', err));
}

// Adaptive publisher bitrate: monitors outbound-rtp stats and adjusts
// encoding maxBitrate in response to qualityLimitationReason. Returns a
// cleanup fn that stops the monitor. Logs transitions to the console.
function startAdaptiveBitrate(sender, tiers, label) {
    let tierIdx = 0;
    let lastGoodAt = Date.now();
    let stopped = false;

    const applyTier = async (idx) => {
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = tiers[idx];
            await sender.setParameters(params);
        } catch (e) {
            // Sender may not be fully bound yet — just skip this tick.
        }
    };

    // Apply initial cap shortly after attach so the transport is ready.
    setTimeout(() => { if (!stopped) applyTier(0); }, 500);

    const interval = setInterval(async () => {
        if (stopped || !sender.track || sender.track.readyState !== 'live') return;
        let bwLimited = false;
        try {
            const stats = await sender.getStats();
            stats.forEach(s => {
                if (s.type === 'outbound-rtp' && s.kind === 'video' &&
                    s.qualityLimitationReason === 'bandwidth') {
                    bwLimited = true;
                }
            });
        } catch (e) {
            return;
        }
        const now = Date.now();
        if (bwLimited) {
            if (tierIdx < tiers.length - 1) {
                tierIdx++;
                await applyTier(tierIdx);
            }
            lastGoodAt = now;
        } else if (tierIdx > 0 && now - lastGoodAt > 15000) {
            tierIdx--;
            await applyTier(tierIdx);
            lastGoodAt = now;
        }
    }, 3000);

    return () => { stopped = true; clearInterval(interval); };
}

async function startScreenShare() {
    if (!peerConnection || isScreenSharing) return;

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: 'always' },
            audio: false,
        });
        localStorage.setItem('vocala-screen', 'true');
        hideResumeScreenBanner();

        const videoTrack = screenStream.getVideoTracks()[0];
        // Tell the SFU that the next video track is a screen, not a camera —
        // classification is flag-based on the server and the camera flag may
        // already be set from an earlier session restored from localStorage.
        sendWS({ type: 'screen_on' });
        // Per-track msid->kind mapping: unambiguous even when camera and
        // screen are added in the same renegotiation.
        sendWS({ type: 'media_track', payload: { stream_id: screenStream.id, kind: 'screen' } });
        screenSender = peerConnection.addTrack(videoTrack, screenStream);
        screenAdaptiveCleanup = startAdaptiveBitrate(screenSender, SCREEN_BITRATE_TIERS_BPS, 'screen');
        isScreenSharing = true;

        // When user stops sharing via browser UI
        videoTrack.onended = () => {
            stopScreenShare();
        };

        // Show local preview
        showLocalScreenPreview(screenStream);
        updateScreenShareUI();
        // onnegotiationneeded will handle the renegotiation

        // Start sending screen preview thumbnails
        setTimeout(captureAndSendPreview, 500);
        screenPreviewInterval = setInterval(captureAndSendPreview, 5 * 60 * 1000);
    } catch (err) {
        console.error('Screen share failed:', err);
    }
}

async function stopScreenShare() {
    if (!isScreenSharing) return;

    clearInterval(screenPreviewInterval);
    screenPreviewInterval = null;

    if (screenAdaptiveCleanup) { screenAdaptiveCleanup(); screenAdaptiveCleanup = null; }
    if (screenSender && peerConnection) {
        peerConnection.removeTrack(screenSender);
    }
    sendWS({ type: 'screen_off' });
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenSender = null;
    isScreenSharing = false;
    localStorage.setItem('vocala-screen', 'false');

    // onnegotiationneeded will handle renegotiation after removeTrack
    removeLocalScreenPreview();
    updateScreenShareUI();
}

function addScreenTileToGrid({ id, stream, label, track }) {
    ensureCameraGrid();
    const grid = document.getElementById('camera-grid');
    if (!grid) return;

    // Replace existing tile if same id (e.g. on renegotiation)
    const existing = document.getElementById(id);
    if (existing) {
        const v = existing.querySelector('video');
        if (v) {
            try { v.pause(); } catch (_) {}
            v.srcObject = null;
            v.srcObject = stream;
            v.play().catch(() => {});
        }
        if (track) {
            existing.dataset.trackId = track.id;
            track.onended = () => {
                if (document.getElementById(id)?.dataset.trackId === track.id) removeScreenTileFromGrid(id);
            };
        }
        attachUserPreviewsToCards();
        if (document.body.classList.contains('expanded-tile-mode')) populateExpandedUsersRail();
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = id;
    wrapper.className = 'rounded-xl overflow-hidden bg-black border-2 border-vc-accent aspect-video relative group cursor-pointer';
    wrapper.dataset.tileType = 'screen';

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    // object-contain (not cover) so the full shared screen is visible
    video.className = 'w-full h-full object-contain';
    video.play().catch(() => {});

    const labelEl = document.createElement('div');
    labelEl.className = 'absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded z-10';
    labelEl.textContent = label;

    const controls = document.createElement('div');
    controls.className = 'absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition z-10';
    controls.innerHTML = `
        <button onclick="event.stopPropagation(); setCamViewMode('${id}', 'expanded')" title="Expand" class="p-1 rounded bg-black/60 text-white hover:bg-white/20 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
        </button>
        <button onclick="event.stopPropagation(); setCamViewMode('${id}', 'fullscreen')" title="Fullscreen" class="p-1 rounded bg-black/60 text-white hover:bg-white/20 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM6 14v4h4v2H4v-6h2zm12 4v-4h2v6h-6v-2h4z"/></svg>
        </button>
    `;

    wrapper.onclick = () => {
        const isExpanded = wrapper.dataset.expanded === 'true';
        setCamViewMode(id, isExpanded ? 'default' : 'expanded');
    };

    wrapper.appendChild(video);
    wrapper.appendChild(labelEl);
    wrapper.appendChild(controls);
    // Screen tiles always at the top of the grid
    grid.prepend(wrapper);
    updateGridColumns();

    if (track) {
        wrapper.dataset.trackId = track.id;
        track.onended = () => {
            if (document.getElementById(id)?.dataset.trackId === track.id) removeScreenTileFromGrid(id);
        };
    }

    // Screen share always enters spotlight so all participants see it prominently
    setCamViewMode(id, 'expanded');
}

function removeScreenTileFromGrid(id) {
    const wasExpanded = expandedCamId === id;
    if (wasExpanded) {
        document.body.classList.remove('expanded-tile-mode');
        expandedCamId = null;
        clearExpandedUsersRail();
    }
    const el = document.getElementById(id);
    if (el) {
        if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
        el.remove();
        updateGridColumns();
    }
    if (wasExpanded) promoteNextMediaToMainStage();
    attachUserPreviewsToCards();
}

function promoteNextMediaToMainStage() {
    const grid = document.getElementById('camera-grid');
    if (!grid) return;
    if (previousMainTileId && document.getElementById(previousMainTileId)) {
        const id = previousMainTileId;
        previousMainTileId = null;
        setCamViewMode(id, 'expanded');
        return;
    }
    const screen = grid.querySelector('[id^="remote-screen-share-"], #local-screen-share');
    if (screen) { setCamViewMode(screen.id, 'expanded'); return; }
    const cam = grid.querySelector('[id^="remote-cam-camera-"], #local-camera');
    if (cam) { setCamViewMode(cam.id, 'expanded'); return; }
}

function showLocalScreenPreview(stream) {
    addScreenTileToGrid({ id: 'local-screen-share', stream, label: 'Your screen' });
}

function removeLocalScreenPreview() {
    removeScreenTileFromGrid('local-screen-share');
}

function showRemoteVideo(stream, track) {
    // Remote screen shares are rendered as grid tiles alongside cameras.
    // Using stream.id (stable from SFU: "screen-<userID>") as the tile id
    // ensures renegotiations replace the tile in place rather than duplicating.
    const id = 'remote-screen-share-' + stream.id;
    const label = screenShareUsername ? escapeHTML(screenShareUsername) + ' — screen' : 'Screen share';
    addScreenTileToGrid({ id, stream, label, track });
}

let screenViewMode = 'default';

function syncControlsBarHeightVar() {
    const bar = document.querySelector('.channel-controls-bar');
    if (!bar) return;
    const h = bar.getBoundingClientRect().height || 92;
    document.documentElement.style.setProperty('--controls-bar-height', h + 'px');
}

let _cameraGridObserver = null;
function observeCameraGrid() {
    const grid = document.getElementById('camera-grid');
    if (!grid) return;
    if (_cameraGridObserver) _cameraGridObserver.disconnect();
    _cameraGridObserver = new MutationObserver(() => {
        attachUserPreviewsToCards();
        if (document.body.classList.contains('expanded-tile-mode')) {
            const stillExpanded = grid.querySelector('.expanded-tile');
            if (!stillExpanded) {
                document.body.classList.remove('expanded-tile-mode');
                expandedCamId = null;
                clearExpandedUsersRail();
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
            }
        }
    });
    _cameraGridObserver.observe(grid, { childList: true, subtree: true });
}

// Returns Map<userKey, [{tileId, kind}]> for all tiles with an active srcObject.
// userKey is String(u.ID) for remote users, `self:${username}` for self.
function buildMediaTilesByUser(selfName) {
    const map = new Map();
    const grid = document.getElementById('camera-grid');
    if (!grid) return map;
    grid.querySelectorAll('[id]').forEach(el => {
        if (!el.querySelector('video')?.srcObject) return;
        const id = el.id;
        let userKey = null, kind = null;
        if (id.startsWith('remote-cam-camera-'))          { userKey = id.replace('remote-cam-camera-', '');          kind = 'camera'; }
        else if (id.startsWith('remote-screen-share-screen-')) { userKey = id.replace('remote-screen-share-screen-', ''); kind = 'screen'; }
        else if (id.startsWith('remote-cam-screen-'))     { userKey = id.replace('remote-cam-screen-', '');          kind = 'screen'; }
        else if (id === 'local-camera' && selfName)       { userKey = `self:${selfName}`;                            kind = 'camera'; }
        else if (id === 'local-screen-share' && selfName) { userKey = `self:${selfName}`;                            kind = 'screen'; }
        if (!userKey) return;
        if (!map.has(userKey)) map.set(userKey, []);
        map.get(userKey).push({ tileId: id, kind });
    });
    return map;
}

// Attaches srcObject from a camera-grid tile onto a <video> element.
function syncVideoFromTile(videoEl, tileId, mirror) {
    const src = document.getElementById(tileId)?.querySelector('video');
    if (src?.srcObject && videoEl.srcObject !== src.srcObject) {
        videoEl.srcObject = src.srcObject;
        videoEl.play().catch(() => {});
    }
    videoEl.style.transform = mirror ? 'scaleX(-1)' : '';
}

function attachUserPreviewsToCards() {
    const selfName = document.getElementById('self-avatar')?.dataset?.username || window.VOCALA_GUEST_NAME;
    const grid = document.querySelector('#channel-view-users .user-grid');

    // Remove synthetic screen cards from a previous run before rebuilding
    document.querySelectorAll('#channel-view-users [data-synthetic-screen]').forEach(el => el.remove());

    const tilesByUser = buildMediaTilesByUser(selfName);

    const cards = document.querySelectorAll('#channel-view-users [data-user-id]');
    cards.forEach(card => {
        const uid = card.dataset.userId;
        const username = card.dataset.username;
        const isSelf = username === selfName;
        const userKey = isSelf ? `self:${selfName}` : uid;

        const legacyPreviews = card.querySelector('.user-card-previews');
        if (legacyPreviews) legacyPreviews.remove();

        const tiles = tilesByUser.get(userKey) || [];
        const cameraTile = tiles.find(t => t.kind === 'camera');
        const screenTile = tiles.find(t => t.kind === 'screen');
        const primary = cameraTile || screenTile; // camera on main card, screen gets its own card

        const avatarCircle = card.querySelector('.avatar-circle');
        const muteIndicator = card.querySelector('.mute-indicator');
        let overlay = card.querySelector('.card-video-overlay');

        if (primary) {
            const fitClass = primary.kind === 'screen' ? 'object-contain' : 'object-cover';
            if (!overlay) {
                overlay = document.createElement('video');
                overlay.className = `card-video-overlay absolute inset-0 w-full h-full ${fitClass}`;
                overlay.style.zIndex = '1';
                overlay.autoplay = true;
                overlay.playsInline = true;
                overlay.muted = true;
                card.insertBefore(overlay, card.firstChild);
            } else {
                overlay.classList.toggle('object-cover', primary.kind !== 'screen');
                overlay.classList.toggle('object-contain', primary.kind === 'screen');
            }
            syncVideoFromTile(overlay, primary.tileId, isSelf && primary.kind === 'camera');
            if (avatarCircle) avatarCircle.style.visibility = 'hidden';
            if (muteIndicator) muteIndicator.style.zIndex = '10';
            card.style.cursor = 'pointer';
            card.onclick = (e) => {
                if (e.target.closest('button')) return;
                setCamViewMode(primary.tileId, 'expanded');
            };
        } else {
            if (overlay) { try { overlay.srcObject = null; } catch (_) {} overlay.remove(); }
            if (avatarCircle) avatarCircle.style.visibility = '';
            if (muteIndicator) muteIndicator.style.zIndex = '';
            card.style.cursor = '';
            card.onclick = null;
        }

        // When both camera AND screen share are active — add a synthetic screen card
        if (cameraTile && screenTile) {
            const screenCard = document.createElement('div');
            screenCard.dataset.userId = uid;
            screenCard.dataset.ownerUsername = username;
            screenCard.dataset.syntheticScreen = 'true';
            screenCard.className = card.className;
            screenCard.style.cursor = 'pointer';

            const screenVideo = document.createElement('video');
            screenVideo.className = 'card-video-overlay absolute inset-0 w-full h-full object-contain';
            screenVideo.style.zIndex = '1';
            screenVideo.autoplay = true;
            screenVideo.playsInline = true;
            screenVideo.muted = true;
            screenCard.appendChild(screenVideo);
            syncVideoFromTile(screenVideo, screenTile.tileId, false);

            const label = document.createElement('div');
            label.className = 'absolute bottom-2 left-2 z-10 text-xs text-white/80 bg-black/50 px-1.5 py-0.5 rounded';
            label.textContent = username + ' · screen';
            screenCard.appendChild(label);

            screenCard.onclick = (e) => {
                if (e.target.closest('button')) return;
                setCamViewMode(screenTile.tileId, 'expanded');
            };
            card.insertAdjacentElement('afterend', screenCard);
        }
    });

    if (grid) {
        const totalCards = grid.querySelectorAll('[data-user-id]').length;
        setMeetGridColumns(grid, Math.max(1, totalCards));
    }
}

function populateExpandedUsersRail() {
    const rail = document.getElementById('expanded-users-rail');
    if (!rail) return;
    rail.innerHTML = '';
    const sorted = (lastChannelUsers || []).slice().sort((a, b) => {
        if (!!b.Speaking - !!a.Speaking !== 0) return !!b.Speaking - !!a.Speaking;
        return (a.Username || '').localeCompare(b.Username || '');
    });
    const selfName = document.getElementById('self-avatar')?.dataset?.username || window.VOCALA_GUEST_NAME;
    const mediaTilesByUser = buildMediaTilesByUser(selfName);

    const addThumb = (u, opts) => {
        opts = opts || {};
        const card = document.createElement('div');
        card.dataset.userId = u.ID;
        if (opts.tileId) card.dataset.tileId = opts.tileId;
        const ring = u.Speaking ? 'ring-2 ring-vc-green/60' : '';
        const isMain = expandedCamId && expandedCamId === opts.tileId;
        const border = u.Speaking
            ? 'border-vc-green shadow-lg shadow-vc-green/30'
            : (isMain ? 'border-vc-accent' : 'border-vc-border');
        card.className = `relative aspect-video rounded-lg overflow-hidden bg-black/80 border-2 ${border} cursor-pointer hover:border-vc-accent transition`;
        const labelChip = `
            <div class="absolute bottom-1 left-1 right-1 flex items-center gap-1 text-[10px] z-10">
                <span class="truncate text-white drop-shadow flex-1">${escapeHTML(u.Username)}${opts.kind === 'screen' ? ' · screen' : ''}</span>
                ${u.Muted ? '<svg class="w-3 h-3 text-vc-red flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>' : ''}
            </div>`;
        if (opts.tileId) {
            card.innerHTML = `
                <video autoplay playsinline muted class="absolute inset-0 w-full h-full ${opts.kind === 'screen' ? 'object-contain' : 'object-cover'}"></video>
                ${labelChip}
            `;
            syncVideoFromTile(card.querySelector('video'), opts.tileId, opts.tileId === 'local-camera');
            card.addEventListener('click', () => swapMainStageWith(opts.tileId));
        } else {
            card.innerHTML = `
                <div class="absolute inset-0 flex items-center justify-center bg-vc-sidebar/70">
                    <img src="${avatarURL(u.Username)}" alt="" class="w-12 h-12 rounded-full ${ring}">
                </div>
                ${labelChip}
            `;
        }
        rail.appendChild(card);
    };

    sorted.forEach(u => {
        const isSelf = u.Username === selfName;
        const key = isSelf ? `self:${u.Username}` : String(u.ID);
        const tiles = mediaTilesByUser.get(key);
        if (tiles && tiles.length > 0) {
            tiles.forEach(t => addThumb(u, t));
        } else {
            addThumb(u, {});
        }
    });
}

function updateRailMainStageHighlight() {
    const rail = document.getElementById('expanded-users-rail');
    if (!rail) return;
    rail.querySelectorAll('[data-tile-id]').forEach(card => {
        const isMain = expandedCamId && card.dataset.tileId === expandedCamId;
        if (card.className.includes('border-vc-green')) return;
        card.className = card.className
            .replace(/border-vc-(accent|border)\b/g, '')
            .trim();
        card.className = (card.className + ' ' + (isMain ? 'border-vc-accent' : 'border-vc-border')).replace(/\s+/g, ' ');
    });
}

function updateRailSpeakingState() {
    const rail = document.getElementById('expanded-users-rail');
    if (!rail) return;
    const speakingByUser = new Map();
    const mutedByUser = new Map();
    (lastChannelUsers || []).forEach(u => {
        speakingByUser.set(String(u.ID), !!u.Speaking && !u.Muted);
        mutedByUser.set(String(u.ID), !!u.Muted);
    });
    rail.querySelectorAll('[data-user-id]').forEach(card => {
        const uid = card.dataset.userId;
        const speaking = speakingByUser.get(uid);
        const isMain = expandedCamId && card.dataset.tileId === expandedCamId;
        card.className = card.className
            .replace(/border-vc-(green|accent|border)\b/g, '')
            .replace(/shadow-lg/g, '')
            .replace(/shadow-vc-green\/[0-9]+/g, '');
        const next = speaking
            ? 'border-vc-green shadow-lg shadow-vc-green/30'
            : (isMain ? 'border-vc-accent' : 'border-vc-border');
        card.className = (card.className.trim() + ' ' + next).replace(/\s+/g, ' ');
        const muted = mutedByUser.get(uid);
        const mutedSvg = card.querySelector('.absolute.bottom-1 svg.text-vc-red');
        if (muted && !mutedSvg) {
            const chip = card.querySelector('.absolute.bottom-1');
            if (chip) {
                chip.insertAdjacentHTML('beforeend', '<svg class="w-3 h-3 text-vc-red flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>');
            }
        } else if (!muted && mutedSvg) {
            mutedSvg.remove();
        }
    });
}

function swapMainStageWith(tileId) {
    if (!tileId || expandedCamId === tileId) return;
    if (expandedCamId && expandedCamId !== tileId) {
        previousMainTileId = expandedCamId;
    }
    setCamViewMode(tileId, 'expanded');
}

let previousMainTileId = null;

function clearExpandedUsersRail() {
    const rail = document.getElementById('expanded-users-rail');
    if (rail) rail.innerHTML = '';
    _lastRailTilesSignature = '';
    _lastRailUserSignature = '';
}

function toggleExpandedUsersRail() {
    const rail = document.getElementById('expanded-users-rail');
    if (!rail) return;
    rail.classList.toggle('rail-hidden');
}

function setScreenViewMode(mode) {
    syncControlsBarHeightVar();
    const container = document.getElementById('screen-share-container');
    const video = document.getElementById('screen-share-video');
    if (!container || !video) return;

    // Exit fullscreen if leaving fullscreen mode
    if (screenViewMode === 'fullscreen' && mode !== 'fullscreen') {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }

    screenViewMode = mode;

    // Remove close button if exists
    const oldCloseBtn = container.querySelector('.ss-close-btn');
    if (oldCloseBtn) oldCloseBtn.remove();
    const oldRailBtn = container.querySelector('.ss-rail-btn');
    if (oldRailBtn) oldRailBtn.remove();
    const oldFsBtn = container.querySelector('.ss-fs-btn');
    if (oldFsBtn) oldFsBtn.remove();

    if (mode === 'default') {
        container.classList.remove('expanded-tile');
        container.className = 'w-full bg-black rounded-xl overflow-hidden mb-4 relative group';
        container.style.maxHeight = '';
        container.style.position = '';
        container.style.top = '';
        container.style.left = '';
        container.style.right = '';
        container.style.bottom = '';
        container.style.inset = '';
        container.style.zIndex = '';
        container.style.borderRadius = '';
        container.style.margin = '';
        video.className = 'w-full h-full object-contain';
        video.style.maxHeight = '70vh';
        document.body.classList.remove('expanded-tile-mode');
        clearExpandedUsersRail();
    } else if (mode === 'expanded') {
        container.className = 'expanded-tile bg-black overflow-hidden group';
        container.style.position = '';
        container.style.top = '';
        container.style.left = '';
        container.style.right = '';
        container.style.bottom = '';
        container.style.inset = '';
        container.style.zIndex = '40';
        container.style.maxHeight = '';
        container.style.borderRadius = '0';
        container.style.margin = '0';
        document.body.classList.add('expanded-tile-mode');
        populateExpandedUsersRail();
        // Add close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ss-close-btn absolute top-4 right-4 z-20 p-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition';
        closeBtn.title = 'Exit (Esc)';
        closeBtn.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
        closeBtn.onclick = () => setScreenViewMode('default');
        container.appendChild(closeBtn);
        const railBtn = document.createElement('button');
        railBtn.className = 'ss-rail-btn absolute top-4 right-16 z-20 p-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition';
        railBtn.title = 'Toggle participants';
        railBtn.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z"/></svg>';
        railBtn.onclick = (e) => { e.stopPropagation(); toggleExpandedUsersRail(); };
        container.appendChild(railBtn);
        const fsBtn = document.createElement('button');
        fsBtn.className = 'ss-fs-btn absolute top-4 right-28 z-20 p-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition';
        fsBtn.title = 'Fullscreen';
        fsBtn.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>';
        fsBtn.onclick = (e) => {
            e.stopPropagation();
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else {
                setScreenViewMode('fullscreen');
            }
        };
        container.appendChild(fsBtn);
        updateFullscreenButtonsIcon();
        video.className = 'w-full h-full object-contain';
        video.style.maxHeight = '';
    } else if (mode === 'fullscreen') {
        if (!container.classList.contains('expanded-tile')) {
            setScreenViewMode('expanded');
        }
        const target = document.getElementById('main-content') || document.documentElement;
        if (target.requestFullscreen) {
            target.requestFullscreen().catch(err => console.warn('fullscreen failed:', err));
        } else if (target.webkitRequestFullscreen) {
            target.webkitRequestFullscreen();
        }
    }
}

// Handle ESC from fullscreen
const FS_ENTER_ICON = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>';
const FS_EXIT_ICON = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 4l-6 6m0 0V5m0 5h5M4 20l6-6m0 0v5m0-5H5M20 20l-6-6m0 0h5m-5 0v5M4 4l6 6m0 0H5m5 0V5"/></svg>';

function updateFullscreenButtonsIcon() {
    const inFs = !!document.fullscreenElement;
    document.querySelectorAll('.cam-fs-btn, .ss-fs-btn').forEach(btn => {
        btn.innerHTML = inFs ? FS_EXIT_ICON : FS_ENTER_ICON;
        btn.title = inFs ? 'Exit fullscreen' : 'Fullscreen';
    });
}

document.addEventListener('fullscreenchange', () => {
    updateFullscreenButtonsIcon();
});
document.addEventListener('webkitfullscreenchange', updateFullscreenButtonsIcon);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && screenViewMode === 'expanded') {
        setScreenViewMode('default');
    }
});

function removeRemoteVideo() {
    // Remove all remote-screen-share tiles from the grid.
    const grid = document.getElementById('camera-grid');
    if (!grid) return;
    grid.querySelectorAll('[id^="remote-screen-share-"]').forEach(el => {
        if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
        el.remove();
    });
    updateGridColumns();
    const wasMainGone = expandedCamId && !document.getElementById(expandedCamId);
    if (wasMainGone) {
        expandedCamId = null;
        promoteNextMediaToMainStage();
    }
    if (!expandedCamId) {
        document.body.classList.remove('expanded-tile-mode');
        clearExpandedUsersRail();
    }
}

function updateScreenShareUI() {
    const btn = document.getElementById('screen-share-btn');
    if (!btn) return;
    const baseIcon = `
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
        </svg>`;
    if (isScreenSharing) {
        btn.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-vc-green/20 text-vc-green transition';
        btn.title = 'Stop sharing';
    } else {
        btn.className = 'flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition';
        btn.title = 'Share screen';
    }
    btn.innerHTML = baseIcon;
}

// ─── Camera ───────────────────────────────────────────────────

async function toggleCamera() {
    if (isCameraOn) {
        stopCamera();
    } else {
        await startCamera();
    }
    localStorage.setItem('vocala-camera', isCameraOn);
}

async function startCamera() {
    if (!peerConnection) return;
    try {
        const camConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' };
        if (selectedCamId) camConstraints.deviceId = { exact: selectedCamId };
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: camConstraints,
            audio: false,
        });

        const videoTrack = cameraStream.getVideoTracks()[0];

        // Tell SFU next video track is camera, then add track
        // SFU will initiate renegotiation — do NOT create offer from client
        sendWS({ type: 'camera_on' });
        sendWS({ type: 'media_track', payload: { stream_id: cameraStream.id, kind: 'camera' } });
        cameraSender = peerConnection.addTrack(videoTrack, cameraStream);
        cameraAdaptiveCleanup = startAdaptiveBitrate(cameraSender, CAMERA_BITRATE_TIERS_BPS, 'camera');

        isCameraOn = true;
        updateCameraUI();
        addLocalCameraToGrid();

        videoTrack.onended = () => stopCamera();
    } catch (err) {
        console.error('Failed to start camera:', err);
        // Make sure expectCamera flag is cleared on server
        sendWS({ type: 'camera_off' });
    }
}

function stopCamera() {
    if (cameraAdaptiveCleanup) { cameraAdaptiveCleanup(); cameraAdaptiveCleanup = null; }
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    sendWS({ type: 'camera_off' });
    if (cameraSender && peerConnection) {
        peerConnection.removeTrack(cameraSender);
        cameraSender = null;
    }
    isCameraOn = false;
    updateCameraUI();
    removeFromCameraGrid('local-camera');
}

function updateCameraUI() {
    const btn = document.getElementById('camera-btn');
    if (!btn) return;
    btn.className = isCameraOn
        ? 'flex items-center justify-center w-10 h-10 rounded-full bg-vc-green/20 text-vc-green transition'
        : 'flex items-center justify-center w-10 h-10 rounded-full bg-vc-channel hover:bg-vc-hover text-vc-text transition';
}

// --- Unified camera grid (local + remote) ---

function ensureCameraGrid() {
    if (document.getElementById('camera-grid')) return;
    const anchor = document.getElementById('screen-share-anchor');
    if (!anchor) return;

    const grid = document.createElement('div');
    grid.id = 'camera-grid';
    grid.className = 'grid gap-3 mb-4 w-full max-w-5xl mx-auto';
    anchor.parentElement.insertBefore(grid, anchor.nextSibling);
    updateGridColumns();
    observeCameraGrid();
}

function updateGridColumns() {
    const grid = document.getElementById('camera-grid');
    if (!grid) return;
    const count = grid.children.length;
    let cls;
    if (count <= 1) {
        cls = 'grid grid-cols-1 gap-3 mb-4 w-full max-w-2xl mx-auto';
    } else if (count === 2) {
        cls = 'grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 w-full max-w-4xl mx-auto';
    } else if (count <= 4) {
        cls = 'grid grid-cols-2 gap-3 mb-4 w-full max-w-5xl mx-auto';
    } else if (count <= 9) {
        cls = 'grid grid-cols-2 md:grid-cols-3 gap-2 mb-4 w-full max-w-6xl mx-auto';
    } else if (count <= 16) {
        cls = 'grid grid-cols-3 md:grid-cols-4 gap-2 mb-4 w-full mx-auto';
    } else {
        cls = 'grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1.5 mb-4 w-full mx-auto';
    }
    grid.className = cls;
    syncAvatarTileVisibility();
    if (document.body.classList.contains('expanded-tile-mode')) {
        const ids = Array.from(grid.children).map(el => el.id).sort().join('|');
        if (ids !== _lastRailTilesSignature) {
            _lastRailTilesSignature = ids;
            populateExpandedUsersRail();
        }
    }
}

function ensureExpandedMode() {
    const grid = document.getElementById('camera-grid');
    if (!grid || grid.children.length === 0) return;
    const expandedEl = expandedCamId ? document.getElementById(expandedCamId) : null;
    const expandedAlive = expandedEl && grid.contains(expandedEl);
    if (!expandedAlive) {
        expandedCamId = null;
        promoteNextMediaToMainStage();
    }
    if (expandedCamId && !document.body.classList.contains('expanded-tile-mode')) {
        setCamViewMode(expandedCamId, 'expanded');
    }
}

let _lastRailTilesSignature = '';
let _lastRailUserSignature = '';

function addLocalCameraToGrid() {
    ensureCameraGrid();
    const grid = document.getElementById('camera-grid');
    if (!grid) return;

    const existing = document.getElementById('local-camera');
    if (existing) {
        const v = existing.querySelector('video');
        if (v) {
            try { v.pause(); } catch (_) {}
            v.srcObject = null;
            v.srcObject = cameraStream;
            v.play().catch(() => {});
        }
        attachUserPreviewsToCards();
        if (document.body.classList.contains('expanded-tile-mode')) populateExpandedUsersRail();
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = 'local-camera';
    wrapper.className = 'rounded-xl overflow-hidden bg-black border-2 border-vc-accent aspect-video relative group cursor-pointer';

    const video = document.createElement('video');
    video.srcObject = cameraStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.className = 'w-full h-full object-cover';
    video.style.transform = 'scaleX(-1)';
    video.play().catch(() => {});

    const label = document.createElement('div');
    label.className = 'absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-0.5 rounded z-10';
    label.textContent = 'You';

    const localControls = document.createElement('div');
    localControls.className = 'absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition z-10';
    localControls.innerHTML = `
        <button onclick="event.stopPropagation(); setCamViewMode('local-camera', 'expanded')" title="Expand" class="p-1 rounded bg-black/60 text-white hover:bg-white/20 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
        </button>
        <button onclick="event.stopPropagation(); setCamViewMode('local-camera', 'fullscreen')" title="Fullscreen" class="p-1 rounded bg-black/60 text-white hover:bg-white/20 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM6 14v4h4v2H4v-6h2zm12 4v-4h2v6h-6v-2h4z"/></svg>
        </button>
    `;

    wrapper.onclick = () => {
        const isExpanded = wrapper.dataset.expanded === 'true';
        setCamViewMode('local-camera', isExpanded ? 'default' : 'expanded');
    };

    wrapper.appendChild(video);
    wrapper.appendChild(label);
    wrapper.appendChild(localControls);
    // Local camera always first
    grid.prepend(wrapper);
    updateGridColumns();
}

function handleRemoteCameraTrack(stream, track, mid) {
    ensureCameraGrid();
    const grid = document.getElementById('camera-grid');
    if (!grid) return;

    // stream.id = "camera-{userID}" from SFU — stable across renegotiation
    const camId = 'remote-cam-' + stream.id;
    const existing = document.getElementById(camId);
    if (existing) {
        const prevTrackId = existing.dataset.trackId;
        if (prevTrackId && prevTrackId !== track.id) {
            if (expandedCamId === camId) {
                document.body.classList.remove('expanded-tile-mode');
                expandedCamId = null;
                clearExpandedUsersRail();
            }
            const v = existing.querySelector('video');
            if (v) { try { v.pause(); } catch (_) {} v.srcObject = null; }
            existing.remove();
        } else {
            const video = existing.querySelector('video');
            if (video) {
                try { video.pause(); } catch (_) {}
                video.srcObject = null;
                video.srcObject = new MediaStream([track]);
                video.play().catch(() => {});
            }
            existing.dataset.trackId = track.id;
            attachUserPreviewsToCards();
            if (document.body.classList.contains('expanded-tile-mode')) populateExpandedUsersRail();
            return;
        }
    }

    const wrapper = document.createElement('div');
    wrapper.id = camId;
    wrapper.dataset.trackId = track.id;
    wrapper.className = 'rounded-xl overflow-hidden bg-black border border-vc-border aspect-video relative group cursor-pointer';

    const video = document.createElement('video');
    video.srcObject = new MediaStream([track]);
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.className = 'w-full h-full object-cover';
    video.play().catch(() => {});

    // View mode controls (hover)
    const controls = document.createElement('div');
    controls.className = 'absolute top-1 right-1 flex gap-1 opacity-0 group-hover:opacity-100 transition z-10';
    controls.innerHTML = `
        <button onclick="event.stopPropagation(); setCamViewMode('${camId}', 'expanded')" title="Expand" class="p-1 rounded bg-black/60 text-white hover:bg-white/20 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
        </button>
        <button onclick="event.stopPropagation(); setCamViewMode('${camId}', 'fullscreen')" title="Fullscreen" class="p-1 rounded bg-black/60 text-white hover:bg-white/20 transition">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM6 14v4h4v2H4v-6h2zm12 4v-4h2v6h-6v-2h4z"/></svg>
        </button>
    `;

    // Click on video to toggle expand
    wrapper.onclick = () => {
        const isExpanded = wrapper.dataset.expanded === 'true';
        setCamViewMode(camId, isExpanded ? 'default' : 'expanded');
    };

    wrapper.appendChild(video);
    wrapper.appendChild(controls);
    grid.appendChild(wrapper);
    updateGridColumns();

    track.onended = () => {
        if (document.getElementById(camId)?.dataset.trackId === track.id) removeFromCameraGrid(camId);
    };

    let muteTimer = null;
    track.onmute = () => {
        if (document.getElementById(camId)?.dataset.trackId === track.id)
            muteTimer = setTimeout(() => {
                if (document.getElementById(camId)?.dataset.trackId === track.id) removeFromCameraGrid(camId);
            }, 5000);
    };
    track.onunmute = () => {
        if (muteTimer) { clearTimeout(muteTimer); muteTimer = null; }
    };
}

let expandedCamId = null;

function setCamViewMode(camId, mode) {
    syncControlsBarHeightVar();
    const wrapper = document.getElementById(camId);
    if (!wrapper) return;

    if (mode === 'expanded'
        && expandedCamId === camId
        && wrapper.classList.contains('expanded-tile')
        && document.body.classList.contains('expanded-tile-mode')) {
        return;
    }

    // Reset previous expanded
    if (expandedCamId && expandedCamId !== camId) {
        const prev = document.getElementById(expandedCamId);
        if (prev) {
            prev.classList.remove('expanded-tile');
            prev.style.position = '';
            prev.style.top = '';
            prev.style.left = '';
            prev.style.right = '';
            prev.style.bottom = '';
            prev.style.inset = '';
            prev.style.zIndex = '';
            prev.style.borderRadius = '';
            prev.style.width = '';
            prev.style.height = '';
            prev.dataset.expanded = '';
            prev.className = prev.className.replace('fixed', '').trim();
            prev.querySelectorAll('.cam-close-btn, .cam-rail-btn, .cam-fs-btn, .cam-prev-btn').forEach(el => el.remove());
        }
        expandedCamId = null;
    }

    if (mode === 'default') {
        wrapper.classList.remove('expanded-tile');
        wrapper.style.position = '';
        wrapper.style.top = '';
        wrapper.style.left = '';
        wrapper.style.right = '';
        wrapper.style.bottom = '';
        wrapper.style.inset = '';
        wrapper.style.zIndex = '';
        wrapper.style.borderRadius = '';
        wrapper.style.width = '';
        wrapper.style.height = '';
        wrapper.dataset.expanded = '';
        expandedCamId = null;
        document.body.classList.remove('expanded-tile-mode');
        clearExpandedUsersRail();
        const video = wrapper.querySelector('video');
        if (video) video.className = 'w-full h-full object-cover';
        wrapper.querySelectorAll('.cam-close-btn, .cam-rail-btn, .cam-fs-btn, .cam-prev-btn').forEach(el => el.remove());
    } else if (mode === 'expanded') {
        wrapper.classList.add('expanded-tile');
        wrapper.style.position = '';
        wrapper.style.top = '';
        wrapper.style.left = '';
        wrapper.style.right = '';
        wrapper.style.bottom = '';
        wrapper.style.inset = '';
        wrapper.style.zIndex = '40';
        wrapper.style.borderRadius = '0';
        wrapper.style.width = '';
        wrapper.style.height = '';
        wrapper.dataset.expanded = 'true';
        const wasInExpandedMode = document.body.classList.contains('expanded-tile-mode');
        expandedCamId = camId;
        document.body.classList.add('expanded-tile-mode');
        if (wasInExpandedMode) {
            updateRailMainStageHighlight();
        } else {
            populateExpandedUsersRail();
        }
        const video = wrapper.querySelector('video');
        if (video) video.className = 'w-full h-full object-contain';
        let closeBtn = wrapper.querySelector('.cam-close-btn');
        if (!closeBtn) {
            closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'cam-close-btn absolute top-4 right-4 z-20 p-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition';
            closeBtn.title = 'Exit spotlight (Esc)';
            closeBtn.setAttribute('aria-label', 'Exit spotlight');
            closeBtn.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
            closeBtn.onclick = (e) => { e.stopPropagation(); setCamViewMode(camId, 'default'); };
            wrapper.appendChild(closeBtn);
        }
        let railBtn = wrapper.querySelector('.cam-rail-btn');
        if (!railBtn) {
            railBtn = document.createElement('button');
            railBtn.className = 'cam-rail-btn absolute top-4 right-16 z-20 p-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition';
            railBtn.title = 'Toggle participants';
            railBtn.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z"/></svg>';
            railBtn.onclick = (e) => { e.stopPropagation(); toggleExpandedUsersRail(); };
            wrapper.appendChild(railBtn);
        }
        let fsBtn = wrapper.querySelector('.cam-fs-btn');
        if (!fsBtn) {
            fsBtn = document.createElement('button');
            fsBtn.className = 'cam-fs-btn absolute top-4 right-28 z-20 p-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition';
            fsBtn.title = 'Fullscreen';
            fsBtn.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>';
            fsBtn.onclick = (e) => {
            e.stopPropagation();
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else {
                setCamViewMode(camId, 'fullscreen');
            }
        };
            wrapper.appendChild(fsBtn);
        }
        const prevExists = previousMainTileId && document.getElementById(previousMainTileId);
        let prevBtn = wrapper.querySelector('.cam-prev-btn');
        if (prevExists && previousMainTileId !== camId) {
            if (!prevBtn) {
                prevBtn = document.createElement('button');
                prevBtn.className = 'cam-prev-btn absolute top-4 left-4 z-20 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-black/70 text-white hover:bg-white/20 transition text-sm';
                prevBtn.title = 'Return to previous share';
                prevBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg><span>Previous share</span>';
                prevBtn.onclick = (e) => {
                    e.stopPropagation();
                    swapMainStageWith(previousMainTileId);
                };
                wrapper.appendChild(prevBtn);
            }
        } else if (prevBtn) {
            prevBtn.remove();
        }
        updateFullscreenButtonsIcon();
    } else if (mode === 'fullscreen') {
        if (!wrapper.classList.contains('expanded-tile')) {
            setCamViewMode(camId, 'expanded');
        }
        const target = document.getElementById('main-content') || document.documentElement;
        if (target.requestFullscreen) {
            target.requestFullscreen().catch(err => console.warn('fullscreen failed:', err));
        } else if (target.webkitRequestFullscreen) {
            target.webkitRequestFullscreen();
        }
    }
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    } else if (expandedCamId && !document.getElementById('confirm-modal')) {
        setCamViewMode(expandedCamId, 'default');
    }
});

function removeFromCameraGrid(id) {
    const wasMain = expandedCamId === id;
    if (wasMain) {
        expandedCamId = null;
    }
    const el = document.getElementById(id);
    if (el) el.remove();
    const grid = document.getElementById('camera-grid');
    if (grid && grid.children.length === 0) {
        grid.remove();
    } else {
        updateGridColumns();
    }
    if (wasMain) {
        promoteNextMediaToMainStage();
        if (!expandedCamId) {
            document.body.classList.remove('expanded-tile-mode');
            clearExpandedUsersRail();
        }
    }
    attachUserPreviewsToCards();
}

function showScreenPreviewPlaceholder() {
    // No-op: remote screen shares are now rendered as tiles in camera-grid
    // via showRemoteVideo() as soon as the video track arrives. The standalone
    // preview placeholder is obsolete in the unified-grid layout.
}

function captureAndSendPreview() {
    if (!screenStream) return;
    const video = document.querySelector('#local-screen-share video');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = Math.round(320 * video.videoHeight / video.videoWidth);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
    sendWS({ type: 'screen_preview', payload: { image: dataUrl } });
}

function cleanupWebRTC() {
    activeCallChannelID = null;
    activeCallChannelName = null;
    _stashedCallNodes = null;
    pendingIceCandidates = [];
    clearInterval(screenPreviewInterval);
    screenPreviewInterval = null;
    latestScreenPreview = null;
    screenShareUsername = null;
    if (vadInterval) {
        clearInterval(vadInterval);
        vadInterval = null;
    }
    if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
        analyser = null;
    }
    if (screenAdaptiveCleanup) { screenAdaptiveCleanup(); screenAdaptiveCleanup = null; }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenSender = null;
    isScreenSharing = false;
    removeRemoteVideo();
    removeLocalScreenPreview();
    // Cleanup camera
    if (cameraAdaptiveCleanup) { cameraAdaptiveCleanup(); cameraAdaptiveCleanup = null; }
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    cameraSender = null;
    isCameraOn = false;
    remoteCameras = {};
    const cameraGrid = document.getElementById('camera-grid');
    if (cameraGrid) cameraGrid.remove();
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (processedStream) {
        processedStream.getTracks().forEach(t => t.stop());
        processedStream = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    gainNode = null;
    isSpeaking = false;
}

// ─── WebRTC Diagnostics ───────────────────────────────────────

function diagLogIceServers(iceServers) {
    console.groupCollapsed('[vocala-diag] ICE servers (' + (iceServers?.length || 0) + ')');
    (iceServers || []).forEach((s, i) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        urls.forEach(u => {
            const hasAuth = !!(s.username && s.credential);
            console.log('  [' + i + '] ' + u + (hasAuth ? ' (auth)' : ''));
        });
    });
    console.groupEnd();
}

// Probe each STUN/TURN URL via a temporary RTCPeerConnection and report
// which ones returned candidates (server-reflexive for STUN, relay for TURN).
async function diagProbeIceServers(iceServers, timeoutMs) {
    timeoutMs = timeoutMs || 5000;
    const results = [];
    for (const s of iceServers || []) {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        for (const url of urls) {
            const single = { urls: url };
            if (s.username) single.username = s.username;
            if (s.credential) single.credential = s.credential;
            const r = await diagProbeOne(single, timeoutMs);
            results.push(Object.assign({ url: url }, r));
        }
    }
    console.groupCollapsed('[vocala-diag] STUN/TURN probe results');
    results.forEach(r => {
        const tag = r.ok ? '%c OK ' : '%c FAIL';
        const css = r.ok ? 'background:#0a0;color:#fff;padding:1px 4px' : 'background:#a00;color:#fff;padding:1px 4px';
        console.log(tag + ' %s — srflx=%s relay=%s host=%s err=%s', css, r.url,
            r.srflx || '-', r.relay || '-', r.host || '-', r.err || '-');
    });
    console.groupEnd();
    return results;
}

function diagProbeOne(server, timeoutMs) {
    return new Promise(resolve => {
        let pc;
        const out = { ok: false, srflx: null, relay: null, host: null, err: null };
        try {
            pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: 'all' });
        } catch (e) {
            resolve({ ok: false, err: 'ctor: ' + e.message }); return;
        }
        const done = () => {
            try { pc.close(); } catch (_) {}
            resolve(out);
        };
        const timer = setTimeout(() => {
            if (!out.srflx && !out.relay && !out.host) out.err = 'timeout';
            done();
        }, timeoutMs);
        pc.onicecandidate = (ev) => {
            if (!ev.candidate) {
                clearTimeout(timer);
                out.ok = !!(out.srflx || out.relay);
                // For STUN we expect srflx; for TURN we expect relay.
                const isTurn = (server.urls || '').toString().startsWith('turn');
                if (isTurn && !out.relay) {
                    out.ok = false;
                    out.err = out.err || 'no relay candidate (auth or reachability)';
                } else if (!isTurn && !out.srflx) {
                    out.ok = false;
                    out.err = out.err || 'no srflx candidate (STUN blocked)';
                }
                done();
                return;
            }
            const c = ev.candidate.candidate || '';
            const m = c.match(/ typ (\S+)/);
            const typ = m ? m[1] : '';
            const addrMatch = c.match(/candidate:\S+ \d+ \S+ \d+ (\S+) (\d+)/);
            const addr = addrMatch ? (addrMatch[1] + ':' + addrMatch[2]) : '';
            if (typ === 'srflx') out.srflx = addr || 'yes';
            else if (typ === 'relay') out.relay = addr || 'yes';
            else if (typ === 'host') out.host = addr || 'yes';
        };
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') {
                clearTimeout(timer);
                out.ok = !!(out.srflx || out.relay);
                const isTurn = (server.urls || '').toString().startsWith('turn');
                if (isTurn && !out.relay) {
                    out.ok = false;
                    out.err = out.err || 'no relay candidate';
                } else if (!isTurn && !out.srflx) {
                    out.ok = false;
                    out.err = out.err || 'no srflx candidate';
                }
                done();
            }
        };
        // Need a data channel to trigger gathering without media.
        try { pc.createDataChannel('diag'); } catch (_) {}
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => {
            clearTimeout(timer);
            out.err = 'offer: ' + e.message;
            done();
        });
    });
}

// Snapshot current peerConnection: selected candidate pair, inbound video stats.
async function diagPeerStats() {
    if (!peerConnection) {
        console.warn('[vocala-diag] no active peerConnection');
        return null;
    }
    const stats = await peerConnection.getStats();
    const report = { selectedPair: null, inboundVideo: [], outboundVideo: [], local: null, remote: null };
    const byId = {};
    stats.forEach(r => { byId[r.id] = r; });
    stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
            const local = byId[r.localCandidateId] || {};
            const remote = byId[r.remoteCandidateId] || {};
            report.selectedPair = {
                localType: local.candidateType,
                localProto: local.protocol,
                localAddr: (local.address || local.ip) + ':' + local.port,
                remoteType: remote.candidateType,
                remoteAddr: (remote.address || remote.ip) + ':' + remote.port,
                bytesSent: r.bytesSent, bytesReceived: r.bytesReceived,
                rtt: r.currentRoundTripTime,
            };
        }
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
            report.inboundVideo.push({
                ssrc: r.ssrc, trackId: r.trackIdentifier,
                framesDecoded: r.framesDecoded, framesReceived: r.framesReceived,
                bytesReceived: r.bytesReceived, packetsLost: r.packetsLost,
                frameWidth: r.frameWidth, frameHeight: r.frameHeight,
            });
        }
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
            report.outboundVideo.push({
                ssrc: r.ssrc, framesSent: r.framesSent, framesEncoded: r.framesEncoded,
                bytesSent: r.bytesSent, frameWidth: r.frameWidth, frameHeight: r.frameHeight,
            });
        }
    });
    console.groupCollapsed('[vocala-diag] Peer connection stats');
    console.log('connectionState:', peerConnection.connectionState);
    console.log('iceConnectionState:', peerConnection.iceConnectionState);
    console.log('iceGatheringState:', peerConnection.iceGatheringState);
    console.log('selected pair:', report.selectedPair);
    console.log('inbound video:', report.inboundVideo);
    console.log('outbound video:', report.outboundVideo);
    console.groupEnd();
    // Warn if inbound video has frames received but none decoded — typical "black screen".
    report.inboundVideo.forEach(v => {
        if (v.framesReceived > 0 && (!v.framesDecoded || v.framesDecoded === 0)) {
            console.warn('[vocala-diag] black screen suspected: ssrc=' + v.ssrc +
                ' received=' + v.framesReceived + ' decoded=' + v.framesDecoded);
        }
    });
    return report;
}

// Public entry point — users run `vocalaDiag()` from devtools.
window.vocalaDiag = async function () {
    const iceServers = window.VOCALA_ICE_SERVERS || [
        { urls: 'stun:stun.l.google.com:19302' },
    ];
    diagLogIceServers(iceServers);
    const probe = await diagProbeIceServers(iceServers, 5000);
    const stats = await diagPeerStats();
    return { iceServers, probe, stats };
};

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
    // audioContext is already created in startWebRTC
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const freqBins = analyser.frequencyBinCount;
    const sampleRate = audioContext.sampleRate;
    const binHz = sampleRate / 2 / freqBins;
    const speechLowBin = Math.max(1, Math.floor(150 / binHz));
    const speechHighBin = Math.min(freqBins - 1, Math.ceil(4000 / binHz));
    const dataArray = new Uint8Array(freqBins);

    let noiseFloor = 8;            // running estimate of background noise
    let speechHoldFrames = 0;      // keep gate open this many frames after speech
    const HOLD_FRAMES = 12;        // ~600ms tail so word-endings aren't cut
    const RATIO_OPEN = 2.2;        // open gate when energy > noise * this
    const RATIO_CLOSE = 1.4;       // close when below this (hysteresis)
    let gateOpen = false;
    let smoothedGain = 0;

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

    vadInterval = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);

        let total = 0;
        for (let i = 0; i < freqBins; i++) total += dataArray[i];
        currentVadLevel = total / freqBins;

        let speech = 0;
        for (let i = speechLowBin; i <= speechHighBin; i++) speech += dataArray[i];
        speech /= (speechHighBin - speechLowBin + 1);

        if (!gateOpen) {
            noiseFloor += (speech - noiseFloor) * 0.05;
        } else {
            noiseFloor += Math.min(0, speech - noiseFloor) * 0.05;
        }
        noiseFloor = Math.max(1, noiseFloor);

        const manual = Math.max(2, vadThreshold);
        const openThresh = Math.max(manual, noiseFloor * RATIO_OPEN);
        const closeThresh = Math.max(manual * 0.7, noiseFloor * RATIO_CLOSE);

        const meter = document.getElementById('vad-meter');
        if (meter) {
            const pct = Math.min(100, (currentVadLevel / 80) * 100);
            meter.style.width = pct + '%';
            meter.className = `h-full rounded-full transition-all duration-75 ${gateOpen ? 'bg-vc-green' : 'bg-vc-muted/50'}`;
        }

        if (isMuted || (pushToTalk && !pttActive)) {
            return;
        }

        if (speech > openThresh) {
            gateOpen = true;
            speechHoldFrames = HOLD_FRAMES;
        } else if (speech < closeThresh && speechHoldFrames === 0) {
            gateOpen = false;
        }
        if (gateOpen && speech <= openThresh) speechHoldFrames--;

        const target = gateOpen ? 1.0 : (rnnoiseEnabled ? 0.15 : 0.0);
        smoothedGain += (target - smoothedGain) * (target > smoothedGain ? 0.6 : 0.25);
        if (gainNode) gainNode.gain.value = Math.max(0, Math.min(1, smoothedGain));

        if (gateOpen !== isSpeaking) {
            isSpeaking = gateOpen;
            sendWS({ type: 'speaking', payload: { speaking: isSpeaking } });
            updateSelfSpeakingUI(isSpeaking);
        }
        void isIOS;
    }, 50);
}

function updateSelfSpeakingUI(speaking) {
    const avatar = document.getElementById('self-avatar');
    const indicator = document.getElementById('self-speaking-indicator');
    if (avatar) {
        if (speaking) {
            avatar.classList.add('ring-2', 'ring-vc-green', 'ring-offset-1', 'ring-offset-vc-bg');
        } else {
            avatar.classList.remove('ring-2', 'ring-vc-green', 'ring-offset-1', 'ring-offset-vc-bg');
        }
    }
    if (indicator) {
        indicator.classList.toggle('hidden', !speaking);
        indicator.classList.toggle('flex', speaking);
    }
}

function setVadThreshold(value) {
    vadThreshold = parseInt(value);
    localStorage.setItem('vocala-vad-threshold', vadThreshold);
    const label = document.getElementById('vad-threshold-label');
    if (label) label.textContent = vadThreshold;
    const marker = document.getElementById('vad-threshold-marker');
    if (marker) marker.style.left = Math.min(100, (vadThreshold / 80) * 100) + '%';
}

// ─── Push-to-Talk Keyboard ────────────────────────────────────

document.addEventListener('keydown', (e) => {
    if (!pushToTalk || !localStream) return;
    if (e.code === 'Space' && !e.repeat && !isInputFocused()) {
        e.preventDefault();
        pttActive = true;
        if (gainNode) gainNode.gain.value = 1.0;
    }
});

document.addEventListener('keyup', (e) => {
    if (!pushToTalk || !localStream) return;
    if (e.code === 'Space' && !isInputFocused()) {
        e.preventDefault();
        pttActive = false;
        if (gainNode) gainNode.gain.value = 0.0;
    }
});

function isInputFocused() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.contentEditable === 'true');
}

// ─── Init ─────────────────────────────────────────────────────

// Delegated click handlers for data-action buttons (XSS-safe, no inline onclick)
document.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const chId = +btn.dataset.chId;
    const chName = btn.dataset.chName;
    if (action === 'manage-members') openMemberManager(chId, chName);
    if (action === 'delete-channel') deleteChannel(chId, chName);
    if (action === 'toggle-privacy') toggleChannelPrivacy(chId, chName, btn.dataset.private === 'true');
    if (action === 'join-channel') joinChannel(chId, chName);
});

// Set self avatar
const selfAvatar = document.getElementById('self-avatar');
if (selfAvatar && selfAvatar.dataset.username) {
    selfAvatar.src = avatarURL(selfAvatar.dataset.username);
}

connectWS();
checkMicPermission();
if (!window.VOCALA_GUEST_CHANNEL) {
    loadDMList();
    loadGroupList();
    setInterval(() => { loadDMList(); loadGroupList(); }, 30000);
}
// Notification.requestPermission() must be called from a user gesture —
// Firefox blocks it otherwise. Defer to the first click on the page.
document.addEventListener('click', requestNotificationPermission, { once: true, capture: true });

function reconnectIfNeeded() {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectAttempts = 0;
        connectWS();
    }
}

let cameraWasOnBeforeHidden = false;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        cameraWasOnBeforeHidden = !!isCameraOn;
    } else {
        reconnectIfNeeded();
        if (cameraWasOnBeforeHidden && !isCameraOn) {
            cameraWasOnBeforeHidden = false;
            setTimeout(() => {
                if (peerConnection && !isCameraOn) {
                    startCamera().catch(err => console.warn('camera resume failed:', err));
                }
            }, 600);
        }
    }
});
window.addEventListener('focus', reconnectIfNeeded);
window.addEventListener('online', reconnectIfNeeded);
window.addEventListener('pageshow', reconnectIfNeeded);

async function checkMicPermission() {
    if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        return;
    }
    try {
        const result = await navigator.permissions.query({ name: 'microphone' });
        if (result.state === 'denied') {
            showGlobalMicWarning();
        }
        result.addEventListener('change', () => {
            if (result.state === 'denied') {
                showGlobalMicWarning();
            } else {
                hideGlobalMicWarning();
            }
        });
    } catch (e) {
    }
}

function showGlobalMicWarning() {
    if (!isMuted) {
        isMuted = true;
        updateMuteUI();
    }
    if (document.getElementById('global-mic-warning')) return;
    const banner = document.createElement('div');
    banner.id = 'global-mic-warning';
    banner.className = 'fixed top-0 left-0 right-0 z-50 bg-vc-red/90 backdrop-blur-sm text-white px-4 py-3 flex items-center justify-center gap-3 text-sm shadow-lg';
    banner.innerHTML = `
        <svg class="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
        </svg>
        <span><strong>Microphone blocked</strong> — Click the lock icon in the address bar, allow microphone access, and reload the page.</span>
    `;
    document.body.prepend(banner);
}

function hideGlobalMicWarning() {
    const banner = document.getElementById('global-mic-warning');
    if (banner) banner.remove();
}

// ─── Chat ─────────────────────────────────────────────────────

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '👏', '🔥'];

function sendVoiceReaction(emoji) {
    sendWS({ type: 'voice_reaction', payload: { emoji } });
}

function handleStaleChannel() {
    document.getElementById('member-modal')?.remove();
    document.getElementById('settings-modal')?.remove();
    if (currentChannelID) {
        sendWS({ type: 'leave_channel' });
        currentChannelID = null;
        cleanupWebRTC();
    }
    history.pushState({}, '', '/');
    const mc = document.getElementById('main-content');
    if (mc) mc.innerHTML = '<div class="flex-1 flex items-center justify-center text-vc-muted text-sm">This channel no longer exists.</div>';
    showToast('Channel no longer exists');
}

function showToast(text) {
    const t = document.createElement('div');
    t.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-vc-sidebar border border-vc-border shadow-lg text-sm text-vc-text';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity 0.4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(() => t.remove(), 3100);
}

function showDoubleLoginBanner() {
    if (document.getElementById('double-login-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'double-login-banner';
    banner.className = 'fixed top-0 inset-x-0 z-50 bg-vc-red/90 text-white px-4 py-3 text-sm flex items-center justify-center gap-3 shadow-lg';
    banner.innerHTML = `
        <span>You signed in from another window. This tab has been disconnected.</span>
        <button class="px-3 py-1 rounded bg-white/20 hover:bg-white/30 transition">Reconnect here</button>
    `;
    banner.querySelector('button').addEventListener('click', () => {
        banner.remove();
        wsBouncedOut = false;
        wsRapidBounceCount = 0;
        reconnectAttempts = 0;
        connectWS();
    });
    document.body.appendChild(banner);
}

function startHuddle(toUserId) {
    outgoingCalleeUserId = toUserId;
    const dmRow = document.querySelector(`#dm-list [data-other-id="${toUserId}"]`);
    outgoingCalleeUsername = dmRow ? (dmRow.querySelector('.dm-name')?.textContent || '') : '';
    sendWS({ type: 'huddle_invite', payload: { to_user_id: toUserId } });
    showToast('Calling…');
}


async function loadGroupList() {
    try {
        const res = await fetch('/api/groups');
        if (!res.ok) return;
        const list = await res.json();
        renderGroupList(list || []);
    } catch (err) {
        console.error('loadGroupList failed', err);
    }
}

let _loadDMListTimer = null;
let _loadGroupListTimer = null;
function loadDMListDebounced() {
    if (_loadDMListTimer) return;
    _loadDMListTimer = setTimeout(() => { _loadDMListTimer = null; loadDMList(); }, 400);
}
function loadGroupListDebounced() {
    if (_loadGroupListTimer) return;
    _loadGroupListTimer = setTimeout(() => { _loadGroupListTimer = null; loadGroupList(); }, 400);
}

function renderGroupList(items) {
    const root = document.getElementById('group-list');
    const section = document.getElementById('group-section');
    if (!root) return;
    if (!items.length) {
        root.innerHTML = '';
        if (section) section.classList.add('hidden');
        return;
    }
    if (section) section.classList.remove('hidden');
    root.innerHTML = '';
    items.forEach(g => {
        const active = currentChannelID === g.ID ? 'bg-vc-hover/60' : 'hover:bg-vc-hover';
        const row = document.createElement('div');
        row.className = `flex items-center gap-2 px-2 py-1.5 rounded-lg ${active} transition cursor-pointer`;
        row.dataset.groupChannel = String(g.ID);
        row.innerHTML = `
            <div class="w-7 h-7 rounded-lg bg-vc-channel flex items-center justify-center flex-shrink-0">
                <svg class="w-4 h-4 text-vc-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-5a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
            </div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-vc-text truncate"></div>
            </div>
        `;
        row.querySelector('.flex-1 > div').textContent = g.Name;
        row.addEventListener('click', () => openGroupChannel(g.ID, g.Name));
        root.appendChild(row);
    });
    const ids = items.map(g => g.ID);
    if (ids.length > 0) sendWS({ type: 'watch_channels', payload: { channel_ids: ids } });
}

function openGroupChannel(channelId, name) {
    // Match DM behaviour: clicking a Group opens chat-only first; the user can
    // then press the Huddle button in the header to start/join the call. If
    // they're already voice-joined to this group, joinChannel will restore
    // the live call view.
    joinChannel(channelId, name, { chatOnly: true });
}

async function loadDMList() {
    try {
        const res = await fetch('/api/dms');
        if (!res.ok) return;
        const list = await res.json();
        renderDMList(list || []);
    } catch (err) {
        console.error('loadDMList failed', err);
    }
}

function dmRelativeTime(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
    return new Date(ts * 1000).toLocaleDateString();
}

function renderDMList(items) {
    const root = document.getElementById('dm-list');
    if (!root) return;
    items.forEach(d => {
        dmChannelIds.add(d.channel_id);
        if (typeof d.unread_count === 'number') {
            if (d.unread_count > 0) dmUnread.set(d.channel_id, d.unread_count);
            else dmUnread.delete(d.channel_id);
        }
    });
    persistDMUnread();
    if (!items.length) {
        root.innerHTML = '<div class="text-center text-vc-muted text-xs py-2">No conversations yet</div>';
        return;
    }
    root.innerHTML = '';
    items.forEach(d => {
        const active = currentChannelID === d.channel_id ? 'bg-vc-hover/60' : 'hover:bg-vc-hover';
        const row = document.createElement('div');
        row.className = `group flex items-center gap-2 px-2 py-1.5 rounded-lg ${active} transition cursor-pointer`;
        row.dataset.dmChannel = String(d.channel_id);
        row.dataset.otherId = String(d.other_user_id);
        row.innerHTML = `
            <img src="${avatarURL(d.other_name)}" alt="" class="w-7 h-7 rounded-full flex-shrink-0">
            <div class="flex-1 min-w-0">
                <div class="dm-name text-sm font-medium text-vc-text truncate"></div>
            </div>
        `;
        row.querySelector('.dm-name').textContent = d.other_name;
        row.addEventListener('click', () => openDMChannel(d.channel_id, d.other_name));
        root.appendChild(row);
    });
    updateCallIndicators();
    updateGlobalUnreadFavicon();
    const ids = items.map(d => d.channel_id);
    if (ids.length > 0) {
        sendWS({ type: 'watch_channels', payload: { channel_ids: ids } });
    }
}

const dmChannelIds = new Set();

const dmUnread = (() => {
    try {
        return new Map(Object.entries(JSON.parse(localStorage.getItem('vocala-dm-unread') || '{}')).map(([k, v]) => [parseInt(k, 10), v | 0]));
    } catch (_) {
        return new Map();
    }
})();

function persistDMUnread() {
    try {
        const obj = {};
        for (const [k, v] of dmUnread) {
            if (v > 0) obj[k] = v;
        }
        localStorage.setItem('vocala-dm-unread', JSON.stringify(obj));
    } catch (_) {}
}

function bumpDMUnread(channelID) {
    if (!dmChannelIds.has(channelID)) return;
    if (currentChannelID === channelID && document.visibilityState !== 'hidden') return;
    dmUnread.set(channelID, (dmUnread.get(channelID) || 0) + 1);
    persistDMUnread();
    updateCallIndicators();
    updateGlobalUnreadFavicon();
}

function clearDMUnread(channelID) {
    if (!dmUnread.has(channelID)) return;
    dmUnread.delete(channelID);
    persistDMUnread();
    updateCallIndicators();
    updateGlobalUnreadFavicon();
}

function updateCallIndicators() {
    updateDMUnreadIndicators();
    updateUserCardCallIndicators();
    syncOutgoingPhantomCard();
    updateActiveHuddleBadges();
}

function dmHasActiveHuddle(channelID) {
    const selfName = document.getElementById('self-avatar')?.dataset?.username;
    const users = channelUsersData[channelID] || [];
    return users.some(u => u.Username !== selfName);
}

function userIsInAnyCall(userID) {
    if (!userID) return false;
    const uid = Number(userID);
    for (const id of Object.keys(channelUsersData)) {
        const list = channelUsersData[id] || [];
        if (list.some(u => Number(u.ID) === uid)) return true;
    }
    return false;
}

function rejoinActiveHuddle(channelID, displayName) {
    isDMHuddleActive = true;
    currentChannelID = null;
    joinChannel(channelID, displayName, { forceHuddle: true });
}

function updateActiveHuddleBadges() {
    document.querySelectorAll('#dm-list [data-dm-channel]').forEach(row => {
        const id = parseInt(row.dataset.dmChannel, 10);
        const otherId = parseInt(row.dataset.otherId, 10);
        let badge = row.querySelector('.dm-active-huddle');
        const hasCallBadge = !!row.querySelector('.dm-call-badge');
        const showBadge = !hasCallBadge && (dmHasActiveHuddle(id) || userIsInAnyCall(otherId));
        if (showBadge) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'dm-active-huddle flex-shrink-0 inline-flex items-center justify-center w-[20px] h-[20px] rounded-full bg-vc-accent/15 text-vc-accent';
                badge.title = 'On a call';
                badge.innerHTML = '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3a9 9 0 00-9 9v6a3 3 0 003 3h3v-8H5v-1a7 7 0 0114 0v1h-4v8h3a3 3 0 003-3v-6a9 9 0 00-9-9z"/></svg>';
                row.insertBefore(badge, row.querySelector('button'));
            }
        } else if (badge) {
            badge.remove();
        }
    });
    if (isCurrentChannelDM && !isDMHuddleActive && currentChannelID) {
        const huddleBtn = document.querySelector('#main-content [data-dm-huddle-btn]');
        const banner = document.getElementById('active-huddle-banner');
        const active = dmHasActiveHuddle(currentChannelID);
        if (active) {
            if (huddleBtn && !huddleBtn.dataset.rejoinWired) {
                huddleBtn.dataset.rejoinWired = '1';
                huddleBtn.dataset.originalOnclick = huddleBtn.getAttribute('onclick') || '';
                huddleBtn.removeAttribute('onclick');
                huddleBtn.onclick = (e) => {
                    e.stopPropagation();
                    const dmRow = document.querySelector(`#dm-list [data-dm-channel="${currentChannelID}"]`);
                    const name = dmRow ? (dmRow.querySelector('.dm-name')?.textContent || '') : '';
                    rejoinActiveHuddle(currentChannelID, name);
                };
            }
            if (huddleBtn) {
                huddleBtn.classList.add('bg-vc-green', 'hover:bg-vc-green/80');
                huddleBtn.classList.remove('bg-vc-accent', 'hover:bg-vc-accent/80');
                const label = huddleBtn.querySelector('span');
                if (label) label.textContent = 'Rejoin huddle';
                huddleBtn.title = 'Rejoin the active huddle';
            }
            if (!banner) {
                const header = document.querySelector('#main-content > div > div:first-child');
                if (header) {
                    const b = document.createElement('div');
                    b.id = 'active-huddle-banner';
                    b.className = 'flex items-center gap-2 px-4 md:px-6 py-2 bg-vc-green/15 border-b border-vc-green/30 text-sm cursor-pointer';
                    b.innerHTML = `
                        <svg class="w-4 h-4 text-vc-green animate-pulse" fill="currentColor" viewBox="0 0 24 24"><path d="M6.62 10.79a15.5 15.5 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24 11.4 11.4 0 003.57.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.57 1 1 0 01-.24 1.02l-2.21 2.2z"/></svg>
                        <span class="text-vc-green flex-1">Huddle in progress</span>
                        <button class="px-3 py-1 text-xs rounded-md bg-vc-green text-white hover:bg-vc-green/80 transition">Rejoin</button>
                    `;
                    const doRejoin = (e) => {
                        e.stopPropagation();
                        const dmRow = document.querySelector(`#dm-list [data-dm-channel="${currentChannelID}"]`);
                        const name = dmRow ? (dmRow.querySelector('.dm-name')?.textContent || '') : '';
                        rejoinActiveHuddle(currentChannelID, name);
                    };
                    b.querySelector('button').onclick = doRejoin;
                    b.onclick = doRejoin;
                    header.insertAdjacentElement('afterend', b);
                }
            }
        } else {
            if (huddleBtn && huddleBtn.dataset.rejoinWired) {
                delete huddleBtn.dataset.rejoinWired;
                const orig = huddleBtn.dataset.originalOnclick;
                if (orig) huddleBtn.setAttribute('onclick', orig);
                huddleBtn.onclick = null;
            }
            if (huddleBtn) {
                huddleBtn.classList.remove('bg-vc-green', 'hover:bg-vc-green/80');
                huddleBtn.classList.add('bg-vc-accent', 'hover:bg-vc-accent/80');
                const label = huddleBtn.querySelector('span');
                if (label) label.textContent = 'Huddle';
                huddleBtn.title = 'Start huddle';
            }
            if (banner) banner.remove();
        }
    }
}

function syncOutgoingPhantomCard() {
    const grid = document.querySelector('#channel-view-users .user-grid');
    const existing = document.getElementById('outgoing-call-phantom');
    if (!outgoingCalleeUserId || !grid) {
        if (existing) existing.remove();
        return;
    }
    const real = grid.querySelector(`[data-user-id="${outgoingCalleeUserId}"]`);
    if (real) {
        if (existing) existing.remove();
        return;
    }
    const name = outgoingCalleeUsername || 'User';
    if (existing) {
        const nameEl = existing.querySelector('.user-name');
        if (nameEl) nameEl.textContent = name;
        return;
    }
    const card = document.createElement('div');
    card.id = 'outgoing-call-phantom';
    card.className = 'flex flex-col items-center gap-3 p-4 rounded-xl bg-vc-sidebar/40 border border-vc-accent/40 transition-all duration-200';
    card.innerHTML = `
        <div class="relative">
            <div class="avatar-circle w-16 h-16 rounded-full overflow-hidden transition-all ring-2 ring-vc-accent/40 animate-pulse">
                <img src="${avatarURL(name)}" alt="" class="w-full h-full">
            </div>
            <div class="absolute -top-1 -left-1 w-6 h-6 rounded-full bg-vc-accent flex items-center justify-center border-2 border-vc-bg shadow-md animate-pulse">
                <svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6.62 10.79a15.5 15.5 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24 11.4 11.4 0 003.57.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.57 1 1 0 01-.24 1.02l-2.21 2.2z"/></svg>
            </div>
        </div>
        <span class="user-name text-sm font-medium text-vc-text">${escapeHTML(name)}</span>
        <span class="text-[11px] text-vc-accent">Calling…</span>
        <div class="speaking-spacer h-5"></div>
    `;
    grid.appendChild(card);
}

function removeOutgoingPhantomCard() {
    const el = document.getElementById('outgoing-call-phantom');
    if (el) el.remove();
}

function updateUserCardCallIndicators() {
    document.querySelectorAll('#channel-view-users [data-user-id]').forEach(card => {
        const uid = parseInt(card.dataset.userId, 10);
        let dmCh = 0;
        const dmRow = document.querySelector(`#dm-list [data-other-id="${uid}"]`);
        if (dmRow) dmCh = parseInt(dmRow.dataset.dmChannel, 10) || 0;
        const incoming = dmCh && incomingCallChannelID === dmCh;
        const outgoing = dmCh && outgoingCallChannelID === dmCh;

        const avatarWrap = card.querySelector('.relative');
        if (!avatarWrap) return;
        let badge = avatarWrap.querySelector('.card-call-badge');
        if (incoming || outgoing) {
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'card-call-badge absolute -top-1 -left-1 w-6 h-6 rounded-full flex items-center justify-center border-2 border-vc-bg shadow-md';
                avatarWrap.appendChild(badge);
            }
            const bg = incoming ? 'bg-vc-green' : 'bg-vc-accent';
            badge.className = `card-call-badge absolute -top-1 -left-1 w-6 h-6 rounded-full flex items-center justify-center border-2 border-vc-bg shadow-md ${bg} animate-pulse`;
            badge.title = incoming ? 'Incoming call' : 'Calling…';
            badge.innerHTML = '<svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6.62 10.79a15.5 15.5 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24 11.4 11.4 0 003.57.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.57 1 1 0 01-.24 1.02l-2.21 2.2z"/></svg>';
        } else if (badge) {
            badge.remove();
        }
    });
}

function updateDMUnreadIndicators() {
    document.querySelectorAll('#dm-list [data-dm-channel]').forEach(row => {
        const id = parseInt(row.dataset.dmChannel, 10);
        const count = dmUnread.get(id) || 0;
        const nameEl = row.querySelector('.dm-name');
        const incoming = incomingCallChannelID === id;
        const outgoing = outgoingCallChannelID === id;
        let callBadge = row.querySelector('.dm-call-badge');
        if (incoming || outgoing) {
            if (!callBadge) {
                callBadge = document.createElement('span');
                callBadge.className = 'dm-call-badge flex-shrink-0 inline-flex items-center justify-center w-[20px] h-[20px] rounded-full text-[11px]';
                row.insertBefore(callBadge, row.querySelector('button'));
            }
            const color = incoming ? 'bg-vc-green text-white animate-pulse' : 'bg-vc-accent text-white animate-pulse';
            callBadge.className = `dm-call-badge flex-shrink-0 inline-flex items-center justify-center w-[20px] h-[20px] rounded-full text-[11px] ${color}`;
            callBadge.title = incoming ? 'Incoming call' : 'Calling…';
            callBadge.innerHTML = '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M6.62 10.79a15.5 15.5 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24 11.4 11.4 0 003.57.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.4 11.4 0 00.57 3.57 1 1 0 01-.24 1.02l-2.21 2.2z"/></svg>';
        } else if (callBadge) {
            callBadge.remove();
        }
        let badge = row.querySelector('.dm-unread-badge');
        if (count > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'dm-unread-badge flex-shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-vc-accent text-white text-[10px] font-semibold';
                row.insertBefore(badge, row.querySelector('button'));
            }
            badge.textContent = count > 99 ? '99+' : String(count);
            if (nameEl) nameEl.classList.add('font-semibold', 'text-vc-text');
        } else {
            if (badge) badge.remove();
            if (nameEl) nameEl.classList.remove('font-semibold');
        }
    });
}

function updateGlobalUnreadFavicon() {
    let total = 0;
    for (const v of dmUnread.values()) total += v;
    const base = 'Vocala';
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${base}` : base;
}

function openDMChannel(channelId, otherName) {
    dmChannelIds.add(channelId);
    clearDMUnread(channelId);
    joinChannel(channelId, otherName, { isDM: true });
}

function renderDMChatOnly(channelID, displayName) {
    renderChannelChatOnly(channelID, displayName, { isDM: true });
}

function renderChannelChatOnly(channelID, displayName, opts) {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
    const isDM = !!opts?.isDM;
    let otherUserId = 0;
    if (isDM) {
        const dmRow = document.querySelector(`#dm-list [data-dm-channel="${channelID}"]`);
        if (dmRow) otherUserId = parseInt(dmRow.dataset.otherId, 10) || 0;
    }
    const safeName = escapeHTML(displayName || (isDM ? 'Direct message' : 'Channel'));
    const huddleBtn = isDM && otherUserId
        ? `<button data-dm-huddle-btn onclick="startDMHuddle(${channelID}, ${otherUserId}, '${safeName.replace(/'/g, "\\'")}')" class="flex items-center gap-1.5 px-3 py-1.5 bg-vc-accent hover:bg-vc-accent/80 text-white text-xs md:text-sm rounded-lg transition" title="Start huddle">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.95.68l1.5 4.49a1 1 0 01-.5 1.21l-2.26 1.13a11 11 0 005.52 5.52l1.13-2.26a1 1 0 011.21-.5l4.49 1.5a1 1 0 01.68.95V19a2 2 0 01-2 2h-1C9.72 21 3 14.28 3 6V5z"/></svg>
            <span>Huddle</span>
        </button>`
        : `<button data-dm-huddle-btn onclick="joinChannelHuddle(${channelID}, '${safeName.replace(/'/g, "\\'")}')" class="flex items-center gap-1.5 px-3 py-1.5 bg-vc-accent hover:bg-vc-accent/80 text-white text-xs md:text-sm rounded-lg transition" title="Join huddle">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.95.68l1.5 4.49a1 1 0 01-.5 1.21l-2.26 1.13a11 11 0 005.52 5.52l1.13-2.26a1 1 0 011.21-.5l4.49 1.5a1 1 0 01.68.95V19a2 2 0 01-2 2h-1C9.72 21 3 14.28 3 6V5z"/></svg>
            <span>Join huddle</span>
        </button>`;
    const avatar = isDM
        ? `<img src="${avatarURL(displayName || 'dm')}" class="w-8 h-8 rounded-full flex-shrink-0">`
        : `<svg class="w-6 h-6 text-vc-accent flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`;
    const returnPill = (activeCallChannelID && activeCallChannelID !== channelID)
        ? `<button onclick="returnToActiveCall()" class="flex items-center gap-1.5 px-3 py-1.5 bg-vc-green/20 hover:bg-vc-green/30 text-vc-green text-xs md:text-sm rounded-lg transition" title="Return to your call">
            <span class="w-2 h-2 rounded-full bg-vc-green animate-pulse"></span>
            <span>Return to call</span>
        </button>`
        : '';
    mainContent.innerHTML = `
        <div class="w-full h-full flex flex-col">
            <div class="px-4 md:px-6 py-3 border-b border-vc-border flex items-center gap-3">
                ${avatar}
                <h2 class="text-base md:text-xl font-bold truncate flex-1">${safeName}</h2>
                ${returnPill}
                ${huddleBtn}
                <button onclick="leaveChannel()" class="px-3 py-1.5 bg-vc-channel hover:bg-vc-hover text-vc-muted hover:text-vc-text text-xs md:text-sm rounded-lg transition" title="Close">
                    Close
                </button>
            </div>
            <div class="flex-1 flex flex-col overflow-hidden">
                <div id="chat-messages" class="flex-1 overflow-y-auto p-3 space-y-1 min-h-0"></div>
                <div class="p-3 border-t border-vc-border">
                    <form onsubmit="sendChatMessage(event)" class="flex gap-2">
                        <input type="text" id="chat-input" placeholder="Message ${safeName}…" autocomplete="off"
                            class="flex-1 px-3 py-2 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                        <button type="submit" class="px-3 py-2 bg-vc-accent hover:bg-vc-accent/80 text-white rounded-lg transition">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                            </svg>
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `;
    setTimeout(updateActiveHuddleBadges, 0);
}

function joinChannelHuddle(channelID, displayName) {
    chatOnlyChannelID = null;
    currentChannelID = null;
    joinChannel(channelID, displayName, { forceHuddle: true });
}

// _stashedCallNodes holds the detached call-view DOM while the user peeks
// another channel's chat. Stored in a JS var (not in the live document) so
// getElementById doesn't see duplicate IDs.
let _stashedCallNodes = null;

function stashCallView() {
    const main = document.getElementById('main-content');
    if (!main) return;
    const frag = document.createDocumentFragment();
    while (main.firstChild) frag.appendChild(main.firstChild);
    _stashedCallNodes = frag;
}

// returnToActiveCall restores the cached call-view DOM. Used when the user
// clicks back into the channel they're actively voice-joined to.
function returnToActiveCall() {
    if (!activeCallChannelID) return;
    currentChannelID = activeCallChannelID;
    chatOnlyChannelID = null;
    isCurrentChannelDM = !!(activeCallChannelName && /^dm-\d+-\d+$/.test(activeCallChannelName)) || dmChannelIds.has(activeCallChannelID);
    isDMHuddleActive = isCurrentChannelDM;
    const main = document.getElementById('main-content');
    if (main && _stashedCallNodes) {
        main.innerHTML = '';
        main.appendChild(_stashedCallNodes);
        _stashedCallNodes = null;
    }
    document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('bg-vc-hover/50'));
    const item = document.querySelector(`[data-channel-id="${activeCallChannelID}"]`);
    if (item) item.classList.add('bg-vc-hover/50');
    if (!window.VOCALA_GUEST_CHANNEL && activeCallChannelName) {
        history.pushState({ channelID: activeCallChannelID, channelName: activeCallChannelName }, '', '/channels/' + encodeURIComponent(activeCallChannelName));
    }
    const mobileChName = document.getElementById('mobile-channel-name');
    if (mobileChName && activeCallChannelName) mobileChName.textContent = activeCallChannelName;
}

async function openAddToCallPicker() {
    if (!currentChannelID) return;
    try {
        const res = await fetch('/api/users');
        const users = await res.json();
        const selfName = document.getElementById('self-avatar')?.dataset?.username || window.VOCALA_GUEST_NAME;
        const presentIds = new Set((lastChannelUsers || []).map(u => u.ID));
        const candidates = (users || []).filter(u => u.username !== selfName && !presentIds.has(u.id));

        document.getElementById('add-to-call-picker')?.remove();
        const modal = document.createElement('div');
        modal.id = 'add-to-call-picker';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4';
        modal.innerHTML = `
            <div class="bg-vc-sidebar border border-vc-border rounded-xl shadow-2xl w-80 max-h-[70vh] flex flex-col">
                <div class="flex items-center justify-between px-4 py-3 border-b border-vc-border">
                    <h3 class="text-sm font-bold text-vc-text">Add to call</h3>
                    <button onclick="document.getElementById('add-to-call-picker').remove()" class="text-vc-muted hover:text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <input id="add-to-call-search" type="text" placeholder="Search…" autocomplete="off"
                    class="m-3 px-3 py-1.5 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                <div id="add-to-call-list" class="flex-1 overflow-y-auto px-2 pb-2 space-y-1"></div>
                <div class="px-3 py-2 border-t border-vc-border flex justify-end">
                    <button id="add-to-call-invite" disabled
                        class="px-3 py-1.5 rounded-lg bg-vc-accent hover:bg-vc-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition">Invite</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const listEl = document.getElementById('add-to-call-list');
        const inviteBtn = document.getElementById('add-to-call-invite');
        const selected = new Set();
        const updateInvite = () => { inviteBtn.disabled = selected.size === 0; };
        const render = (q) => {
            q = (q || '').toLowerCase().trim();
            const matches = candidates.filter(u => !q || u.username.toLowerCase().includes(q));
            if (matches.length === 0) {
                listEl.innerHTML = '<div class="text-center text-vc-muted text-xs py-3">No users to add</div>';
                return;
            }
            listEl.innerHTML = matches.map(u => `
                <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-vc-hover transition cursor-pointer">
                    <input type="checkbox" data-uid="${u.id}" ${selected.has(u.id) ? 'checked' : ''}
                        class="rounded border-vc-border text-vc-accent focus:ring-vc-accent">
                    <img src="${avatarURL(u.username)}" class="w-6 h-6 rounded-full">
                    <span class="text-sm text-vc-text">${escapeHTML(u.username)}</span>
                </label>
            `).join('');
            listEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
                cb.addEventListener('change', () => {
                    const id = parseInt(cb.dataset.uid, 10);
                    if (cb.checked) selected.add(id); else selected.delete(id);
                    updateInvite();
                });
            });
        };
        render('');
        document.getElementById('add-to-call-search').addEventListener('input', (e) => render(e.target.value));
        inviteBtn.addEventListener('click', () => {
            const ids = Array.from(selected);
            if (ids.length === 0) return;
            sendWS({ type: 'huddle_invite_others', payload: { user_ids: ids } });
            modal.remove();
            showToast(ids.length === 1 ? 'Inviting…' : `Inviting ${ids.length} people…`);
        });
    } catch (err) {
        console.error('openAddToCallPicker failed', err);
    }
}

function hangUp() {
    const ch = currentChannelID;
    if (!ch) return;
    let displayName;
    if (isCurrentChannelDM) {
        const dmRow = document.querySelector(`#dm-list [data-dm-channel="${ch}"]`);
        displayName = dmRow ? (dmRow.querySelector('.text-vc-text')?.textContent || 'Direct message') : 'Direct message';
        sendWS({ type: 'huddle_end', payload: {} });
    } else {
        const item = document.querySelector(`[data-channel-id="${ch}"] [data-ch-name]`);
        displayName = item ? item.dataset.chName : 'Channel';
    }
    isDMHuddleActive = false;
    outgoingCallChannelID = null;
    outgoingCalleeUserId = null;
    outgoingCalleeUsername = null;
    removeOutgoingPhantomCard();
    chatOnlyChannelID = ch;
    try { sessionStorage.removeItem('vocala-in-call'); } catch (_) {}
    cleanupWebRTC();
    sendWS({ type: 'leave_channel' });
    renderChannelChatOnly(ch, displayName, { isDM: isCurrentChannelDM });
    sendWS({ type: 'peek_history', payload: { channel_id: ch } });
    if (isCurrentChannelDM) loadDMList();
}

function startDMHuddle(channelID, otherUserId, displayName) {
    isDMHuddleActive = true;
    outgoingCalleeUserId = otherUserId;
    outgoingCalleeUsername = displayName;
    sendWS({ type: 'huddle_invite', payload: { to_user_id: otherUserId } });
    currentChannelID = null;
    joinChannel(channelID, displayName, { forceHuddle: true });
}

async function openNewDMPicker() {
    try {
        const res = await fetch('/api/users');
        const users = await res.json();
        const selfName = document.getElementById('self-avatar')?.dataset?.username || window.VOCALA_GUEST_NAME;
        const others = (users || []).filter(u => u.username !== selfName);

        const old = document.getElementById('new-dm-picker');
        if (old) old.remove();

        const modal = document.createElement('div');
        modal.id = 'new-dm-picker';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4';
        modal.innerHTML = `
            <div class="bg-vc-sidebar border border-vc-border rounded-xl shadow-2xl w-80 max-h-[70vh] flex flex-col">
                <div class="flex items-center justify-between px-4 py-3 border-b border-vc-border">
                    <h3 class="text-sm font-bold text-vc-text">New direct message</h3>
                    <button onclick="document.getElementById('new-dm-picker').remove()" class="text-vc-muted hover:text-vc-text transition">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                    </button>
                </div>
                <input id="new-dm-search" type="text" placeholder="Search…" autocomplete="off"
                    class="m-3 px-3 py-1.5 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                <div id="new-dm-list" class="flex-1 overflow-y-auto px-2 pb-2 space-y-1"></div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        const listEl = document.getElementById('new-dm-list');
        const render = (filter) => {
            const q = (filter || '').toLowerCase().trim();
            const matches = others.filter(u => !q || u.username.toLowerCase().includes(q));
            if (matches.length === 0) {
                listEl.innerHTML = '<div class="text-center text-vc-muted text-xs py-3">No users</div>';
                return;
            }
            listEl.innerHTML = matches.map(u => `
                <button onclick="startDMWithUser(${u.id}, '${escapeHTML(u.username).replace(/'/g, "\\'")}')"
                    class="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-vc-hover transition">
                    <img src="${avatarURL(u.username)}" alt="" class="w-6 h-6 rounded-full">
                    <span class="text-sm text-vc-text">${escapeHTML(u.username)}</span>
                </button>
            `).join('');
        };
        render('');
        document.getElementById('new-dm-search').addEventListener('input', (e) => render(e.target.value));
    } catch (err) {
        console.error('openNewDMPicker failed', err);
    }
}

async function startDMWithUser(userId, username) {
    document.getElementById('new-dm-picker')?.remove();
    try {
        const fd = new FormData();
        fd.append('user_id', userId);
        fd.append('csrf_token', getCSRFToken());
        const res = await fetch('/api/dms/open', { method: 'POST', body: fd });
        if (!res.ok) {
            showToast('Failed to open DM');
            return;
        }
        const data = await res.json();
        dmChannelIds.add(data.channel_id);
        await loadDMList();
        joinChannel(data.channel_id, username, { isDM: true });
    } catch (err) {
        console.error('startDMWithUser failed', err);
    }
}

async function startQuickRoom() {
    try {
        const fd = new FormData();
        fd.append('csrf_token', getCSRFToken());
        const res = await fetch('/channels/quick', {
            method: 'POST',
            body: fd,
        });
        if (!res.ok) {
            showToast('Failed to create quick room');
            return;
        }
        const data = await res.json();
        const shareUrl = location.origin + (data.guest_url || data.url);
        try {
            await navigator.clipboard.writeText(shareUrl);
            showToast('Guest link copied');
        } catch (_) {
        }
        joinChannel(data.id, data.name);
    } catch (err) {
        console.error('Quick room failed:', err);
    }
}

function showHuddleInvite(msg) {
    if (currentChannelID === msg.channel_id && isDMHuddleActive) return;
    if (incomingCallChannelID === msg.channel_id) return;
    const existing = document.getElementById('huddle-invite-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = 'huddle-invite-banner';
    banner.className = 'fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg bg-vc-accent text-white shadow-2xl text-sm';
    banner.innerHTML = `
        <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.95.68l1.5 4.49a1 1 0 01-.5 1.21l-2.26 1.13a11 11 0 005.52 5.52l1.13-2.26a1 1 0 011.21-.5l4.49 1.5a1 1 0 01.68.95V19a2 2 0 01-2 2h-1C9.72 21 3 14.28 3 6V5z"/>
        </svg>
        <span><strong>${escapeHTML(msg.from_name || 'Someone')}</strong> is calling…</span>
        <button id="huddle-accept" class="px-3 py-1 rounded bg-white/20 hover:bg-white/30 transition">Join</button>
        <button id="huddle-decline" class="px-2 py-1 rounded hover:bg-white/20 transition">Dismiss</button>
    `;
    document.body.appendChild(banner);
    incomingCallChannelID = msg.channel_id;
    updateCallIndicators();
    startRingtone();
    let dismissed = false;
    const close = () => {
        dismissed = true;
        banner.remove();
        stopRingtone();
        incomingCallChannelID = null;
        updateCallIndicators();
    };
    document.getElementById('huddle-accept').onclick = () => {
        close();
        currentChannelID = null;
        joinChannel(msg.channel_id, msg.channel_name, { forceHuddle: true });
    };
    document.getElementById('huddle-decline').onclick = () => {
        sendWS({
            type: 'huddle_decline',
            payload: { from_user_id: msg.from_user_id, channel_id: msg.channel_id, missed: false },
        });
        close();
    };
    setTimeout(() => {
        if (!dismissed) {
            sendWS({
                type: 'huddle_decline',
                payload: { from_user_id: msg.from_user_id, channel_id: msg.channel_id, missed: true },
            });
            close();
        }
    }, 60000);
}

function showBarReactionPicker(anchorBtn) {
    const old = document.getElementById('voice-reaction-picker');
    if (old) { old.remove(); return; }
    const picker = document.createElement('div');
    picker.id = 'voice-reaction-picker';
    picker.className = 'fixed z-50 bg-vc-sidebar border border-vc-border rounded-xl shadow-2xl p-1.5 flex gap-1';
    REACTION_EMOJIS.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'hover:bg-vc-hover rounded-lg w-10 h-10 text-2xl transition flex items-center justify-center';
        btn.textContent = emoji;
        btn.onclick = (e) => {
            e.stopPropagation();
            sendVoiceReaction(emoji);
            picker.remove();
        };
        picker.appendChild(btn);
    });
    document.body.appendChild(picker);
    const rect = anchorBtn.getBoundingClientRect();
    const pickerRect = picker.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - pickerRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pickerRect.width - 8));
    picker.style.left = left + 'px';
    picker.style.top = (rect.top - pickerRect.height - 8) + 'px';
    const dismiss = (e) => {
        if (!picker.contains(e.target) && e.target !== anchorBtn) {
            picker.remove();
            document.removeEventListener('click', dismiss);
        }
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
    setTimeout(() => picker.remove(), 8000);
}

function showVoiceReaction(msg) {
    const card = document.querySelector(`#channel-view-users [data-user-id="${msg.user_id}"]`);
    const target = card || document.querySelector(`#expanded-users-rail [data-user-id="${msg.user_id}"]`);
    if (target) {
        if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
        const existing = target.querySelector('.voice-reaction-badge');
        if (existing) existing.remove();
        const badge = document.createElement('div');
        badge.className = 'voice-reaction-badge pointer-events-none absolute -top-2 -right-2 w-10 h-10 rounded-full bg-vc-accent text-white shadow-lg flex items-center justify-center text-2xl border-2 border-vc-bg';
        badge.style.zIndex = '20';
        badge.style.animation = 'voiceReactionPop 3s ease-out forwards';
        badge.textContent = msg.emoji;
        target.appendChild(badge);
        setTimeout(() => badge.remove(), 3000);
    }
    pushReactionToFeed(msg);
}

const REACTION_FEED_TTL = 5000;
const REACTION_FEED_STATE = new Map(); // emoji -> { count, lastTs, names: Set, removeTimer }

function ensureReactionsFeed() {
    let feed = document.getElementById('reactions-feed');
    if (feed) return feed;
    const voiceArea = document.getElementById('voice-area');
    if (!voiceArea) return null;
    feed = document.createElement('div');
    feed.id = 'reactions-feed';
    feed.className = 'pointer-events-none absolute bottom-4 right-4 flex flex-col items-end gap-2';
    feed.style.zIndex = '25';
    voiceArea.appendChild(feed);
    return feed;
}

function pushReactionToFeed(msg) {
    const feed = ensureReactionsFeed();
    if (!feed) return;
    const emoji = msg.emoji;
    let entry = REACTION_FEED_STATE.get(emoji);
    let pill = feed.querySelector(`[data-emoji="${emoji}"]`);
    if (!entry || !pill) {
        entry = { count: 0, names: new Set(), removeTimer: null };
        REACTION_FEED_STATE.set(emoji, entry);
        pill = document.createElement('div');
        pill.dataset.emoji = emoji;
        pill.className = 'pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full bg-vc-sidebar/95 border border-vc-border shadow-lg text-sm transition-all';
        pill.style.animation = 'reactionPillIn 0.25s ease-out';
        pill.innerHTML = `
            <span class="text-xl leading-none reaction-emoji">${emoji}</span>
            <span class="text-xs text-vc-muted reaction-from"></span>
            <span class="text-sm font-semibold text-vc-text reaction-count" style="display:none"></span>
        `;
        feed.appendChild(pill);
    } else {
        pill.style.animation = 'none';
        void pill.offsetWidth;
        pill.style.animation = 'reactionPillPulse 0.35s ease-out';
    }
    entry.count += 1;
    entry.names.add(msg.username || '');
    pill.querySelector('.reaction-from').textContent = Array.from(entry.names).slice(-2).join(', ');
    const counter = pill.querySelector('.reaction-count');
    if (entry.count > 1) {
        counter.textContent = '×' + entry.count;
        counter.style.display = '';
    } else {
        counter.style.display = 'none';
    }
    if (entry.removeTimer) clearTimeout(entry.removeTimer);
    entry.removeTimer = setTimeout(() => {
        pill.style.animation = 'reactionPillOut 0.3s ease-in forwards';
        setTimeout(() => {
            pill.remove();
            REACTION_FEED_STATE.delete(emoji);
        }, 280);
    }, REACTION_FEED_TTL);
}

function clearChat() {
    if (!confirm('Clear all chat messages in this channel?')) return;
    sendWS({ type: 'clear_chat' });
}

function sendChatMessage(event) {
    event.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || !currentChannelID) return;

    sendWS({
        type: 'chat_message',
        payload: { text, channel_id: currentChannelID },
    });
    input.value = '';
}

function loadChatHistory(messages, reactions) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    container.innerHTML = '';
    messages.forEach(msg => appendChatMessage({ ...msg, _history: true }));
    (reactions || []).forEach(r => addChatReaction(r));
}

function appendChatMessage(msg) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    // Sound + notification for messages from others (not history load)
    const selfName = document.getElementById('self-avatar')?.dataset?.username;
    if (msg.username !== selfName && !msg._history && msg.kind !== 'system') {
        playChatSound();
        if (document.hidden) showNotification(msg.username + ': ' + msg.text);
    }

    const el = document.createElement('div');
    el.id = 'msg-' + msg.id;

    const time = new Date(msg.timestamp * 1000);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (msg.kind === 'system') {
        el.className = 'flex items-center gap-2 my-2 px-2';
        el.innerHTML = `
            <div class="flex-1 h-px bg-vc-border"></div>
            <div class="flex items-center gap-2 px-3 py-1 rounded-full bg-vc-channel/60 border border-vc-border">
                <span class="text-xs text-vc-muted">${escapeHTML(msg.text)}</span>
                <span class="text-[10px] text-vc-muted/70">${timeStr}</span>
            </div>
            <div class="flex-1 h-px bg-vc-border"></div>
        `;
        container.appendChild(el);
        container.scrollTop = container.scrollHeight;
        return;
    }

    el.className = 'group relative px-2 py-1 rounded hover:bg-vc-hover/30 transition';
    el.innerHTML = `
        <div class="flex gap-2">
            <img src="${avatarURL(msg.username)}" alt="" class="w-6 h-6 rounded-full flex-shrink-0 mt-0.5">
            <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-1.5">
                    <span class="text-xs font-semibold text-vc-accent">${escapeHTML(msg.username)}</span>
                    <span class="text-[10px] text-vc-muted">${timeStr}</span>
                </div>
                <div class="text-sm text-vc-text break-words">${escapeHTML(msg.text)}</div>
                <div class="reactions flex flex-wrap gap-1 mt-0.5" id="reactions-${msg.id}"></div>
            </div>
        </div>
        <button onclick="showReactionPicker('${msg.id}')"
            class="absolute right-1 top-0.5 opacity-0 group-hover:opacity-100 text-xs bg-vc-channel hover:bg-vc-hover rounded px-1 py-0.5 transition text-vc-muted">
            +
        </button>
    `;

    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
}

function showReactionPicker(messageId) {
    // Remove existing picker
    const old = document.getElementById('reaction-picker');
    if (old) old.remove();

    const picker = document.createElement('div');
    picker.id = 'reaction-picker';
    picker.className = 'absolute z-50 bg-vc-sidebar border border-vc-border rounded-lg shadow-lg p-1 flex gap-0.5';

    REACTION_EMOJIS.forEach(emoji => {
        const btn = document.createElement('button');
        btn.className = 'hover:bg-vc-hover rounded p-1 text-sm transition';
        btn.textContent = emoji;
        btn.onclick = () => {
            sendWS({
                type: 'chat_reaction',
                payload: { message_id: messageId, emoji },
            });
            picker.remove();
        };
        picker.appendChild(btn);
    });

    const msgEl = document.getElementById('msg-' + messageId);
    if (msgEl) {
        msgEl.appendChild(picker);
        // Auto-remove after 5s
        setTimeout(() => picker.remove(), 5000);
    }
}

function addChatReaction(msg) {
    const container = document.getElementById('reactions-' + msg.message_id);
    if (!container) return;

    const userId = String(msg.user_id);
    const existing = container.querySelector(`[data-emoji="${msg.emoji}"]`);
    if (existing) {
        const users = (existing.dataset.users || '').split(',').filter(Boolean);
        if (users.includes(userId)) return;
        users.push(userId);
        existing.dataset.users = users.join(',');
        existing.dataset.count = String(users.length);
        existing.textContent = msg.emoji + (users.length > 1 ? ' ' + users.length : '');
        return;
    }

    const badge = document.createElement('span');
    badge.className = 'inline-flex items-center px-1 py-0.5 rounded bg-vc-channel text-xs cursor-default';
    badge.dataset.emoji = msg.emoji;
    badge.dataset.users = userId;
    badge.dataset.count = '1';
    badge.textContent = msg.emoji;
    badge.title = msg.username;
    container.appendChild(badge);
}

function removeChatReaction(msg) {
    const container = document.getElementById('reactions-' + msg.message_id);
    if (!container) return;
    const badge = container.querySelector(`[data-emoji="${msg.emoji}"]`);
    if (!badge) return;
    const userId = String(msg.user_id);
    const users = (badge.dataset.users || '').split(',').filter(Boolean).filter(u => u !== userId);
    if (users.length === 0) {
        badge.remove();
        return;
    }
    badge.dataset.users = users.join(',');
    badge.dataset.count = String(users.length);
    badge.textContent = msg.emoji + (users.length > 1 ? ' ' + users.length : '');
}

// ─── WS Media Transport (mobile fallback) ─────────────────────

const USE_WS_MEDIA = /Android/i.test(navigator.userAgent);
let wsMediaRecorder = null;
let wsMediaAudioElements = {}; // userID -> Audio element
let wsMediaVideoElements = {}; // userID -> container element

async function startWSMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: noiseSuppressionEnabled && !rnnoiseEnabled,
                autoGainControl: agcEnabled && !rnnoiseEnabled,
            },
            video: false,
        });
        hideGlobalMicWarning();

        // Setup VAD (reads raw stream for level detection)
        audioContext = new AudioContext(rnnoiseEnabled ? { sampleRate: 48000 } : undefined);
        if (audioContext.state === 'suspended') {
            try { await audioContext.resume(); } catch (_) {}
        }
        const rnnoiseNode = await loadRnnoiseNode(audioContext);
        const source = audioContext.createMediaStreamSource(localStream);
        gainNode = audioContext.createGain();
        gainNode.gain.value = (pushToTalk || isMuted) ? 0.0 : 1.0;
        const dest = audioContext.createMediaStreamDestination();
        if (rnnoiseNode) {
            source.connect(rnnoiseNode);
            rnnoiseNode.connect(gainNode);
        } else {
            source.connect(gainNode);
        }
        gainNode.connect(dest);
        processedStream = dest.stream;
        setupVAD(localStream);

        // Tell server we use WS media
        sendWS({ type: 'ws_media_mode' });

        // Start recording processed audio and sending via WS
        startWSAudioSend(processedStream);

        // Handle incoming binary frames
        ws.binaryType = 'arraybuffer';

        updateRTCStatus();
        const statusEl = document.getElementById('rtc-status');
        if (statusEl) {
            statusEl.innerHTML = '<div class="w-2 h-2 rounded-full bg-vc-green"></div><span class="text-xs text-vc-green">Connected (WS)</span>';
        }
    } catch (err) {
        console.error('WS Media failed:', err);
        updateRTCStatusText('connected', 'Listen-only (no mic) — tap mic to enable');
    }
}

function startWSAudioSend(stream) {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4;codecs=opus',
        'audio/mp4',
    ];
    let mimeType = null;
    for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) { mimeType = c; break; }
    }
    if (!mimeType) {
        console.error('No supported MediaRecorder mimeType found — WS media send disabled');
        return;
    }

    wsMediaRecorder = new MediaRecorder(stream, {
        mimeType: mimeType,
        audioBitsPerSecond: 32000,
    });

    wsMediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
            event.data.arrayBuffer().then(buf => {
                // Frame: [0x01 (audio)] + [payload]
                const frame = new Uint8Array(1 + buf.byteLength);
                frame[0] = 0x01;
                frame.set(new Uint8Array(buf), 1);
                ws.send(frame.buffer);
            });
        }
    };

    wsMediaRecorder.start(60); // 60ms chunks for low latency
}

function stopWSMedia() {
    if (wsMediaRecorder && wsMediaRecorder.state !== 'inactive') {
        wsMediaRecorder.stop();
        wsMediaRecorder = null;
    }
    // Clean up remote audio elements
    Object.values(wsMediaAudioElements).forEach(el => {
        if (el.src) URL.revokeObjectURL(el.src);
        el.remove();
    });
    wsMediaAudioElements = {};
    Object.values(wsMediaVideoElements).forEach(el => el.remove());
    wsMediaVideoElements = {};
}

function handleWSMediaFrame(data) {
    const view = new DataView(data);
    if (data.byteLength < 10) return;

    const type = view.getUint8(0);
    const userIdHi = view.getUint32(1);
    const userIdLo = view.getUint32(5);
    const userId = userIdHi * 0x100000000 + userIdLo;
    const payload = data.slice(9);

    if (type === 0x01) {
        // Audio frame
        playWSAudio(userId, payload);
    } else if (type === 0x02) {
        // Video frame (future)
        playWSVideo(userId, payload);
    }
}

// Audio playback using MediaSource or Blob URLs
function playWSAudio(userId, payload) {
    if (!wsMediaAudioElements[userId]) {
        const audio = new Audio();
        audio.autoplay = true;
        wsMediaAudioElements[userId] = audio;
    }

    const audio = wsMediaAudioElements[userId];
    const blob = new Blob([payload], { type: 'audio/webm;codecs=opus' });
    const url = URL.createObjectURL(blob);
    
    // Queue playback
    if (!audio._queue) audio._queue = [];
    audio._queue.push(url);

    if (audio.paused || audio.ended) {
        playNextChunk(audio);
    }
}

function playNextChunk(audio) {
    if (!audio._queue || audio._queue.length === 0) return;
    
    const url = audio._queue.shift();
    if (audio._prevUrl) URL.revokeObjectURL(audio._prevUrl);
    audio._prevUrl = url;
    audio.src = url;
    audio.play().catch(() => {});
    audio.onended = () => playNextChunk(audio);
}

function playWSVideo(userId, payload) {
    // Placeholder for future video support
}

// WS camera send
let wsCameraRecorder = null;

async function startWSCamera() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
            audio: false,
        });

        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
            ? 'video/webm;codecs=vp8'
            : 'video/webm';

        wsCameraRecorder = new MediaRecorder(cameraStream, {
            mimeType: mimeType,
            videoBitsPerSecond: 500000,
        });

        wsCameraRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
                event.data.arrayBuffer().then(buf => {
                    // Frame: [0x02 (video)] + [payload]
                    const frame = new Uint8Array(1 + buf.byteLength);
                    frame[0] = 0x02;
                    frame.set(new Uint8Array(buf), 1);
                    ws.send(frame.buffer);
                });
            }
        };

        wsCameraRecorder.start(100); // 100ms chunks

        isCameraOn = true;
        updateCameraUI();
        addLocalCameraToGrid();

        cameraStream.getVideoTracks()[0].onended = () => stopWSCamera();
    } catch (err) {
        console.error('WS Camera failed:', err);
    }
}

function stopWSCamera() {
    if (wsCameraRecorder && wsCameraRecorder.state !== 'inactive') {
        wsCameraRecorder.stop();
        wsCameraRecorder = null;
    }
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    isCameraOn = false;
    updateCameraUI();
    removeFromCameraGrid('local-camera');
}

// ─── Auto-join from URL ───────────────────────────────────────

function autoJoinFromURL() {
    const channelName = window.VOCALA_AUTO_JOIN;
    if (!channelName) return;

    const tryJoin = () => {
        const buttons = document.querySelectorAll('[data-ch-name]');
        for (const btn of buttons) {
            if (btn.dataset.chName === channelName) {
                const chId = parseInt(btn.dataset.chId);
                let wasInCall = null;
                try { wasInCall = sessionStorage.getItem('vocala-in-call'); } catch (_) {}
                if (wasInCall && parseInt(wasInCall, 10) === chId) {
                    joinChannel(chId, channelName, { forceHuddle: true, restore: true });
                } else {
                    joinChannel(chId, channelName, { chatOnly: true });
                }
                return true;
            }
        }
        return false;
    };

    if (tryJoin()) return;

    let attempts = 0;
    const interval = setInterval(() => {
        attempts += 1;
        if (tryJoin() || attempts >= 40) {
            clearInterval(interval);
        }
    }, 50);
}

// Handle browser back/forward
window.addEventListener('popstate', (event) => {
    if (event.state && event.state.channelID) {
        joinChannel(event.state.channelID, event.state.channelName);
    } else if (currentChannelID) {
        leaveChannel();
    }
});

// --- Private channel member management ---

function getCSRFToken() {
    const match = document.cookie.match(/csrf_token=([^;]+)/);
    return match ? match[1] : '';
}

async function openMemberManager(channelId, channelName) {
    // Remove existing modal
    const old = document.getElementById('member-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'member-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60';
    modal.innerHTML = `
        <div class="bg-vc-sidebar border border-vc-border rounded-xl shadow-2xl w-96 max-h-[80vh] flex flex-col">
            <div class="flex items-center justify-between px-4 py-3 border-b border-vc-border">
                <h3 class="text-sm font-bold text-vc-text">${escapeHTML(channelName)} - Members</h3>
                <button onclick="document.getElementById('member-modal').remove()" class="text-vc-muted hover:text-vc-text transition">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </button>
            </div>
            <div class="p-3 border-b border-vc-border">
                <div class="relative mb-2">
                    <div class="flex gap-2">
                        <input id="member-user-search" type="text" placeholder="Search user to add…" autocomplete="off"
                            class="flex-1 min-w-0 px-3 py-1.5 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                        <button id="member-add-btn" onclick="addMemberFromSearch(${channelId})" disabled
                            class="flex-shrink-0 px-3 py-1.5 bg-vc-accent hover:bg-vc-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition">Add</button>
                    </div>
                    <div id="member-user-options" class="hidden absolute left-0 right-0 mt-1 bg-vc-sidebar border border-vc-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10"></div>
                </div>
                <button onclick="generateInviteLink(${channelId})" class="w-full px-3 py-1.5 bg-vc-channel hover:bg-vc-hover text-vc-text text-sm rounded-lg transition flex items-center justify-center gap-1.5">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                    </svg>
                    Generate invite link
                </button>
                <div id="invite-link-result" class="hidden mt-2"></div>
            </div>
            <div id="member-list" class="flex-1 overflow-y-auto p-2 space-y-1">
                <div class="text-center text-vc-muted text-xs py-4">Loading...</div>
            </div>
        </div>
    `;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
    loadMembers(channelId);
    loadUserSelect(channelId);
}

async function loadMembers(channelId) {
    try {
        const res = await fetch('/channels/members?id=' + channelId);
        if (res.status === 404) {
            handleStaleChannel();
            return;
        }
        if (res.status === 403) {
            document.getElementById('member-list').innerHTML = '<div class="text-center text-vc-red text-xs py-4">No permission to manage members</div>';
            return;
        }
        const data = await res.json();
        const list = document.getElementById('member-list');
        if (!data.members || data.members.length === 0) {
            list.innerHTML = '<div class="text-center text-vc-muted text-xs py-4">No members yet</div>';
            return;
        }
        list.innerHTML = data.members.map(m => `
            <div class="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-vc-hover/30 transition">
                <div class="flex items-center gap-2">
                    <img src="${avatarURL(m.Username)}" alt="" class="w-6 h-6 rounded-full">
                    <span class="text-sm text-vc-text">${escapeHTML(m.Username)}</span>
                    ${m.UserID === data.created_by ? '<span class="text-[10px] text-vc-yellow bg-vc-yellow/10 px-1 rounded">owner</span>' : ''}
                </div>
                ${m.UserID !== data.created_by ? `
                    <button onclick="removeMember(${channelId}, ${m.UserID})" class="text-vc-muted hover:text-vc-red transition text-xs px-1.5 py-0.5 rounded hover:bg-vc-red/10">
                        Remove
                    </button>
                ` : ''}
            </div>
        `).join('');
    } catch (err) {
        console.error('Failed to load members:', err);
    }
}

async function loadUserSelect(channelId) {
    try {
        const [usersRes, membersRes] = await Promise.all([
            fetch('/api/users'),
            fetch('/channels/members?id=' + channelId),
        ]);
        if (membersRes.status === 404) {
            handleStaleChannel();
            return;
        }
        const users = await usersRes.json();
        const membersData = await membersRes.json();
        const memberIds = new Set((membersData.members || []).map(m => m.UserID));

        const input = document.getElementById('member-user-search');
        const optionsEl = document.getElementById('member-user-options');
        const addBtn = document.getElementById('member-add-btn');
        if (!input || !optionsEl || !addBtn) return;

        const available = users.filter(u => !memberIds.has(u.id));
        if (available.length === 0) {
            input.disabled = true;
            input.placeholder = 'All users already added';
            return;
        }
        input.disabled = false;
        input.placeholder = 'Search user to add…';
        input._available = available;
        input._channelId = channelId;

        const render = (filter) => {
            const q = (filter || '').toLowerCase().trim();
            const matches = available.filter(u => !q || u.username.toLowerCase().includes(q));
            if (matches.length === 0) {
                optionsEl.innerHTML = '<div class="px-3 py-2 text-xs text-vc-muted">No matches</div>';
                addBtn.disabled = true;
                return;
            }
            optionsEl.innerHTML = matches.map(u =>
                `<button type="button" data-username="${escapeHTML(u.username)}" class="member-opt w-full text-left px-3 py-1.5 hover:bg-vc-hover transition flex items-center gap-2">
                    <img src="${avatarURL(u.username)}" alt="" class="w-5 h-5 rounded-full">
                    <span class="text-sm text-vc-text">${escapeHTML(u.username)}</span>
                </button>`
            ).join('');
            optionsEl.querySelectorAll('.member-opt').forEach(btn => {
                btn.addEventListener('click', () => {
                    input.value = btn.dataset.username;
                    optionsEl.classList.add('hidden');
                    addBtn.disabled = false;
                    addBtn.focus();
                });
            });
            const exact = available.find(u => u.username.toLowerCase() === q);
            addBtn.disabled = !exact;
        };

        input.oninput = () => {
            optionsEl.classList.remove('hidden');
            render(input.value);
        };
        input.onfocus = () => {
            optionsEl.classList.remove('hidden');
            render(input.value);
        };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (!addBtn.disabled) {
                    addMemberFromSearch(channelId);
                } else {
                    const first = optionsEl.querySelector('.member-opt');
                    if (first) first.click();
                }
            } else if (e.key === 'Escape') {
                optionsEl.classList.add('hidden');
            }
        };
        document.addEventListener('click', (e) => {
            if (!optionsEl.contains(e.target) && e.target !== input) {
                optionsEl.classList.add('hidden');
            }
        });
    } catch (err) {
        console.error('Failed to load users:', err);
    }
}

async function addMemberFromSearch(channelId) {
    const input = document.getElementById('member-user-search');
    const username = input ? input.value.trim() : '';
    if (!username) return;

    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('username', username);
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/channels/members/add', { method: 'POST', body: form });
        if (res.status === 404) {
            showToast('User not found');
            return;
        }
        if (!res.ok) {
            showToast('Failed to add member');
            return;
        }
        if (input) input.value = '';
        document.getElementById('member-user-options')?.classList.add('hidden');
        loadMembers(channelId);
        loadUserSelect(channelId);
    } catch (err) {
        console.error('Failed to add member:', err);
    }
}

async function generateInviteLink(channelId) {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/channels/invite', { method: 'POST', body: form });
        if (res.status === 404) {
            handleStaleChannel();
            return;
        }
        if (!res.ok) {
            alert('Failed to generate invite link');
            return;
        }
        const data = await res.json();
        const url = window.location.origin + data.url;
        const container = document.getElementById('invite-link-result');
        if (!container) return;
        container.classList.remove('hidden');
        container.innerHTML = `
            <div class="flex gap-1.5">
                <input type="text" value="${escapeHTML(url)}" readonly
                    class="flex-1 px-2.5 py-1.5 bg-vc-bg border border-vc-border rounded-lg text-xs text-vc-text font-mono select-all focus:outline-none">
                <button onclick="navigator.clipboard.writeText('${url}').then(() => this.textContent = 'Copied!')"
                    class="px-2.5 py-1.5 bg-vc-accent hover:bg-vc-accent/80 text-white text-xs font-medium rounded-lg transition whitespace-nowrap">
                    Copy
                </button>
            </div>
            <div class="text-[10px] text-vc-muted mt-1">Link expires in 7 days</div>
        `;
    } catch (err) {
        console.error('Failed to generate invite:', err);
    }
}

async function removeMember(channelId, userId) {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('user_id', userId);
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/channels/members/remove', { method: 'POST', body: form });
        if (!res.ok) {
            alert('Failed to remove member');
            return;
        }
        loadMembers(channelId);
        loadUserSelect(channelId);
    } catch (err) {
        console.error('Failed to remove member:', err);
    }
}

// --- Theme picker ---

const THEMES = [
    { id: 'default',    name: 'Default',    color: '#7c5cfc' },
    { id: 'midnight',   name: 'Midnight',   color: '#4f8ff7' },
    { id: 'forest',     name: 'Forest',     color: '#34d399' },
    { id: 'cherry',     name: 'Cherry',     color: '#f43f5e' },
    { id: 'amber',      name: 'Amber',      color: '#f59e0b' },
    { id: 'abyss',      name: 'Abyss',      color: '#a78bfa' },
    { id: 'light',      name: 'Light',      color: '#f5f5f7', border: '#d1d5db' },
    { id: 'light-warm', name: 'Warm Light', color: '#faf7f2', border: '#d6cfc5' },
    { id: 'light-sky',  name: 'Sky Light',  color: '#f0f7ff', border: '#bdd0e0' },
];

function setTheme(themeId) {
    document.documentElement.setAttribute('data-theme', themeId);
    localStorage.setItem('vocala-theme', themeId);
    // Update active indicator
    document.querySelectorAll('.theme-dot').forEach(el => {
        el.classList.toggle('ring-2', el.dataset.theme === themeId);
        el.classList.toggle('ring-white', el.dataset.theme === themeId);
        el.classList.toggle('ring-offset-2', el.dataset.theme === themeId);
        el.classList.toggle('ring-offset-vc-sidebar', el.dataset.theme === themeId);
    });
}

function toggleThemePicker() {
    const existing = document.getElementById('theme-picker');
    if (existing) { existing.remove(); return; }

    const current = localStorage.getItem('vocala-theme') || 'default';
    const picker = document.createElement('div');
    picker.id = 'theme-picker';
    picker.className = 'absolute bottom-14 left-2 bg-vc-channel border border-vc-border rounded-xl p-3 shadow-2xl z-50 fade-in';
    picker.innerHTML = `
        <div class="text-xs font-medium text-vc-muted mb-2">Theme</div>
        <div class="flex gap-2 flex-wrap max-w-[230px]">
            ${THEMES.map(t => `
                <button onclick="setTheme('${t.id}')" title="${t.name}"
                    class="theme-dot w-7 h-7 rounded-full transition-all hover:scale-110 ${t.id === current ? 'ring-2 ring-white ring-offset-2 ring-offset-vc-sidebar' : ''}"
                    data-theme="${t.id}"
                    style="background: ${t.color}${t.border ? '; box-shadow: inset 0 0 0 2px ' + t.border : ''}">
                </button>
            `).join('')}
        </div>
    `;

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function closePicker(e) {
            if (!picker.contains(e.target) && !e.target.closest('[title="Theme"]')) {
                picker.remove();
                document.removeEventListener('click', closePicker);
            }
        });
    }, 0);

    // Find the sidebar bottom panel to position relative to
    const bottomBar = document.querySelector('.border-t.border-vc-border .flex.items-center');
    if (bottomBar) {
        bottomBar.style.position = 'relative';
        bottomBar.appendChild(picker);
    } else {
        document.body.appendChild(picker);
    }
}

// --- Guest invite link ---

function createGuestLink(channelId) {
    const existing = document.getElementById('guest-link-popup');
    if (existing) { existing.remove(); return; }

    const popup = document.createElement('div');
    popup.id = 'guest-link-popup';
    popup.className = 'fixed top-20 right-4 bg-vc-sidebar border border-vc-border rounded-xl shadow-2xl p-4 z-50 w-80 fade-in';
    popup.innerHTML = `
        <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-bold text-vc-text">Guest Invite Link</span>
            <button onclick="document.getElementById('guest-link-popup').remove()" class="text-vc-muted hover:text-vc-text">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
            </button>
        </div>
        <div class="flex gap-2 mb-3" id="guest-link-durations">
            <button data-hours="1" onclick="generateGuestLink(${channelId}, 1, this)" class="guest-dur flex-1 py-1.5 text-xs font-medium rounded-lg border border-vc-border hover:border-vc-accent hover:text-vc-accent transition text-vc-muted">1h</button>
            <button data-hours="6" onclick="generateGuestLink(${channelId}, 6, this)" class="guest-dur flex-1 py-1.5 text-xs font-medium rounded-lg border border-vc-border hover:border-vc-accent hover:text-vc-accent transition text-vc-muted">6h</button>
            <button data-hours="24" onclick="generateGuestLink(${channelId}, 24, this)" class="guest-dur flex-1 py-1.5 text-xs font-medium rounded-lg border border-vc-border hover:border-vc-accent hover:text-vc-accent transition text-vc-muted">24h</button>
            <button data-hours="72" onclick="generateGuestLink(${channelId}, 72, this)" class="guest-dur flex-1 py-1.5 text-xs font-medium rounded-lg border border-vc-border hover:border-vc-accent hover:text-vc-accent transition text-vc-muted">3d</button>
            <button data-hours="168" onclick="generateGuestLink(${channelId}, 168, this)" class="guest-dur flex-1 py-1.5 text-xs font-medium rounded-lg border border-vc-border hover:border-vc-accent hover:text-vc-accent transition text-vc-muted">7d</button>
        </div>
        <div id="guest-link-result" class="text-center text-xs text-vc-muted">Select link duration</div>
    `;
    document.body.appendChild(popup);
}

async function generateGuestLink(channelId, hours, btn) {
    const resultEl = document.getElementById('guest-link-result');
    if (!resultEl) return;

    // Update active state on duration buttons
    const inactiveCls = ['border-vc-border', 'hover:border-vc-accent', 'hover:text-vc-accent', 'text-vc-muted'];
    const activeCls = ['border-vc-accent', 'bg-vc-accent/10', 'text-vc-accent'];
    document.querySelectorAll('#guest-link-durations .guest-dur').forEach(b => {
        b.classList.remove(...activeCls);
        b.classList.add(...inactiveCls);
    });
    if (btn) {
        btn.classList.remove(...inactiveCls);
        btn.classList.add(...activeCls);
    }

    resultEl.innerHTML = '<span class="text-vc-muted">Generating...</span>';

    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('hours', hours);
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/channels/guest-invite', { method: 'POST', body: form });
        if (!res.ok) {
            resultEl.innerHTML = '<span class="text-vc-red">Failed to generate link</span>';
            return;
        }
        const data = await res.json();
        const url = window.location.origin + data.url;
        const label = hours >= 24 ? Math.floor(hours / 24) + 'd' : hours + 'h';
        resultEl.innerHTML = `
            <div class="flex gap-1.5 mb-1.5">
                <input type="text" value="${escapeHTML(url)}" readonly
                    class="flex-1 px-2.5 py-1.5 bg-vc-bg border border-vc-border rounded-lg text-xs text-vc-text font-mono select-all focus:outline-none">
                <button onclick="navigator.clipboard.writeText('${url}').then(() => this.textContent = 'OK')"
                    class="px-2.5 py-1.5 bg-vc-accent hover:bg-vc-accent/80 text-white text-xs font-medium rounded-lg transition whitespace-nowrap">
                    Copy
                </button>
            </div>
            <div class="text-[10px] text-vc-muted">Expires in ${label}. Guest sees only this channel.</div>
        `;
    } catch (err) {
        resultEl.innerHTML = '<span class="text-vc-red">Request failed</span>';
    }
}

// --- Settings modal (devices, sounds) ---

let rnnoiseEnabled = (localStorage.getItem('vocala-rnnoise') ?? '1') === '1';
let agcEnabled = localStorage.getItem('vocala-agc') !== '0';
let noiseSuppressionEnabled = localStorage.getItem('vocala-ns') !== '0';
let selectedMicId = localStorage.getItem('vocala-mic') || '';
let selectedCamId = localStorage.getItem('vocala-cam') || '';
let selectedSpkId = localStorage.getItem('vocala-spk') || '';

async function openSettings() {
    const old = document.getElementById('settings-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'settings-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60';
    modal.innerHTML = `
        <div class="bg-vc-sidebar border border-vc-border rounded-xl shadow-2xl w-[420px] max-h-[80vh] flex flex-col">
            <div class="flex items-center justify-between px-4 py-3 border-b border-vc-border">
                <h3 class="text-sm font-bold text-vc-text">Settings</h3>
                <button onclick="document.getElementById('settings-modal').remove()" class="text-vc-muted hover:text-vc-text transition">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </button>
            </div>
            <div class="p-4 space-y-4 overflow-y-auto">
                <div>
                    <label class="block text-xs font-medium text-vc-muted mb-1">Microphone</label>
                    <select id="settings-mic" class="w-full px-3 py-2 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text focus:outline-none focus:border-vc-accent transition">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-medium text-vc-muted mb-1">Camera</label>
                    <select id="settings-cam" class="w-full px-3 py-2 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text focus:outline-none focus:border-vc-accent transition">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-medium text-vc-muted mb-1">Speaker</label>
                    <select id="settings-spk" class="w-full px-3 py-2 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text focus:outline-none focus:border-vc-accent transition">
                        <option value="">Loading...</option>
                    </select>
                </div>
                <div class="border-t border-vc-border pt-3">
                    <label class="flex items-center justify-between cursor-pointer">
                        <span class="text-sm text-vc-text">Sound notifications</span>
                        <input type="checkbox" id="settings-sounds" ${notifSoundsEnabled ? 'checked' : ''}
                            class="rounded border-vc-border text-vc-accent focus:ring-vc-accent"
                            onchange="toggleSounds()">
                    </label>
                </div>
                <div class="border-t border-vc-border pt-3">
                    <label class="flex items-center justify-between cursor-pointer">
                        <span class="text-sm text-vc-text">Automatic gain control</span>
                        <input type="checkbox" id="settings-agc" ${agcEnabled ? 'checked' : ''}
                            class="rounded border-vc-border text-vc-accent focus:ring-vc-accent"
                            onchange="toggleAgc()">
                    </label>
                </div>
                <div class="border-t border-vc-border pt-3">
                    <label class="flex items-center justify-between cursor-pointer">
                        <span class="text-sm text-vc-text">Noise suppression</span>
                        <input type="checkbox" id="settings-ns" ${noiseSuppressionEnabled ? 'checked' : ''}
                            class="rounded border-vc-border text-vc-accent focus:ring-vc-accent"
                            onchange="toggleNoiseSuppression()">
                    </label>
                </div>
                <div class="border-t border-vc-border pt-3">
                    <label class="flex items-center justify-between cursor-pointer">
                        <span class="text-sm text-vc-text">RNNoise (enhanced noise suppression)</span>
                        <input type="checkbox" id="settings-rnnoise" ${rnnoiseEnabled ? 'checked' : ''}
                            class="rounded border-vc-border text-vc-accent focus:ring-vc-accent"
                            onchange="toggleRnnoise()">
                    </label>
                    <p class="text-xs text-vc-muted mt-1">Rejoin the channel to apply.</p>
                </div>
                <div class="border-t border-vc-border pt-3">
                    <div class="text-xs font-medium text-vc-muted mb-2">Change Password</div>
                    <div class="space-y-2">
                        <input type="password" id="settings-old-pw" placeholder="Current password"
                            class="w-full px-3 py-2 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                        <input type="password" id="settings-new-pw" placeholder="New password (min 8 chars)"
                            class="w-full px-3 py-2 bg-vc-bg border border-vc-border rounded-lg text-sm text-vc-text placeholder-vc-muted focus:outline-none focus:border-vc-accent transition">
                        <button onclick="changePassword()" class="w-full px-3 py-2 bg-vc-channel hover:bg-vc-hover text-vc-text text-sm font-medium rounded-lg transition border border-vc-border">
                            Change Password
                        </button>
                        <div id="settings-pw-msg" class="hidden text-xs"></div>
                    </div>
                </div>
            </div>
            <div class="px-4 py-3 border-t border-vc-border flex justify-end">
                <button onclick="saveSettings()" class="px-4 py-2 bg-vc-accent hover:bg-vc-accent/80 text-white text-sm font-medium rounded-lg transition">
                    Save
                </button>
            </div>
        </div>
    `;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
    await loadDeviceList();
}

async function loadDeviceList() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const micSelect = document.getElementById('settings-mic');
        const camSelect = document.getElementById('settings-cam');
        const spkSelect = document.getElementById('settings-spk');

        const mics = devices.filter(d => d.kind === 'audioinput');
        const cams = devices.filter(d => d.kind === 'videoinput');
        const spks = devices.filter(d => d.kind === 'audiooutput');

        micSelect.innerHTML = '<option value="">Default</option>' +
            mics.map(d => `<option value="${d.deviceId}" ${d.deviceId === selectedMicId ? 'selected' : ''}>${escapeHTML(d.label || 'Microphone ' + (mics.indexOf(d) + 1))}</option>`).join('');
        camSelect.innerHTML = '<option value="">Default</option>' +
            cams.map(d => `<option value="${d.deviceId}" ${d.deviceId === selectedCamId ? 'selected' : ''}>${escapeHTML(d.label || 'Camera ' + (cams.indexOf(d) + 1))}</option>`).join('');
        spkSelect.innerHTML = '<option value="">Default</option>' +
            spks.map(d => `<option value="${d.deviceId}" ${d.deviceId === selectedSpkId ? 'selected' : ''}>${escapeHTML(d.label || 'Speaker ' + (spks.indexOf(d) + 1))}</option>`).join('');
    } catch (e) {
        console.error('Failed to enumerate devices:', e);
    }
}

async function changePassword() {
    const oldPw = document.getElementById('settings-old-pw')?.value || '';
    const newPw = document.getElementById('settings-new-pw')?.value || '';
    const msgEl = document.getElementById('settings-pw-msg');

    if (!oldPw || !newPw) {
        msgEl.textContent = 'Fill in both fields';
        msgEl.className = 'text-xs text-vc-red';
        return;
    }
    if (newPw.length < 8) {
        msgEl.textContent = 'New password must be at least 8 characters';
        msgEl.className = 'text-xs text-vc-red';
        return;
    }

    const form = new FormData();
    form.append('old_password', oldPw);
    form.append('new_password', newPw);
    form.append('csrf_token', getCSRFToken());

    try {
        const res = await fetch('/account/password', { method: 'POST', body: form });
        const data = await res.json();
        if (res.ok) {
            msgEl.textContent = 'Password changed';
            msgEl.className = 'text-xs text-vc-green';
            document.getElementById('settings-old-pw').value = '';
            document.getElementById('settings-new-pw').value = '';
        } else {
            msgEl.textContent = data.error || 'Failed to change password';
            msgEl.className = 'text-xs text-vc-red';
        }
    } catch (e) {
        msgEl.textContent = 'Request failed';
        msgEl.className = 'text-xs text-vc-red';
    }
}

function saveSettings() {
    const mic = document.getElementById('settings-mic')?.value || '';
    const cam = document.getElementById('settings-cam')?.value || '';
    const spk = document.getElementById('settings-spk')?.value || '';

    selectedMicId = mic;
    selectedCamId = cam;
    selectedSpkId = spk;
    localStorage.setItem('vocala-mic', mic);
    localStorage.setItem('vocala-cam', cam);
    localStorage.setItem('vocala-spk', spk);

    // Apply speaker to all audio/video elements
    if (spk) {
        document.querySelectorAll('audio, video').forEach(el => {
            if (el.setSinkId) el.setSinkId(spk).catch(() => {});
        });
    }

    document.getElementById('settings-modal')?.remove();
}



function adjustUserVolume(username, value) {
    const vol = parseInt(value) / 100;
    setUserVolume(username, vol);
    // Apply volume to all remote audio elements
    // SFU assigns streamID "audio-{userID}" but we need username->userID mapping
    // For now, apply to all audio (works well with small groups)
    document.querySelectorAll('audio').forEach(el => {
        el.volume = vol;
    });
}

function getUserVolume(username) {
    if (userVolumes[username] !== undefined) return userVolumes[username];
    const saved = localStorage.getItem('vocala-vol-' + username);
    if (saved !== null) {
        userVolumes[username] = parseFloat(saved);
        return userVolumes[username];
    }
    return 1.0;
}
