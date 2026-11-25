package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/foxzi/vocala/internal/auth"
	"github.com/foxzi/vocala/internal/database"
	"github.com/foxzi/vocala/internal/recording"
	"github.com/foxzi/vocala/internal/storage"
	"github.com/pion/rtp"
)

// recordGroupCall records bob speaking in a group call started by alice,
// then removes the call's channel, as the hourly cleanup does.
func recordGroupCall(t *testing.T) (recID, segID int64) {
	t.Helper()
	dir := t.TempDir()
	database.Init(filepath.Join(dir, "test.db"))
	t.Cleanup(func() { database.DB.Close() })
	blobs, err := storage.NewLocal(filepath.Join(dir, "storage"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := recording.NewManager(database.DB, blobs, recording.Config{TmpDir: filepath.Join(dir, "tmp")})
	if err != nil {
		t.Fatal(err)
	}
	old := recorder
	recorder = m
	t.Cleanup(func() { recorder = old })

	database.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', '-')`)
	res, err := database.DB.Exec(`INSERT INTO channels (name, created_by, is_private, is_ephemeral, is_group) VALUES ('Group-1', 1, 1, 1, 1)`)
	if err != nil {
		t.Fatal(err)
	}
	chID, _ := res.LastInsertId()
	st, err := m.Start(chID, 1, "alice")
	if err != nil {
		t.Fatal(err)
	}
	sendTone(m, chID, 2, "bob")
	m.Stop(chID)
	m.Wait()
	database.DB.Exec(`DELETE FROM channels WHERE id = ?`, chID)
	rec, err := m.Get(st.RecordingID)
	if err != nil || len(rec.Segments) != 1 {
		t.Fatalf("recording %+v, %v", rec, err)
	}
	return rec.ID, rec.Segments[0].ID
}

func get(user *auth.User, h http.HandlerFunc, url string, header http.Header) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, url, nil)
	for k, v := range header {
		r.Header[k] = v
	}
	r = r.WithContext(context.WithValue(r.Context(), userCtxKey, user))
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestParticipantsKeepRecordingsOfDeletedChannels(t *testing.T) {
	recID, segID := recordGroupCall(t)
	audio := fmt.Sprintf("/api/recordings/audio?recording_id=%d&segment_id=%d", recID, segID)
	for _, c := range []struct {
		user *auth.User
		want int
	}{
		{&auth.User{ID: 1}, http.StatusOK},                // started it
		{&auth.User{ID: 2}, http.StatusOK},                // spoke in it
		{&auth.User{ID: 3}, http.StatusForbidden},         // was not there
		{&auth.User{ID: 4, IsAdmin: true}, http.StatusOK}, // admin
	} {
		if w := get(c.user, handleRecordingAudio, audio, nil); w.Code != c.want {
			t.Errorf("user %d: audio %d, want %d", c.user.ID, w.Code, c.want)
		}
	}

	w := get(&auth.User{ID: 2}, handleRecordings, "/api/recordings?mine=1", nil)
	var list []recording.Recording
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 || list[0].ChannelKind != "deleted" {
		t.Errorf("My recordings of bob = %+v", list)
	}
	w = get(&auth.User{ID: 3}, handleRecordings, "/api/recordings?mine=1", nil)
	if w.Body.String() != "[]\n" {
		t.Errorf("My recordings of a stranger = %s", w.Body)
	}

	// The transcript goes through the same check (none exists yet: 404).
	transcript := fmt.Sprintf("/api/recordings/transcript?recording_id=%d", recID)
	if w := get(&auth.User{ID: 2}, handleRecordingTranscript, transcript, nil); w.Code != http.StatusNotFound {
		t.Errorf("participant: transcript %d, want 404 (allowed, not made yet)", w.Code)
	}
	if w := get(&auth.User{ID: 3}, handleRecordingTranscript, transcript, nil); w.Code != http.StatusForbidden {
		t.Errorf("stranger: transcript %d, want 403", w.Code)
	}

	// All recordings is for admins only.
	if w := get(&auth.User{ID: 2}, handleRecordings, "/api/recordings?all=1", nil); w.Code != http.StatusForbidden {
		t.Errorf("all=1 for a user: %d, want 403", w.Code)
	}
	w = get(&auth.User{ID: 4, IsAdmin: true}, handleRecordings, "/api/recordings?all=1", nil)
	list = nil
	json.Unmarshal(w.Body.Bytes(), &list)
	if w.Code != http.StatusOK || len(list) != 1 {
		t.Errorf("all=1 for an admin: %d, %d recordings", w.Code, len(list))
	}
}

// Admins see every recording, DM calls of other users included (decided
// 25.11.2026); a third user does not.
func TestAdminSeesDMRecordings(t *testing.T) {
	recordGroupCall(t) // sets up the database and the recorder
	database.DB.Exec(`INSERT INTO users (id, username, password_hash) VALUES (2, 'bob', '-')`)
	res, err := database.DB.Exec(`INSERT INTO channels (name, created_by, is_private, is_dm, dm_user_a, dm_user_b) VALUES ('dm-1-2', 1, 1, 1, 1, 2)`)
	if err != nil {
		t.Fatal(err)
	}
	dm, _ := res.LastInsertId()
	st, err := recorder.Start(dm, 1, "alice")
	if err != nil {
		t.Fatal(err)
	}
	sendTone(recorder, dm, 2, "bob")
	recorder.Stop(dm)
	recorder.Wait()
	rec, _ := recorder.Get(st.RecordingID)
	if len(rec.Segments) != 1 {
		t.Fatalf("DM recording has %d segments", len(rec.Segments))
	}
	audio := fmt.Sprintf("/api/recordings/audio?recording_id=%d&segment_id=%d", rec.ID, rec.Segments[0].ID)
	list := fmt.Sprintf("/api/recordings?channel_id=%d", dm)
	admin, stranger := &auth.User{ID: 9, IsAdmin: true}, &auth.User{ID: 3}
	if w := get(admin, handleRecordingAudio, audio, nil); w.Code != http.StatusOK {
		t.Errorf("admin: DM audio %d, want 200", w.Code)
	}
	if w := get(admin, handleRecordings, list, nil); w.Code != http.StatusOK {
		t.Errorf("admin: DM list %d, want 200", w.Code)
	}
	if w := get(stranger, handleRecordingAudio, audio, nil); w.Code != http.StatusForbidden {
		t.Errorf("third user: DM audio %d, want 403", w.Code)
	}
	if w := get(stranger, handleRecordings, list, nil); w.Code != http.StatusForbidden {
		t.Errorf("third user: DM list %d, want 403", w.Code)
	}
}

func TestETagMatches(t *testing.T) {
	for header, want := range map[string]bool{
		`"seg-1"`: true, `W/"seg-1"`: true, `"x", "seg-1"`: true, `*`: true,
		`"seg-10"`: false, ``: false,
	} {
		if got := etagMatches(header, `"seg-1"`); got != want {
			t.Errorf("etagMatches(%q) = %v, want %v", header, got, want)
		}
	}
}

func TestAudioETag(t *testing.T) {
	recID, segID := recordGroupCall(t)
	audio := fmt.Sprintf("/api/recordings/audio?recording_id=%d&segment_id=%d", recID, segID)
	bob := &auth.User{ID: 2}
	w := get(bob, handleRecordingAudio, audio, nil)
	etag := w.Header().Get("ETag")
	if w.Code != http.StatusOK || etag == "" {
		t.Fatalf("first GET: %d, ETag %q", w.Code, etag)
	}
	w = get(bob, handleRecordingAudio, audio, http.Header{"If-None-Match": {etag}})
	if w.Code != http.StatusNotModified || w.Body.Len() != 0 {
		t.Errorf("revalidation: %d with %d bytes, want 304 and no body", w.Code, w.Body.Len())
	}
	// A cached copy does not bypass the access check.
	if w := get(&auth.User{ID: 3}, handleRecordingAudio, audio, http.Header{"If-None-Match": {etag}}); w.Code != http.StatusForbidden {
		t.Errorf("stranger with an ETag: %d, want 403", w.Code)
	}
}

// sendTone sends one second of Opus silence frames from the user.
func sendTone(m *recording.Manager, channelID, userID int64, name string) {
	for i := 0; i < 50; i++ {
		p := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(i), Timestamp: uint32(i * 960), SSRC: 1},
			Payload: []byte{0xF8, 0xFF, 0xFE}}
		raw, _ := p.Marshal()
		m.AudioPacket(channelID, userID, name, "t"+fmt.Sprint(userID), raw)
	}
}
