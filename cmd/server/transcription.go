package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"github.com/foxzi/vocala/internal/channel"
	"github.com/foxzi/vocala/internal/logger"
	"github.com/foxzi/vocala/internal/recording"
	"github.com/foxzi/vocala/internal/signaling"
	"github.com/foxzi/vocala/internal/speech"
	"github.com/foxzi/vocala/internal/storage"
	"github.com/foxzi/vocala/internal/transcription"
)

// transcriber is nil when transcription is off (no transcription.url).
var transcriber *transcription.Worker

// stopTranscription ends the worker on shutdown.
var stopTranscription = func() {}

// setupTranscription queues every finished recording for transcription by
// the speech service. Call it before RecoverInterrupted, so recovered
// recordings are queued too.
func setupTranscription(m *recording.Manager, tmpDir string) {
	stt := speech.New(cfg.Transcription.URL, cfg.Transcription.Model, cfg.Transcription.Language)
	if stt == nil {
		logger.Info("transcription: disabled (no transcription.url)")
		return
	}
	w, err := transcription.NewWorker(m, stt, filepath.Join(tmpDir, "transcripts"))
	if err != nil {
		logger.Error("transcription: disabled, %v", err)
		return
	}
	w.OnReady(func(r recording.Recording) {
		// No clock time here: the server's time zone (UTC in Docker) is not
		// the readers'.
		signaling.PostSystemMessage(r.ChannelID, fmt.Sprintf("📝 Transcript of the recording started by %s is ready — see Recordings", r.StartedBy))
	})
	m.OnRecorded(func(_ int64, recordingID int64) {
		if _, err := w.Queue(recordingID); err != nil {
			logger.Error("transcription: queue %d: %v", recordingID, err)
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	stopTranscription = cancel
	go stt.Prepare(ctx)
	go w.Run(ctx)
	transcriber = w
	logger.Info("transcription: enabled, model %s via %s", cfg.Transcription.Model, cfg.Transcription.URL)
}

// recordingForMember returns the recording if the user may see it.
func recordingForMember(w http.ResponseWriter, r *http.Request) (recording.Recording, bool) {
	if recorder == nil {
		http.NotFound(w, r)
		return recording.Recording{}, false
	}
	user := userFromContext(r)
	id, err := strconv.ParseInt(r.FormValue("recording_id"), 10, 64)
	if err != nil {
		http.Error(w, "invalid recording_id", http.StatusBadRequest)
		return recording.Recording{}, false
	}
	rec, err := recorder.Get(id)
	if errors.Is(err, recording.ErrNotFound) {
		http.NotFound(w, r)
		return rec, false
	}
	if err != nil {
		logger.Error("get recording: %v", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return rec, false
	}
	if !channel.CanJoin(rec.ChannelID, user.ID, user.IsAdmin) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return rec, false
	}
	return rec, true
}

// handleRecordingTranscript returns a transcript as Markdown:
// GET /api/recordings/transcript?recording_id=N[&download=1]
func handleRecordingTranscript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rec, ok := recordingForMember(w, r)
	if !ok {
		return
	}
	rc, err := recorder.OpenTranscript(r.Context(), rec.ID)
	if errors.Is(err, recording.ErrNotFound) || errors.Is(err, storage.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		logger.Error("open transcript %d: %v", rec.ID, err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-cache")
	if r.URL.Query().Get("download") == "1" {
		name := "transcript-" + time.UnixMilli(rec.StartedAt).Format("2006-01-02-1504") + ".md"
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	}
	io.Copy(w, rc)
}

// handleRecordingTranscribe queues a recording for (re)transcription:
// POST /api/recordings/transcribe recording_id=N
func handleRecordingTranscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if transcriber == nil {
		http.Error(w, "transcription is disabled", http.StatusNotFound)
		return
	}
	rec, ok := recordingForMember(w, r)
	if !ok {
		return
	}
	queued, err := transcriber.Queue(rec.ID)
	if err != nil {
		logger.Error("queue transcript %d: %v", rec.ID, err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	if !queued {
		http.Error(w, "already queued or still recording", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}
