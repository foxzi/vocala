package transcription

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/foxzi/vocala/internal/database"
	"github.com/foxzi/vocala/internal/recording"
	"github.com/foxzi/vocala/internal/speech"
	"github.com/foxzi/vocala/internal/storage"
	"github.com/pion/rtp"
)

// fakeSTT answers from a script keyed by the bytes it is sent: every
// segment file is identified by its user in the test.
type fakeSTT struct {
	mu      sync.Mutex
	calls   int
	byCall  [][]speech.Phrase
	errs    []error
	formats []string
}

var alwaysReady = func() chan struct{} { c := make(chan struct{}); close(c); return c }()

func (f *fakeSTT) Ready() <-chan struct{} { return alwaysReady }

func (f *fakeSTT) Transcribe(_ context.Context, audio io.Reader, filename string) ([]speech.Phrase, error) {
	io.Copy(io.Discard, audio)
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.calls
	f.calls++
	f.formats = append(f.formats, filename)
	if i < len(f.errs) && f.errs[i] != nil {
		return nil, f.errs[i]
	}
	if i < len(f.byCall) {
		return f.byCall[i], nil
	}
	return nil, nil
}

func newManager(t *testing.T) *recording.Manager {
	t.Helper()
	dir := t.TempDir()
	database.Init(filepath.Join(dir, "test.db"))
	t.Cleanup(func() { database.DB.Close() })
	blobs, err := storage.NewLocal(filepath.Join(dir, "storage"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := recording.NewManager(database.DB, blobs, recording.Config{TmpDir: filepath.Join(dir, "storage", "tmp")})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// record makes a finished recording in which each speaker talks for 1 s,
// in order, through the SFU path.
func record(t *testing.T, m *recording.Manager, speakers ...string) int64 {
	t.Helper()
	st, err := m.Start(1, 1, speakers[0])
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range speakers {
		for n := 0; n < 50; n++ {
			p := rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(n), Timestamp: uint32(n * 960)},
				Payload: []byte{0xF8, 0xFF, 0xFE},
			}
			raw, _ := p.Marshal()
			m.AudioPacket(1, int64(i+1), name, name, raw)
		}
		time.Sleep(30 * time.Millisecond) // distinct segment start times
	}
	if err := m.Stop(1); err != nil {
		t.Fatal(err)
	}
	m.Wait()
	return st.RecordingID
}

func runUntil(t *testing.T, m *recording.Manager, w *Worker, status string, id int64) recording.Recording {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		r, err := m.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if r.TranscriptStatus == status {
			return r
		}
		if time.Now().After(deadline) {
			t.Fatalf("transcript status = %q, want %q", r.TranscriptStatus, status)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTranscribesRecordingOnStop(t *testing.T) {
	m := newManager(t)
	stt := &fakeSTT{byCall: [][]speech.Phrase{
		{{Start: 0.1, End: 0.5, Text: "Привет"}, {Start: 0.6, End: 0.9, Text: "всем."}},
		{{Start: 2.0, End: 2.5, Text: "Здравствуйте."}},
	}}
	w, err := NewWorker(m, stt, filepath.Join(t.TempDir(), "tr"))
	if err != nil {
		t.Fatal(err)
	}
	var ready []int64
	w.OnReady(func(r recording.Recording) { ready = append(ready, r.ID) })
	m.OnRecorded(func(_, id int64) { w.Queue(id) })

	id := record(t, m, "Ivan", "Maria")
	r := runUntil(t, m, w, recording.TranscriptReady, id)
	if len(ready) != 1 || ready[0] != id {
		t.Fatalf("OnReady calls = %v", ready)
	}
	if len(r.Segments) != 2 || stt.calls != 2 {
		t.Fatalf("segments = %d, service calls = %d", len(r.Segments), stt.calls)
	}
	for _, f := range stt.formats {
		if f != "segment.ogg" {
			t.Errorf("filename = %q, want segment.ogg", f)
		}
	}
	rc, err := m.OpenTranscript(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	text, _ := io.ReadAll(rc)
	rc.Close()
	got := string(text)
	for _, want := range []string{"# Transcript", "Participants: Ivan, Maria.", "] Ivan: Привет всем.", "] Maria: "} {
		if !strings.Contains(got, want) {
			t.Errorf("transcript lacks %q:\n%s", want, got)
		}
	}
	if strings.Index(got, "Ivan:") > strings.Index(got, "Maria:") {
		t.Errorf("Ivan spoke first but comes later:\n%s", got)
	}
}

func TestFailedAttemptsEndInFailed(t *testing.T) {
	m := newManager(t)
	boom := errors.New("service answered 500")
	stt := &fakeSTT{errs: []error{boom, boom, boom}}
	w, _ := NewWorker(m, stt, filepath.Join(t.TempDir(), "tr"))
	id := record(t, m, "Ivan")
	if queued, err := w.Queue(id); !queued || err != nil {
		t.Fatalf("Queue = %v, %v", queued, err)
	}
	// Skip the backoff between attempts.
	for i := 0; i < maxAttempts; i++ {
		rid, attempts, ok, err := m.NextTranscript()
		if !ok || err != nil || rid != id {
			t.Fatalf("NextTranscript = %d, %v, %v", rid, ok, err)
		}
		w.attempt(context.Background(), rid, attempts)
	}
	r, _ := m.Get(id)
	if r.TranscriptStatus != recording.TranscriptFailed {
		t.Fatalf("status = %q, want failed", r.TranscriptStatus)
	}
	// A member queues it again.
	if queued, _ := w.Queue(id); !queued {
		t.Fatal("failed transcript could not be queued again")
	}
}

func TestReadyTranscriptIsNotRedone(t *testing.T) {
	m := newManager(t)
	stt := &fakeSTT{}
	w, _ := NewWorker(m, stt, filepath.Join(t.TempDir(), "tr"))
	id := record(t, m, "Ivan")
	w.Queue(id)
	rid, attempts, _, _ := m.NextTranscript()
	w.attempt(context.Background(), rid, attempts)
	if r, _ := m.Get(id); r.TranscriptStatus != recording.TranscriptReady {
		t.Fatalf("status = %q", r.TranscriptStatus)
	}
	if queued, _ := w.Queue(id); queued {
		t.Fatal("a ready transcript was queued again")
	}
}

func TestJobsWaitUntilTheModelIsReady(t *testing.T) {
	m := newManager(t)
	stt := &slowStartSTT{ready: make(chan struct{})}
	w, _ := NewWorker(m, stt, filepath.Join(t.TempDir(), "tr"))
	id := record(t, m, "Ivan")
	w.Queue(id)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	time.Sleep(100 * time.Millisecond)
	if r, _ := m.Get(id); r.TranscriptStatus != recording.TranscriptPending {
		t.Fatalf("status before the model is ready = %q, want pending", r.TranscriptStatus)
	}
	close(stt.ready)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if r, _ := m.Get(id); r.TranscriptStatus == recording.TranscriptReady {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("not transcribed after the model became ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
}

type slowStartSTT struct {
	fakeSTT
	ready chan struct{}
}

func (s *slowStartSTT) Ready() <-chan struct{} { return s.ready }

func TestUnavailableServiceIsNotAnAttempt(t *testing.T) {
	m := newManager(t)
	stt := &fakeSTT{errs: []error{fmt.Errorf("%w: dial", speech.ErrUnavailable)}}
	w, _ := NewWorker(m, stt, filepath.Join(t.TempDir(), "tr"))
	id := record(t, m, "Ivan")
	w.Queue(id)
	rid, attempts, _, _ := m.NextTranscript()
	w.attempt(context.Background(), rid, attempts)
	rid, attempts, ok, _ := m.NextTranscript()
	if !ok || rid != id || attempts != 0 {
		t.Fatalf("after an unreachable service: job %d ok=%v attempts=%d, want queued with 0 attempts", rid, ok, attempts)
	}
}

func TestRenderMergesAndOrders(t *testing.T) {
	r := recording.Recording{
		StartedAt: time.Date(2026, 11, 25, 10, 0, 0, 0, time.Local).UnixMilli(),
		Segments:  []recording.Segment{{Name: "Ivan"}, {Name: "Maria"}},
	}
	r.EndedAt = r.StartedAt + 65_000
	lines := []Line{
		{At: 10 * time.Second, End: 12 * time.Second, Speaker: "Maria", Text: "Да."},
		{At: 1 * time.Second, End: 3 * time.Second, Speaker: "Ivan", Text: "Начнём."},
		{At: 4 * time.Second, End: 6 * time.Second, Speaker: "Ivan", Text: "Кто первый?"},
		{At: 61 * time.Second, End: 63 * time.Second, Speaker: "Ivan", Text: "Всё."},
	}
	got := Render(r, lines)
	want := "# Transcript, " + time.UnixMilli(r.StartedAt).Format("2006-01-02 15:04 MST") + "\n\n" +
		"Duration: 00:01:05. Participants: Ivan, Maria.\n\n" +
		"[00:00:01] Ivan: Начнём. Кто первый?\n\n" +
		"[00:00:10] Maria: Да.\n\n" +
		"[00:01:01] Ivan: Всё.\n\n"
	if got != want {
		t.Fatalf("Render:\n%s\nwant:\n%s", got, want)
	}
	if empty := Render(r, nil); !strings.Contains(empty, "No speech was recognized") {
		t.Fatalf("empty transcript:\n%s", empty)
	}
}
