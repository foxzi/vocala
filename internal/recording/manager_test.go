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
