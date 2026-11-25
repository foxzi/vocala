package signaling

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/foxzi/vocala/internal/channel"
	"github.com/foxzi/vocala/internal/database"
	"github.com/foxzi/vocala/internal/recording"
	"github.com/foxzi/vocala/internal/storage"
)

func withRecorder(t *testing.T) *recording.Manager {
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
	old, oldGrace := recorder, emptyGrace
	recorder, emptyGrace = m, 400*time.Millisecond
	t.Cleanup(func() {
		emptyTimersMu.Lock()
		for id, w := range emptyTimers {
			w.timer.Stop()
			delete(emptyTimers, id)
		}
		recorder, emptyGrace = old, oldGrace
		emptyTimersMu.Unlock()
		m.StopAll()
		m.Wait()
	})
	return m
}

// The last participant reloading the page does not end the recording.
func TestRecordingSurvivesShortEmptyChannel(t *testing.T) {
	m := withRecorder(t)
	const ch = 501
	channel.Join(ch, 1, "alice")
	if _, err := m.Start(ch, 1, "alice"); err != nil {
		t.Fatal(err)
	}
	channel.Leave(1)
	channelUsersChanged(ch)
	time.Sleep(50 * time.Millisecond)
	channel.Join(ch, 1, "alice") // back within the grace
	channelUsersChanged(ch)
	time.Sleep(600 * time.Millisecond)
	if !m.State(ch).Active {
		t.Fatal("recording stopped although alice came back in time")
	}

	// Leaving again restarts the wait; staying away stops it.
	channel.Leave(1)
	channelUsersChanged(ch)
	time.Sleep(100 * time.Millisecond)
	if !m.State(ch).Active {
		t.Fatal("recording stopped before the grace ran out")
	}
	time.Sleep(700 * time.Millisecond)
	if m.State(ch).Active {
		t.Fatal("recording still running in a channel empty for longer than the grace")
	}
}
