package conformance

import (
	"encoding/json"
	"strings"
	"testing"
)

const appWordWarning = "warning: the Cuelor app requires timestamps=word for per-take transcription (spec/v1.md section 3.7.1)"

// C1 and C2 ask for the finest timestamps value the catalog allows. The test provider refuses a value
// its catalog does not list, so a run that passes also shows what was sent.
func TestTimestampsGranularity(t *testing.T) {
	cases := []struct {
		name  string
		modes []string
		want  string
		warn  bool
	}{
		{"all three values", nil, "word", false},
		{"only none", []string{"asr-timestamps-none"}, "none", true},
		{"only segment", []string{"asr-timestamps-segment"}, "segment", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			forms(t, tc.modes, func(t *testing.T, opts Options, command bool) {
				opts.Only = []string{"C1", "C2"}
				report := run(t, opts)
				// A warning does not fail a run.
				c1Status := StatusPassed
				if tc.warn {
					c1Status = StatusWarning
				}
				expectStatus(t, report, c1Status, "C1")
				expectStatus(t, report, StatusPassed, "C2")
				note := "note: timestamps=" + tc.want + " (the finest the catalog allows)"
				for _, id := range []string{"C1", "C2"} {
					if d := result(t, report, id).Detail; !strings.Contains(d, note) {
						t.Errorf("%s: no %q in %s", id, note, d)
					}
				}
				c1, c2 := result(t, report, "C1").Detail, result(t, report, "C2").Detail
				if got := strings.Contains(c1, appWordWarning); got != tc.warn {
					t.Errorf("C1 warning present = %v, want %v: %s", got, tc.warn, c1)
				}
				if strings.Contains(c2, "warning:") {
					t.Errorf("C2 has a warning: %s", c2)
				}
			})
		})
	}
}

// The timing rules are those of the requested granularity: segments are checked for segment, and
// nothing for none.
func TestTimestampsChecksFollowGranularity(t *testing.T) {
	forms(t, []string{"asr-timestamps-segment", "overlapping-segments"}, func(t *testing.T, opts Options, command bool) {
		opts.Only = []string{"C1"}
		res := result(t, run(t, opts), "C1")
		if res.Status != StatusFailed || !strings.Contains(res.Detail, "before the previous segment ends") {
			t.Errorf("overlapping segments: %s %s", res.Status, res.Detail)
		}
	})
	// Overlapping units are not looked at when units were not requested.
	forms(t, []string{"asr-timestamps-none", "overlapping-units"}, func(t *testing.T, opts Options, command bool) {
		opts.Only = []string{"C1"}
		expectStatus(t, run(t, opts), StatusWarning, "C1")
	})
	// Language, text and the rest are still checked.
	forms(t, []string{"asr-timestamps-none", "garbled-transcript"}, func(t *testing.T, opts Options, command bool) {
		opts.Only = []string{"C1"}
		res := result(t, run(t, opts), "C1")
		if res.Status != StatusFailed || !strings.Contains(res.Detail, "character error rate") {
			t.Errorf("garbled transcript: %s %s", res.Status, res.Detail)
		}
	})
}

func TestTimestampsFor(t *testing.T) {
	pick := func(routeHas bool, param string) string {
		t.Helper()
		var m model
		if param != "" {
			var p parameter
			if err := json.Unmarshal([]byte(param), &p); err != nil {
				t.Fatal(err)
			}
			m.Parameters = []parameter{p}
		}
		tc := &testCase{model: &m, route: &route{}}
		if routeHas {
			tc.route.ParameterNames = []string{"timestamps"}
		}
		return timestampsFor(tc)
	}
	for _, c := range []struct {
		routeHas bool
		param    string
		want     string
	}{
		{false, `{"name":"timestamps","kind":"enum","enum_values":["word"]}`, ""},
		{true, ``, "word"},
		{true, `{"name":"timestamps","kind":"enum"}`, "word"},
		{true, `{"name":"timestamps","kind":"enum","enum_values":["none","segment","word"]}`, "word"},
		{true, `{"name":"timestamps","kind":"enum","enum_values":["none","segment"]}`, "segment"},
		{true, `{"name":"timestamps","kind":"enum","enum_values":["none"]}`, "none"},
		{true, `{"name":"timestamps","kind":"enum","enum_values":["frames"]}`, ""},
	} {
		if got := pick(c.routeHas, c.param); got != c.want {
			t.Errorf("route has %v, %s: %q, want %q", c.routeHas, c.param, got, c.want)
		}
	}
}

func TestSegmentIssues(t *testing.T) {
	var tr transcript
	doc := `{"segments":[{"text":"a"},{"text":"b","start_ms":0,"end_ms":500},{"text":"c","start_ms":400,"end_ms":900},{"text":"d","start_ms":950,"end_ms":1100}]}`
	if err := json.Unmarshal([]byte(doc), &tr); err != nil {
		t.Fatal(err)
	}
	// Segments without times are fine; c overlaps b, and d ends 100 ms after a 1000 ms audio.
	if got := segmentIssues(&tr, 1000); len(got) != 2 {
		t.Errorf("issues: %v", got)
	}
	if got := segmentIssues(&tr, 1100); len(got) != 1 {
		t.Errorf("issues: %v", got)
	}
}
