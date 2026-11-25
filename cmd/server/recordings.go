package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/foxzi/vocala/internal/auth"
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
	dir := storageDir()
	blobs, where, err := openStorage(dir)
	if errors.Is(err, storage.ErrUnreachable) {
		// Probably starting together with us: uploads retry, and what
		// fails meanwhile is uploaded again later.
		logger.Warn("recording: storage not reachable yet, recordings will be uploaded when it is: %v", err)
	} else if err != nil {
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
	// Which recordings were interrupted is decided now, before new ones can
	// start; moving their files to storage (maybe slow S3) goes on in the
	// background, with uploads a storage outage left behind.
	interrupted, err := m.InterruptedRecordings()
	if err != nil {
		logger.Error("recording: find interrupted: %v", err)
	}
	go func() {
		if err := m.RecoverRecordings(interrupted); err != nil {
			logger.Error("recording: recover interrupted: %v", err)
		}
		for {
			if err := m.RetryFailedUploads(); err != nil {
				logger.Error("recording: retry uploads: %v", err)
			}
			time.Sleep(10 * time.Minute)
		}
	}()
	recorder = m
	rtc.SetAudioRecorder(m)
	signaling.SetRecorder(m)
	logger.Info("recording: enabled, files in %s", where)

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

// openStorage opens the configured backend. Files being written stay on
// the local disk (tmp under dir) whatever the backend.
func openStorage(dir string) (storage.Blobs, string, error) {
	switch cfg.Storage.Backend {
	case "", "local":
		blobs, err := storage.NewLocal(dir)
		return blobs, dir, err
	case "s3":
		s3 := cfg.Storage.S3
		// Short: the server waits for this before it accepts calls.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		blobs, err := storage.NewS3(ctx, storage.S3Config{
			Endpoint: s3.Endpoint, Region: s3.Region, Bucket: s3.Bucket, Prefix: s3.Prefix,
			AccessKey: s3.AccessKey, SecretKey: s3.SecretKey, Insecure: s3.Insecure,
		})
		return blobs, "s3://" + s3.Bucket + "/" + strings.Trim(s3.Prefix, "/"), err
	}
	return nil, "", fmt.Errorf("unknown storage backend %q (supported: local, s3)", cfg.Storage.Backend)
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

// canSeeRecording: admins (every recording, DM calls included: decided
// 25.11.2026), whoever may join the recording's channel, and
// the recording's participants (a track in it, or started it). The last
// keeps recordings of group calls reachable after the channel is removed.
func canSeeRecording(user *auth.User, recordingID, channelID int64) (bool, error) {
	if user.IsAdmin || channel.CanJoin(channelID, user.ID, false) {
		return true, nil
	}
	return recorder.IsParticipant(recordingID, user.ID)
}

// handleRecordings lists a channel's recordings, with mine=1 the
// recordings the user took part in, in any channel, and with all=1 (admins)
// every recording:
// GET /api/recordings?channel_id=N
// GET /api/recordings?mine=1
// GET /api/recordings?all=1
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
	var list []recording.Recording
	var err error
	switch {
	case r.URL.Query().Get("all") == "1":
		if !user.IsAdmin {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		list, err = recorder.ListAll(recordingsListLimit)
	case r.URL.Query().Get("mine") == "1":
		list, err = recorder.ListForUser(user.ID, recordingsListLimit)
	default:
		chID, perr := strconv.ParseInt(r.URL.Query().Get("channel_id"), 10, 64)
		if perr != nil || chID <= 0 {
			http.Error(w, "invalid channel_id", http.StatusBadRequest)
			return
		}
		// Admins see every recording, DM calls included (canSeeRecording).
		if !user.IsAdmin && !channel.CanJoin(chID, user.ID, false) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		list, err = recorder.List(chID, recordingsListLimit)
	}
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
	if ok, err := canSeeRecording(user, recID, chID); err != nil {
		logger.Error("recording audio: %v", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	} else if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// A stored segment never changes, so its id is its version. A browser
	// that has it gets 304 before the storage (maybe S3) is asked.
	etag := `"seg-` + strconv.FormatInt(segID, 10) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	rc, format, err := recorder.OpenSegment(r.Context(), recID, segID)
	if err != nil {
		// An error must not be cached for a day and confirmed by 304s.
		w.Header().Del("ETag")
		w.Header().Set("Cache-Control", "no-store")
	}
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
	if rs, ok := rc.(io.ReadSeeker); ok {
		// Range requests let the browser seek inside the recording.
		http.ServeContent(w, r, name, time.Time{}, rs)
		return
	}
	io.Copy(w, rc)
}

// etagMatches reports whether an If-None-Match header names etag: a list,
// a weak tag (W/"…") or "*" count, as in http.ServeContent.
func etagMatches(header, etag string) bool {
	for _, tag := range strings.Split(header, ",") {
		tag = strings.TrimPrefix(strings.TrimSpace(tag), "W/")
		if tag == etag || tag == "*" {
			return true
		}
	}
	return false
}
