package recording

import (
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

const (
	opusClockRate = 48000
	// maxGap is the longest jump in a participant's RTP timestamps that
	// still continues the same file. A longer pause, or a jump backwards
	// (timestamp reset), starts a new segment with its own wall-clock start.
	maxGap = opusClockRate // one second of RTP time
	// silenceFrameSamples is the length of opusSilence.
	silenceFrameSamples = opusClockRate / 50 // 20 ms
)

// opusSilence is a 20 ms CELT frame of silence, the one browsers send.
var opusSilence = []byte{0xF8, 0xFF, 0xFE}

// segment is one participant's continuous audio, written as Ogg/Opus to a
// temporary file until it is finished and moved to storage.
//
// The Ogg writer advances time by the samples it is given, not by RTP
// timestamps, so lost packets would make the file shorter than the call and
// shift everything after them. write fills such gaps with silence; together
// with maxGap this keeps every file aligned to its wall-clock start.
type segment struct {
	id        int64
	userID    int64
	name      string
	key       string
	tmpPath   string
	startedAt time.Time
	w         *oggwriter.OggWriter

	hasTS       bool
	firstTS     uint32
	lastTS      uint32
	lastSamples uint32 // length of the last written packet
	filled      int    // silence frames inserted for lost packets
}

func openSegment(id, userID int64, name, key, tmpPath string, startedAt time.Time) (*segment, error) {
	w, err := oggwriter.New(tmpPath, opusClockRate, 2)
	if err != nil {
		return nil, err
	}
	return &segment{id: id, userID: userID, name: name, key: key, tmpPath: tmpPath, startedAt: startedAt, w: w}, nil
}

// breaksAt reports whether pkt cannot continue this file: after a long
// pause, or with a timestamp far behind the last one.
func (s *segment) breaksAt(pkt *rtp.Packet) bool {
	if !s.hasTS {
		return false
	}
	d := int32(pkt.Timestamp - s.lastTS)
	return d > maxGap || d < -maxGap
}

// write appends pkt. Packets older than the last written one (reordered or
// retransmitted) are dropped so time in the file only moves forward.
func (s *segment) write(pkt *rtp.Packet) error {
	if s.hasTS {
		d := int32(pkt.Timestamp - s.lastTS)
		if d <= 0 {
			return nil
		}
		if err := s.fillGap(uint32(d)); err != nil {
			return err
		}
	}
	if err := s.w.WriteRTP(pkt); err != nil {
		return err
	}
	if !s.hasTS {
		s.firstTS = pkt.Timestamp
		s.hasTS = true
	}
	s.lastTS = pkt.Timestamp
	s.lastSamples = opusSamples(pkt.Payload)
	return nil
}

// fillGap writes silence for the samples between the end of the last packet
// and a packet that starts delta samples after it.
func (s *segment) fillGap(delta uint32) error {
	if delta <= s.lastSamples {
		return nil
	}
	for missing := delta - s.lastSamples; missing >= silenceFrameSamples; missing -= silenceFrameSamples {
		silence := &rtp.Packet{
			Header:  rtp.Header{Version: 2, Timestamp: s.lastTS + s.lastSamples},
			Payload: opusSilence,
		}
		if err := s.w.WriteRTP(silence); err != nil {
			return err
		}
		s.lastTS += s.lastSamples
		s.lastSamples = silenceFrameSamples
		s.filled++
	}
	return nil
}

func (s *segment) duration() time.Duration {
	if !s.hasTS {
		return 0
	}
	samples := s.lastTS - s.firstTS + s.lastSamples
	return time.Duration(samples) * time.Second / opusClockRate
}

// opusSamples returns the number of 48 kHz samples in an Opus packet, from
// its TOC byte (RFC 6716, section 3.1). It returns 20 ms for a malformed
// packet, the browsers' default frame.
func opusSamples(payload []byte) uint32 {
	if len(payload) == 0 {
		return silenceFrameSamples
	}
	toc := payload[0]
	config := toc >> 3
	var frame uint32 // samples per frame
	switch {
	case config < 12: // SILK: 10, 20, 40, 60 ms
		frame = [4]uint32{480, 960, 1920, 2880}[config%4]
	case config < 16: // hybrid: 10, 20 ms
		frame = [2]uint32{480, 960}[config%2]
	default: // CELT: 2.5, 5, 10, 20 ms
		frame = [4]uint32{120, 240, 480, 960}[config%4]
	}
	frames := uint32(1)
	switch toc & 0x03 {
	case 1, 2:
		frames = 2
	case 3:
		if len(payload) < 2 {
			return silenceFrameSamples
		}
		frames = uint32(payload[1] & 0x3F)
	}
	return frame * frames
}
