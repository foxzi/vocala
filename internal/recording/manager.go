// Package recording records call audio on the server: the SFU hands every
// incoming Opus packet to the Manager, which writes one Ogg file per
// participant (see docs/adr/0001-recording-and-transcription.md).
package recording

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/foxzi/vocala/internal/logger"
	"github.com/foxzi/vocala/internal/storage"
	"github.com/pion/rtp"
)

const (
	StatusRecording = "recording"
	StatusReady     = "ready"
	StatusFailed    = "failed"
)

const (
	// queueSize bounds the packets waiting for the writer of one recording:
	// about 80 s of one speaker or 8 s of ten. A full queue drops packets
	// rather than slowing down the SFU.
	queueSize = 4096
	// startCooldown limits how often a channel can start a recording, so
	// start/stop spam cannot flood the channel with notices.
	startCooldown = 2 * time.Second
)

var (
	ErrAlreadyRecording = errors.New("recording: channel is already being recorded")
	ErrNotRecording     = errors.New("recording: channel is not being recorded")
	ErrTooSoon          = errors.New("recording: started too recently")
	ErrNotFound         = errors.New("recording: not found")
)

// Config tunes the Manager.
type Config struct {
	// TmpDir holds segments while they are being written.
	TmpDir string
	// MaxDuration stops a forgotten recording; 0 means no limit.
	MaxDuration time.Duration
}

// State is what clients see about a channel's recording. A stopped
// recording keeps its RecordingID so clients can tell a late "stopped"
// of an old recording from the end of the current one.
type State struct {
	Active      bool   `json:"active"`
	RecordingID int64  `json:"recording_id,omitempty"`
	StartedBy   string `json:"started_by,omitempty"`
	StartedAt   int64  `json:"started_at,omitempty"` // unix ms
}

// Manager owns the active recordings, one per channel at most.
//
// The SFU calls AudioPacket on its forwarding path, so nothing there waits
// on disk or the database: packets are copied into the recording's queue and
// a writer goroutine per recording does the rest.
type Manager struct {
	db     *sql.DB
	blobs  storage.Blobs
	cfg    Config
	notify func(channelID int64, st State)
	// onRecorded is told about every recording whose audio is in storage.
	onRecorded func(channelID, recordingID int64)

	mu        sync.RWMutex
	active    map[int64]*session
	lastStart map[int64]time.Time

	// writers counts recordings whose files are still being finished.
	writers sync.WaitGroup
}

func NewManager(db *sql.DB, blobs storage.Blobs, cfg Config) (*Manager, error) {
	if err := os.MkdirAll(cfg.TmpDir, 0o750); err != nil {
		return nil, fmt.Errorf("recording: create %s: %w", cfg.TmpDir, err)
	}
	return &Manager{
		db: db, blobs: blobs, cfg: cfg,
		active:    make(map[int64]*session),
		lastStart: make(map[int64]time.Time),
	}, nil
}

// OnStateChange registers the callback that tells a channel a recording
// started or stopped. It is called without any Manager lock held.
func (m *Manager) OnStateChange(fn func(channelID int64, st State)) {
	m.notify = fn
}

// event is an RTP packet, a MediaRecorder chunk or the end of a track, on
// its way to the writer.
type event struct {
	trackKey string
	userID   int64
	name     string
	packet   []byte    // RTP packet from the SFU
	chunk    []byte    // MediaRecorder chunk from a WebSocket client
	at       time.Time // arrival of chunk
	format   string    // set on the start of a MediaRecorder stream
}

// session is one active recording.
type session struct {
	id        int64
	channelID int64
	startedBy string
	startedAt time.Time
	limit     *time.Timer
	queue     chan event // closed once the session leaves Manager.active
	dropped   atomic.Int64

	// Owned by the writer goroutine.
	segments map[string]*segment // by SFU track key
	broken   map[string]bool     // tracks whose file could not be opened
	opened   int                 // segments created
	streams  map[string]string   // WebSocket streams announced, waiting for their first chunk: key -> format
	headless int                 // chunks of streams that started before the recording

	// lost marks WebSocket streams that lost a chunk or an announcement on
	// the way (full queue, rate limit). Raw WebM cannot skip bytes, so the
	// writer closes the file there and waits for the next stream. Written by
	// producers, hence the mutex.
	lostMu sync.Mutex
	lost   map[string]bool

	pending sync.WaitGroup // segments being moved to storage
	failed  atomic.Bool
}

func (s *session) state() State {
	return State{Active: true, RecordingID: s.id, StartedBy: s.startedBy, StartedAt: s.startedAt.UnixMilli()}
}

// Start begins recording channelID on behalf of the named participant.
func (m *Manager) Start(channelID, userID int64, username string) (State, error) {
	m.mu.RLock()
	current, last := m.active[channelID], m.lastStart[channelID]
	m.mu.RUnlock()
	if current != nil {
		return current.state(), ErrAlreadyRecording
	}
	if time.Since(last) < startCooldown {
		return State{}, ErrTooSoon
	}

	// The insert runs without m.mu: AudioPacket takes it for every packet
	// of every call, and SQLite may wait seconds for a busy writer.
	now := time.Now()
	res, err := m.db.Exec(
		`INSERT INTO recordings (channel_id, started_by_id, started_by_name, started_at_ms, status) VALUES (?, ?, ?, ?, ?)`,
		channelID, userID, username, now.UnixMilli(), StatusRecording,
	)
	if err != nil {
		return State{}, err
	}
	id, _ := res.LastInsertId()

	s := &session{
		id: id, channelID: channelID, startedBy: username, startedAt: now,
		queue:    make(chan event, queueSize),
		segments: make(map[string]*segment), broken: make(map[string]bool),
		streams: make(map[string]string),
		lost:    make(map[string]bool),
	}
	if m.cfg.MaxDuration > 0 {
		// Set before s is published: end reads s.limit from another goroutine.
		s.limit = time.AfterFunc(m.cfg.MaxDuration, func() {
			logger.Info("recording: %d reached the duration limit", s.id)
			m.stopSession(s)
		})
	}
	m.mu.Lock()
	if current := m.active[channelID]; current != nil {
		// Another participant started one at the same moment.
		m.mu.Unlock()
		if s.limit != nil {
			s.limit.Stop()
		}
		m.db.Exec(`DELETE FROM recordings WHERE id = ?`, id)
		return current.state(), ErrAlreadyRecording
	}
	m.active[channelID] = s
	m.lastStart[channelID] = now
	m.writers.Add(1)
	go m.run(s)
	m.mu.Unlock()

	logger.Info("recording: %d started in channel %d by %q", id, channelID, username)
	st := s.state()
	m.emit(channelID, st)
	return st, nil
}

// Stop ends the channel's recording. Its files are finished in the
// background; Wait blocks until they are stored.
func (m *Manager) Stop(channelID int64) error {
	m.mu.Lock()
	s := m.active[channelID]
	delete(m.active, channelID)
	m.mu.Unlock()
	if s == nil {
		return ErrNotRecording
	}
	m.end(s)
	return nil
}

// StopAll ends every active recording and waits for the files, e.g. on
// shutdown.
func (m *Manager) StopAll() {
	m.mu.Lock()
	all := make([]*session, 0, len(m.active))
	for ch, s := range m.active {
		all = append(all, s)
		delete(m.active, ch)
	}
	m.mu.Unlock()
	for _, s := range all {
		m.end(s)
	}
	m.Wait()
}

// Wait blocks until every stopped recording has its files in storage.
func (m *Manager) Wait() {
	m.writers.Wait()
}

// State reports the channel's current recording.
func (m *Manager) State(channelID int64) State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s, ok := m.active[channelID]; ok {
		return s.state()
	}
	return State{}
}

// stopSession stops s if it is still the channel's active recording.
func (m *Manager) stopSession(s *session) {
	m.mu.Lock()
	if m.active[s.channelID] != s {
		m.mu.Unlock()
		return
	}
	delete(m.active, s.channelID)
	m.mu.Unlock()
	m.end(s)
}

// end runs once per session, after it left m.active: no AudioPacket can
// reach its queue any more, so closing it is safe. Clients learn right
// away; the writer finishes the files on its own.
func (m *Manager) end(s *session) {
	if s.limit != nil {
		s.limit.Stop()
	}
	close(s.queue)
	m.emit(s.channelID, State{RecordingID: s.id})
}

func (m *Manager) emit(channelID int64, st State) {
	if m.notify != nil {
		m.notify(channelID, st)
	}
}

// AudioPacket receives one RTP packet of a participant's audio. It is on the
// SFU forwarding path and never blocks: a channel that is not recorded
// costs one map lookup, a recorded one a copy into the queue. raw is only
// valid during the call.
func (m *Manager) AudioPacket(channelID, userID int64, username, trackKey string, raw []byte) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := m.active[channelID]
	if s == nil {
		return
	}
	ev := event{trackKey: trackKey, userID: userID, name: username, packet: append([]byte(nil), raw...)}
	select {
	case s.queue <- ev:
	default:
		s.dropped.Add(1)
	}
}

// MediaStreamStarted announces that the client behind streamKey started a
// new MediaRecorder stream of the given format: the next chunk is its
// first, with the container header. Only such a stream can be stored —
// chunks without the header cannot be decoded — so when recording starts,
// signaling asks the clients to restart their recorder.
func (m *Manager) MediaStreamStarted(channelID int64, streamKey, format string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s := m.active[channelID]; s != nil {
		select {
		case s.queue <- event{trackKey: streamKey, format: format}:
		default:
			s.dropped.Add(1)
			s.markLost(streamKey)
		}
	}
}

// MediaChunkLost reports a chunk of streamKey that was dropped before it
// reached the recorder.
func (m *Manager) MediaChunkLost(channelID int64, streamKey string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s := m.active[channelID]; s != nil {
		s.markLost(streamKey)
	}
}

func (s *session) markLost(key string) {
	s.lostMu.Lock()
	s.lost[key] = true
	s.lostMu.Unlock()
}

func (s *session) takeLost(key string) bool {
	s.lostMu.Lock()
	defer s.lostMu.Unlock()
	lost := s.lost[key]
	delete(s.lost, key)
	return lost
}

// MediaChunk receives one chunk of a MediaRecorder stream that a mobile
// client sends over WebSocket instead of WebRTC. streamKey identifies the
// client connection. Like AudioPacket it never blocks.
func (m *Manager) MediaChunk(channelID, userID int64, username, streamKey string, chunk []byte) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s := m.active[channelID]
	if s == nil {
		return
	}
	ev := event{trackKey: streamKey, userID: userID, name: username, chunk: append([]byte(nil), chunk...), at: time.Now()}
	select {
	case s.queue <- ev:
	default:
		s.dropped.Add(1)
		s.markLost(streamKey)
	}
}

// MediaStreamEnded closes the file of a WebSocket media stream.
func (m *Manager) MediaStreamEnded(channelID int64, streamKey string) {
	m.AudioTrackEnded(channelID, streamKey)
}

// AudioTrackEnded closes the file of a track that stopped (peer left,
// renegotiated, reconnected). If the queue is full the file is closed when
// the recording stops instead.
func (m *Manager) AudioTrackEnded(channelID int64, trackKey string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s := m.active[channelID]; s != nil {
		select {
		case s.queue <- event{trackKey: trackKey}:
		default:
		}
	}
}

// run is the recording's writer: it owns the segment files.
func (m *Manager) run(s *session) {
	defer m.writers.Done()
	for ev := range s.queue {
		if ev.format != "" {
			m.startStream(s, ev)
			continue
		}
		if ev.chunk != nil {
			m.writeChunk(s, ev)
			continue
		}
		if ev.packet == nil {
			if seg, ok := s.segments[ev.trackKey]; ok {
				delete(s.segments, ev.trackKey)
				m.finish(s, seg)
			}
			delete(s.broken, ev.trackKey)
			delete(s.streams, ev.trackKey)
			continue
		}
		m.write(s, ev)
	}
	for key, seg := range s.segments {
		delete(s.segments, key)
		m.finish(s, seg)
	}
	s.pending.Wait()
	m.complete(s)
}

func (m *Manager) write(s *session, ev event) {
	if s.broken[ev.trackKey] {
		return
	}
	var pkt rtp.Packet
	if err := pkt.Unmarshal(ev.packet); err != nil || len(pkt.Payload) == 0 {
		return
	}
	seg := s.segments[ev.trackKey]
	if seg != nil && seg.breaksAt(&pkt) {
		delete(s.segments, ev.trackKey)
		m.finish(s, seg)
		seg = nil
	}
	if seg == nil {
		var err error
		if seg, err = m.openSegment(s, ev.userID, ev.name, formatOgg, time.Now()); err != nil {
			logger.Error("recording: %d: open segment for user %d: %v", s.id, ev.userID, err)
			s.broken[ev.trackKey] = true
			s.failed.Store(true)
			return
		}
		s.opened++
		s.segments[ev.trackKey] = seg
	}
	if err := seg.write(&pkt); err != nil {
		logger.Error("recording: %d: write segment %d: %v", s.id, seg.id, err)
		delete(s.segments, ev.trackKey)
		s.broken[ev.trackKey] = true
		s.failed.Store(true)
		m.finish(s, seg)
	}
}

// startStream closes the file of the stream's previous MediaRecorder; the
// next chunk opens a new one.
func (m *Manager) startStream(s *session, ev event) {
	if seg, ok := s.segments[ev.trackKey]; ok {
		delete(s.segments, ev.trackKey)
		m.finish(s, seg)
	}
	delete(s.broken, ev.trackKey)
	s.streams[ev.trackKey] = ev.format
}

// writeChunk appends a MediaRecorder chunk. Chunks of a stream that began
// before the recording are dropped: they lack the container header.
func (m *Manager) writeChunk(s *session, ev event) {
	if s.broken[ev.trackKey] {
		return
	}
	if s.takeLost(ev.trackKey) {
		// Something before this chunk never arrived: keep the file valid
		// up to the gap and drop the rest of this stream.
		if seg, ok := s.segments[ev.trackKey]; ok {
			delete(s.segments, ev.trackKey)
			m.finish(s, seg)
		}
		delete(s.streams, ev.trackKey)
		logger.Warn("recording: %d: WebSocket audio of user %d lost a chunk, the rest of this stream is not recorded", s.id, ev.userID)
		s.headless++
		return
	}
	seg := s.segments[ev.trackKey]
	if seg == nil {
		format, announced := s.streams[ev.trackKey]
		if !announced {
			s.headless++
			return
		}
		delete(s.streams, ev.trackKey)
		// The first chunk carries one timeslice of audio recorded before it
		// was sent.
		start := ev.at.Add(-mediaRecorderTimeslice)
		var err error
		if seg, err = m.openSegment(s, ev.userID, ev.name, format, start); err != nil {
			logger.Error("recording: %d: open %s segment for user %d: %v", s.id, format, ev.userID, err)
			s.broken[ev.trackKey] = true
			s.failed.Store(true)
			return
		}
		s.opened++
		s.segments[ev.trackKey] = seg
	}
	if err := seg.appendChunk(ev.chunk, ev.at); err != nil {
		logger.Error("recording: %d: write segment %d: %v", s.id, seg.id, err)
		delete(s.segments, ev.trackKey)
		s.broken[ev.trackKey] = true
		s.failed.Store(true)
		m.finish(s, seg)
	}
}

// complete records the outcome once every segment is stored. A recording
// without any audio is deleted: it would only clutter the list.
func (m *Manager) complete(s *session) {
	if n := s.dropped.Load(); n > 0 {
		logger.Warn("recording: %d: dropped %d packets, the writer fell behind", s.id, n)
	}
	if s.headless > 0 {
		// A few are normal: chunks of the old recorder that arrive between
		// the start and the client's restart. Many mean a client that does
		// not restart (old page) or a stream that lost a chunk.
		logger.Info("recording: %d: skipped %d WebSocket chunks of streams that began before the recording", s.id, s.headless)
	}
	defer os.Remove(m.sessionTmpDir(s.id))
	if s.opened == 0 && !s.failed.Load() {
		if _, err := m.db.Exec(`DELETE FROM recordings WHERE id = ?`, s.id); err != nil {
			logger.Error("recording: delete empty %d: %v", s.id, err)
		}
		logger.Info("recording: %d stopped without audio, removed", s.id)
		return
	}
	status := StatusReady
	if s.failed.Load() {
		status = StatusFailed
	}
	if _, err := m.db.Exec(`UPDATE recordings SET ended_at_ms = ?, status = ? WHERE id = ?`,
		time.Now().UnixMilli(), status, s.id); err != nil {
		logger.Error("recording: finish %d: %v", s.id, err)
	}
	logger.Info("recording: %d stopped (%s)", s.id, status)
	m.recorded(s.channelID, s.id)
}

func (m *Manager) sessionTmpDir(recordingID int64) string {
	return filepath.Join(m.cfg.TmpDir, fmt.Sprint(recordingID))
}

func (m *Manager) tmpPath(recordingID, segmentID int64, format string) string {
	return filepath.Join(m.sessionTmpDir(recordingID), fmt.Sprintf("%d.%s", segmentID, format))
}

func segmentKey(recordingID, segmentID int64, format string) string {
	return fmt.Sprintf("recordings/%d/%d.%s", recordingID, segmentID, format)
}

// openSegment registers the segment in the database first, so a crash
// mid-call leaves a row that RecoverInterrupted can match to its file.
func (m *Manager) openSegment(s *session, userID int64, name, format string, startedAt time.Time) (*segment, error) {
	tx, err := m.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(
		`INSERT INTO recording_segments (recording_id, user_id, display_name, started_at_ms, storage_key, format) VALUES (?, ?, ?, ?, '', ?)`,
		s.id, userID, name, startedAt.UnixMilli(), format,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	key := segmentKey(s.id, id, format)
	if _, err := tx.Exec(`UPDATE recording_segments SET storage_key = ? WHERE id = ?`, key, id); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(m.sessionTmpDir(s.id), 0o750); err != nil {
		return nil, err
	}
	seg, err := openSegment(id, userID, name, key, m.tmpPath(s.id, id, format), format, startedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		seg.close()
		os.Remove(seg.tmpPath)
		return nil, err
	}
	return seg, nil
}

// finish closes seg and moves it to storage in the background, so a slow
// store (S3) does not hold up the writer.
func (m *Manager) finish(s *session, seg *segment) {
	s.pending.Add(1)
	go func() {
		defer s.pending.Done()
		if err := m.store(seg); err != nil {
			logger.Error("recording: %d: store segment %d: %v", s.id, seg.id, err)
			s.failed.Store(true)
		}
	}()
}

func (m *Manager) store(seg *segment) error {
	if err := seg.close(); err != nil {
		return err
	}
	if err := m.blobs.PutFile(context.Background(), seg.key, seg.tmpPath); err != nil {
		return err
	}
	_, err := m.db.Exec(`UPDATE recording_segments SET duration_ms = ?, stored = 1 WHERE id = ?`,
		seg.duration().Milliseconds(), seg.id)
	return err
}
