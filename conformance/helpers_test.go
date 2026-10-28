package conformance

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestReachable(t *testing.T) {
	ok := [][2]string{
		{"queued", "running"}, {"queued", "succeeded"}, {"running", "succeeded"}, {"queued", "pending_approval"},
		{"pending_approval", "queued"}, {"pending_approval", "succeeded"}, {"pending_approval", "expired"},
		{"running", "cancelled"}, {"queued", "failed"}, {"running", "pending_approval"}, {"succeeded", "succeeded"},
	}
	for _, p := range ok {
		if !reachable(p[0], p[1]) {
			t.Errorf("%s -> %s should be allowed", p[0], p[1])
		}
	}
	// Polling can miss states, so running -> queued and queued -> expired are reachable through
	// pending_approval. Terminal states lead nowhere.
	bad := [][2]string{
		{"succeeded", "running"}, {"failed", "succeeded"}, {"cancelled", "queued"}, {"expired", "queued"},
		{"rejected", "pending_approval"},
	}
	for _, p := range bad {
		if reachable(p[0], p[1]) {
			t.Errorf("%s -> %s should not be allowed", p[0], p[1])
		}
	}
}

func TestStateIssues(t *testing.T) {
	obs := func(states ...string) []observation {
		out := []observation{}
		for i, s := range states {
			out = append(out, observation{job: job{Status: s, UpdatedAt: "2026-10-23T08:00:0" + string(rune('0'+i)) + "Z"}, from: "query"})
		}
		return out
	}
	if issues := stateIssues(obs("queued", "running", "succeeded", "succeeded")); len(issues) != 0 {
		t.Errorf("valid sequence: %v", issues)
	}
	if issues := stateIssues(obs("queued", "succeeded", "running")); len(issues) == 0 {
		t.Error("a terminal state that changes must be reported")
	}
	back := obs("queued", "running")
	back[1].job.UpdatedAt = "2026-10-23T07:00:00Z"
	if issues := stateIssues(back); len(issues) != 1 || !strings.Contains(issues[0], "updated_at") {
		t.Errorf("updated_at going back: %v", issues)
	}
}

func TestSplitCommand(t *testing.T) {
	cases := map[string][]string{
		`node dist/provider.mjs`:           {"node", "dist/provider.mjs"},
		`  node   "my dir/p.mjs" --x=1 `:   {"node", "my dir/p.mjs", "--x=1"},
		`sh -c 'echo "a b"'`:               {"sh", "-c", `echo "a b"`},
		`a\ b c`:                           {"a b", "c"},
		`""`:                               {""},
		`node --fault=no-auth provider.js`: {"node", "--fault=no-auth", "provider.js"},
	}
	for in, want := range cases {
		got, err := splitCommand(in)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("splitCommand(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{`"unterminated`, `trailing\`} {
		if _, err := splitCommand(in); err == nil {
			t.Errorf("splitCommand(%q) should fail", in)
		}
	}
}

func TestCharacterErrorRate(t *testing.T) {
	if cer := characterErrorRate("The quick brown fox.", "the QUICK brown fox"); cer != 0 {
		t.Errorf("case and punctuation should not count: %v", cer)
	}
	if cer := characterErrorRate("今天天气很好，我们去公园散步。", "今天天气很好我们去公园散步"); cer != 0 {
		t.Errorf("Chinese punctuation should not count: %v", cer)
	}
	if cer := characterErrorRate("abcd", "abxd"); cer != 0.25 {
		t.Errorf("one substitution in four: %v", cer)
	}
	if cer := characterErrorRate("abc", ""); cer != 1 {
		t.Errorf("empty hypothesis: %v", cer)
	}
}

func TestUnitIssues(t *testing.T) {
	var tr transcript
	_ = json.Unmarshal([]byte(`{"segments":[{"timed_text_units":[
		{"text":"a","start_ms":0,"end_ms":100},{"text":"b","start_ms":100,"end_ms":300},{"text":"c","start_ms":350,"end_ms":1050}]}]}`), &tr)
	if issues := unitIssues(&tr, 1000); len(issues) != 0 {
		t.Errorf("valid units (ending within 60 ms of the end): %v", issues)
	}
	if issues := unitIssues(&tr, 980); len(issues) != 1 {
		t.Errorf("a unit ending 70 ms after the audio: %v", issues)
	}
	_ = json.Unmarshal([]byte(`{"segments":[{"timed_text_units":[
		{"text":"a","start_ms":0,"end_ms":200},{"text":"b","start_ms":150,"end_ms":300},{"text":"c","start_ms":400,"end_ms":390}]}]}`), &tr)
	if issues := unitIssues(&tr, 1000); len(issues) != 2 {
		t.Errorf("an overlap and a reversed unit: %v", issues)
	}
}

func TestCatalogProblems(t *testing.T) {
	var cat catalog
	err := json.Unmarshal([]byte(`{"models":[{"id":"m","label":"M","available":true,"output":{"modality":"image"},
		"parameters":[
			{"name":"duration","kind":"integer","default":6,"min":4,"max":15,"step":2},
			{"name":"ratio","kind":"enum","default":"4:3","enum_values":["1:1"]},
			{"name":"bad","kind":"number","min":5,"max":1}
		],
		"routes":[{"id":"r","parameter_names":["duration","missing"],
			"input":{"slots":[{"id":"s","role":"reference","modality":"image","min_artifacts":3,"max_artifacts":2,"media_types":["image"]}],"max_total_artifacts":1},
			"output":{"media_types":["video/mp4"]}}]}]}`), &cat)
	if err != nil {
		t.Fatal(err)
	}
	problems := strings.Join(catalogProblems(&cat), "\n")
	for _, want := range []string{
		"not in enum_values", "min 5 > max 1", `lists "missing"`, "min_artifacts 3 > max_artifacts 2",
		"less than the sum", `"image" is not a valid MIME type`, "does not match the model's output modality",
	} {
		if !strings.Contains(problems, want) {
			t.Errorf("missing problem %q in:\n%s", want, problems)
		}
	}
	if strings.Contains(problems, "min + k * step") {
		t.Errorf("default 6 with min 4 and step 2 is aligned:\n%s", problems)
	}
	cat.Models[0].Parameters[0].Default = json.RawMessage("7")
	if !strings.Contains(strings.Join(catalogProblems(&cat), "\n"), "min + k * step") {
		t.Error("default 7 with min 4 and step 2 is not aligned")
	}
}

// widget, visible_when and parameter_rules have fixed shapes (spec/v1.md section 3.3). A5 checks the
// shapes only: unknown members are fine, and the names need not be defined parameters.
func TestCatalogShapes(t *testing.T) {
	decode := func(params, rules string) *catalog {
		t.Helper()
		var cat catalog
		doc := `{"models":[{"id":"m","label":"M","available":true,"output":{"modality":"image"},
			"parameters":[` + params + `],` + rules + `
			"routes":[{"id":"text2image","input":{"slots":[]},"parameter_names":["ratio"],"output":{"media_types":["image/png"]}}]}]}`
		if err := json.Unmarshal([]byte(doc), &cat); err != nil {
			t.Fatalf("%v in %s", err, doc)
		}
		return &cat
	}
	good := decode(`{"name":"ratio","kind":"enum","default":"1:1","enum_values":["1:1","16:9"],"widget":"select","visible_when":{"name":"mode","equals":null,"extra":1}}`,
		`"parameter_rules":[{"when_name":"ratio","when_values":["16:9"],"reject_name":"undefined_param","reject_values":[],"message":"no","severity":"error"}],`)
	if problems := catalogProblems(good); len(problems) != 0 {
		t.Errorf("valid shapes: %v", problems)
	}
	ratio := `{"name":"ratio","kind":"enum","default":"1:1","enum_values":["1:1","16:9"]`
	rule := func(change string) string {
		return `"parameter_rules":[{"when_name":"ratio","when_values":["16:9"],"reject_name":"r","reject_values":["4k"],"message":"no"` + change + `}],`
	}
	cases := []struct{ params, rules, want string }{
		{ratio + `,"widget":{"type":"select"}}`, "", "widget must be a string"},
		{ratio + `,"widget":null}`, "", "widget must be a string"},
		{ratio + `,"visible_when":{"name":"mode"}}`, "", "visible_when needs equals"},
		{ratio + `,"visible_when":{"equals":1}}`, "", "visible_when.name must be a string"},
		{ratio + `,"visible_when":[{"name":"mode","equals":1}]}`, "", "visible_when must be an object"},
		{ratio + `,"visible_when":"mode=pro"}`, "", "visible_when must be an object"},
		{ratio + `}`, `"parameter_rules":{"when_name":"ratio"},`, "parameter_rules must be an array"},
		{ratio + `}`, `"parameter_rules":["ratio"],`, "parameter_rules[0] must be an object"},
		{ratio + `}`, `"parameter_rules":[{"when_name":"ratio","when_values":["16:9"],"reject_name":"r","reject_values":["4k"]}],`, "parameter_rules[0].message must be a string"},
		{ratio + `}`, rule(`,"when_values":"16:9"`), "parameter_rules[0].when_values must be an array of strings"},
		{ratio + `}`, rule(`,"reject_values":[4]`), "parameter_rules[0].reject_values must be an array of strings"},
		{ratio + `}`, rule(`,"when_name":1`), "parameter_rules[0].when_name must be a string"},
		{ratio + `}`, rule(`,"reject_name":null`), "parameter_rules[0].reject_name must be a string"},
	}
	for _, tc := range cases {
		problems := strings.Join(catalogProblems(decode(tc.params, tc.rules)), "\n")
		if !strings.Contains(problems, tc.want) {
			t.Errorf("%s %s: missing %q in:\n%s", tc.params, tc.rules, tc.want, problems)
		}
	}
}

func TestHeaderMatches(t *testing.T) {
	if ok, known := headerMatches("image/png", sampleImage("image/png", 1)); !ok || !known {
		t.Error("PNG")
	}
	if ok, _ := headerMatches("image/jpeg", sampleImage("image/png", 1)); ok {
		t.Error("a PNG is not a JPEG")
	}
	if ok, _ := headerMatches("video/mp4", sampleVideo()); !ok {
		t.Error("MP4 sample")
	}
	if ok, _ := headerMatches("audio/wav", speechSampleFor("zh").data); !ok {
		t.Error("WAV sample")
	}
	if _, known := headerMatches("model/gltf+json", nil); known {
		t.Error("unknown type")
	}
}

func TestSamples(t *testing.T) {
	samples, err := loadSpeechSamples()
	if err != nil || len(samples) != 2 {
		t.Fatalf("samples: %v %d", err, len(samples))
	}
	for _, s := range samples {
		if len(s.data) == 0 || s.DurationMS <= 0 || s.Text == "" {
			t.Errorf("sample %s is incomplete", s.File)
		}
	}
}

func TestChecksCatalogue(t *testing.T) {
	ids := []string{}
	for _, c := range Checks() {
		ids = append(ids, c.ID)
	}
	want := "A1 A2 A3 A4 A5 A6 A7 A8 A9 B1 B2 B3 B4 B5 B6 B7 B8 B9 B10 B11 C1 C2"
	if got := strings.Join(ids, " "); got != want {
		t.Errorf("checks: %s", got)
	}
}

// Numeric parameters may list their values in enum_values, and a number's step may be fractional
// (spec/v1.md section 3.3). A5 compares values as JSON numbers and aligns with a tolerance.
func TestNumericParameters(t *testing.T) {
	problems := func(param string) string {
		t.Helper()
		var p parameter
		if err := json.Unmarshal([]byte(param), &p); err != nil {
			t.Fatalf("%v in %s", err, param)
		}
		return strings.Join(parameterProblems(&p), "\n")
	}
	valid := []string{
		`{"name":"duration","kind":"integer","default":6,"enum_values":[4,6,8]}`,
		`{"name":"duration","kind":"integer","default":6,"enum_values":[4,6,8],"min":4,"max":8,"step":2}`,
		`{"name":"motion","kind":"number","default":0.75,"enum_values":[0.25,0.5,0.75]}`,
		`{"name":"motion","kind":"number","default":0.3,"min":0,"max":1,"step":0.1}`,
		`{"name":"motion","kind":"number","default":7.4,"min":1.1,"step":0.7}`,
		`{"name":"seconds","kind":"number","default":9876543.2,"min":0,"step":0.1}`,
		`{"name":"seconds","kind":"number","default":4938274.3,"min":2.7,"step":0.05}`,
	}
	for _, p := range valid {
		if got := problems(p); got != "" {
			t.Errorf("%s: %s", p, got)
		}
	}
	invalid := []struct{ param, want string }{
		{`{"name":"duration","kind":"integer","default":5,"enum_values":[4,6,8]}`, "not in enum_values"},
		{`{"name":"ratio","kind":"enum","default":4,"enum_values":["4","6"]}`, "not in enum_values"},
		{`{"name":"duration","kind":"integer","default":4,"enum_values":["4",6]}`, "enum_values of an integer parameter must be numbers"},
		{`{"name":"duration","kind":"integer","default":4,"enum_values":[4,6.5]}`, "enum_values of an integer parameter must be whole numbers"},
		{`{"name":"motion","kind":"number","default":0.5,"enum_values":[0.5,true]}`, "enum_values of a number parameter must be numbers"},
		{`{"name":"motion","kind":"number","default":0.35,"min":0,"max":1,"step":0.1}`, "min + k * step"},
		{`{"name":"seconds","kind":"number","default":9876543.25,"min":0,"step":0.1}`, "min + k * step"},
	}
	for _, tc := range invalid {
		if got := problems(tc.param); !strings.Contains(got, tc.want) {
			t.Errorf("%s: missing %q in %q", tc.param, tc.want, got)
		}
	}
}

// Only downloads follow redirects. A redirect never goes from https to http, drops Authorization
// when the origin changes, and the suite follows at most 5.
func TestDownloadRedirectPolicy(t *testing.T) {
	req := func(raw string) *http.Request {
		r, err := http.NewRequest("GET", raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Authorization", "Bearer secret")
		return r
	}
	start := req("https://service.example.com/v1/artifacts/a/content")
	cases := []struct {
		to       string
		keepAuth bool
		fail     string
	}{
		{"https://service.example.com/other", true, ""},
		{"https://storage.example.com/blob?sig=1", false, ""},
		{"https://service.example.com:8443/blob", false, ""},
		{"http://service.example.com/blob", false, "https to http"},
	}
	for _, tc := range cases {
		next := req(tc.to)
		err := followDownloadRedirect(next, []*http.Request{start})
		switch {
		case tc.fail != "" && (err == nil || !strings.Contains(err.Error(), tc.fail)):
			t.Errorf("%s: got %v, want an error with %q", tc.to, err, tc.fail)
		case tc.fail == "" && err != nil:
			t.Errorf("%s: %v", tc.to, err)
		case tc.fail == "" && (next.Header.Get("Authorization") != "") != tc.keepAuth:
			t.Errorf("%s: Authorization kept = %v, want %v", tc.to, next.Header.Get("Authorization") != "", tc.keepAuth)
		}
	}
	// Plain http on loopback, another port: followed, without the token.
	local := req("http://127.0.0.1:4000/v1/artifacts/a/content")
	next := req("http://127.0.0.1:4001/blob")
	if err := followDownloadRedirect(next, []*http.Request{local}); err != nil || next.Header.Get("Authorization") != "" {
		t.Errorf("loopback, another port: %v, Authorization %q", err, next.Header.Get("Authorization"))
	}
	// After an https hop, http is refused even when the first request was http.
	hop := req("https://storage.example.com/a")
	if err := followDownloadRedirect(req("http://storage.example.com/b"), []*http.Request{local, hop}); err == nil {
		t.Error("https to http after a hop must be refused")
	}
	via := []*http.Request{start}
	for i := 0; i < 5; i++ {
		via = append(via, req("https://storage.example.com/"+strconv.Itoa(i)))
	}
	if err := followDownloadRedirect(req("https://storage.example.com/last"), via[:5]); err != nil {
		t.Errorf("the 5th redirect: %v", err)
	}
	if err := followDownloadRedirect(req("https://storage.example.com/last"), via); err == nil || !strings.Contains(err.Error(), "more than 5") {
		t.Errorf("the 6th redirect: %v", err)
	}
	// Other requests do not follow at all.
	if err := noRedirect(req("https://service.example.com/v1/provider"), []*http.Request{start}); err != http.ErrUseLastResponse {
		t.Errorf("a redirect outside downloads: %v", err)
	}
}

// The suite builds requests for numeric parameters listed by their values: a valid value is one of
// them, and the out-of-range value of A6 is none of them.
func TestNumericEnumRequests(t *testing.T) {
	var m model
	if err := json.Unmarshal([]byte(`{"id":"v","label":"V","available":true,"output":{"modality":"video"},
		"parameters":[{"name":"duration","kind":"integer","required":true,"enum_values":[4,6,8]}],
		"routes":[{"id":"text2video","input":{"slots":[]},"parameter_names":["duration"]}]}`), &m); err != nil {
		t.Fatal(err)
	}
	if v := fillParameter(m.param("duration")); v != 4.0 {
		t.Errorf("fillParameter: %v, want 4", v)
	}
	name, v, ok := outOfRangeParameter(&testCase{model: &m, route: &m.Routes[0]})
	if !ok || name != "duration" || v != 9.0 {
		t.Errorf("outOfRangeParameter: %s %v %v, want duration 9", name, v, ok)
	}
}
