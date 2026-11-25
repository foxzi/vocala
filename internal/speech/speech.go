// Package speech is a client of a self-hosted, OpenAI-compatible speech
// recognition service (speaches with faster-whisper, the same setup as the
// platform's ADR-0041). Audio never leaves the server's network, and the
// package does not log audio or text — only the fact of a failure.
package speech

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/foxzi/vocala/internal/logger"
)

const (
	// prepareTimeout covers downloading the model (1.5 GB for medium) on
	// the service's first start.
	prepareTimeout = 30 * time.Minute
	// prepareRetry — the service may come up after Vocala.
	prepareRetry = 30 * time.Second
)

// ErrUnavailable wraps failures to reach the service at all, as opposed to
// the service rejecting a file. Callers retry the former without counting
// it as a failed attempt.
var ErrUnavailable = errors.New("speech: service unavailable")

// Client talks to POST /v1/audio/transcriptions.
type Client struct {
	base     string
	model    string
	language string
	http     *http.Client
	ready    chan struct{} // closed once Prepare succeeded
}

// New returns a client for the service at base, or nil when base is empty:
// transcription is off, which is a normal configuration.
func New(base, model, language string) *Client {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return nil
	}
	return &Client{base: base, model: model, language: language, http: &http.Client{}, ready: make(chan struct{})}
}

// Phrase is one recognized piece of speech; Start and End are seconds from
// the start of the file.
type Phrase struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// Transcribe recognizes speech in audio. filename only carries the
// extension the service uses to pick a decoder ("segment.webm"). Phrases
// Whisper invents on silence are removed.
func (c *Client) Transcribe(ctx context.Context, audio io.Reader, filename string) ([]Phrase, error) {
	// The file is streamed: a four-hour track is tens of megabytes.
	pr, pw := io.Pipe()
	form := multipart.NewWriter(pw)
	go func() { pw.CloseWithError(c.writeForm(form, audio, filename)) }()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/v1/audio/transcriptions", pr)
	if err != nil {
		pr.Close()
		return nil, err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := c.http.Do(req)
	if err != nil {
		pr.CloseWithError(err)
		if couldNotConnect(err) {
			return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		// The request may have reached the service and broken it (a crash
		// on a long file): that counts as a failed attempt.
		return nil, err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusBadGateway || resp.StatusCode == http.StatusServiceUnavailable:
		return nil, fmt.Errorf("%w: status %d", ErrUnavailable, resp.StatusCode)
	case resp.StatusCode == http.StatusNotFound && modelMissing(resp.Body):
		// speaches answers 404 "Model ... is not installed locally" while
		// Prepare is still downloading it.
		return nil, fmt.Errorf("%w: model %s is not installed yet", ErrUnavailable, c.model)
	case resp.StatusCode != http.StatusOK:
		// The body is not repeated: it may quote recognized text.
		return nil, fmt.Errorf("speech: service answered %d", resp.StatusCode)
	}
	var out struct {
		Segments []Phrase `json:"segments"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("speech: decode answer: %w", err)
	}
	phrases := out.Segments[:0]
	for _, p := range out.Segments {
		if p.Text = Clean(p.Text); p.Text != "" {
			phrases = append(phrases, p)
		}
	}
	return phrases, nil
}

func (c *Client) writeForm(form *multipart.Writer, audio io.Reader, filename string) error {
	file, err := form.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	if _, err := io.Copy(file, audio); err != nil {
		return err
	}
	fields := [][2]string{
		{"model", c.model},
		{"response_format", "verbose_json"},
		{"timestamp_granularities[]", "segment"},
		// speaches defaults to VAD on; explicit, since it is what makes
		// long silences in per-speaker tracks cheap.
		{"vad_filter", "true"},
	}
	if c.language != "" {
		fields = append(fields, [2]string{"language", c.language})
	}
	for _, f := range fields {
		if err := form.WriteField(f[0], f[1]); err != nil {
			return err
		}
	}
	return form.Close()
}

// couldNotConnect reports errors where the request never reached the
// service: it is not up (yet), being redeployed, or not resolvable.
func couldNotConnect(err error) bool {
	var opErr *net.OpError
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr) || (errors.As(err, &opErr) && opErr.Op == "dial")
}

func modelMissing(body io.Reader) bool {
	b, _ := io.ReadAll(io.LimitReader(body, 4096))
	return bytes.Contains(b, []byte("not installed"))
}

// Prepare asks the service to download the model and keep it loaded, so
// the first recording does not wait for either. It retries until the
// service answers or ctx ends.
func (c *Client) Prepare(ctx context.Context) {
	for {
		err := c.prepare(ctx)
		if err == nil {
			logger.Info("speech: model %s is ready", c.model)
			close(c.ready)
			return
		}
		logger.Warn("speech: model %s not prepared yet: %v", c.model, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(prepareRetry):
		}
	}
}

// Ready is closed once the model is downloaded and loaded.
func (c *Client) Ready() <-chan struct{} {
	return c.ready
}

func (c *Client) prepare(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, prepareTimeout)
	defer cancel()
	// speaches routes {model_id:path}: the slash in the model id stays.
	// Download: 200 — downloaded now, 201 — already there.
	// Load: 201 — loaded, 409 — already loaded.
	steps := []struct {
		path string
		ok   []int
	}{
		{"/v1/models/" + c.model, []int{http.StatusOK, http.StatusCreated}},
		{"/api/ps/" + c.model, []int{http.StatusCreated, http.StatusConflict}},
	}
	for _, step := range steps {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+step.path, nil)
		if err != nil {
			return err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		good := false
		for _, code := range step.ok {
			good = good || resp.StatusCode == code
		}
		if !good {
			return fmt.Errorf("%s: status %d", step.path, resp.StatusCode)
		}
	}
	return nil
}

// hallucinations are phrases Whisper makes up on silence and noise: it was
// trained on video subtitles, and their tails surface where nobody speaks.
// The subtitle credits are cut to the end of the line, since they continue
// with names whose initials contain dots.
var hallucinations = []*regexp.Regexp{
	regexp.MustCompile(`(?i)продолжение следует\.*`),
	regexp.MustCompile(`(?i)субтитры (сделал|сделала|создавал|создавала|подготовил|подготовила|делал|делала)[^\n]*`),
	regexp.MustCompile(`(?i)редактор субтитров[^\n]*`),
	regexp.MustCompile(`(?i)спасибо за просмотр[.!]*`),
	regexp.MustCompile(`(?i)подписывайтесь на (наш )?канал[.!]*`),
	regexp.MustCompile(`(?i)dimatorzok`),
	regexp.MustCompile(`(?i)subtitles by the amara\.org community[.!]*`),
}

// wholeHallucinations are dropped only when they are the whole phrase:
// people do say "thanks for watching the demo" in a call. A bare
// "Thank you." is left alone, it is said for real far too often.
var wholeHallucinations = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^(thank you|thanks)( (so|very) much)? for watching[.!]*$`),
	regexp.MustCompile(`(?i)^(please )?(like and )?subscribe( to (my|our|the) channel)?[.!]*$`),
	regexp.MustCompile(`(?i)^see you in the next (video|one)[.!]*$`),
}

// Clean removes hallucinations and extra whitespace.
func Clean(text string) string {
	for _, pattern := range hallucinations {
		text = pattern.ReplaceAllString(text, " ")
	}
	text = strings.Join(strings.Fields(text), " ")
	for _, pattern := range wholeHallucinations {
		if pattern.MatchString(text) {
			return ""
		}
	}
	return text
}
