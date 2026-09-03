package signaling

import "testing"

func TestHubReplacementOwnsRegistration(t *testing.T) {
	h := &Hub{clients: make(map[int64]*Client)}
	first := &Client{UserID: 42}
	second := &Client{UserID: 42}

	if replaced := h.Register(first); replaced {
		t.Fatal("first registration unexpectedly replaced a client")
	}
	if replaced := h.Register(second); !replaced {
		t.Fatal("second registration did not report replacement")
	}
	if removed := h.Unregister(first); removed {
		t.Fatal("displaced client removed the active registration")
	}
	if got := h.clients[42]; got != second {
		t.Fatal("displaced client changed the active registration")
	}
	if removed := h.Unregister(second); !removed {
		t.Fatal("active client was not unregistered")
	}
}
