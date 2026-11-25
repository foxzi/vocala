package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"github.com/foxzi/vocala/internal/channel"
	"github.com/foxzi/vocala/internal/database"
	"github.com/foxzi/vocala/internal/logger"
	"github.com/foxzi/vocala/internal/recording"
	"github.com/foxzi/vocala/internal/signaling"
	"github.com/foxzi/vocala/internal/storage"
	rtc "github.com/foxzi/vocala/internal/webrtc"
)

// recorder is nil when recording is disabled.
var recorder *recording.Manager

// recordingsListLimit caps one channel's list; with 30-day retention it is
// far more than a channel accumulates.
const recordingsListLimit = 200

// setupRecording wires the recorder into the SFU and signaling, finishes
// recordings a crash left open and starts the retention cleanup.
func setupRecording() {
	if !cfg.Recording.Enabled {
		logger.Info("recording: disabled")
		return
	}
	// A misconfigured recording must not keep the server from starting
	// (e.g. after an upgrade): calls work, recording stays off.
	if cfg.Storage.Backend != "" && cfg.Storage.Backend != "local" {
		logger.Error("recording: disabled, unknown storage backend %q (supported: local)", cfg.Storage.Backend)
		return
	}
	dir := storageDir()
	blobs, err := storage.NewLocal(dir)
	if err != nil {
		logger.Error("recording: disabled, %v", err)
		return
	}
	tmpDir := cfg.Recording.TmpDir
	if tmpDir == "" {
		tmpDir = filepath.Join(dir, "tmp")
	}
	m, err := recording.NewManager(database.DB, blobs, recording.Config{
		TmpDir:      tmpDir,
		MaxDuration: time.Duration(cfg.Recording.MaxHours) * time.Hour,
	})
	if err != nil {
		logger.Error("recording: disabled, %v", err)
		return
	}
	setupTranscription(m, tmpDir)
	if err := m.RecoverInterrupted(); err != nil {
		logger.Error("recording: recover interrupted: %v", err)
	}
	recorder = m
	rtc.SetAudioRecorder(m)
	signaling.SetRecorder(m)
	logger.Info("recording: enabled, files in %s", dir)

	if days := cfg.Recording.RetentionDays; days > 0 {
		go func() {
			for {
				if n, err := m.Cleanup(days); err != nil {
					logger.Error("recording cleanup error: %v", err)
				} else if n > 0 {
					logger.Info("recording cleanup: removed %d old recordings", n)
				}
				time.Sleep(6 * time.Hour)
			}
		}()
	}
}

// storageDir is storage.local.dir, or "storage" next to the database so
// recordings land on the same persistent volume (/var/lib/vocala in the
// packages, the data volume in Docker).
func storageDir() string {
	if cfg.Storage.Local.Dir != "" {
		return cfg.Storage.Local.Dir
	}
	return filepath.Join(filepath.Dir(cfg.Database.Path), "storage")
}

// handleRecordings lists a channel's recordings:
// GET /api/recordings?channel_id=N
func handleRecordings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if recorder == nil {
		http.Error(w, "recording disabled", http.StatusNotFound)
		return
	}
	user := userFromContext(r)
	chID, err := strconv.ParseInt(r.URL.Query().Get("channel_id"), 10, 64)
	if err != nil || chID <= 0 {
		http.Error(w, "invalid channel_id", http.StatusBadRequest)
		return
	}
	if !channel.CanJoin(chID, user.ID, user.IsAdmin) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	list, err := recorder.List(chID, recordingsListLimit)
	if err != nil {
		logger.Error("list recordings: %v", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	if list == nil {
		list = []recording.Recording{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// handleRecordingAudio streams one participant's segment:
// GET /api/recordings/audio?recording_id=N&segment_id=M
func handleRecordingAudio(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if recorder == nil {
		http.NotFound(w, r)
		return
	}
	user := userFromContext(r)
	recID, err1 := strconv.ParseInt(r.URL.Query().Get("recording_id"), 10, 64)
	segID, err2 := strconv.ParseInt(r.URL.Query().Get("segment_id"), 10, 64)
	if err1 != nil || err2 != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}
	chID, err := recorder.SegmentChannel(recID, segID)
	if errors.Is(err, recording.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		logger.Error("recording audio: %v", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	if !channel.CanJoin(chID, user.ID, user.IsAdmin) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	rc, format, err := recorder.OpenSegment(r.Context(), recID, segID)
	if errors.Is(err, recording.ErrNotFound) || errors.Is(err, storage.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		logger.Error("recording audio: %v", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer rc.Close()

	name := "recording-" + strconv.FormatInt(recID, 10) + "-" + strconv.FormatInt(segID, 10) + "." + format
	w.Header().Set("Content-Type", "audio/"+format) // ogg, webm or mp4
	w.Header().Set("Content-Disposition", `inline; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if rs, ok := rc.(io.ReadSeeker); ok {
		// Range requests let the browser seek inside the recording.
		http.ServeContent(w, r, name, time.Time{}, rs)
		return
	}
	io.Copy(w, rc)
}
