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

	// Leave, come back and leave again within the grace: the wait counts
	// from the last leave, the first one's timer must not stop it.
	firstLeave := time.Now()
	channel.Leave(1)
	channelUsersChanged(ch)
	time.Sleep(100 * time.Millisecond)
	channel.Join(ch, 1, "alice")
	channelUsersChanged(ch)
	time.Sleep(100 * time.Millisecond)
	channel.Leave(1)
	channelUsersChanged(ch)
	time.Sleep(time.Until(firstLeave.Add(emptyGrace + 100*time.Millisecond)))
	if !m.State(ch).Active {
		t.Fatal("the first leave's timer stopped the recording; the wait must restart")
	}
	time.Sleep(500 * time.Millisecond)
	if m.State(ch).Active {
		t.Fatal("recording still running in a channel empty for longer than the grace")
	}
}
