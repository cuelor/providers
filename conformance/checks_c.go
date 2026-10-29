package conformance

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Limits of C1 (spec/v1.md sections 3.7.2 and the conformance section).
const (
	maxCharacterErrorRate = 0.30
	unitEndToleranceMS    = 60
)

// transcriptionCase returns the case C1 and C2 run. Without one they fail as not run.
func (r *runner) transcriptionCase(c *checkCtx) *testCase {
	plan := r.livePrelude(c)
	tc := plan.transcription
	if tc == nil {
		if m, ok := plan.missingFor("transcription"); ok {
			c.notRunf("%s", m.detail())
		}
		c.fatal("no transcription model")
	}
	c.note("jobs for %s, from %s", tc.label(), tc.source)
	return tc
}

// timestampsRank orders the values of the `timestamps` parameter (spec/v1.md section 3.7.1), finest first.
var timestampsRank = []string{"word", "segment", "none"}

// timestampsFor returns the finest `timestamps` value the catalog allows for the case's model, in the
// order word, segment, none. Without `enum_values` the parameter allows all three, so it is word. It
// returns "" when the route has no such parameter (nothing is sent; the specification's default, word,
// applies) or when `enum_values` lists no known value (nothing is sent either).
func timestampsFor(tc *testCase) string {
	if !tc.route.hasParam("timestamps") {
		return ""
	}
	p := tc.model.param("timestamps")
	if p == nil || len(p.EnumValues) == 0 {
		return "word"
	}
	allowed := map[string]bool{}
	for _, raw := range p.EnumValues {
		var v string
		if json.Unmarshal(raw, &v) == nil {
			allowed[v] = true
		}
	}
	for _, v := range timestampsRank {
		if allowed[v] {
			return v
		}
	}
	return ""
}

// timestampsNote describes the choice for a check's notes.
func timestampsNote(tc *testCase) string {
	switch ts := timestampsFor(tc); {
	case !tc.route.hasParam("timestamps"):
		return "the route has no timestamps parameter; checked as timestamps=word, the default"
	case ts == "":
		return "timestamps was not sent: the catalog lists none of none, segment, word"
	default:
		return fmt.Sprintf("timestamps=%s (the finest the catalog allows)", ts)
	}
}

// granularity is the timestamps value a transcript is checked against.
func granularity(tc *testCase) string {
	if ts := timestampsFor(tc); ts != "" {
		return ts
	}
	return "word"
}

// transcribe uploads a sample, runs audio2text on it and returns the transcript. language "" leaves
// the parameter out; "auto" asks for detection.
func (r *runner) transcribe(c *checkCtx, tc *testCase, sample speechSample, language string) *transcript {
	req := r.buildRequest(c, tc, sample.data)
	if tc.route.hasParam("language") {
		if language != "" {
			req.Parameters["language"] = language
		}
	} else if language != "" && language != "auto" {
		c.note("the route has no language parameter; the sample's language was not passed")
	}
	if ts := timestampsFor(tc); ts != "" {
		req.Parameters["timestamps"] = ts
	}
	label := fmt.Sprintf("%s sample", sample.Language)
	resp, err := r.submitJob(newKey("c-"+sample.Language), req)
	if err != nil {
		c.fatal("%s: submitting: %v", label, err)
	}
	first := r.decodeJob(c, label+": POST /v1/jobs", resp)
	if first == nil {
		panic(checkAbort{})
	}
	obs := []observation{{*first, "submit"}}
	final := r.poll(c, first.ID, &obs, nil)
	if final == nil {
		panic(checkAbort{})
	}
	data := r.verifyOutputs(c, label, tc, final)
	if data == nil {
		panic(checkAbort{})
	}
	var t transcript
	if err := json.Unmarshal(data, &t); err != nil {
		c.fatal("%s: the transcript: %v", label, err)
	}
	return &t
}

// transcriptIssues checks the C1 rules against a sample. The timing rules depend on the requested
// timestamps value: word checks the units, segment checks the segments' times where they are given,
// none checks no timing.
func transcriptIssues(c *checkCtx, label string, t *transcript, sample speechSample, timestamps string) {
	if t.SchemaVersion != 1 {
		c.fail("%s: schema_version is %d, expected 1", label, t.SchemaVersion)
	}
	if primaryLanguage(t.Language) != sample.Language {
		c.fail("%s: language is %q, the sample is %s", label, t.Language, sample.Language)
	}
	if t.Unit == "" {
		c.fail("%s: unit is not set", label)
	}
	var timing []string
	switch timestamps {
	case "word":
		timing = unitIssues(t, sample.DurationMS)
	case "segment":
		timing = segmentIssues(t, sample.DurationMS)
	}
	for _, issue := range timing {
		c.fail("%s: %s", label, issue)
	}
	cer := characterErrorRate(sample.Text, t.Text)
	if cer >= maxCharacterErrorRate {
		c.fail("%s: the character error rate against the known text is %.0f%% (limit %.0f%%); got %q", label, cer*100, maxCharacterErrorRate*100, t.Text)
	} else {
		c.note("%s: character error rate %.0f%%, unit %s", label, cer*100, t.Unit)
	}
}

// segmentIssues checks the times of the segments that give them (they are optional in the format):
// ordered, not overlapping, start <= end, and ending no more than 60 ms after the audio. It does not
// ask for timed_text_units.
func segmentIssues(t *transcript, durationMS int64) []string {
	var out []string
	var prevEnd int64 = -1
	for si, seg := range t.Segments {
		if seg.StartMS == nil || seg.EndMS == nil {
			continue
		}
		start, end := *seg.StartMS, *seg.EndMS
		where := fmt.Sprintf("segments[%d]", si)
		if start > end {
			out = append(out, fmt.Sprintf("%s starts at %d ms after it ends at %d ms", where, start, end))
		}
		if prevEnd >= 0 && start < prevEnd {
			out = append(out, fmt.Sprintf("%s starts at %d ms, before the previous segment ends at %d ms", where, start, prevEnd))
		}
		if end > durationMS+unitEndToleranceMS {
			out = append(out, fmt.Sprintf("%s ends at %d ms; the audio is %d ms long", where, end, durationMS))
		}
		if end > prevEnd {
			prevEnd = end
		}
	}
	if len(out) > 5 {
		out = append(out[:5], fmt.Sprintf("and %d more problems", len(out)-5))
	}
	return out
}

// unitIssues checks timed_text_units: ordered, not overlapping, start <= end, and ending no more
// than 60 ms after the audio.
func unitIssues(t *transcript, durationMS int64) []string {
	var out []string
	var prevEnd int64 = -1
	count := 0
	for si, seg := range t.Segments {
		for ui, u := range seg.Units {
			count++
			where := fmt.Sprintf("segments[%d].timed_text_units[%d] (%q)", si, ui, u.Text)
			if u.StartMS > u.EndMS {
				out = append(out, fmt.Sprintf("%s starts at %d ms after it ends at %d ms", where, u.StartMS, u.EndMS))
			}
			if prevEnd >= 0 && u.StartMS < prevEnd {
				out = append(out, fmt.Sprintf("%s starts at %d ms, before the previous unit ends at %d ms", where, u.StartMS, prevEnd))
			}
			if u.EndMS > durationMS+unitEndToleranceMS {
				out = append(out, fmt.Sprintf("%s ends at %d ms; the audio is %d ms long", where, u.EndMS, durationMS))
			}
			if u.EndMS > prevEnd {
				prevEnd = u.EndMS
			}
		}
	}
	if count == 0 {
		out = append(out, "no timed_text_units, although timestamps=word was requested")
	}
	if len(out) > 5 {
		out = append(out[:5], fmt.Sprintf("and %d more problems", len(out)-5))
	}
	return out
}

// C1: transcribing the Chinese and English samples with the finest timestamps the catalog allows:
// schema_version 1, the sample's language, unit set, the timing of that granularity (units for word,
// segments for segment, none for none) ordered, not overlapping and inside the audio, character error
// rate below 30 %. A granularity other than word adds a warning.
func checkC1(r *runner, c *checkCtx) {
	tc := r.transcriptionCase(c)
	c.note("%s", timestampsNote(tc))
	if granularity(tc) != "word" {
		c.warn("the Cuelor app requires timestamps=word for per-take transcription (spec/v1.md section 3.7.1)")
	}
	samples, err := loadSpeechSamples()
	if err != nil {
		c.fatal("loading the samples: %v", err)
	}
	for _, s := range samples {
		func() {
			defer func() {
				if e := recover(); e != nil {
					if _, ok := e.(checkAbort); !ok {
						panic(e)
					}
				}
			}()
			t := r.transcribe(c, tc, s, s.Language)
			transcriptIssues(c, s.Language+" sample", t, s, granularity(tc))
		}()
	}
}

// C2: with language=auto the English sample is reported as en.
func checkC2(r *runner, c *checkCtx) {
	tc := r.transcriptionCase(c)
	c.note("%s", timestampsNote(tc))
	s := speechSampleFor("en")
	t := r.transcribe(c, tc, s, "auto")
	if primaryLanguage(t.Language) != "en" {
		c.fail("with language=auto the English sample was reported as %q", t.Language)
	} else {
		c.note("detected %s; text %q", t.Language, strings.TrimSpace(t.Text))
	}
}
