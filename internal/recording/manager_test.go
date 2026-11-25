package recording

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/foxzi/vocala/internal/database"
	"github.com/foxzi/vocala/internal/storage"
	"github.com/pion/rtp"
)

type fixture struct {
	m     *Manager
	blobs *storage.Local
	dir   string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	database.Init(filepath.Join(dir, "test.db"))
	t.Cleanup(func() { database.DB.Close() })
	return reopen(t, dir)
}

// reopen builds a Manager over the same database and directories, as a
// restarted server would.
func reopen(t *testing.T, dir string) *fixture {
	t.Helper()
	blobs, err := storage.NewLocal(filepath.Join(dir, "storage"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(database.DB, blobs, Config{TmpDir: filepath.Join(dir, "storage", "tmp")})
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{m: m, blobs: blobs, dir: dir}
}

func packet(t *testing.T, seq uint16, ts uint32) []byte {
	t.Helper()
	p := rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: seq, Timestamp: ts, SSRC: 1},
		Payload: opusSilence,
	}
	raw, err := p.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// talk sends n consecutive 20 ms packets starting at RTP timestamp ts.
func talk(t *testing.T, m *Manager, channelID, userID int64, name, track string, ts uint32, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		m.AudioPacket(channelID, userID, name, track, packet(t, uint16(i), ts+uint32(i*960)))
	}
}

func readSegment(t *testing.T, m *Manager, recID, segID int64) []byte {
	t.Helper()
	rc, format, err := m.OpenSegment(context.Background(), recID, segID)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	if format != "ogg" {
		t.Fatalf("format = %q, want ogg", format)
	}
	data, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRecordsOneFilePerParticipant(t *testing.T) {
	f := newFixture(t)
	var mu sync.Mutex
	var states []State
	f.m.OnStateChange(func(_ int64, st State) {
		mu.Lock()
		states = append(states, st)
		mu.Unlock()
	})

	// Not recording yet: packets are ignored.
	talk(t, f.m, 7, 1, "alice", "a", 0, 10)

	st, err := f.m.Start(7, 1, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if !st.Active || st.StartedBy != "alice" || st.RecordingID == 0 {
		t.Fatalf("unexpected state %+v", st)
	}
	if _, err := f.m.Start(7, 2, "bob"); !errors.Is(err, ErrAlreadyRecording) {
		t.Fatalf("second Start: err = %v, want ErrAlreadyRecording", err)
	}

	talk(t, f.m, 7, 1, "alice", "a", 1000, 50) // 1 s
	talk(t, f.m, 7, 2, "bob", "b", 5000, 100)  // 2 s
	talk(t, f.m, 8, 3, "carol", "c", 0, 10)    // other channel, not recorded

	if err := f.m.Stop(7); err != nil {
		t.Fatal(err)
	}
	f.m.Wait()
	if err := f.m.Stop(7); !errors.Is(err, ErrNotRecording) {
		t.Fatalf("second Stop: err = %v, want ErrNotRecording", err)
	}
	if f.m.State(7).Active {
		t.Fatal("state still active after Stop")
	}

	mu.Lock()
	if len(states) != 2 || !states[0].Active || states[1].Active || states[1].RecordingID != st.RecordingID {
		t.Fatalf("notifications = %+v, want start then stop", states)
	}
	mu.Unlock()

	list, err := f.m.List(7, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("recordings = %d, want 1", len(list))
	}
	rec := list[0]
	if rec.Status != StatusReady || rec.EndedAt == 0 {
		t.Fatalf("recording %+v, want ready with end time", rec)
	}
	if len(rec.Segments) != 2 {
		t.Fatalf("segments = %d, want 2", len(rec.Segments))
	}
	want := map[string]int64{"alice": 1000, "bob": 2000}
	for _, seg := range rec.Segments {
		if got := seg.DurationMs; got < want[seg.Name]-40 || got > want[seg.Name]+40 {
			t.Errorf("%s duration = %d ms, want ~%d", seg.Name, got, want[seg.Name])
		}
		data := readSegment(t, f.m, rec.ID, seg.ID)
		if !bytes.HasPrefix(data, []byte("OggS")) || !bytes.Contains(data, []byte("OpusHead")) {
			t.Errorf("%s: not an Ogg/Opus file", seg.Name)
		}
	}

	if other, _ := f.m.List(8, 10); len(other) != 0 {
		t.Fatalf("channel 8 has %d recordings, want 0", len(other))
	}
	if entries, _ := os.ReadDir(filepath.Join(f.dir, "storage", "tmp")); len(entries) != 0 {
		t.Fatalf("tmp dir not cleaned: %d entries", len(entries))
	}
}

func TestLongPauseStartsNewSegment(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 1, 1, "alice", "a", 0, 10)
	talk(t, f.m, 1, 1, "alice", "a", 10*960+3*opusClockRate, 10) // 3 s later
	if err := f.m.Stop(1); err != nil {
		t.Fatal(err)
	}
	f.m.Wait()
	list, _ := f.m.List(1, 10)
	if n := len(list[0].Segments); n != 2 {
		t.Fatalf("segments = %d, want 2 split by the pause", n)
	}
}

func TestTrackEndClosesSegment(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 1, 1, "alice", "a1", 0, 10)
	f.m.AudioTrackEnded(1, "a1")
	// Reconnected: new track key, new file.
	talk(t, f.m, 1, 1, "alice", "a2", 0, 10)
	if err := f.m.Stop(1); err != nil {
		t.Fatal(err)
	}
	f.m.Wait()
	list, _ := f.m.List(1, 10)
	if n := len(list[0].Segments); n != 2 {
		t.Fatalf("segments = %d, want 2", n)
	}
}

func TestRecoverInterrupted(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 1, 1, "alice", "a", 0, 50)
	// Let the writer put the packets on disk, then the process dies: no
	// Stop. A new Manager finds the open recording.
	waitFor(t, func() bool {
		entries, _ := os.ReadDir(f.m.sessionTmpDir(1))
		return len(entries) == 1
	})
	time.Sleep(50 * time.Millisecond)
	g := reopen(t, f.dir)
	if err := g.m.RecoverInterrupted(); err != nil {
		t.Fatal(err)
	}
	list, _ := g.m.List(1, 10)
	if len(list) != 1 || list[0].Status != StatusReady || list[0].EndedAt == 0 {
		t.Fatalf("recovered = %+v, want one ready recording", list)
	}
	if len(list[0].Segments) != 1 {
		t.Fatalf("segments = %d, want 1", len(list[0].Segments))
	}
	data := readSegment(t, g.m, list[0].ID, list[0].Segments[0].ID)
	if !bytes.HasPrefix(data, []byte("OggS")) {
		t.Fatal("recovered segment is not an Ogg file")
	}
}

func TestCleanupRemovesOldRecordings(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 1, 1, "alice", "a", 0, 10)
	if err := f.m.Stop(1); err != nil {
		t.Fatal(err)
	}
	f.m.Wait()
	list, _ := f.m.List(1, 10)
	seg := list[0].Segments[0]

	if n, _ := f.m.Cleanup(30); n != 0 {
		t.Fatalf("fresh recording removed")
	}
	old := time.Now().AddDate(0, 0, -31).UnixMilli()
	database.DB.Exec(`UPDATE recordings SET started_at_ms = ?`, old)
	if n, err := f.m.Cleanup(30); err != nil || n != 1 {
		t.Fatalf("Cleanup = %d, %v; want 1", n, err)
	}
	if list, _ := f.m.List(1, 10); len(list) != 0 {
		t.Fatalf("recording still listed")
	}
	if _, err := f.blobs.Open(context.Background(), segmentKey(list[0].ID, seg.ID, formatOgg)); !errors.Is(err, storage.ErrNotFound) {
		t.Fatalf("file still in storage: %v", err)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met in 5 s")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func stopAndList(t *testing.T, m *Manager, channelID int64) []Recording {
	t.Helper()
	if err := m.Stop(channelID); err != nil {
		t.Fatal(err)
	}
	m.Wait()
	list, err := m.List(channelID, 10)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func TestTimestampJumpBackStartsNewSegment(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 1, 1, "alice", "a", 10*opusClockRate, 10)
	talk(t, f.m, 1, 1, "alice", "a", 0, 50) // timestamps reset to zero
	list := stopAndList(t, f.m, 1)
	if n := len(list[0].Segments); n != 2 {
		t.Fatalf("segments = %d, want 2", n)
	}
	var total int64
	for _, s := range list[0].Segments {
		total += s.DurationMs
	}
	if total != 1200 {
		t.Fatalf("total duration = %d ms, want 1200: audio after the reset was lost", total)
	}
}

func TestLostPacketsAreFilledWithSilence(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	// 1 s of audio with every other packet lost: the file must still last 1 s.
	for i := 0; i < 50; i += 2 {
		f.m.AudioPacket(1, 1, "alice", "a", packet(t, uint16(i), uint32(i*960)))
	}
	list := stopAndList(t, f.m, 1)
	if got := list[0].Segments[0].DurationMs; got != 980 {
		t.Fatalf("duration = %d ms, want 980 (49 frames incl. silence)", got)
	}
	data := readSegment(t, f.m, list[0].ID, list[0].Segments[0].ID)
	// One Ogg page per packet: 2 header pages + 49 audio pages.
	if pages := bytes.Count(data, []byte("OggS")); pages != 51 {
		t.Fatalf("ogg pages = %d, want 51", pages)
	}
}

func TestRecordingWithoutAudioIsRemoved(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	if list := stopAndList(t, f.m, 1); len(list) != 0 {
		t.Fatalf("recordings = %d, want 0", len(list))
	}
}

func TestStartCooldown(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	f.m.Stop(1)
	if _, err := f.m.Start(1, 1, "alice"); !errors.Is(err, ErrTooSoon) {
		t.Fatalf("restart right away: err = %v, want ErrTooSoon", err)
	}
	f.m.Wait()
}

// The SFU calls AudioPacket on its forwarding path: a busy database must
// not slow it down.
func TestAudioPacketDoesNotWaitForDatabase(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	conn, err := database.DB.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	talk(t, f.m, 1, 2, "bob", "b", 0, 100) // opening bob's segment needs the DB
	if took := time.Since(start); took > 100*time.Millisecond {
		t.Fatalf("100 packets took %v with the database locked", took)
	}
	conn.ExecContext(context.Background(), "ROLLBACK")
	conn.Close()
	list := stopAndList(t, f.m, 1)
	if len(list[0].Segments) != 1 {
		t.Fatalf("segments = %d, want 1 once the database is free", len(list[0].Segments))
	}
}

func TestRecoverKeepsSegmentAlreadyInStorage(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 1, 1, "alice", "a", 0, 10)
	waitFor(t, func() bool {
		entries, _ := os.ReadDir(f.m.sessionTmpDir(1))
		return len(entries) == 1
	})
	time.Sleep(50 * time.Millisecond)
	// Crash after the file was moved to storage, before stored = 1.
	if err := f.blobs.PutFile(context.Background(), segmentKey(1, 1, formatOgg), f.m.tmpPath(1, 1, formatOgg)); err != nil {
		t.Fatal(err)
	}
	g := reopen(t, f.dir)
	if err := g.m.RecoverInterrupted(); err != nil {
		t.Fatal(err)
	}
	list, _ := g.m.List(1, 10)
	if len(list) != 1 || len(list[0].Segments) != 1 {
		t.Fatalf("recovered = %+v, want the stored segment kept", list)
	}
}

func TestOpusSamples(t *testing.T) {
	cases := []struct {
		payload []byte
		want    uint32
	}{
		{[]byte{0xF8}, 960},        // CELT 20 ms, one frame
		{[]byte{0x78}, 960},        // hybrid FB 20 ms
		{[]byte{0x08}, 960},        // SILK NB 20 ms
		{[]byte{0x18}, 2880},       // SILK NB 60 ms
		{[]byte{0xF9}, 1920},       // two CELT 20 ms frames
		{[]byte{0xFB, 0x03}, 2880}, // code 3, three frames
	}
	for _, c := range cases {
		if got := opusSamples(c.payload); got != c.want {
			t.Errorf("opusSamples(%x) = %d, want %d", c.payload, got, c.want)
		}
	}
}

func TestWebSocketStreamsFromAnnouncedStart(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	// A stream that started before the recording: no header, unusable.
	f.m.MediaChunk(1, 5, "phone", "ws-1", []byte("old"))
	// The client restarted its recorder; Chrome may split the header.
	f.m.MediaStreamStarted(1, "ws-1", "webm")
	f.m.MediaChunk(1, 5, "phone", "ws-1", []byte{0x1A})
	f.m.MediaChunk(1, 5, "phone", "ws-1", []byte{0x45, 0xDF, 0xA3})
	f.m.MediaChunk(1, 5, "phone", "ws-1", []byte("c1"))
	// Restarted again (reconnect): a new file.
	f.m.MediaStreamStarted(1, "ws-1", "webm")
	f.m.MediaChunk(1, 5, "phone", "ws-1", []byte("h2"))
	f.m.MediaStreamEnded(1, "ws-1")
	f.m.MediaChunk(1, 5, "phone", "ws-1", []byte("after-end")) // not announced: dropped

	list := stopAndList(t, f.m, 1)
	segs := list[0].Segments
	if len(segs) != 2 {
		t.Fatalf("segments = %d, want 2", len(segs))
	}
	want := []string{"\x1a\x45\xdf\xa3c1", "h2"}
	for i, seg := range segs {
		if seg.Format != "webm" || seg.Name != "phone" || seg.UserID != 5 {
			t.Errorf("segment %d = %+v", i, seg)
		}
		rc, format, err := f.m.OpenSegment(context.Background(), list[0].ID, seg.ID)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		if format != "webm" || string(data) != want[i] {
			t.Errorf("segment %d: %s %q, want webm %q", i, format, data, want[i])
		}
		if seg.DurationMs < 60 {
			t.Errorf("segment %d duration = %d ms, want at least one timeslice", i, seg.DurationMs)
		}
	}
}

func TestFormatForMIME(t *testing.T) {
	cases := map[string]string{
		"audio/webm;codecs=opus":     "webm",
		"audio/webm":                 "webm",
		"audio/mp4;codecs=mp4a.40.2": "mp4",
		"audio/ogg":                  "",
		"":                           "",
	}
	for mime, want := range cases {
		if got := FormatForMIME(mime); got != want {
			t.Errorf("FormatForMIME(%q) = %q, want %q", mime, got, want)
		}
	}
}

// Raw WebM cannot skip bytes: after a lost chunk the file ends there and
// the stream is not recorded until the client starts a new one.
func TestLostWebSocketChunkClosesStream(t *testing.T) {
	f := newFixture(t)
	if _, err := f.m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	f.m.MediaStreamStarted(1, "ws-5", "webm")
	f.m.MediaChunk(1, 5, "phone", "ws-5", []byte("h1"))
	f.m.MediaChunk(1, 5, "phone", "ws-5", []byte("a"))
	waitFor(t, func() bool { // let the writer take both chunks
		entries, _ := os.ReadDir(f.m.sessionTmpDir(1))
		return len(entries) == 1
	})
	time.Sleep(50 * time.Millisecond)
	f.m.MediaChunkLost(1, "ws-5")
	f.m.MediaChunk(1, 5, "phone", "ws-5", []byte("c")) // after the gap: dropped
	f.m.MediaStreamStarted(1, "ws-5", "webm")
	f.m.MediaChunk(1, 5, "phone", "ws-5", []byte("h2"))

	list := stopAndList(t, f.m, 1)
	var got []string
	for _, seg := range list[0].Segments {
		rc, _, err := f.m.OpenSegment(context.Background(), list[0].ID, seg.ID)
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(rc)
		rc.Close()
		got = append(got, string(data))
	}
	if len(got) != 2 || got[0] != "h1a" || got[1] != "h2" {
		t.Fatalf("segments = %q, want [h1a h2]", got)
	}
}

// flakyBlobs fails PutFile (and Open, if openErr is set) while down.
type flakyBlobs struct {
	*storage.Local
	mu      sync.Mutex
	down    bool
	failsN  int // PutFile calls left to fail even when up
	puts    int
	openErr error
}

func (f *flakyBlobs) PutFile(ctx context.Context, key, path string) error {
	f.mu.Lock()
	f.puts++
	fail := f.down || f.failsN > 0
	if f.failsN > 0 {
		f.failsN--
	}
	f.mu.Unlock()
	if fail {
		return errors.New("connection refused")
	}
	return f.Local.PutFile(ctx, key, path)
}

func (f *flakyBlobs) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	f.mu.Lock()
	err := f.openErr
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return f.Local.Open(ctx, key)
}

func flakyFixture(t *testing.T, blobs *flakyBlobs) *Manager {
	t.Helper()
	dir := t.TempDir()
	database.Init(filepath.Join(dir, "test.db"))
	t.Cleanup(func() { database.DB.Close() })
	local, err := storage.NewLocal(filepath.Join(dir, "storage"))
	if err != nil {
		t.Fatal(err)
	}
	blobs.Local = local
	m, err := NewManager(database.DB, blobs, Config{
		TmpDir: filepath.Join(dir, "storage", "tmp"), UploadAttempts: 3, UploadBackoff: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestUploadRetriesShortOutage(t *testing.T) {
	blobs := &flakyBlobs{failsN: 2}
	m := flakyFixture(t, blobs)
	if _, err := m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, m, 1, 1, "alice", "a", 0, 10)
	list := stopAndList(t, m, 1)
	if list[0].Status != StatusReady || len(list[0].Segments) != 1 || blobs.puts != 3 {
		t.Fatalf("status %s, segments %d, uploads %d; want ready after the third upload", list[0].Status, len(list[0].Segments), blobs.puts)
	}
}

func TestFailedUploadIsRetriedLater(t *testing.T) {
	blobs := &flakyBlobs{down: true}
	m := flakyFixture(t, blobs)
	var recorded []int64
	m.OnRecorded(func(_, id int64) { recorded = append(recorded, id) })
	st, err := m.Start(1, 1, "alice")
	if err != nil {
		t.Fatal(err)
	}
	talk(t, m, 1, 1, "alice", "a", 0, 10)
	list := stopAndList(t, m, 1)
	if list[0].Status != StatusFailed || len(list[0].Segments) != 0 || len(recorded) != 0 {
		t.Fatalf("during the outage: status %s, stored segments %d, recorded %v", list[0].Status, len(list[0].Segments), recorded)
	}

	// Still down: nothing changes, the file stays on disk.
	if err := m.RetryFailedUploads(); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(m.sessionTmpDir(st.RecordingID)); len(entries) != 1 {
		t.Fatalf("tmp files = %d, want the segment kept", len(entries))
	}

	blobs.mu.Lock()
	blobs.down = false
	blobs.mu.Unlock()
	if err := m.RetryFailedUploads(); err != nil {
		t.Fatal(err)
	}
	list, _ = m.List(1, 10)
	if list[0].Status != StatusReady || len(list[0].Segments) != 1 {
		t.Fatalf("after the outage: status %s, segments %d; want ready with 1", list[0].Status, len(list[0].Segments))
	}
	if len(recorded) != 1 || recorded[0] != st.RecordingID {
		t.Fatalf("recorded = %v, want the recording queued for transcription once", recorded)
	}
}

// A storage that cannot answer must not make recovery forget a segment
// that may well be in it.
func TestRecoveryKeepsSegmentWhenStorageErrs(t *testing.T) {
	blobs := &flakyBlobs{}
	m := flakyFixture(t, blobs)
	if _, err := m.Start(1, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	talk(t, m, 1, 1, "alice", "a", 0, 10)
	waitFor(t, func() bool {
		entries, _ := os.ReadDir(m.sessionTmpDir(1))
		return len(entries) == 1
	})
	time.Sleep(50 * time.Millisecond)
	// Crash after the upload, before stored = 1; then the storage errs.
	if err := blobs.Local.PutFile(context.Background(), segmentKey(1, 1, formatOgg), m.tmpPath(1, 1, formatOgg)); err != nil {
		t.Fatal(err)
	}
	blobs.openErr = errors.New("503 slow down")
	if err := m.RecoverInterrupted(); err != nil {
		t.Fatal(err)
	}
	var rows int
	database.DB.QueryRow(`SELECT COUNT(*) FROM recording_segments WHERE recording_id = 1`).Scan(&rows)
	if rows != 1 {
		t.Fatalf("segment rows = %d, want the row kept", rows)
	}
	blobs.openErr = nil
	if err := m.RetryFailedUploads(); err != nil {
		t.Fatal(err)
	}
	if list, _ := m.List(1, 10); list[0].Status != StatusReady || len(list[0].Segments) != 1 {
		t.Fatalf("after storage recovered: %+v", list[0])
	}
}

// A disk error loses the audio of a few seconds, not the rest of the
// participant's recording.
func TestDiskErrorRetriesAfterAWhile(t *testing.T) {
	old := diskRetry
	diskRetry = 50 * time.Millisecond
	t.Cleanup(func() { diskRetry = old })
	f := newFixture(t)

	st, err := f.m.Start(7, 1, "alice")
	if err != nil {
		t.Fatal(err)
	}
	// A file where the session's directory should be: nothing can be opened.
	blocker := f.m.sessionTmpDir(st.RecordingID)
	os.MkdirAll(filepath.Dir(blocker), 0o750)
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, 7, 1, "alice", "a", 0, 50)
	time.Sleep(200 * time.Millisecond) // the writer tries and fails
	os.Remove(blocker)
	removed := time.Now()
	time.Sleep(100 * time.Millisecond) // past diskRetry
	talk(t, f.m, 7, 1, "alice", "a", 5*48000, 50)

	if err := f.m.Stop(7); err != nil {
		t.Fatal(err)
	}
	f.m.Wait()
	rec, err := f.m.Get(st.RecordingID)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != StatusReady || len(rec.Segments) != 1 {
		t.Fatalf("status %s with %d segments, want ready with the audio after the error", rec.Status, len(rec.Segments))
	}
	// The file was opened after the disk recovered: the first batch really
	// hit the error (a slow writer would have opened it before).
	if rec.Segments[0].StartedAt < removed.UnixMilli() {
		t.Fatalf("segment started %d ms before the disk recovered: the error path never ran",
			removed.UnixMilli()-rec.Segments[0].StartedAt)
	}
}

// When nothing could be written at all, the recording stays as failed
// instead of vanishing as empty.
func TestDiskErrorThroughoutIsFailed(t *testing.T) {
	f := newFixture(t)
	st, err := f.m.Start(7, 1, "alice")
	if err != nil {
		t.Fatal(err)
	}
	blocker := f.m.sessionTmpDir(st.RecordingID)
	os.MkdirAll(filepath.Dir(blocker), 0o750)
	os.WriteFile(blocker, nil, 0o600)
	talk(t, f.m, 7, 1, "alice", "a", 0, 50)
	if err := f.m.Stop(7); err != nil {
		t.Fatal(err)
	}
	f.m.Wait()
	os.Remove(blocker)
	rec, err := f.m.Get(st.RecordingID)
	if err != nil {
		t.Fatalf("recording gone: %v", err)
	}
	if rec.Status != StatusFailed {
		t.Fatalf("status %s, want failed", rec.Status)
	}
}

// Participants keep their recordings when the channel is gone: My
// recordings lists them and IsParticipant grants access.
func TestRecordingsOfParticipants(t *testing.T) {
	f := newFixture(t)
	database.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', '-')`)
	res, err := database.DB.Exec(`INSERT INTO channels (name, created_by, is_private, is_ephemeral, is_group) VALUES ('Group-1', 1, 1, 1, 1)`)
	if err != nil {
		t.Fatal(err)
	}
	chID, _ := res.LastInsertId()
	st, err := f.m.Start(chID, 1, "alice") // alice starts, bob speaks, carol is silent
	if err != nil {
		t.Fatal(err)
	}
	talk(t, f.m, chID, 2, "bob", "b", 0, 50)
	f.m.Stop(chID)
	f.m.Wait()

	for user, want := range map[int64]bool{1: true, 2: true, 3: false} {
		ok, err := f.m.IsParticipant(st.RecordingID, user)
		if err != nil || ok != want {
			t.Errorf("IsParticipant(user %d) = %v, %v; want %v", user, ok, err, want)
		}
		list, err := f.m.ListForUser(user, 10)
		if err != nil || (len(list) == 1) != want {
			t.Errorf("ListForUser(%d) = %d recordings, %v; want listed: %v", user, len(list), err, want)
		}
	}
	list, _ := f.m.ListForUser(2, 10)
	if list[0].ChannelKind != "group" || list[0].ChannelName != "Group-1" {
		t.Errorf("channel = %s %q, want group Group-1", list[0].ChannelKind, list[0].ChannelName)
	}

	// The group call's channel is removed an hour after it empties.
	database.DB.Exec(`DELETE FROM channels WHERE id = ?`, chID)
	if ok, _ := f.m.IsParticipant(st.RecordingID, 2); !ok {
		t.Error("bob lost access with the channel")
	}
	rec, err := f.m.Get(st.RecordingID)
	if err != nil || rec.ChannelKind != "deleted" || len(rec.Segments) != 1 {
		t.Errorf("after channel deletion: %+v, %v", rec, err)
	}
}

// A WebSocket stream cannot resume mid-stream after a disk error: the
// client is asked for a new stream once diskRetry has passed.
func TestDiskErrorAsksWebSocketClientForNewStream(t *testing.T) {
	old := diskRetry
	diskRetry = 50 * time.Millisecond
	t.Cleanup(func() { diskRetry = old })
	f := newFixture(t)
	asked := make(chan [2]int64, 1)
	f.m.OnStreamBroken(func(ch, user int64) { asked <- [2]int64{ch, user} })

	st, err := f.m.Start(1, 5, "phone")
	if err != nil {
		t.Fatal(err)
	}
	blocker := f.m.sessionTmpDir(st.RecordingID)
	os.MkdirAll(filepath.Dir(blocker), 0o750)
	os.WriteFile(blocker, nil, 0o600)
	f.m.MediaStreamStarted(1, "ws-5", "webm")
	f.m.MediaChunk(1, 5, "phone", "ws-5", []byte{0x1A})
	select {
	case got := <-asked:
		if got != [2]int64{1, 5} {
			t.Fatalf("asked %v, want channel 1 user 5", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the client was never asked for a new stream")
	}
	os.Remove(blocker)
	f.m.Stop(1)
	f.m.Wait()
}
