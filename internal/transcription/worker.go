// Package transcription turns finished recordings into text: each
// participant's segment goes to the speech service on its own, and the
// recognized phrases are laid out on the recording's timeline, so the
// transcript says who spoke without guessing (ADR-0001).
package transcription

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/foxzi/vocala/internal/logger"
	"github.com/foxzi/vocala/internal/recording"
	"github.com/foxzi/vocala/internal/speech"
)

const (
	// maxAttempts before a recording's transcript is marked failed; a member
	// can queue it again from the recordings list.
	maxAttempts = 3
	// idleCheck re-reads the queue even without a wake-up, e.g. for a job a
	// failed attempt put back.
	idleCheck = time.Minute
	// unavailableBackoff waits for a speech service that cannot be reached
	// (still starting, redeployed).
	unavailableBackoff = 30 * time.Second
	// retryBackoff spaces out attempts after the service rejected a file.
	retryBackoff = time.Minute
)

// Transcriber recognizes the speech in one audio file. Ready is closed
// once it can take files (the model is downloaded and loaded); jobs wait
// for it instead of failing while a model downloads on first start.
type Transcriber interface {
	Transcribe(ctx context.Context, audio io.Reader, filename string) ([]speech.Phrase, error)
	Ready() <-chan struct{}
}

// Worker transcribes queued recordings one at a time: recognition takes
// the server's CPU, and one job at a time keeps calls unaffected.
type Worker struct {
	rec     *recording.Manager
	stt     Transcriber
	tmpDir  string
	onReady func(r recording.Recording)
	wake    chan struct{}
}

func NewWorker(rec *recording.Manager, stt Transcriber, tmpDir string) (*Worker, error) {
	if err := os.MkdirAll(tmpDir, 0o750); err != nil {
		return nil, fmt.Errorf("transcription: create %s: %w", tmpDir, err)
	}
	return &Worker{rec: rec, stt: stt, tmpDir: tmpDir, wake: make(chan struct{}, 1)}, nil
}

// OnReady registers the callback told about every finished transcript.
func (w *Worker) OnReady(fn func(r recording.Recording)) {
	w.onReady = fn
}

// Queue adds a recording to the queue; false if it is already there or
// still being recorded.
func (w *Worker) Queue(recordingID int64) (bool, error) {
	queued, err := w.rec.QueueTranscript(recordingID)
	if queued {
		select {
		case w.wake <- struct{}{}:
		default:
		}
	}
	return queued, err
}

// Run processes the queue until ctx ends.
func (w *Worker) Run(ctx context.Context) {
	if err := w.rec.RequeueRunningTranscripts(); err != nil {
		logger.Error("transcription: requeue: %v", err)
	}
	select {
	case <-ctx.Done():
		return
	case <-w.stt.Ready():
	}
	for ctx.Err() == nil {
		id, attempts, ok, err := w.rec.NextTranscript()
		if err != nil {
			logger.Error("transcription: next job: %v", err)
			sleep(ctx, retryBackoff)
			continue
		}
		if !ok {
			select {
			case <-ctx.Done():
			case <-w.wake:
			case <-time.After(idleCheck):
			}
			continue
		}
		sleep(ctx, w.attempt(ctx, id, attempts))
	}
}

// attempt transcribes one claimed recording and returns how long to wait
// before the next job.
func (w *Worker) attempt(ctx context.Context, id int64, attempts int) time.Duration {
	start := time.Now()
	err := w.process(ctx, id)
	switch {
	case err == nil:
		logger.Info("transcription: recording %d done in %s", id, time.Since(start).Round(time.Second))
		return 0
	case ctx.Err() != nil || errors.Is(err, speech.ErrUnavailable):
		// Not the recording's fault: try again later, without counting.
		logger.Warn("transcription: recording %d postponed: %v", id, err)
		if err := w.rec.PostponeTranscript(id); err != nil {
			logger.Error("transcription: postpone %d: %v", id, err)
		}
		return unavailableBackoff
	default:
		failed, dbErr := w.rec.RetryTranscript(id, attempts+1, maxAttempts)
		if dbErr != nil {
			logger.Error("transcription: retry %d: %v", id, dbErr)
		}
		if failed {
			logger.Error("transcription: recording %d failed after %d attempts: %v", id, maxAttempts, err)
			return 0
		}
		logger.Warn("transcription: recording %d attempt %d failed: %v", id, attempts+1, err)
		return retryBackoff
	}
}

func (w *Worker) process(ctx context.Context, id int64) error {
	r, err := w.rec.Get(id)
	if errors.Is(err, recording.ErrNotFound) {
		return nil // deleted meanwhile
	}
	if err != nil {
		return err
	}
	var lines []Line
	for _, seg := range r.Segments {
		if seg.DurationMs == 0 {
			// Recovered after a crash without a known length: assume the
			// whole recording for the timeout.
			seg.DurationMs = r.EndedAt - r.StartedAt
		}
		phrases, err := w.transcribeSegment(ctx, seg)
		if err != nil {
			return fmt.Errorf("segment %d: %w", seg.ID, err)
		}
		offset := seg.StartedAt - r.StartedAt
		for _, p := range phrases {
			lines = append(lines, Line{
				At:      time.Duration(offset)*time.Millisecond + seconds(p.Start),
				End:     time.Duration(offset)*time.Millisecond + seconds(p.End),
				Speaker: seg.Name,
				Text:    p.Text,
			})
		}
	}

	path := filepath.Join(w.tmpDir, fmt.Sprintf("%d.md", id))
	if err := os.WriteFile(path, []byte(Render(r, lines)), 0o640); err != nil {
		return err
	}
	if err := w.rec.StoreTranscript(ctx, id, path); err != nil {
		os.Remove(path)
		return err
	}
	if w.onReady != nil {
		w.onReady(r)
	}
	return nil
}

func (w *Worker) transcribeSegment(ctx context.Context, seg recording.Segment) ([]speech.Phrase, error) {
	rc, err := w.rec.OpenSegmentFile(ctx, seg)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	// Generous: medium on four CPU threads runs from 0.4x real time on a
	// modern CPU to about 1x on an old one, and the service may still be
	// busy with something else.
	timeout := 5*time.Minute + 2*time.Duration(seg.DurationMs)*time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return w.stt.Transcribe(ctx, rc, "segment."+seg.Format)
}

func seconds(s float64) time.Duration {
	return time.Duration(s * float64(time.Second))
}

func sleep(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
