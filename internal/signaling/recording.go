package signaling

import (
	"encoding/json"
	"errors"

	"github.com/foxzi/vocala/internal/channel"
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
	})
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

// channelUsersChanged publishes the channel's participants and stops its
// recording once the last one has left.
func channelUsersChanged(channelID int64) {
	broadcastChannelUpdate(channelID)
	if recorder != nil && len(channel.GetUsers(channelID)) == 0 {
		if err := recorder.Stop(channelID); err != nil && !errors.Is(err, recording.ErrNotRecording) {
			logger.Error("signaling: stop recording in empty channel %d: %v", channelID, err)
		}
	}
}
