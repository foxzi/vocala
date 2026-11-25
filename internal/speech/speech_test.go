package speech

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTranscribeSendsFormAndParsesSegments(t *testing.T) {
	var got map[string]string
	var file string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" {
			http.NotFound(w, r)
			return
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
		}
		got = map[string]string{}
		for k, v := range r.MultipartForm.Value {
			got[k] = v[0]
		}
		f, h, _ := r.FormFile("file")
		data, _ := io.ReadAll(f)
		file = h.Filename + ":" + string(data)
		io.WriteString(w, `{"text":"x","segments":[
			{"start":0.5,"end":1.5,"text":" Привет,  всем. "},
			{"start":2,"end":3,"text":"Продолжение следует..."}]}`)
	}))
	defer srv.Close()

	c := New(srv.URL+"/", "Systran/faster-whisper-medium", "ru")
	phrases, err := c.Transcribe(context.Background(), strings.NewReader("AUDIO"), "segment.webm")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"model": "Systran/faster-whisper-medium", "language": "ru", "response_format": "verbose_json",
		"timestamp_granularities[]": "segment", "vad_filter": "true",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("form %s = %q, want %q", k, got[k], v)
		}
	}
	if file != "segment.webm:AUDIO" {
		t.Errorf("file = %q", file)
	}
	if len(phrases) != 1 || phrases[0].Text != "Привет, всем." || phrases[0].Start != 0.5 || phrases[0].End != 1.5 {
		t.Fatalf("phrases = %+v, want one cleaned phrase", phrases)
	}
}

func TestTranscribeErrors(t *testing.T) {
	status := http.StatusServiceUnavailable
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		io.WriteString(w, "recognized secret text")
	}))
	c := New(srv.URL, "m", "")

	if _, err := c.Transcribe(context.Background(), strings.NewReader("a"), "s.ogg"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("503: err = %v, want ErrUnavailable", err)
	}
	status = http.StatusUnsupportedMediaType
	_, err := c.Transcribe(context.Background(), strings.NewReader("a"), "s.ogg")
	if err == nil || errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "secret") {
		t.Errorf("415: err = %v, want a plain error without the body", err)
	}

	srv.Close() // nothing listens any more
	if _, err := c.Transcribe(context.Background(), strings.NewReader("a"), "s.ogg"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("closed server: err = %v, want ErrUnavailable", err)
	}
}

func TestModelNotInstalledYetIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"detail":"Model 'm' is not installed locally."}`)
	}))
	defer srv.Close()
	_, err := New(srv.URL, "m", "").Transcribe(context.Background(), strings.NewReader("a"), "s.ogg")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable while the model downloads", err)
	}
}

// A service that dies on a file must not be retried forever as
// "unavailable": the error counts as a failed attempt.
func TestConnectionDroppedMidRequestIsAnAttempt(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	}))
	defer srv.Close()
	_, err := New(srv.URL, "m", "").Transcribe(context.Background(), strings.NewReader("a"), "s.ogg")
	if err == nil || errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want a plain error", err)
	}
}

func TestNewWithoutURLIsDisabled(t *testing.T) {
	if New("  ", "m", "ru") != nil {
		t.Fatal("empty URL must disable transcription")
	}
}

func TestClean(t *testing.T) {
	cases := map[string]string{
		"Субтитры сделал DimaTorzok":            "",
		"Итак. Продолжение следует...":          "Итак.",
		"Редактор субтитров А.Синецкая\nДальше": "Дальше",
		"  обычная   речь ":                     "обычная речь",
	}
	for in, want := range cases {
		if got := Clean(in); got != want {
			t.Errorf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
}
