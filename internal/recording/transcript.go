package recording

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
)

// Transcript states, kept on the recording row so the transcription queue
// survives restarts.
const (
	TranscriptNone    = ""
	TranscriptPending = "pending"
	TranscriptRunning = "running"
	TranscriptReady   = "ready"
	TranscriptFailed  = "failed"
)

// OnRecorded registers the callback told about every recording whose audio
// reached storage (after Stop, and after crash recovery). Set it before
// RecoverInterrupted.
func (m *Manager) OnRecorded(fn func(channelID, recordingID int64)) {
	m.onRecorded = fn
}

func (m *Manager) recorded(channelID, recordingID int64) {
	if m.onRecorded != nil {
		m.onRecorded(channelID, recordingID)
	}
}

// Get returns one recording with its stored segments.
func (m *Manager) Get(recordingID int64) (Recording, error) {
	r, err := scanRecording(m.db.QueryRow(`SELECT `+recordingColumns+` WHERE r.id = ?`, recordingID))
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	if err != nil {
		return r, err
	}
	r.Segments, err = m.segments(r.ID)
	return r, err
}

// QueueTranscript marks a finished recording with stored audio for
// transcription. Only one that has no transcript yet or whose transcript
// failed is queued: a ready transcript is not redone (each run takes the
// server's CPU), and one still recording, queued or running is left alone.
func (m *Manager) QueueTranscript(recordingID int64) (bool, error) {
	res, err := m.db.Exec(
		`UPDATE recordings SET transcript_status = ?, transcript_attempts = 0
		 WHERE id = ? AND status != ? AND transcript_status IN (?, ?)
		 AND EXISTS (SELECT 1 FROM recording_segments WHERE recording_id = recordings.id AND stored = 1)`,
		TranscriptPending, recordingID, StatusRecording, TranscriptNone, TranscriptFailed,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// NextTranscript claims the oldest pending recording, marking it running.
func (m *Manager) NextTranscript() (recordingID int64, attempts int, ok bool, err error) {
	err = m.db.QueryRow(
		// Fewest attempts first: a recording that keeps failing does not
		// hold up the others.
		`SELECT id, transcript_attempts FROM recordings WHERE transcript_status = ? ORDER BY transcript_attempts, id LIMIT 1`,
		TranscriptPending,
	).Scan(&recordingID, &attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, false, nil
	}
	if err != nil {
		return 0, 0, false, err
	}
	_, err = m.db.Exec(`UPDATE recordings SET transcript_status = ? WHERE id = ?`, TranscriptRunning, recordingID)
	return recordingID, attempts, err == nil, err
}

// RequeueRunningTranscripts returns jobs a stopped server left running.
func (m *Manager) RequeueRunningTranscripts() error {
	_, err := m.db.Exec(`UPDATE recordings SET transcript_status = ? WHERE transcript_status = ?`,
		TranscriptPending, TranscriptRunning)
	return err
}

// RetryTranscript puts a job back in the queue after a failed attempt, or
// marks it failed once attempts reach maxAttempts.
func (m *Manager) RetryTranscript(recordingID int64, attempts, maxAttempts int) (failed bool, err error) {
	status := TranscriptPending
	if attempts >= maxAttempts {
		status = TranscriptFailed
	}
	_, err = m.db.Exec(`UPDATE recordings SET transcript_status = ?, transcript_attempts = ? WHERE id = ?`,
		status, attempts, recordingID)
	return status == TranscriptFailed, err
}

// PostponeTranscript returns a running job to the queue without counting
// an attempt (the service was unreachable).
func (m *Manager) PostponeTranscript(recordingID int64) error {
	_, err := m.db.Exec(`UPDATE recordings SET transcript_status = ? WHERE id = ? AND transcript_status = ?`,
		TranscriptPending, recordingID, TranscriptRunning)
	return err
}

func transcriptKey(recordingID int64) string {
	return fmt.Sprintf("recordings/%d/transcript.md", recordingID)
}

// StoreTranscript moves a finished transcript file into storage and marks
// the recording's transcript ready. A recording deleted meanwhile (by
// retention) leaves no orphan file behind.
func (m *Manager) StoreTranscript(ctx context.Context, recordingID int64, localPath string) error {
	key := transcriptKey(recordingID)
	if err := m.blobs.PutFile(ctx, key, localPath); err != nil {
		return err
	}
	res, err := m.db.Exec(`UPDATE recordings SET transcript_status = ?, transcript_key = ? WHERE id = ?`,
		TranscriptReady, key, recordingID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return m.blobs.Delete(ctx, key)
	}
	return nil
}

// OpenTranscript returns the recording's transcript (Markdown).
func (m *Manager) OpenTranscript(ctx context.Context, recordingID int64) (io.ReadCloser, error) {
	var key, status string
	err := m.db.QueryRow(`SELECT transcript_key, transcript_status FROM recordings WHERE id = ?`, recordingID).Scan(&key, &status)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (status != TranscriptReady || key == "")) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return m.blobs.Open(ctx, key)
}

// OpenSegmentFile opens a stored segment of a recording.
func (m *Manager) OpenSegmentFile(ctx context.Context, seg Segment) (io.ReadCloser, error) {
	return m.blobs.Open(ctx, seg.key)
}
