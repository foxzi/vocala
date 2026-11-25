package signaling

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/foxzi/vocala/internal/channel"
	"github.com/foxzi/vocala/internal/database"
	"github.com/foxzi/vocala/internal/logger"
	"github.com/foxzi/vocala/internal/recording"
)

// recorder is nil when recording is disabled in the config.
var recorder *recording.Manager

// SetRecorder enables the recording_start/recording_stop messages and tells
// channels when their recording starts or stops.
func SetRecorder(m *recording.Manager) {
	recorder = m
	m.OnStateChange(func(channelID int64, st recording.State) {
		GlobalHub.BroadcastToChannel(channelID, recordingStateMessage(channelID, st))
		if st.Active {
			restartWSMedia(channelID)
		}
	})
	m.OnStreamBroken(restartUserWSMedia)
}

// restartUserWSMedia asks one WebSocket-audio client for a new stream, if
// it is still in the channel: a disk error broke its recorded stream.
func restartUserWSMedia(channelID, userID int64) {
	if channel.GetUserChannel(userID) != channelID {
		return
	}
	GlobalHub.mu.RLock()
	c := GlobalHub.clients[userID]
	GlobalHub.mu.RUnlock()
	if c != nil && c.wsMedia.Load() {
		msg, _ := json.Marshal(map[string]any{"type": "ws_media_restart"})
		GlobalHub.SendToPriority(userID, msg)
	}
}

// restartWSMedia asks the channel's WebSocket-audio clients to restart
// their MediaRecorder. Only the first chunk of a MediaRecorder stream holds
// the container header, so a recording that starts mid-stream needs a new
// one. Participants who join later start a fresh recorder anyway.
func restartWSMedia(channelID int64) {
	msg, _ := json.Marshal(map[string]any{"type": "ws_media_restart"})
	for _, u := range channel.GetUsers(channelID) {
		GlobalHub.mu.RLock()
		c := GlobalHub.clients[u.ID]
		GlobalHub.mu.RUnlock()
		if c != nil && c.wsMedia.Load() {
			GlobalHub.SendToPriority(u.ID, msg)
		}
	}
}

// mediaStreamKey identifies a user's WebSocket audio stream to the
// recorder. A user has one connection at a time (Hub.Register), and a
// reconnect announces a new stream anyway, so the user id is enough.
func mediaStreamKey(userID int64) string {
	return "ws-" + strconv.FormatInt(userID, 10)
}

// startMediaStream tells the recorder that the client's next audio chunk
// begins a new MediaRecorder stream. The client sends this before the
// stream's first chunk on the same connection, so the order holds.
func startMediaStream(c *Client, mime string) {
	chID := channel.GetUserChannel(c.UserID)
	format := recording.FormatForMIME(mime)
	if recorder == nil || chID == 0 || format == "" {
		return
	}
	recorder.MediaStreamStarted(chID, mediaStreamKey(c.UserID), format)
}

// recordMediaChunk hands a WebSocket audio chunk to the recorder.
func recordMediaChunk(c *Client, channelID int64, chunk []byte) {
	if recorder != nil {
		recorder.MediaChunk(channelID, c.UserID, c.Username, mediaStreamKey(c.UserID), chunk)
	}
}

// mediaChunkLost tells the recorder that one of the client's audio chunks
// was dropped before it got there.
func mediaChunkLost(c *Client) {
	if chID := channel.GetUserChannel(c.UserID); recorder != nil && chID != 0 {
		recorder.MediaChunkLost(chID, mediaStreamKey(c.UserID))
	}
}

// endMediaStream closes the user's WebSocket audio file, if any.
func endMediaStream(channelID, userID int64) {
	if recorder != nil {
		recorder.MediaStreamEnded(channelID, mediaStreamKey(userID))
	}
}

func recordingStateMessage(channelID int64, st recording.State) []byte {
	msg, _ := json.Marshal(map[string]any{
		"type":         "recording_state",
		"channel_id":   channelID,
		"active":       st.Active,
		"recording_id": st.RecordingID,
		"started_by":   st.StartedBy,
		"started_at":   st.StartedAt,
	})
	return msg
}

// sendRecordingState tells a participant who just joined whether the call
// is being recorded. It is sent even when it is not: a client rejoining
// after a dropped connection may still show a recording that ended.
func sendRecordingState(userID, channelID int64) {
	if recorder == nil {
		return
	}
	GlobalHub.SendTo(userID, recordingStateMessage(channelID, recorder.State(channelID)))
}

// handleRecordingStart lets any participant of the call start recording it,
// guests included (ADR-0001: rights come later).
func handleRecordingStart(c *Client) {
	chID := channel.GetUserChannel(c.UserID)
	if chID == 0 {
		return
	}
	if recorder == nil {
		errMsg, _ := json.Marshal(map[string]any{
			"type":  "error",
			"error": "recording_disabled",
			"text":  "Recording is disabled on this server",
		})
		GlobalHub.SendTo(c.UserID, errMsg)
		return
	}
	_, err := recorder.Start(chID, c.UserID, c.Username)
	if errors.Is(err, recording.ErrAlreadyRecording) || errors.Is(err, recording.ErrTooSoon) {
		// Show the caller the real state instead of their stale button.
		GlobalHub.SendTo(c.UserID, recordingStateMessage(chID, recorder.State(chID)))
		return
	}
	if err != nil {
		logger.Error("signaling: start recording in channel %d: %v", chID, err)
	}
}

func handleRecordingStop(c *Client) {
	chID := channel.GetUserChannel(c.UserID)
	if chID == 0 || recorder == nil {
		return
	}
	if err := recorder.Stop(chID); err != nil && !errors.Is(err, recording.ErrNotRecording) {
		logger.Error("signaling: stop recording in channel %d: %v", chID, err)
	}
}

// emptyGrace is how long a recording outlives an empty channel: a page
// reload or a network blip of the last participant must not end it.
var emptyGrace = 60 * time.Second

// emptyWaits holds the pending stop of each empty channel's recording.
var (
	emptyTimersMu sync.Mutex
	emptyTimers   = map[int64]*emptyWait{}
)

type emptyWait struct{ timer *time.Timer }

// channelUsersChanged publishes the channel's participants and stops its
// recording once the channel has stayed empty for emptyGrace.
func channelUsersChanged(channelID int64) {
	broadcastChannelUpdate(channelID)
	// A recording cannot start in an empty channel, so only a running one
	// needs the wait.
	if recorder == nil || len(channel.GetUsers(channelID)) > 0 || !recorder.State(channelID).Active {
		return
	}
	// Each time the channel empties the wait starts over; whoever comes
	// back in time keeps the recording going (the stop re-checks).
	emptyTimersMu.Lock()
	defer emptyTimersMu.Unlock()
	if w := emptyTimers[channelID]; w != nil {
		w.timer.Stop()
	}
	w := &emptyWait{}
	w.timer = time.AfterFunc(emptyGrace, func() { stopIfStillEmpty(channelID, w) })
	emptyTimers[channelID] = w
}

func stopIfStillEmpty(channelID int64, w *emptyWait) {
	emptyTimersMu.Lock()
	current := emptyTimers[channelID] == w
	if current {
		delete(emptyTimers, channelID)
	}
	rec := recorder
	emptyTimersMu.Unlock()
	if !current || rec == nil {
		return // the channel emptied again since; a newer wait is pending
	}
	if len(channel.GetUsers(channelID)) > 0 {
		return
	}
	if err := rec.Stop(channelID); err == nil {
		logger.Info("signaling: channel %d stayed empty, recording stopped", channelID)
	} else if !errors.Is(err, recording.ErrNotRecording) {
		logger.Error("signaling: stop recording in empty channel %d: %v", channelID, err)
	}
}

// PostSystemMessage stores a system line in the channel's chat and sends it
// to everyone who sees that chat, as the huddle notices do.
func PostSystemMessage(channelID int64, text string) {
	now := time.Now()
	id := fmt.Sprintf("sys-rec-%d-%d", channelID, now.UnixNano())
	if err := database.SaveChatMessage(database.ChatMessage{
		ID: id, ChannelID: channelID, Username: "Vocala", Text: text, CreatedAt: now.Unix(), Kind: "system",
	}); err != nil {
		logger.Error("signaling: save system message in channel %d: %v", channelID, err)
	}
	msg, _ := json.Marshal(map[string]any{
		"type":       "chat_message",
		"id":         id,
		"user_id":    0,
		"username":   "Vocala",
		"text":       text,
		"channel_id": channelID,
		"timestamp":  now.Unix(),
		"kind":       "system",
	})
	GlobalHub.BroadcastChatToChannel(channelID, msg)
}
