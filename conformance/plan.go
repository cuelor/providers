package conformance

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// testCase is a model and route the suite submits jobs to.
type testCase struct {
	capability string // image, video or transcription
	model      *model
	route      *route
	params     map[string]any
	source     string // where the case came from, for details
}

func (tc *testCase) label() string {
	return fmt.Sprintf("%s (%s, %s)", tc.capability, tc.model.ID, tc.route.ID)
}

type inputRef struct {
	ArtifactID string `json:"artifact_id"`
	Role       string `json:"role"`
	Position   int    `json:"position"`
}

type jobRequest struct {
	Model string `json:"model"`
	Route string `json:"route"`
	Input struct {
		Artifacts []inputRef `json:"artifacts"`
	} `json:"input"`
	Parameters map[string]any `json:"parameters"`
}

func (j jobRequest) clone() jobRequest {
	out := j
	out.Input.Artifacts = append([]inputRef{}, j.Input.Artifacts...)
	out.Parameters = map[string]any{}
	for k, v := range j.Parameters {
		out.Parameters[k] = v
	}
	return out
}

func (j jobRequest) body() []byte {
	raw, _ := json.Marshal(j)
	return raw
}

// livePlan is what tiers B and C submit.
type livePlan struct {
	// primary runs the B checks.
	primary *testCase
	// extra are the other generation capabilities; each runs one job checked by B4, B5 and B10.
	extra []testCase
	// transcription runs the C checks.
	transcription *testCase
}

func (r *runner) getPlan() (*livePlan, error) {
	r.planOnce.Do(func() { r.plan, r.planErr = r.makePlan() })
	return r.plan, r.planErr
}

func (r *runner) makePlan() (*livePlan, error) {
	if r.desc == nil {
		return nil, fmt.Errorf("GET /v1/provider failed: %v", r.descErr)
	}
	if r.cat == nil {
		return nil, fmt.Errorf("GET /v1/models failed or is invalid: %v", r.catErr)
	}
	plan := &livePlan{}
	caps := r.desc.Capabilities
	for _, capability := range caps.Generation {
		tc, err := r.findCase(capability)
		if err != nil {
			return nil, err
		}
		if plan.primary == nil {
			plan.primary = tc
		} else {
			plan.extra = append(plan.extra, *tc)
		}
	}
	if caps.Transcription {
		tc, err := r.findCase("transcription")
		if err != nil {
			return nil, err
		}
		plan.transcription = tc
		if plan.primary == nil {
			plan.primary = tc
		}
	}
	if plan.primary == nil {
		return nil, fmt.Errorf("the service declares neither generation nor transcription")
	}
	return plan, nil
}

// findCase takes the manifest's test entry for a capability, or the first suitable model.
func (r *runner) findCase(capability string) (*testCase, error) {
	if r.manifest != nil {
		if entry, ok := r.manifest.Test[capability]; ok {
			m := r.findModel(entry.Model)
			if m == nil {
				return nil, fmt.Errorf("the manifest's test.%s names model %q, which is not in the catalog", capability, entry.Model)
			}
			rt := m.route(entry.Route)
			if rt == nil {
				return nil, fmt.Errorf("the manifest's test.%s names route %q, which model %q does not have", capability, entry.Route, entry.Model)
			}
			if !m.Available {
				return nil, fmt.Errorf("the manifest's test.%s model %q is not available", capability, entry.Model)
			}
			return &testCase{capability, m, rt, copyParams(entry.Parameters), "the manifest's test." + capability}, nil
		}
	}
	for i := range r.cat.Models {
		m := &r.cat.Models[i]
		if !m.Available {
			continue
		}
		for j := range m.Routes {
			rt := &m.Routes[j]
			matches := false
			if capability == "transcription" {
				matches = rt.ID == "audio2text"
			} else {
				matches = m.Output.Modality == capability && rt.ID != "audio2text"
			}
			if matches && canFill(rt) {
				return &testCase{capability, m, rt, map[string]any{}, "the first suitable model in the catalog"}, nil
			}
		}
	}
	return nil, fmt.Errorf("no available model for %s whose required inputs the suite can provide; add test.%s to the manifest", capability, capability)
}

func (r *runner) findModel(id string) *model {
	for i := range r.cat.Models {
		if r.cat.Models[i].ID == id {
			return &r.cat.Models[i]
		}
	}
	return nil
}

func copyParams(p map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range p {
		out[k] = v
	}
	return out
}

// canFill reports whether the suite has samples for every required input of a route.
func canFill(rt *route) bool {
	for _, s := range rt.Input.Slots {
		if s.MinArtifacts > 0 {
			if _, _, ok := sampleFor(s, 0); !ok {
				return false
			}
		}
	}
	return true
}

// buildRequest uploads the required inputs of a case and fills in required parameters. audio, when
// set, is the input for an audio slot (the transcription samples).
func (r *runner) buildRequest(c *checkCtx, tc *testCase, audio []byte) jobRequest {
	req := jobRequest{Model: tc.model.ID, Route: tc.route.ID, Parameters: copyParams(tc.params)}
	req.Input.Artifacts = []inputRef{}
	seed := 1
	for _, s := range tc.route.Input.Slots {
		n := s.MinArtifacts
		if audio != nil && s.Modality == "audio" && n == 0 && s.MaxArtifacts > 0 {
			n = 1
		}
		for i := 0; i < n; i++ {
			var data []byte
			var mt string
			if audio != nil && s.Modality == "audio" {
				data, mt = audio, "audio/wav"
			} else {
				var ok bool
				data, mt, ok = sampleFor(s, seed)
				if !ok {
					c.fatal("%s: slot %s needs one of %v, and the suite has no sample of those types", tc.label(), s.ID, s.MediaTypes)
				}
			}
			seed++
			a := r.mustUpload(c, data, mt, "conformance"+extensionFor(mt))
			req.Input.Artifacts = append(req.Input.Artifacts, inputRef{a.ID, s.Role, len(req.Input.Artifacts)})
		}
	}
	for _, name := range tc.route.ParameterNames {
		p := tc.model.param(name)
		if p == nil || !p.Required {
			continue
		}
		if _, ok := req.Parameters[name]; ok {
			continue
		}
		req.Parameters[name] = fillParameter(p)
	}
	return req
}

// fillParameter picks a valid value for a required parameter the test entry did not set.
func fillParameter(p *parameter) any {
	if len(p.Default) > 0 && string(p.Default) != "null" {
		var v any
		if json.Unmarshal(p.Default, &v) == nil {
			return v
		}
	}
	switch p.Kind {
	case "text", "string":
		if p.Name == "prompt" {
			return "a red square"
		}
		return "test"
	case "enum":
		if len(p.EnumValues) > 0 {
			var v any
			_ = json.Unmarshal(p.EnumValues[0], &v)
			return v
		}
	case "integer", "number":
		if len(p.EnumValues) > 0 {
			var v any
			_ = json.Unmarshal(p.EnumValues[0], &v)
			return v
		}
		if p.Min != nil {
			return *p.Min
		}
		return 1
	case "boolean":
		return false
	}
	return "test"
}

// conflictingRequest returns a valid request that differs from req, for B3.
func conflictingRequest(tc *testCase, req jobRequest) (jobRequest, string, bool) {
	out := req.clone()
	if tc.route.hasParam("prompt") {
		prompt, _ := out.Parameters["prompt"].(string)
		if prompt == "" {
			prompt = "a red square"
		}
		out.Parameters["prompt"] = prompt + " (variant)"
		return out, "a different prompt", true
	}
	for _, name := range tc.route.ParameterNames {
		p := tc.model.param(name)
		if p == nil {
			continue
		}
		cur, has := out.Parameters[name]
		switch p.Kind {
		case "enum":
			for _, raw := range p.EnumValues {
				var v any
				_ = json.Unmarshal(raw, &v)
				if !has || fmt.Sprint(v) != fmt.Sprint(cur) {
					if !has && string(raw) == string(p.Default) {
						continue
					}
					out.Parameters[name] = v
					return out, "a different value of " + name, true
				}
			}
		case "boolean":
			b, _ := cur.(bool)
			if !has {
				var d bool
				_ = json.Unmarshal(p.Default, &d)
				b = d
			}
			out.Parameters[name] = !b
			return out, "a different value of " + name, true
		}
	}
	return req, "", false
}

// costOf estimates one job's cost in the billing unit, from the estimate endpoint when the service
// has one, else from the route's pricing hint.
func (r *runner) costOf(tc *testCase, req jobRequest, audioMS int64) (float64, string, error) {
	unit := r.desc.Billing.Unit
	if r.desc.Capabilities.Estimate {
		resp, err := r.send(request{method: "POST", path: "/v1/estimates", body: req.body(), contentType: "application/json"})
		if err != nil {
			return 0, "", err
		}
		if resp.status != 200 {
			return 0, "", fmt.Errorf("POST /v1/estimates returned HTTP %d (%s)", resp.status, snippet(resp.body))
		}
		if err := r.schemas.validate("estimate", resp.json); err != nil {
			return 0, "", fmt.Errorf("POST /v1/estimates: the response %v", err)
		}
		var e estimate
		_ = json.Unmarshal(resp.body, &e)
		if e.Estimate.Unit != unit {
			return 0, "", fmt.Errorf("the estimate is in %s but billing.unit is %s", e.Estimate.Unit, unit)
		}
		return e.Estimate.Amount, "estimate endpoint", nil
	}
	p := tc.route.Pricing
	if p == nil {
		return 0, "", fmt.Errorf("%s has no pricing hint and the service has no estimate endpoint", tc.label())
	}
	if p.Currency != unit {
		return 0, "", fmt.Errorf("%s is priced in %s but billing.unit is %s", tc.label(), p.Currency, unit)
	}
	switch p.Unit {
	case "job", "image":
		return p.Amount, "pricing hint", nil
	case "second", "minute":
		seconds := 0.0
		if audioMS > 0 {
			seconds = float64(audioMS) / 1000
		} else if d, ok := numberParam(tc, req, "duration"); ok {
			seconds = d
		} else {
			return 0, "", fmt.Errorf("%s is priced per %s but the request has no duration", tc.label(), p.Unit)
		}
		if p.Unit == "minute" {
			return p.Amount * math.Ceil(seconds) / 60, "pricing hint", nil
		}
		return p.Amount * math.Ceil(seconds), "pricing hint", nil
	case "character":
		prompt, _ := req.Parameters["prompt"].(string)
		return p.Amount * float64(len([]rune(prompt))), "pricing hint", nil
	}
	return 0, "", fmt.Errorf("%s is priced per %q, which the suite cannot compute", tc.label(), p.Unit)
}

func numberParam(tc *testCase, req jobRequest, name string) (float64, bool) {
	if v, ok := req.Parameters[name]; ok {
		switch n := v.(type) {
		case float64:
			return n, true
		case int:
			return float64(n), true
		case json.Number:
			f, err := n.Float64()
			return f, err == nil
		}
	}
	if p := tc.model.param(name); p != nil && len(p.Default) > 0 {
		var f float64
		if json.Unmarshal(p.Default, &f) == nil {
			return f, true
		}
	}
	return 0, false
}

// jobsPlanned counts the jobs the selected live checks create with the primary case.
func (r *runner) jobsPlanned(selected func(string) bool) (primary, transcriptionEN, transcriptionZH int) {
	flow := false
	for _, id := range []string{"B1", "B2", "B3", "B4", "B5", "B10"} {
		flow = flow || selected(id)
	}
	if flow {
		primary++
	}
	if selected("A6") {
		primary++
	}
	if r.t.command() {
		if selected("B6") {
			primary++
		}
		if selected("B7") {
			primary += b7Attempts
		}
	}
	if selected("B8") {
		primary++
	}
	if selected("B9") && r.desc.Capabilities.Cancel {
		primary++
	}
	if selected("B11") && r.desc.Capabilities.Estimate {
		primary++
	}
	if r.desc.Capabilities.Transcription {
		if selected("C1") {
			transcriptionEN++
			transcriptionZH++
		}
		if selected("C2") {
			transcriptionEN++
		}
	}
	return
}

// budget estimates the cost of the live run once and returns a note about it, or an error when the
// run would cost more than MaxCost or its cost cannot be estimated. Over the budget no job is
// submitted at all: tiers B and C fail as not run and A6 leaves out its valid submission.
func (r *runner) budget() (string, error) {
	r.budgetOnce.Do(func() { r.budgetNote, r.budgetErr = r.checkBudget() })
	return r.budgetNote, r.budgetErr
}

// requireBudget ends a tier B or C check as not run when the run is over the budget.
func (r *runner) requireBudget(c *checkCtx) {
	if _, err := r.budget(); err != nil {
		c.notRunf("%v; no job was submitted", err)
	}
}

func (r *runner) checkBudget() (string, error) {
	plan, err := r.getPlan()
	if err != nil {
		return "", err
	}
	c := &checkCtx{}
	var total float64
	sources := map[string]bool{}
	err = func() (err error) {
		defer func() {
			if p := recover(); p != nil {
				if _, ok := p.(checkAbort); ok {
					err = fmt.Errorf("%s", strings.Join(c.failures, "; "))
					return
				}
				panic(p)
			}
		}()
		primaryJobs, en, zh := r.jobsPlanned(func(id string) bool { return r.selected[id] })
		add := func(tc *testCase, audio *speechSample, n int) error {
			if n == 0 {
				return nil
			}
			var data []byte
			var ms int64
			if audio != nil {
				data, ms = audio.data, audio.DurationMS
			}
			req := r.buildRequest(c, tc, data)
			cost, source, err := r.costOf(tc, req, ms)
			if err != nil {
				return err
			}
			sources[source] = true
			total += cost * float64(n)
			return nil
		}
		var primaryAudio *speechSample
		if plan.primary.capability == "transcription" {
			s := speechSampleFor("en")
			primaryAudio = &s
		}
		if err := add(plan.primary, primaryAudio, primaryJobs); err != nil {
			return err
		}
		if primaryJobs > 0 && (r.selected["B1"] || r.selected["B4"] || r.selected["B5"] || r.selected["B10"] || r.selected["B2"] || r.selected["B3"]) {
			for i := range plan.extra {
				if err := add(&plan.extra[i], nil, 1); err != nil {
					return err
				}
			}
		}
		if plan.transcription != nil {
			en1, zh1 := speechSampleFor("en"), speechSampleFor("zh")
			if err := add(plan.transcription, &en1, en); err != nil {
				return err
			}
			if err := add(plan.transcription, &zh1, zh); err != nil {
				return err
			}
		}
		return nil
	}()
	if err != nil {
		return "", fmt.Errorf("the cost of the live run cannot be estimated (--max-cost %g %s): %v", *r.opts.MaxCost, r.desc.Billing.Unit, err)
	}
	max := *r.opts.MaxCost
	unit := r.desc.Billing.Unit
	estimated := fmt.Sprintf("estimated cost of the live run: %g %s (from the %s)", total, unit, strings.Join(sortedKeys(sources), " and "))
	if total > max+1e-9 {
		return "", fmt.Errorf("%s exceeds --max-cost %g %s", estimated, max, unit)
	}
	return fmt.Sprintf("%s, within --max-cost %g %s", estimated, max, unit), nil
}
