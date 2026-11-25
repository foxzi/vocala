package transcription

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/foxzi/vocala/internal/recording"
)

// mergeGap joins consecutive phrases of one speaker closer than this into
// one line: Whisper splits speech at short pauses.
const mergeGap = 2 * time.Second

// Line is a phrase placed on the recording's timeline.
type Line struct {
	At      time.Duration // from the start of the recording
	End     time.Duration
	Speaker string
	Text    string
}

// Render lays out the phrases of all participants in time order as
// Markdown:
//
//	[00:01:23] Ivan: …
func Render(r recording.Recording, lines []Line) string {
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].At < lines[j].At })
	merged := make([]Line, 0, len(lines))
	for _, l := range lines {
		if n := len(merged); n > 0 && merged[n-1].Speaker == l.Speaker && l.At-merged[n-1].End < mergeGap {
			merged[n-1].Text += " " + l.Text
			merged[n-1].End = max(merged[n-1].End, l.End)
			continue
		}
		merged = append(merged, l)
	}

	var b strings.Builder
	started := time.UnixMilli(r.StartedAt)
	// With the zone: the server's (UTC in Docker) may not be the reader's.
	fmt.Fprintf(&b, "# Transcript, %s\n\n", started.Format("2006-01-02 15:04 MST"))
	if r.EndedAt > r.StartedAt {
		fmt.Fprintf(&b, "Duration: %s. ", clock(time.Duration(r.EndedAt-r.StartedAt)*time.Millisecond))
	}
	fmt.Fprintf(&b, "Participants: %s.\n\n", strings.Join(speakers(r), ", "))
	if len(merged) == 0 {
		b.WriteString("_No speech was recognized._\n")
		return b.String()
	}
	for _, l := range merged {
		fmt.Fprintf(&b, "[%s] %s: %s\n\n", clock(l.At), l.Speaker, l.Text)
	}
	return b.String()
}

func speakers(r recording.Recording) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range r.Segments {
		if !seen[s.Name] {
			seen[s.Name] = true
			out = append(out, s.Name)
		}
	}
	return out
}

func clock(d time.Duration) string {
	s := int(d / time.Second)
	return fmt.Sprintf("%02d:%02d:%02d", s/3600, s/60%60, s%60)
}
