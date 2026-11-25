package recording

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"time"

	"github.com/foxzi/vocala/internal/logger"
	"github.com/foxzi/vocala/internal/storage"
)

// Recording is a finished or running recording with its stored segments.
type Recording struct {
	ID        int64     `json:"id"`
	ChannelID int64     `json:"channel_id"`
	StartedBy string    `json:"started_by"`
	StartedAt int64     `json:"started_at"` // unix ms
	EndedAt   int64     `json:"ended_at"`   // unix ms, 0 while recording
	Status    string    `json:"status"`
	Segments  []Segment `json:"segments"`

	// TranscriptStatus is "" (never transcribed), pending, running, ready
	// or failed.
	TranscriptStatus string `json:"transcript_status"`
}

// Segment is one participant's continuous piece of audio.
type Segment struct {
	ID         int64  `json:"id"`
	UserID     int64  `json:"user_id"`
	Name       string `json:"name"`
	StartedAt  int64  `json:"started_at"` // unix ms
	DurationMs int64  `json:"duration_ms"`
	Format     string `json:"format"`
	key        string
}

// List returns the channel's recordings, newest first, with the segments
// that are already in storage.
func (m *Manager) List(channelID int64, limit int) ([]Recording, error) {
	rows, err := m.db.Query(
		`SELECT id, channel_id, started_by_name, started_at_ms, ended_at_ms, status, transcript_status
		 FROM recordings WHERE channel_id = ? ORDER BY started_at_ms DESC LIMIT ?`,
		channelID, limit,
	)
	if err != nil {
		return nil, err
	}
	var out []Recording
	for rows.Next() {
		var r Recording
		if err := rows.Scan(&r.ID, &r.ChannelID, &r.StartedBy, &r.StartedAt, &r.EndedAt, &r.Status, &r.TranscriptStatus); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Segments, err = m.segments(out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (m *Manager) segments(recordingID int64) ([]Segment, error) {
	rows, err := m.db.Query(
		`SELECT id, user_id, display_name, started_at_ms, duration_ms, format, storage_key
		 FROM recording_segments WHERE recording_id = ? AND stored = 1 ORDER BY started_at_ms, id`,
		recordingID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	segs := []Segment{}
	for rows.Next() {
		var s Segment
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.StartedAt, &s.DurationMs, &s.Format, &s.key); err != nil {
			return nil, err
		}
		segs = append(segs, s)
	}
	return segs, rows.Err()
}

// SegmentChannel returns the channel a stored segment belongs to, for the
// access check before OpenSegment.
func (m *Manager) SegmentChannel(recordingID, segmentID int64) (int64, error) {
	var channelID int64
	err := m.db.QueryRow(
		`SELECT r.channel_id FROM recording_segments s JOIN recordings r ON r.id = s.recording_id
		 WHERE s.id = ? AND s.recording_id = ? AND s.stored = 1`,
		segmentID, recordingID,
	).Scan(&channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return channelID, err
}

// OpenSegment returns the segment's audio and its format (ogg, webm, mp4).
func (m *Manager) OpenSegment(ctx context.Context, recordingID, segmentID int64) (io.ReadCloser, string, error) {
	var key, format string
	err := m.db.QueryRow(
		`SELECT storage_key, format FROM recording_segments WHERE id = ? AND recording_id = ? AND stored = 1`,
		segmentID, recordingID,
	).Scan(&key, &format)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	rc, err := m.blobs.Open(ctx, key)
	return rc, format, err
}

// Cleanup deletes finished recordings older than retentionDays, files first.
func (m *Manager) Cleanup(retentionDays int) (int, error) {
	cutoff := time.Now().AddDate(0, 0, -retentionDays).UnixMilli()
	rows, err := m.db.Query(`SELECT id FROM recordings WHERE started_at_ms < ? AND status != ?`, cutoff, StatusRecording)
	if err != nil {
		return 0, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	removed := 0
	for _, id := range ids {
		if err := m.delete(id); err != nil {
			logger.Error("recording: cleanup %d: %v", id, err)
			continue
		}
		removed++
	}
	return removed, nil
}

func (m *Manager) delete(recordingID int64) error {
	rows, err := m.db.Query(`SELECT storage_key FROM recording_segments WHERE recording_id = ? AND storage_key != ''`, recordingID)
	if err != nil {
		return err
	}
	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err == nil {
			keys = append(keys, k)
		}
	}
	rows.Close()
	// The fixed key, not the column: a transcript being stored right now
	// is not in the column yet.
	keys = append(keys, transcriptKey(recordingID))
	for _, k := range keys {
		ctx, cancel := context.WithTimeout(context.Background(), storageTimeout)
		err := m.blobs.Delete(ctx, k)
		cancel()
		if err != nil {
			return err
		}
	}
	_ = os.RemoveAll(m.sessionTmpDir(recordingID))
	if _, err := m.db.Exec(`DELETE FROM recording_segments WHERE recording_id = ?`, recordingID); err != nil {
		return err
	}
	_, err = m.db.Exec(`DELETE FROM recordings WHERE id = ?`, recordingID)
	return err
}

// RecoverInterrupted finishes recordings that were running when the server
// stopped without StopAll (crash, kill). Their segment files are complete up
// to the last written page; the file's modification time stands in for the
// end, since the RTP timestamps died with the process. Call it before the
// server accepts connections, or split it: InterruptedRecordings first,
// then RecoverRecordings in the background.
func (m *Manager) RecoverInterrupted() error {
	ids, err := m.InterruptedRecordings()
	if err != nil {
		return err
	}
	return m.RecoverRecordings(ids)
}

// InterruptedRecordings lists the recordings a stopped server left running.
// It must run before new recordings can start: those are "recording" too.
func (m *Manager) InterruptedRecordings() ([]int64, error) {
	return m.recordingIDs(`SELECT id FROM recordings WHERE status = ?`, StatusRecording)
}

// RecoverRecordings stores what interrupted recordings left on disk.
func (m *Manager) RecoverRecordings(ids []int64) error {
	for _, id := range ids {
		if err := m.settle(id, true); err != nil {
			return err
		}
	}
	return nil
}

// RetryFailedUploads uploads segments that a storage outage left on the
// local disk, for recordings that ended as failed. Safe to run any time:
// running recordings are never "failed".
func (m *Manager) RetryFailedUploads() error {
	ids, err := m.recordingIDs(
		`SELECT DISTINCT r.id FROM recordings r JOIN recording_segments s ON s.recording_id = r.id
		 WHERE r.status = ? AND s.stored = 0`, StatusFailed)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := m.settle(id, false); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) recordingIDs(query string, args ...any) ([]int64, error) {
	rows, err := m.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// settle moves a recording's unstored segments to storage and records the
// outcome. For an interrupted recording the end time is taken from the
// files (interrupted = true); a failed one keeps its end time.
func (m *Manager) settle(id int64, interrupted bool) error {
	var channelID, startedAt, endedAt int64
	if err := m.db.QueryRow(`SELECT channel_id, started_at_ms, ended_at_ms FROM recordings WHERE id = ?`, id).
		Scan(&channelID, &startedAt, &endedAt); err != nil {
		return err
	}
	segRows, err := m.db.Query(`SELECT id, started_at_ms, storage_key, format FROM recording_segments WHERE recording_id = ? AND stored = 0`, id)
	if err != nil {
		return err
	}
	type seg struct {
		id, startedAt int64
		key, format   string
	}
	var segs []seg
	for segRows.Next() {
		var s seg
		if err := segRows.Scan(&s.id, &s.startedAt, &s.key, &s.format); err == nil {
			segs = append(segs, s)
		}
	}
	segRows.Close()

	ended := max(startedAt, endedAt)
	failed := false
	for _, s := range segs {
		switch rec, err := m.recoverSegment(id, s.id, s.startedAt, s.key, s.format); {
		case err != nil:
			logger.Error("recording: recover segment %d: %v", s.id, err)
			failed = true
		case interrupted && rec.end > 0:
			ended = max(ended, rec.end)
		}
	}
	status := StatusReady
	if failed {
		status = StatusFailed
	}
	// Ended stays at max(started, last segment) — never "now", which
	// could be hours after the crash.
	if _, err := m.db.Exec(`UPDATE recordings SET ended_at_ms = ?, status = ? WHERE id = ?`, ended, status, id); err != nil {
		return err
	}
	if failed {
		logger.Warn("recording: %d still has segments that could not be stored; will retry", id)
		return nil
	}
	_ = os.Remove(m.sessionTmpDir(id))
	logger.Info("recording: %d recovered (%s)", id, status)
	m.recorded(channelID, id)
	return nil
}

type recovered struct{ end int64 }

// recoverSegment moves a segment left in the temporary directory to storage.
// Without a temporary file the crash may have come after the move but
// before the database noted it: the segment is kept if storage has it.
func (m *Manager) recoverSegment(recordingID, segmentID, startedAt int64, key, format string) (recovered, error) {
	if key == "" {
		_, err := m.db.Exec(`DELETE FROM recording_segments WHERE id = ?`, segmentID)
		return recovered{}, err
	}
	tmp := m.tmpPath(recordingID, segmentID, format)
	fi, err := os.Stat(tmp)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), storageTimeout)
		defer cancel()
		rc, openErr := m.blobs.Open(ctx, key)
		switch {
		case errors.Is(openErr, storage.ErrNotFound):
			// Neither on disk nor in storage: the segment is gone.
			_, err := m.db.Exec(`DELETE FROM recording_segments WHERE id = ?`, segmentID)
			return recovered{}, err
		case openErr != nil:
			// The storage could not answer: keep the row and try later.
			return recovered{}, openErr
		}
		rc.Close()
		_, err := m.db.Exec(`UPDATE recording_segments SET stored = 1 WHERE id = ?`, segmentID)
		return recovered{}, err
	}
	end := fi.ModTime().UnixMilli()
	ctx, cancel := context.WithTimeout(context.Background(), storageTimeout)
	defer cancel()
	if err := m.blobs.PutFile(ctx, key, tmp); err != nil {
		return recovered{}, err
	}
	_, err = m.db.Exec(`UPDATE recording_segments SET duration_ms = ?, stored = 1 WHERE id = ?`, max(0, end-startedAt), segmentID)
	return recovered{end: end}, err
}
