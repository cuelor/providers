package conformance

import (
	"encoding/json"
	"fmt"
	"math"
	"mime"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var hex64 = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// A1: GET /v1/provider matches the schema; major version 1; provider.id and version equal the
// manifest; binding is 64 hexadecimal digits.
func checkA1(r *runner, c *checkCtx) {
	resp := r.mustSend(c, request{method: "GET", path: "/v1/provider", class: "describe"})
	if resp.status != 200 {
		c.fatal("GET /v1/provider: expected HTTP 200, got %d (%s)", resp.status, snippet(resp.body))
	}
	if err := r.schemas.validate("provider-description", resp.json); err != nil {
		c.fail("GET /v1/provider: the response %v", err)
	}
	var d description
	if err := json.Unmarshal(resp.body, &d); err != nil {
		c.fatal("GET /v1/provider: %v", err)
	}
	major, _, _ := strings.Cut(d.Protocol.Version, ".")
	if major != "1" {
		c.fail("protocol.version is %q; the major version must be 1", d.Protocol.Version)
	}
	if !hex64.MatchString(d.Account.Binding) {
		c.fail("account.binding must be 64 hexadecimal digits, got %d characters", len(d.Account.Binding))
	}
	if r.manifest != nil {
		if d.Provider.ID != r.manifest.ID {
			c.fail("provider.id is %q but the manifest id is %q", d.Provider.ID, r.manifest.ID)
		}
		if d.Provider.Version != r.manifest.Version {
			c.fail("provider.version is %q but the manifest version is %q", d.Provider.Version, r.manifest.Version)
		}
	} else {
		c.note("no manifest given; provider.id and provider.version were not compared with one")
	}
	declared := map[string]bool{"transcription": d.Capabilities.Transcription}
	for _, g := range d.Capabilities.Generation {
		declared[g] = true
	}
	for _, capability := range sortedKeys(r.opts.Models) {
		if !declared[capability] {
			c.fail("--model %s=%s names a capability the service does not declare (is it misspelt?); the service declares %s",
				capability, r.opts.Models[capability], declaredCapabilities(d))
		}
	}
	if d.Account.Status != "ready" {
		c.note("account.status is %q; catalog and job endpoints are expected to answer 403 provider_not_ready", d.Account.Status)
	}
}

// declaredCapabilities lists the capabilities a description declares, for details.
func declaredCapabilities(d description) string {
	out := append([]string{}, d.Capabilities.Generation...)
	if d.Capabilities.Transcription {
		out = append(out, "transcription")
	}
	if len(out) == 0 {
		return "none"
	}
	return strings.Join(out, ", ")
}

// A2: requests without a bearer token or with a wrong one get 401 and the standard error body, on
// every endpoint.
func checkA2(r *runner, c *checkCtx) {
	caps := r.requireDescription(c).Capabilities
	jobBody := []byte(`{"model":"conformance/none","route":"text2image","input":{"artifacts":[]},"parameters":{}}`)
	upload := func() request {
		body := "--conformance\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\n" +
			string(sampleImage("image/png", 0)) + "\r\n--conformance--\r\n"
		return request{method: "POST", path: "/v1/artifacts", body: []byte(body), contentType: "multipart/form-data; boundary=conformance"}
	}
	endpoints := []request{
		{method: "GET", path: "/v1/provider"},
		{method: "GET", path: "/v1/models"},
		upload(),
		{method: "GET", path: "/v1/artifacts/art_conformance_missing"},
		{method: "GET", path: "/v1/artifacts/art_conformance_missing/content"},
		{method: "POST", path: "/v1/jobs", body: jobBody, contentType: "application/json", headers: map[string]string{"Idempotency-Key": newKey("a2")}},
		{method: "GET", path: "/v1/jobs/job_conformance_missing"},
	}
	if caps.Cancel {
		endpoints = append(endpoints, request{method: "POST", path: "/v1/jobs/job_conformance_missing/cancel"})
	}
	if caps.Estimate {
		endpoints = append(endpoints, request{method: "POST", path: "/v1/estimates", body: jobBody, contentType: "application/json"})
	}
	if caps.Setup {
		endpoints = append(endpoints, request{method: "POST", path: "/v1/setup"})
	}
	tok := r.t.token()
	wrong := []byte(tok)
	if len(wrong) > 0 {
		wrong[len(wrong)/2] ^= 1 // same length, one character different
	}
	variants := []struct {
		name string
		set  func(*request)
	}{
		{"without Authorization", func(q *request) { q.noAuth = true }},
		{"with a wrong token", func(q *request) { q.authHeader = "Bearer " + string(wrong) }},
		{"with the token plus one character", func(q *request) { q.authHeader = "Bearer " + tok + "x" }},
		{"with another scheme", func(q *request) { q.authHeader = "Basic " + tok }},
	}
	checked := 0
	for _, ep := range endpoints {
		for _, v := range variants {
			q := ep
			v.set(&q)
			what := fmt.Sprintf("%s %s %s", ep.method, ep.path, v.name)
			resp, err := r.send(q)
			if err != nil {
				c.fail("%s: %v", what, err)
				continue
			}
			r.expectError(c, what, resp, 401, "unauthorized")
			checked++
		}
	}
	c.note("%d requests to %d endpoints", checked, len(endpoints))
}

// A3: listens on 127.0.0.1 only; rejects a Host other than 127.0.0.1:<port>; rejects requests
// to /v1/ with an Origin header; exits within 5 s of stdin closing and leaves no processes behind.
func checkA3(r *runner, c *checkCtx) {
	port := r.cmd.port()

	// Only 127.0.0.1.
	addrs, _ := net.InterfaceAddrs()
	tried := 0
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() || ipnet.IP.IsLinkLocalMulticast() {
			continue
		}
		tried++
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(ipnet.IP.String(), strconv.Itoa(port)), time.Second)
		if err == nil {
			conn.Close()
			c.fail("the plugin accepts connections on %s, not only on 127.0.0.1", ipnet.IP)
		}
	}
	if tried == 0 {
		c.note("no non-loopback interface to try; listening on 127.0.0.1 only was not checked")
	}

	// Host and Origin.
	for _, host := range []string{fmt.Sprintf("localhost:%d", port), "example.com", fmt.Sprintf("127.0.0.1:%d", port+1)} {
		resp, err := r.send(request{method: "GET", path: "/v1/provider", host: host})
		switch {
		case err != nil:
			c.fail("Host %s: %v", host, err)
		case resp.status < 400 || resp.status > 499:
			c.fail("a request with Host %s was not rejected (HTTP %d); only 127.0.0.1:%d is allowed", host, resp.status, port)
		default:
			r.checkErrorBody(c, "Host "+host, resp, "")
		}
	}
	for _, origin := range []string{"https://example.com", "null"} {
		resp, err := r.send(request{method: "GET", path: "/v1/provider", headers: map[string]string{"Origin": origin}})
		switch {
		case err != nil:
			c.fail("Origin %s: %v", origin, err)
		case resp.status < 400 || resp.status > 499:
			c.fail("a request with Origin %s was not rejected (HTTP %d)", origin, resp.status)
		default:
			r.checkErrorBody(c, "Origin "+origin, resp, "")
		}
	}

	// stdin closing.
	exited, leftovers := r.cmd.closeStdin(5 * time.Second)
	if !exited {
		c.fail("the plugin did not exit within 5 s after stdin was closed")
	}
	if leftovers {
		c.fail("processes were left in the plugin's process group after it exited")
	}
	if err := r.cmd.restart(r.ctx); err != nil {
		c.fatal("restarting the plugin for the remaining checks: %v", err)
	}
	r.refreshDescription()
}

// A4: GET /v1/models matches the schema.
func checkA4(r *runner, c *checkCtx) {
	resp := r.mustSend(c, request{method: "GET", path: "/v1/models", class: "catalog"})
	if resp.status != 200 {
		if resp.status == 403 {
			c.fatal("GET /v1/models: HTTP 403 (%s); is account.status ready?", snippet(resp.body))
		}
		c.fatal("GET /v1/models: expected HTTP 200, got %d (%s)", resp.status, snippet(resp.body))
	}
	if err := r.schemas.validate("catalog", resp.json); err != nil {
		c.fatal("GET /v1/models: the response %v", err)
	}
	var cat catalog
	_ = json.Unmarshal(resp.body, &cat)
	routes := 0
	for _, m := range cat.Models {
		routes += len(m.Routes)
	}
	c.note("%d models, %d routes", len(cat.Models), routes)
}

// A5: every parameter_names entry is defined; defaults inside enums and ranges; min <= max; step
// aligned with min, with a tolerance for fractional steps; numeric enum_values are numbers of the
// parameter's kind; slot min <= max; max_total_artifacts >= the sum of slot minimums; media types
// are valid MIME types; route output types agree with the model's output modality; widget,
// visible_when and parameter_rules have their shapes. A catalog that decodes but does not match the
// schema is still checked, so that A5 names the problem; it fails either way.
func checkA5(r *runner, c *checkCtx) {
	cat := r.cat
	if cat == nil {
		cat = r.catUnchecked
	}
	if cat == nil {
		r.requireCatalog(c)
	}
	for _, problem := range catalogProblems(cat) {
		c.fail("%s", problem)
	}
	if r.cat == nil {
		c.fail("GET /v1/models %v", r.catErr)
	}
}

// catalogProblems returns every semantic problem of a catalog.
func catalogProblems(cat *catalog) []string {
	var out []string
	add := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) }
	modelIDs := map[string]bool{}
	for _, m := range cat.Models {
		if modelIDs[m.ID] {
			add("model %s appears twice", m.ID)
		}
		modelIDs[m.ID] = true
		for _, problem := range ruleShapeProblems(m.ParameterRules) {
			add("model %s: %s", m.ID, problem)
		}
		names := map[string]bool{}
		for i := range m.Parameters {
			p := &m.Parameters[i]
			where := fmt.Sprintf("model %s, parameter %s", m.ID, p.Name)
			if names[p.Name] {
				add("%s: defined twice", where)
			}
			names[p.Name] = true
			for _, problem := range parameterProblems(p) {
				add("%s: %s", where, problem)
			}
			for _, problem := range displayShapeProblems(p) {
				add("%s: %s", where, problem)
			}
		}
		routeIDs := map[string]bool{}
		for _, rt := range m.Routes {
			where := fmt.Sprintf("model %s, route %s", m.ID, rt.ID)
			if routeIDs[rt.ID] {
				add("%s: appears twice", where)
			}
			routeIDs[rt.ID] = true
			for _, name := range rt.ParameterNames {
				if !names[name] {
					add("%s: parameter_names lists %q, which the model does not define", where, name)
				}
			}
			slotIDs := map[string]bool{}
			minSum := 0
			for _, s := range rt.Input.Slots {
				if slotIDs[s.ID] {
					add("%s: slot %s appears twice", where, s.ID)
				}
				slotIDs[s.ID] = true
				if s.MinArtifacts > s.MaxArtifacts {
					add("%s, slot %s: min_artifacts %d > max_artifacts %d", where, s.ID, s.MinArtifacts, s.MaxArtifacts)
				}
				minSum += s.MinArtifacts
				for _, mt := range s.MediaTypes {
					if !validMIME(mt) {
						add("%s, slot %s: %q is not a valid MIME type", where, s.ID, mt)
					}
				}
			}
			if rt.Input.MaxTotalArtifacts != nil && *rt.Input.MaxTotalArtifacts < minSum {
				add("%s: max_total_artifacts %d is less than the sum of the slots' min_artifacts (%d)", where, *rt.Input.MaxTotalArtifacts, minSum)
			}
			if rt.Output != nil {
				for _, mt := range rt.Output.MediaTypes {
					if !validMIME(mt) {
						add("%s: output media type %q is not a valid MIME type", where, mt)
					} else if !outputMatchesModality(m.Output.Modality, mt) {
						add("%s: output media type %s does not match the model's output modality %s", where, mt, m.Output.Modality)
					}
				}
			}
		}
	}
	return out
}

// displayShapeProblems checks the shapes of widget (a string) and visible_when ({name: string,
// equals: any JSON value}). Both are optional; unknown members are allowed.
func displayShapeProblems(p *parameter) []string {
	var out []string
	if len(p.Widget) > 0 {
		var s string
		if json.Unmarshal(p.Widget, &s) != nil || string(p.Widget) == "null" {
			out = append(out, "widget must be a string")
		}
	}
	if len(p.VisibleWhen) > 0 {
		var v map[string]json.RawMessage
		if json.Unmarshal(p.VisibleWhen, &v) != nil || v == nil {
			return append(out, "visible_when must be an object {name, equals}")
		}
		if !isJSONString(v["name"]) {
			out = append(out, "visible_when.name must be a string")
		}
		if _, ok := v["equals"]; !ok {
			out = append(out, "visible_when needs equals")
		}
	}
	return out
}

// ruleShapeProblems checks that parameter_rules, when present, is an array of
// {when_name, when_values, reject_name, reject_values, message}: names and message strings, values
// arrays of strings. It does not check that the names are defined parameters.
func ruleShapeProblems(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var rules []json.RawMessage
	if json.Unmarshal(raw, &rules) != nil || rules == nil {
		return []string{"parameter_rules must be an array"}
	}
	var out []string
	for i, item := range rules {
		var rule map[string]json.RawMessage
		if json.Unmarshal(item, &rule) != nil || rule == nil {
			out = append(out, fmt.Sprintf("parameter_rules[%d] must be an object", i))
			continue
		}
		for _, key := range []string{"when_name", "reject_name", "message"} {
			if !isJSONString(rule[key]) {
				out = append(out, fmt.Sprintf("parameter_rules[%d].%s must be a string", i, key))
			}
		}
		for _, key := range []string{"when_values", "reject_values"} {
			var values []string
			if json.Unmarshal(rule[key], &values) != nil || values == nil {
				out = append(out, fmt.Sprintf("parameter_rules[%d].%s must be an array of strings", i, key))
			}
		}
	}
	return out
}

// isJSONString reports whether raw is a JSON string (not null, not absent).
func isJSONString(raw json.RawMessage) bool {
	var s string
	return len(raw) > 0 && string(raw) != "null" && json.Unmarshal(raw, &s) == nil
}

func parameterProblems(p *parameter) []string {
	var out []string
	add := func(format string, args ...any) { out = append(out, fmt.Sprintf(format, args...)) }
	if p.Min != nil && p.Max != nil && *p.Min > *p.Max {
		add("min %g > max %g", *p.Min, *p.Max)
	}
	switch {
	case p.EnumValues != nil && len(p.EnumValues) == 0:
		// Any kind: a listed enum_values is never empty (spec/v1.md section 3.3).
		add("enum_values of parameter %q is an empty list: omit enum_values instead of sending an empty list", p.Name)
	case p.Kind == "enum" && len(p.EnumValues) == 0:
		add("an enum without enum_values")
	}
	if p.Kind == "integer" {
		for name, v := range map[string]*float64{"min": p.Min, "max": p.Max, "step": p.Step} {
			if v != nil && *v != math.Trunc(*v) {
				add("%s %g of an integer parameter is not an integer", name, *v)
			}
		}
	}
	// A number or integer parameter may list its allowed values (spec/v1.md section 3.3).
	if (p.Kind == "integer" || p.Kind == "number") && len(p.EnumValues) > 0 {
		article := map[string]string{"integer": "an", "number": "a"}[p.Kind]
		for _, raw := range p.EnumValues {
			var v any
			_ = json.Unmarshal(raw, &v)
			f, ok := v.(float64)
			switch {
			case !ok:
				add("enum_values of %s %s parameter must be numbers, got %s", article, p.Kind, string(raw))
			case p.Kind == "integer" && f != math.Trunc(f):
				add("enum_values of an integer parameter must be whole numbers, got %s", string(raw))
			}
		}
	}
	if len(p.Default) == 0 || string(p.Default) == "null" {
		return out
	}
	var def any
	if err := json.Unmarshal(p.Default, &def); err != nil {
		return append(out, "default is not valid JSON")
	}
	if len(p.EnumValues) > 0 {
		found := false
		for _, raw := range p.EnumValues {
			var v any
			_ = json.Unmarshal(raw, &v)
			if sameJSONValue(v, def) {
				found = true
			}
		}
		if !found {
			add("default %s is not in enum_values", string(p.Default))
		}
	}
	switch p.Kind {
	case "integer", "number":
		f, ok := def.(float64)
		if !ok {
			add("default %s is not a number", string(p.Default))
			break
		}
		if p.Kind == "integer" && f != math.Trunc(f) {
			add("default %g of an integer parameter is not an integer", f)
		}
		if p.Min != nil && f < *p.Min {
			add("default %g < min %g", f, *p.Min)
		}
		if p.Max != nil && f > *p.Max {
			add("default %g > max %g", f, *p.Max)
		}
		if p.Step != nil && *p.Step > 0 {
			base := 0.0
			if p.Min != nil {
				base = *p.Min
			}
			if !aligned(f, base, *p.Step) {
				add("default %g is not min + k * step (min %g, step %g)", f, base, *p.Step)
			}
		}
	case "boolean":
		if _, ok := def.(bool); !ok {
			add("default %s is not a boolean", string(p.Default))
		}
	case "text", "string":
		s, ok := def.(string)
		if !ok {
			add("default %s is not a string", string(p.Default))
		} else if p.MaxLength != nil && len([]rune(s)) > *p.MaxLength {
			add("default is longer than max_length %d", *p.MaxLength)
		}
	}
	return out
}

// aligned reports whether v is base + k * step for a whole number k. Values such as 0.1 have no exact
// binary form, so k is compared with a tolerance that grows with its size: a default of 9876543.2
// with step 0.1 is aligned although the division gives 98765431.99999999.
func aligned(v, base, step float64) bool {
	k := (v - base) / step
	return math.Abs(k-math.Round(k)) <= math.Max(1e-9, 1e-12*math.Abs(k))
}

// sameJSONValue compares two decoded JSON values: 4 and "4" differ, 4 and 4.0 do not.
func sameJSONValue(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	}
	return false
}

func validMIME(mt string) bool {
	base, params, err := mime.ParseMediaType(mt)
	return err == nil && len(params) == 0 && strings.Count(base, "/") == 1 && !strings.HasSuffix(base, "/")
}

// outputMatchesModality reports whether an output media type fits a model's output modality.
// Unknown modalities are accepted.
func outputMatchesModality(modality, mediaType string) bool {
	kind := mediaKind(mediaType)
	switch modality {
	case "image", "video", "audio":
		return kind == modality
	case "text":
		return kind == "text" || baseMediaType(mediaType) == TranscriptMediaType || baseMediaType(mediaType) == "application/json"
	}
	return true
}

// A6: invalid submissions (unknown model, unknown route, a parameter out of range, too many inputs,
// a reference out of range, no Idempotency-Key) all get 400 with the standard error body and a
// message without the token; a valid request with a new key still works afterwards.
func checkA6(r *runner, c *checkCtx) {
	cat := r.requireCatalog(c)
	tc := r.chooseBaseline(cat)
	if tc == nil {
		c.fatal("the catalog has no available model whose required inputs the suite can provide")
	}
	base := r.buildRequest(c, tc, nil)
	c.note("built from %s", tc.label())

	submit := func(what string, req jobRequest, key string) {
		headers := map[string]string{}
		if key != "" {
			headers["Idempotency-Key"] = key
		}
		resp, err := r.sendJSON("POST", "/v1/jobs", req, headers)
		if err != nil {
			c.fail("%s: %v", what, err)
			return
		}
		if resp.status == 200 || resp.status == 201 {
			var j job
			_ = json.Unmarshal(resp.body, &j)
			c.fail("%s: the service accepted it (HTTP %d, job %s)", what, resp.status, j.ID)
			return
		}
		e := r.expectError(c, what, resp, 400, "invalid_request")
		if e != nil && what == "a prompt reference out of range" && e.Reason != "prompt_reference_out_of_range" {
			c.fail("%s: expected reason prompt_reference_out_of_range, got %q", what, e.Reason)
		}
	}

	req := base.clone()
	req.Model = "conformance/unknown-model-" + randomToken(6)
	submit("an unknown model", req, newKey("a6"))

	req = base.clone()
	req.Route = "conformance_unknown_route"
	submit("an unknown route", req, newKey("a6"))

	if name, value, ok := outOfRangeParameter(tc); ok {
		req = base.clone()
		req.Parameters[name] = value
		submit(fmt.Sprintf("parameter %s out of range (%v)", name, value), req, newKey("a6"))
	} else {
		c.note("the route has no parameter with a range or enum; the out-of-range submission was not tried")
	}

	if req, desc, ok := r.tooManyInputs(c, tc, base); ok {
		submit("too many inputs ("+desc+")", req, newKey("a6"))
	}

	if tc.route.hasParam("prompt") {
		images := 0
		for _, a := range base.Input.Artifacts {
			for _, s := range tc.route.Input.Slots {
				if s.Role == a.Role && s.Modality == "image" {
					images++
					break
				}
			}
		}
		req = base.clone()
		req.Parameters["prompt"] = fmt.Sprintf("a red square like @image%d", images+1)
		submit("a prompt reference out of range", req, newKey("a6"))
	} else {
		c.note("the route has no prompt parameter; the reference submission was not tried")
	}

	submit("no Idempotency-Key", base.clone(), "")

	if !r.opts.Live {
		c.note("without --live the valid submission after the invalid ones was not made")
		return
	}
	if _, err := r.budget(); err != nil {
		c.warn("the valid submission after the invalid ones was not made: %v", err)
		return
	}
	plan, err := r.getPlan()
	if err != nil {
		c.fatal("%v", err)
	}
	var audio []byte
	if plan.primary.capability == "transcription" {
		audio = speechSampleFor("en").data
	}
	valid := r.buildRequest(c, plan.primary, audio)
	resp, err := r.sendJSON("POST", "/v1/jobs", valid, map[string]string{"Idempotency-Key": newKey("a6-valid")})
	if err != nil {
		c.fatal("the valid submission: %v", err)
	}
	if resp.status != 200 && resp.status != 201 {
		c.fail("the valid submission after the invalid ones: HTTP %d (%s)", resp.status, snippet(resp.body))
		return
	}
	var j job
	_ = json.Unmarshal(resp.body, &j)
	r.rememberJob(j.ID)
}

// chooseBaseline picks the model and route A6 varies: a --model choice, else a manifest test entry,
// else an available route with a prompt and image inputs, else any route the suite can fill.
func (r *runner) chooseBaseline(cat *catalog) *testCase {
	for _, capability := range sortedKeys(r.opts.Models) {
		if mod, rt, err := r.resolveChoice(capability, r.opts.Models[capability]); err == nil {
			return &testCase{capability, mod, rt, map[string]any{}, "--model " + capability}
		}
	}
	if m := r.manifest; m != nil {
		for _, capability := range []string{"image", "video", "transcription"} {
			entry, ok := m.Test[capability]
			if !ok {
				continue
			}
			for i := range cat.Models {
				mod := &cat.Models[i]
				if mod.ID == entry.Model && mod.Available {
					if rt := mod.route(entry.Route); rt != nil && canFill(rt) {
						return &testCase{capability, mod, rt, copyParams(entry.Parameters), "the manifest"}
					}
				}
			}
		}
	}
	var fallback *testCase
	for i := range cat.Models {
		mod := &cat.Models[i]
		if !mod.Available {
			continue
		}
		for j := range mod.Routes {
			rt := &mod.Routes[j]
			if !canFill(rt) {
				continue
			}
			tc := &testCase{mod.Output.Modality, mod, rt, map[string]any{}, "the catalog"}
			if rt.hasParam("prompt") {
				for _, s := range rt.Input.Slots {
					if s.Modality == "image" && s.MaxArtifacts > 0 {
						return tc
					}
				}
			}
			if fallback == nil {
				fallback = tc
			}
		}
	}
	return fallback
}

// outOfRangeParameter finds a route parameter and a value outside its range or enum.
func outOfRangeParameter(tc *testCase) (string, any, bool) {
	for _, name := range tc.route.ParameterNames {
		p := tc.model.param(name)
		if p == nil {
			continue
		}
		if (p.Kind == "integer" || p.Kind == "number") && p.Max != nil {
			step := 1.0
			if p.Step != nil {
				step = *p.Step
			}
			return name, *p.Max + step, true
		}
	}
	// A number listed by its values: one more than the largest.
	for _, name := range tc.route.ParameterNames {
		p := tc.model.param(name)
		if p == nil || (p.Kind != "integer" && p.Kind != "number") || len(p.EnumValues) == 0 {
			continue
		}
		largest, ok := math.Inf(-1), false
		for _, raw := range p.EnumValues {
			var f float64
			if json.Unmarshal(raw, &f) == nil && f > largest {
				largest, ok = f, true
			}
		}
		if ok {
			return name, largest + 1, true
		}
	}
	for _, name := range tc.route.ParameterNames {
		p := tc.model.param(name)
		if p != nil && p.Kind == "enum" && len(p.EnumValues) > 0 {
			return name, "conformance-not-a-value", true
		}
	}
	for _, name := range tc.route.ParameterNames {
		p := tc.model.param(name)
		if p != nil && p.Kind == "text" && p.MaxLength != nil {
			return name, strings.Repeat("a", *p.MaxLength+1), true
		}
	}
	return "", nil, false
}

// tooManyInputs adds one input more than a slot allows.
func (r *runner) tooManyInputs(c *checkCtx, tc *testCase, base jobRequest) (jobRequest, string, bool) {
	for _, s := range tc.route.Input.Slots {
		if s.MaxArtifacts > 16 {
			continue
		}
		if _, _, ok := sampleFor(s, 0); !ok {
			continue
		}
		req := base.clone()
		have := 0
		for _, a := range req.Input.Artifacts {
			if a.Role == s.Role {
				have++
			}
		}
		for i := have; i <= s.MaxArtifacts; i++ {
			data, mt, _ := sampleFor(s, 100+i)
			a := r.mustUpload(c, data, mt, "conformance"+extensionFor(mt))
			req.Input.Artifacts = append(req.Input.Artifacts, inputRef{a.ID, s.Role, len(req.Input.Artifacts)})
		}
		return req, fmt.Sprintf("%d %s inputs, the slot allows %d", s.MaxArtifacts+1, s.Role, s.MaxArtifacts), true
	}
	if len(tc.route.Input.Slots) == 0 {
		req := base.clone()
		a := r.mustUpload(c, sampleImage("image/png", 7), "image/png", "conformance.png")
		req.Input.Artifacts = append(req.Input.Artifacts, inputRef{a.ID, "reference", 0})
		return req, "one input for a route without slots", true
	}
	c.note("no slot the suite can overfill; the too-many-inputs submission was not tried")
	return base, "", false
}

// A7: the same bytes uploaded twice get the same id; sha256 and bytes are right; metadata and
// content match the upload; an upload above the declared max_bytes gets 413. The download may
// redirect (spec/v1.md section 3.4); the final response is checked.
func checkA7(r *runner, c *checkCtx) {
	data := sampleImage("image/png", int(time.Now().UnixNano()%1000))
	first := r.mustUpload(c, data, "image/png", "conformance.png")
	second := r.mustUpload(c, data, "image/png", "conformance-again.png")
	if first.ID != second.ID {
		c.fail("the same bytes uploaded twice got two ids: %s and %s", first.ID, second.ID)
	}
	want := sha256Hex(data)
	if !strings.EqualFold(first.SHA256, want) {
		c.fail("upload: sha256 is %s, the bytes sent hash to %s", first.SHA256, want)
	}
	if first.Bytes != int64(len(data)) {
		c.fail("upload: bytes is %d, %d were sent", first.Bytes, len(data))
	}
	if baseMediaType(first.MediaType) != "image/png" {
		c.fail("upload: media_type is %q, image/png was sent", first.MediaType)
	}

	resp := r.mustSend(c, request{method: "GET", path: "/v1/artifacts/" + first.ID})
	if resp.status != 200 {
		c.fail("GET /v1/artifacts/%s: HTTP %d (%s)", first.ID, resp.status, snippet(resp.body))
	} else if err := r.schemas.validate("artifact", resp.json); err != nil {
		c.fail("GET /v1/artifacts/%s: the response %v", first.ID, err)
	} else {
		var meta artifact
		_ = json.Unmarshal(resp.body, &meta)
		if meta.ID != first.ID || !strings.EqualFold(meta.SHA256, want) || meta.Bytes != int64(len(data)) || baseMediaType(meta.MediaType) != "image/png" {
			c.fail("GET /v1/artifacts/%s does not match the upload: %s", first.ID, snippet(resp.body))
		}
	}

	resp = r.mustSend(c, request{method: "GET", path: "/v1/artifacts/" + first.ID + "/content", download: true, timeout: 5 * time.Minute})
	switch {
	case resp.status != 200:
		c.fail("GET /v1/artifacts/%s/content: HTTP %d (%s)", first.ID, resp.status, snippet(resp.body))
	case string(resp.body) != string(data):
		c.fail("the downloaded content differs from the upload (%d bytes, sha256 %s)", len(resp.body), sha256Hex(resp.body))
	}
	if resp.status == 200 {
		if ct := resp.header.Get("Content-Type"); baseMediaType(ct) != "image/png" {
			c.fail("the download has Content-Type %q, expected image/png", ct)
		}
		if cl := resp.header.Get("Content-Length"); cl != strconv.Itoa(len(data)) {
			c.fail("the download has Content-Length %q, expected %d", cl, len(data))
		}
	}

	// 413 above the largest declared max_bytes.
	limit, mediaType := largestMaxBytes(r.cat)
	switch {
	case limit == 0:
		c.note("not every input slot of the catalog has a max_bytes, so uploads have no declared limit; the 413 upload was not tried")
	case limit > 256<<20:
		c.note("the largest max_bytes is %d bytes; the suite does not send more than 256 MiB, so the 413 upload was not tried", limit)
	default:
		big := make([]byte, limit+1)
		copy(big, sampleImage("image/png", 3))
		resp, err := r.upload(big, mediaType, "conformance-too-large"+extensionFor(mediaType))
		if err != nil {
			c.fail("uploading %d bytes: %v", limit+1, err)
			break
		}
		e := r.expectError(c, fmt.Sprintf("uploading %d bytes (max_bytes %d)", limit+1, limit), resp, 413, "payload_too_large")
		if e != nil {
			if v, ok := e.Params["max_bytes"].(float64); !ok || int64(v) < limit {
				c.fail("the 413 error should carry params.max_bytes (at least %d), got %v", limit, e.Params["max_bytes"])
			}
		}
		c.note("413 tried with the largest max_bytes of the catalog (%d)", limit)
	}
}

// largestMaxBytes returns the largest max_bytes in the catalog and a media type its slot accepts. It
// returns 0 when there is no slot or a slot has no max_bytes: then uploads have no declared limit
// (spec/v1.md section 3.4).
func largestMaxBytes(cat *catalog) (int64, string) {
	if cat == nil {
		return 0, ""
	}
	var limit int64
	mediaType := ""
	for _, m := range cat.Models {
		for _, rt := range m.Routes {
			for _, s := range rt.Input.Slots {
				if s.MaxBytes == nil {
					return 0, ""
				}
				if *s.MaxBytes > limit && len(s.MediaTypes) > 0 {
					limit, mediaType = *s.MaxBytes, s.MediaTypes[0]
				}
			}
		}
	}
	return limit, mediaType
}

// A8: an unknown job and an unknown artifact get 404 with the standard error body.
func checkA8(r *runner, c *checkCtx) {
	missing := randomToken(10)
	probes := []request{
		{method: "GET", path: "/v1/jobs/job_conformance_missing_" + missing, class: "query"},
		{method: "GET", path: "/v1/artifacts/art_conformance_missing_" + missing},
		{method: "GET", path: "/v1/artifacts/art_conformance_missing_" + missing + "/content"},
	}
	if r.desc != nil && r.desc.Capabilities.Cancel {
		probes = append(probes, request{method: "POST", path: "/v1/jobs/job_conformance_missing_" + missing + "/cancel"})
	}
	for _, q := range probes {
		resp, err := r.send(q)
		if err != nil {
			c.fail("%s %s: %v", q.method, q.path, err)
			continue
		}
		r.expectError(c, q.method+" "+q.path, resp, 404, "not_found")
	}
}

// Response-time limits of A9 (spec/v1.md section 3.1). Variables so the suite's own tests can lower
// them.
var (
	responseMust   = 30 * time.Second
	responseShould = 10 * time.Second
)

// A9: describe, catalog and query answer within 30 s; slower than 10 s is a warning.
func checkA9(r *runner, c *checkCtx) {
	for i := 0; i < 3; i++ {
		_, _ = r.send(request{method: "GET", path: "/v1/provider", class: "describe"})
		_, _ = r.send(request{method: "GET", path: "/v1/models", class: "catalog"})
		_, _ = r.send(request{method: "GET", path: "/v1/jobs/job_conformance_missing", class: "query"})
	}
	parts := []string{}
	for _, class := range []string{"describe", "catalog", "query"} {
		max, n := r.maxTiming(class)
		parts = append(parts, fmt.Sprintf("%s max %d ms over %d requests", class, max.Milliseconds(), n))
		switch {
		case max > responseMust:
			c.fail("a %s request took %s; the limit is %s", class, max.Round(time.Millisecond), responseMust)
		case max > responseShould:
			c.warn("a %s request took %s; it should take less than %s", class, max.Round(time.Millisecond), responseShould)
		}
	}
	c.note("%s", strings.Join(parts, "; "))
}
