package conformance

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// forms runs a test against the test provider in the URL form and in the command form.
func forms(t *testing.T, faults []string, test func(t *testing.T, opts Options, command bool)) {
	t.Run("url", func(t *testing.T) { test(t, urlOptions(t, faults...), false) })
	t.Run("command", func(t *testing.T) { test(t, commandOptions(t, faults...), true) })
}

// failures returns the failure lines of a detail, without its notes and warnings.
func failures(detail string) []string {
	out := []string{}
	for _, line := range strings.Split(detail, "\n") {
		if line != "" && !strings.HasPrefix(line, "note: ") && !strings.HasPrefix(line, "warning: ") {
			out = append(out, line)
		}
	}
	return out
}

// expectStatus checks the status of some checks, and that none of them is marked not run.
func expectStatus(t *testing.T, report *Report, want Status, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if res := result(t, report, id); res.Status != want || res.NotRun {
			t.Errorf("%s: %s not_run=%v, want %s (%s)", id, res.Status, res.NotRun, want, res.Detail)
		}
	}
}

// expectOnlyFailure checks that a check failed, ran, and failed for one reason only.
func expectOnlyFailure(t *testing.T, report *Report, id string, want ...string) {
	t.Helper()
	res := result(t, report, id)
	lines := failures(res.Detail)
	if res.Status != StatusFailed || res.NotRun || len(lines) != 1 {
		t.Errorf("%s: %s not_run=%v with failures %q, want one failure", id, res.Status, res.NotRun, lines)
		return
	}
	for _, w := range want {
		if !strings.Contains(lines[0], w) {
			t.Errorf("%s: the failure %q does not mention %q", id, lines[0], w)
		}
	}
}

// expectNotRun checks that a check failed as not run, for the given reason.
func expectNotRun(t *testing.T, report *Report, id string, want ...string) {
	t.Helper()
	res := result(t, report, id)
	if res.Status != StatusFailed || !res.NotRun || !strings.HasPrefix(res.Detail, "not run: ") {
		t.Errorf("%s: %s not_run=%v (%s), want failed and not run", id, res.Status, res.NotRun, res.Detail)
		return
	}
	for _, w := range want {
		if !strings.Contains(res.Detail, w) {
			t.Errorf("%s: the detail %q does not mention %q", id, res.Detail, w)
		}
	}
}

// A declared capability without a usable model fails only the checks that would have tested it.
// The service here declares image, video and transcription, and only image has a model.
func TestMissingCapabilityFailsOnlyItsChecks(t *testing.T) {
	forms(t, []string{"declare-video", "asr-unavailable"}, func(t *testing.T, opts Options, command bool) {
		report := run(t, opts)
		if report.OK() {
			t.Fatalf("a run with untested capabilities must fail:\n%s", describe(report))
		}
		expectStatus(t, report, StatusPassed, "A1", "A2", "A4", "A5", "A6", "A7", "A8", "A9", "B1", "B2", "B3", "B8", "B9", "B11")
		if command {
			expectStatus(t, report, StatusPassed, "A3", "B6", "B7")
		}
		if a6 := result(t, report, "A6"); strings.Contains(a6.Detail, "was not made") {
			t.Errorf("A6 left out its valid submission: %s", a6.Detail)
		}
		if b1 := result(t, report, "B1"); !strings.Contains(b1.Detail, "job for image (test/image, text2image), from the first suitable model in the catalog") {
			t.Errorf("B1 does not say which case ran: %s", b1.Detail)
		}
		for _, id := range []string{"B4", "B5", "B10"} {
			expectOnlyFailure(t, report, id, "video: no test case: no available model for video", "no job was submitted for video")
		}
		for _, id := range []string{"C1", "C2"} {
			expectNotRun(t, report, id, "transcription: no test case: no available model for transcription", "no job was submitted for transcription")
		}
	})
}

// The budget counts only the capabilities that have a test case.
func TestBudgetCountsOnlyTestedCapabilities(t *testing.T) {
	limit := 100.0
	for faults, want := range map[string]string{
		"expensive": "estimated cost of the live run: 4 USD",
		"expensive declare-video asr-unavailable": "estimated cost of the live run: 1 USD",
	} {
		t.Run(faults, func(t *testing.T) {
			opts, provider := urlServer(t, strings.Fields(faults)...)
			opts.MaxCost = &limit
			opts.Only = []string{"B1", "C1", "C2"}
			report := run(t, opts)
			if b1 := result(t, report, "B1"); b1.Status != StatusPassed || !strings.Contains(b1.Detail, want) {
				t.Errorf("B1: %s (%s), want a note %q", b1.Status, b1.Detail, want)
			}
			for _, m := range provider.JobModels() {
				if m != "test/image" && strings.Contains(faults, "asr-unavailable") {
					t.Errorf("a job for %s was submitted", m)
				}
			}
		})
	}
}

// When the first capability has no test case the next one runs the B checks. When none has one, the
// whole live run fails as not run, as before.
func TestPrimaryCaseMovesToTheNextCapability(t *testing.T) {
	t.Run("video declared first", func(t *testing.T) {
		opts := urlOptions(t, "declare-video-first")
		report := run(t, opts)
		expectStatus(t, report, StatusPassed, "B1", "B2", "B3", "B8", "B9", "B11", "C1", "C2")
		if b1 := result(t, report, "B1"); !strings.Contains(b1.Detail, "job for image (test/image, text2image)") {
			t.Errorf("B1 does not run image: %s", b1.Detail)
		}
		for _, id := range []string{"B4", "B5", "B10"} {
			expectOnlyFailure(t, report, id, "video: no test case", "no job was submitted for video")
		}
	})
	t.Run("transcription takes over", func(t *testing.T) {
		report := run(t, urlOptions(t, "image-unavailable"))
		expectStatus(t, report, StatusPassed, "A6", "B1", "B2", "B3", "B8", "B9", "B11", "C1", "C2")
		if b1 := result(t, report, "B1"); !strings.Contains(b1.Detail, "job for transcription (test/asr, audio2text)") {
			t.Errorf("B1 does not run transcription: %s", b1.Detail)
		}
		for _, id := range []string{"B4", "B5", "B10"} {
			expectOnlyFailure(t, report, id, "image: no test case: no available model for image", "no job was submitted for image")
		}
	})
	t.Run("no capability has a case", func(t *testing.T) {
		opts, provider := urlServer(t, "image-unavailable", "asr-unavailable")
		report := run(t, opts)
		for _, res := range report.Checks {
			if res.ID[0] != 'B' && res.ID[0] != 'C' || res.Status == StatusSkipped {
				continue
			}
			expectNotRun(t, report, res.ID, "no declared capability has a test case", "image: no available model", "transcription: no available model", "no job was submitted")
		}
		if n := provider.JobCount(); n != 0 {
			t.Errorf("%d jobs were submitted, want none", n)
		}
	})
}

// writeManifest writes a manifest for the test provider with the given test entries.
func writeManifest(t *testing.T, test map[string]testEntry) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{
		"manifest_version": 1, "id": "example.test", "name": "Test Provider", "version": "1.0.0", "protocol": "1.0",
		"runtime": map[string]any{"kind": "exec", "command": []string{exe, "testprovider"}},
		"test":    test,
	})
	path := filepath.Join(t.TempDir(), "cuelor-provider.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A manifest test entry that names a missing or unavailable model fails only its capability.
func TestManifestTestEntryFailsOnlyItsCapability(t *testing.T) {
	cases := []struct {
		name   string
		faults []string
		test   map[string]testEntry
		check  func(t *testing.T, report *Report)
	}{
		{"transcription model not in the catalog", nil,
			map[string]testEntry{"transcription": {Model: "test/missing", Route: "audio2text", Parameters: map[string]any{}}},
			func(t *testing.T, report *Report) {
				expectStatus(t, report, StatusPassed, "B1", "B4", "B5", "B10")
				for _, id := range []string{"C1", "C2"} {
					expectNotRun(t, report, id, `the manifest's test.transcription names model "test/missing", which is not in the catalog`)
				}
			}},
		{"image model unavailable", []string{"image-unavailable"},
			map[string]testEntry{"image": {Model: "test/image", Route: "text2image", Parameters: map[string]any{}}},
			func(t *testing.T, report *Report) {
				expectStatus(t, report, StatusPassed, "B1", "C1", "C2")
				for _, id := range []string{"B4", "B5", "B10"} {
					expectOnlyFailure(t, report, id, `the manifest's test.image model "test/image" is not available`)
				}
			}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			forms(t, tc.faults, func(t *testing.T, opts Options, command bool) {
				opts.Manifest = writeManifest(t, tc.test)
				opts.Only = []string{"A1", "B1", "B4", "B5", "B10", "C1", "C2"}
				report := run(t, opts)
				expectStatus(t, report, StatusPassed, "A1")
				tc.check(t, report)
			})
		})
	}
}

// --model chooses the case of a capability, in both forms, before the manifest.
func TestModelOption(t *testing.T) {
	cases := []struct {
		name   string
		faults []string
		models map[string]string
		check  func(t *testing.T, report *Report)
	}{
		{"model only", nil, map[string]string{"image": "test/image"}, func(t *testing.T, report *Report) {
			expectB1Case(t, report, "image (test/image, text2image), from --model image")
		}},
		{"model and route", nil, map[string]string{"image": "test/image:image2image"}, func(t *testing.T, report *Report) {
			expectB1Case(t, report, "image (test/image, image2image), from --model image")
		}},
		{"id with a colon", []string{"free-image"}, map[string]string{"image": "test/image:free"}, func(t *testing.T, report *Report) {
			expectB1Case(t, report, "image (test/image:free, text2image), from --model image")
		}},
		{"id with a colon and a route", []string{"free-image"}, map[string]string{"image": "test/image:free:image2image"}, func(t *testing.T, report *Report) {
			expectB1Case(t, report, "image (test/image:free, image2image), from --model image")
		}},
		{"transcription", nil, map[string]string{"transcription": "test/asr"}, func(t *testing.T, report *Report) {
			expectStatus(t, report, StatusPassed, "C1", "C2")
			if c1 := result(t, report, "C1"); !strings.Contains(c1.Detail, "jobs for transcription (test/asr, audio2text), from --model transcription") {
				t.Errorf("C1 does not say where its case came from: %s", c1.Detail)
			}
		}},
		{"model unavailable", []string{"asr-unavailable"}, map[string]string{"transcription": "test/asr"}, func(t *testing.T, report *Report) {
			expectStatus(t, report, StatusPassed, "B1", "B4", "B5", "B10")
			for _, id := range []string{"C1", "C2"} {
				expectNotRun(t, report, id, `--model transcription=test/asr: model "test/asr" is not available`)
			}
		}},
		{"model not in the catalog", nil, map[string]string{"image": "vendor/none"}, func(t *testing.T, report *Report) {
			expectMissingImage(t, report, `--model image=vendor/none: model "vendor/none" is not in the catalog`)
		}},
		{"route the model does not have", nil, map[string]string{"image": "test/image:text2video"}, func(t *testing.T, report *Report) {
			expectMissingImage(t, report, `--model image=test/image:text2video: model "test/image" has no route "text2video"`)
		}},
		{"route of another capability", nil, map[string]string{"image": "test/asr:audio2text"}, func(t *testing.T, report *Report) {
			expectMissingImage(t, report, `--model image=test/asr:audio2text: route "audio2text" of model "test/asr" is not for image`)
		}},
		{"undeclared capability", nil, map[string]string{"vidoe": "test/image"}, func(t *testing.T, report *Report) {
			expectOnlyFailure(t, report, "A1", "--model vidoe=test/image names a capability the service does not declare", "declares image, transcription")
			expectStatus(t, report, StatusPassed, "B1", "B4", "B5", "B10", "C1", "C2")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			forms(t, tc.faults, func(t *testing.T, opts Options, command bool) {
				opts.Models = tc.models
				opts.Only = []string{"A1", "A6", "B1", "B4", "B5", "B10", "C1", "C2"}
				tc.check(t, run(t, opts))
			})
		})
	}
}

func expectB1Case(t *testing.T, report *Report, want string) {
	t.Helper()
	expectStatus(t, report, StatusPassed, "A6", "B1", "B4", "B5", "B10")
	if b1 := result(t, report, "B1"); !strings.Contains(b1.Detail, "job for "+want) {
		t.Errorf("B1: %s, want a note %q", b1.Detail, "job for "+want)
	}
}

// expectMissingImage checks a run whose image case could not be found: transcription runs the B
// checks instead, and B4, B5 and B10 fail for image.
func expectMissingImage(t *testing.T, report *Report, want string) {
	t.Helper()
	expectStatus(t, report, StatusPassed, "B1", "C1", "C2")
	for _, id := range []string{"B4", "B5", "B10"} {
		expectOnlyFailure(t, report, id, "image: no test case: "+want, "no job was submitted for image")
	}
}

// --model comes before the manifest's test entry and is sent without its parameters.
func TestModelOptionComesBeforeTheManifest(t *testing.T) {
	r := &runner{
		cat: &catalog{},
		manifest: &manifest{Test: map[string]testEntry{
			"image": {Model: "test/image", Route: "text2image", Parameters: map[string]any{"ratio": "16:9"}},
		}},
	}
	if err := json.Unmarshal([]byte(`{"models":[
		{"id":"test/image","available":true,"output":{"modality":"image"},"routes":[
			{"id":"text2image","input":{"slots":[]}},
			{"id":"image2image","input":{"slots":[{"id":"r","role":"reference","modality":"image","min_artifacts":1,"max_artifacts":1,"media_types":["image/png"]}]}}]},
		{"id":"vendor/clip:free","available":true,"output":{"modality":"video"},"routes":[{"id":"text2video","input":{"slots":[]}}]},
		{"id":"vendor/clip","available":true,"output":{"modality":"video"},"routes":[{"id":"free","input":{"slots":[]}}]}]}`), r.cat); err != nil {
		t.Fatal(err)
	}
	tc, err := r.findCase("image")
	if err != nil || tc.source != "the manifest's test.image" || tc.params["ratio"] != "16:9" {
		t.Fatalf("without --model: %+v %v", tc, err)
	}
	r.opts.Models = map[string]string{"image": "test/image:image2image", "video": "vendor/clip:free"}
	tc, err = r.findCase("image")
	if err != nil || tc.source != "--model image" || tc.route.ID != "image2image" || len(tc.params) != 0 {
		t.Fatalf("with --model: %+v %v", tc, err)
	}
	// The whole value is a model id before it is split at the last ":".
	tc, err = r.findCase("video")
	if err != nil || tc.model.ID != "vendor/clip:free" || tc.route.ID != "text2video" {
		t.Fatalf("an id with a colon: %+v %v", tc, err)
	}
	r.opts.Models["video"] = "vendor/clip:"
	if _, err := r.findCase("video"); err == nil {
		t.Errorf("vendor/clip: is not a model; split, it names an empty route, and must fail")
	}
}
