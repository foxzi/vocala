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
	for i := 0; i < 50; i++ {
		p := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 111, SequenceNumber: uint16(i), Timestamp: uint32(i * 960), SSRC: 1},
			Payload: []byte{0xF8, 0xFF, 0xFE}}
		raw, _ := p.Marshal()
		m.AudioPacket(chID, 2, "bob", "b", raw)
	}
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
