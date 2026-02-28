package webrtc

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/pion/webrtc/v4"
)

// Peer represents a connected WebRTC peer in a channel.
type Peer struct {
	UserID   int64
	Username string
	PC       *webrtc.PeerConnection
	// Audio track this peer is sending
	audioTrack *webrtc.TrackRemote
	// Local tracks we forward to this peer (from other peers)
	outputTracks map[int64]*webrtc.TrackLocalStaticRTP // srcUserID -> local track
	mu           sync.Mutex
}

// SFU manages all peer connections for a channel.
type SFU struct {
	mu    sync.RWMutex
	peers map[int64]*Peer // userID -> Peer

	// Callback to send signaling messages back to clients
	SendMessage func(userID int64, msg []byte)
}

var (
	globalMu sync.RWMutex
	sfus     = make(map[int64]*SFU) // channelID -> SFU
)

var api *webrtc.API

func init() {
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		log.Fatal("webrtc: failed to register codecs:", err)
	}
	api = webrtc.NewAPI(webrtc.WithMediaEngine(m))
}

func newPeerConnectionConfig() webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
			{URLs: []string{"stun:stun1.l.google.com:19302"}},
		},
	}
}

// GetOrCreateSFU returns the SFU for a channel, creating one if needed.
func GetOrCreateSFU(channelID int64, sendMsg func(userID int64, msg []byte)) *SFU {
	globalMu.Lock()
	defer globalMu.Unlock()

	if s, ok := sfus[channelID]; ok {
		return s
	}

	s := &SFU{
		peers:       make(map[int64]*Peer),
		SendMessage: sendMsg,
	}
	sfus[channelID] = s
	return s
}

// RemoveSFU removes the SFU for a channel if it has no peers.
func RemoveSFU(channelID int64) {
	globalMu.Lock()
	defer globalMu.Unlock()

	if s, ok := sfus[channelID]; ok {
		s.mu.RLock()
		empty := len(s.peers) == 0
		s.mu.RUnlock()
		if empty {
			delete(sfus, channelID)
		}
	}
}

// HandleOffer processes an SDP offer from a client and returns an answer.
func (s *SFU) HandleOffer(userID int64, username string, offerSDP string) error {
	offer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offerSDP,
	}

	pc, err := api.NewPeerConnection(newPeerConnectionConfig())
	if err != nil {
		return err
	}

	peer := &Peer{
		UserID:       userID,
		Username:     username,
		PC:           pc,
		outputTracks: make(map[int64]*webrtc.TrackLocalStaticRTP),
	}

	// Add existing peers' audio as tracks to this new peer
	s.mu.RLock()
	for srcID, existingPeer := range s.peers {
		if existingPeer.audioTrack != nil {
			if err := s.addTrackForPeer(peer, srcID, existingPeer.audioTrack); err != nil {
				log.Printf("webrtc: failed to add existing track from user %d to user %d: %v", srcID, userID, err)
			}
		}
	}
	s.mu.RUnlock()

	// Handle incoming audio tracks from this peer
	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if track.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		log.Printf("webrtc: received audio track from user %d (%s)", userID, username)

		s.mu.Lock()
		peer.audioTrack = track
		s.mu.Unlock()

		// Create output tracks for all other peers
		s.mu.RLock()
		for otherID, otherPeer := range s.peers {
			if otherID == userID {
				continue
			}
			if err := s.addTrackForPeer(otherPeer, userID, track); err != nil {
				log.Printf("webrtc: failed to add track from user %d to user %d: %v", userID, otherID, err)
			} else {
				// Renegotiate with the other peer
				s.renegotiate(otherPeer)
			}
		}
		s.mu.RUnlock()

		// Forward RTP packets
		buf := make([]byte, 1500)
		for {
			n, _, readErr := track.Read(buf)
			if readErr != nil {
				log.Printf("webrtc: track read ended for user %d: %v", userID, readErr)
				return
			}

			s.mu.RLock()
			for otherID, otherPeer := range s.peers {
				if otherID == userID {
					continue
				}
				otherPeer.mu.Lock()
				if lt, ok := otherPeer.outputTracks[userID]; ok {
					if _, writeErr := lt.Write(buf[:n]); writeErr != nil {
						log.Printf("webrtc: write to user %d failed: %v", otherID, writeErr)
					}
				}
				otherPeer.mu.Unlock()
			}
			s.mu.RUnlock()
		}
	})

	// Handle ICE candidates from the server side
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		data, _ := json.Marshal(map[string]any{
			"type": "ice_candidate",
			"payload": map[string]any{
				"candidate": c.ToJSON(),
			},
		})
		s.SendMessage(userID, data)
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("webrtc: peer %d (%s) connection state: %s", userID, username, state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed || state == webrtc.PeerConnectionStateDisconnected {
			s.RemovePeer(userID)
		}
	})

	// Set the remote offer
	if err := pc.SetRemoteDescription(offer); err != nil {
		pc.Close()
		return err
	}

	// Create answer
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return err
	}

	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return err
	}

	// Register peer
	s.mu.Lock()
	// Close old peer connection if exists
	if old, ok := s.peers[userID]; ok {
		old.PC.Close()
	}
	s.peers[userID] = peer
	s.mu.Unlock()

	// Send answer back
	data, _ := json.Marshal(map[string]any{
		"type": "webrtc_answer",
		"payload": map[string]any{
			"sdp": answer.SDP,
		},
	})
	s.SendMessage(userID, data)

	return nil
}

// HandleICECandidate adds a remote ICE candidate for a peer.
func (s *SFU) HandleICECandidate(userID int64, candidateJSON json.RawMessage) error {
	s.mu.RLock()
	peer, ok := s.peers[userID]
	s.mu.RUnlock()

	if !ok {
		return nil
	}

	var candidate webrtc.ICECandidateInit
	if err := json.Unmarshal(candidateJSON, &candidate); err != nil {
		return err
	}

	return peer.PC.AddICECandidate(candidate)
}

// RemovePeer closes and removes a peer from the SFU.
func (s *SFU) RemovePeer(userID int64) {
	s.mu.Lock()
	peer, ok := s.peers[userID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.peers, userID)

	// Remove output tracks from other peers that were receiving this user's audio
	for _, otherPeer := range s.peers {
		otherPeer.mu.Lock()
		delete(otherPeer.outputTracks, userID)
		otherPeer.mu.Unlock()
	}
	s.mu.Unlock()

	if peer.PC.ConnectionState() != webrtc.PeerConnectionStateClosed {
		peer.PC.Close()
	}

	log.Printf("webrtc: removed peer %d (%s)", userID, peer.Username)
}

// addTrackForPeer creates a local track on destPeer that will receive RTP from srcTrack.
func (s *SFU) addTrackForPeer(destPeer *Peer, srcUserID int64, srcTrack *webrtc.TrackRemote) error {
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		srcTrack.Codec().RTPCodecCapability,
		srcTrack.ID(),
		srcTrack.StreamID(),
	)
	if err != nil {
		return err
	}

	destPeer.mu.Lock()
	destPeer.outputTracks[srcUserID] = localTrack
	destPeer.mu.Unlock()

	if _, err := destPeer.PC.AddTrack(localTrack); err != nil {
		destPeer.mu.Lock()
		delete(destPeer.outputTracks, srcUserID)
		destPeer.mu.Unlock()
		return err
	}

	return nil
}

// renegotiate sends a new offer to a peer after tracks change.
func (s *SFU) renegotiate(peer *Peer) {
	offer, err := peer.PC.CreateOffer(nil)
	if err != nil {
		log.Printf("webrtc: renegotiate offer failed for user %d: %v", peer.UserID, err)
		return
	}

	if err := peer.PC.SetLocalDescription(offer); err != nil {
		log.Printf("webrtc: renegotiate setlocal failed for user %d: %v", peer.UserID, err)
		return
	}

	data, _ := json.Marshal(map[string]any{
		"type": "webrtc_offer",
		"payload": map[string]any{
			"sdp": offer.SDP,
		},
	})
	s.SendMessage(peer.UserID, data)
}

// HandleAnswer processes an SDP answer from a client (during renegotiation).
func (s *SFU) HandleAnswer(userID int64, answerSDP string) error {
	s.mu.RLock()
	peer, ok := s.peers[userID]
	s.mu.RUnlock()

	if !ok {
		return nil
	}

	return peer.PC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  answerSDP,
	})
}
