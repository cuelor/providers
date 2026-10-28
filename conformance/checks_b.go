package conformance

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

// primaryRun is the job that B1–B5 and B10 look at. It is submitted once and observed through its
// whole life; each check reports the part it is about.
type primaryRun struct {
	tc   *testCase
	req  jobRequest
	key  string
	jobs map[string]*checkCtx // findings per check id
	// fatal ends every check of the flow, for example when the submission itself fails.
	fatal string
}

func (p *primaryRun) ctx(id string) *checkCtx {
	if p.jobs[id] == nil {
		p.jobs[id] = &checkCtx{}
	}
	return p.jobs[id]
}

// report copies the findings for one check into its context.
func (p *primaryRun) report(id string, c *checkCtx) {
	if p.fatal != "" {
		c.fail("%s", p.fatal)
	}
	if f := p.jobs[id]; f != nil {
		c.failures = append(c.failures, f.failures...)
		c.warnings = append(c.warnings, f.warnings...)
		c.notes = append(c.notes, f.notes...)
	}
}

func (r *runner) livePrelude(c *checkCtx) *livePlan {
	r.requireDescription(c)
	r.requireBudget(c)
	plan, err := r.getPlan()
	if err != nil {
		c.fatal("%v", err)
	}
	return plan
}

func (r *runner) primaryFlow(c *checkCtx) *primaryRun {
	plan := r.livePrelude(c)
	r.primaryOnce.Do(func() {
		r.primary = &primaryRun{tc: plan.primary, jobs: map[string]*checkCtx{}}
		r.primary.ctx("B1").note("%s", r.budgetNote)
		r.runPrimary(r.primary)
		for i := range plan.extra {
			r.runExtra(r.primary, &plan.extra[i])
		}
	})
	return r.primary
}

func (r *runner) runPrimary(p *primaryRun) {
	defer func() {
		if e := recover(); e != nil {
			if _, ok := e.(checkAbort); !ok {
				panic(e)
			}
		}
	}()
	b1, b2, b3, b4, b5, b10 := p.ctx("B1"), p.ctx("B2"), p.ctx("B3"), p.ctx("B4"), p.ctx("B5"), p.ctx("B10")
	setup := &checkCtx{}
	func() {
		defer func() {
			if e := recover(); e != nil {
				if _, ok := e.(checkAbort); !ok {
					panic(e)
				}
				p.fatal = "preparing the request: " + strings.Join(setup.failures, "; ")
			}
		}()
		var audio []byte
		if p.tc.capability == "transcription" {
			audio = speechSampleFor("en").data
		}
		p.req = r.buildRequest(setup, p.tc, audio)
	}()
	if p.fatal != "" {
		return
	}
	b1.note("job for %s, from %s", p.tc.label(), p.tc.source)
	p.key = newKey("b1")

	// B1: the submission.
	resp, err := r.submitJob(p.key, p.req)
	if err != nil {
		p.fatal = "the submission failed: " + err.Error()
		return
	}
	if resp.elapsed > responseMust {
		b1.fail("the submission took %s; the limit is %s", resp.elapsed.Round(time.Millisecond), responseMust)
	}
	first := r.decodeJob(b1, "POST /v1/jobs", resp)
	if first == nil {
		p.fatal = "the submission did not return a job object (see B1)"
		return
	}
	if !initialStates[first.Status] {
		b1.fail("the new job is %s; a new job must be queued, running or pending_approval", first.Status)
	}
	obs := []observation{{*first, "submit"}}

	// B2: an immediate replay.
	replay := func(when string) *job {
		resp, err := r.submitJob(p.key, p.req)
		if err != nil {
			b2.fail("replay %s: %v", when, err)
			return nil
		}
		j := r.decodeJob(b2, "replay "+when, resp)
		if j != nil && j.ID != first.ID {
			b2.fail("replay %s returned job %s instead of %s", when, j.ID, first.ID)
		}
		return j
	}
	if j := replay("immediately"); j != nil {
		obs = append(obs, observation{*j, "replay"})
	}

	// B3: the same key with a different body.
	if other, what, ok := conflictingRequest(p.tc, p.req); ok {
		resp, err := r.submitJob(p.key, other)
		if err != nil {
			b3.fail("the conflicting submission: %v", err)
		} else {
			r.expectError(b3, "the same key with "+what, resp, 409, "idempotency_conflict")
		}
		if j := r.getJob(b3, "the original job after the conflict", first.ID); j != nil {
			obs = append(obs, observation{*j, "query"})
			if j.Model != "" && j.Model != p.req.Model {
				b3.fail("after the conflicting submission the job's model is %s", j.Model)
			}
		}
		if j := replay("after the conflict"); j != nil {
			obs = append(obs, observation{*j, "replay"})
		}
		b3.note("conflict built with %s", what)
	} else {
		b3.fail("the suite could not build a different valid body for %s (no prompt, enum or boolean parameter)", p.tc.label())
	}

	// B4: poll to the end, replaying once while polling.
	replayedWhilePolling := false
	final := r.poll(b4, first.ID, &obs, func(n int, j *job) {
		if n == 2 && !terminalStates[j.Status] {
			if rj := replay("while polling"); rj != nil {
				obs = append(obs, observation{*rj, "replay"})
				replayedWhilePolling = true
			}
		}
	})
	if !replayedWhilePolling {
		b2.note("the job ended before a replay while polling was possible")
	}
	if final == nil {
		for _, issue := range stateIssues(obs) {
			b4.fail("%s", issue)
		}
		b5.fail("the job did not end")
		b10.fail("the job did not end")
		return
	}
	for i := 0; i < 3; i++ {
		if j := r.getJob(b4, "query after the end", first.ID); j != nil {
			obs = append(obs, observation{*j, "query after the end"})
			if !sameOutcome(final, j) {
				b4.fail("the ended job changed on query %d after the end", i+1)
			}
		}
	}
	if j := replay("after the end"); j != nil {
		obs = append(obs, observation{*j, "replay after the end"})
		if j.Status != final.Status {
			b2.fail("replay after the end returned state %s, the job ended %s", j.Status, final.Status)
		}
	}
	for _, issue := range stateIssues(obs) {
		b4.fail("%s", issue)
	}
	b4.note("states seen: %s", stateTrail(obs))

	// B5 and B10.
	r.verifyOutputs(b5, p.tc.label(), p.tc, final)
	r.usageIssues(b10, p.tc.label(), p.tc, p.req, final)
}

// runExtra runs one job for another generation capability and adds its findings to B4, B5, B10.
func (r *runner) runExtra(p *primaryRun, tc *testCase) {
	b4, b5, b10 := p.ctx("B4"), p.ctx("B5"), p.ctx("B10")
	c := &checkCtx{}
	defer func() {
		if e := recover(); e != nil {
			if _, ok := e.(checkAbort); !ok {
				panic(e)
			}
		}
		for _, f := range c.failures {
			b4.fail("%s: %s", tc.label(), f)
		}
	}()
	req := r.buildRequest(c, tc, nil)
	resp, err := r.submitJob(newKey("extra"), req)
	if err != nil {
		c.fatal("submitting: %v", err)
	}
	first := r.decodeJob(c, "POST /v1/jobs", resp)
	if first == nil {
		return
	}
	obs := []observation{{*first, "submit"}}
	final := r.poll(c, first.ID, &obs, nil)
	for _, issue := range stateIssues(obs) {
		b4.fail("%s: %s", tc.label(), issue)
	}
	if final == nil {
		return
	}
	b4.note("%s: states seen: %s", tc.label(), stateTrail(obs))
	r.verifyOutputs(b5, tc.label(), tc, final)
	r.usageIssues(b10, tc.label(), tc, req, final)
}

func sameOutcome(a, b *job) bool {
	if a.Status != b.Status || a.errorCode() != b.errorCode() || len(a.Outputs) != len(b.Outputs) {
		return false
	}
	for i := range a.Outputs {
		if a.Outputs[i].ArtifactID != b.Outputs[i].ArtifactID || !strings.EqualFold(a.Outputs[i].SHA256, b.Outputs[i].SHA256) {
			return false
		}
	}
	return true
}

func stateTrail(obs []observation) string {
	trail := []string{}
	for _, o := range obs {
		if len(trail) == 0 || trail[len(trail)-1] != o.job.Status {
			trail = append(trail, o.job.Status)
		}
	}
	return strings.Join(trail, " -> ")
}

// B1: the submission returns a job object within 30 s, in a valid initial state.
func checkB1(r *runner, c *checkCtx) { r.primaryFlow(c).report("B1", c) }

// B2: replays immediately, while polling and after the end all return the same job id.
func checkB2(r *runner, c *checkCtx) { r.primaryFlow(c).report("B2", c) }

// B3: the same key with a different body gets 409 idempotency_conflict; the job is unaffected.
func checkB3(r *runner, c *checkCtx) { r.primaryFlow(c).report("B3", c) }

// B4: every polled state is in the set and every transition in the diagram; the ended job stays the
// same over 3 more queries; updated_at never decreases.
func checkB4(r *runner, c *checkCtx) { r.primaryFlow(c).report("B4", c) }

// B5: a succeeded job has exactly one output whose content, header and duration are right.
func checkB5(r *runner, c *checkCtx) { r.primaryFlow(c).report("B5", c) }

// B10: an ended job has usage with a valid unit and basis; an estimate more than 50 % away from it
// is a warning.
func checkB10(r *runner, c *checkCtx) { r.primaryFlow(c).report("B10", c) }

// liveRequest prepares a fresh request for the primary case.
func (r *runner) liveRequest(c *checkCtx) (*testCase, jobRequest) {
	plan := r.livePrelude(c)
	var audio []byte
	if plan.primary.capability == "transcription" {
		audio = speechSampleFor("en").data
	}
	return plan.primary, r.buildRequest(c, plan.primary, audio)
}

// B6: kill -9 right after sending a submission, restart with the same data directory and replay
// the same key: one job, the same id twice more, or failed with submission_unknown.
func checkB6(r *runner, c *checkCtx) {
	_, req := r.liveRequest(c)
	key := newKey("b6")
	binding := r.desc.Account.Binding
	// The whole request goes onto the socket and the process group is killed a few milliseconds
	// later, without waiting for an answer: the plugin may be anywhere in handling it.
	conn, err := r.writeRequest(key, req.body())
	if err != nil {
		c.fatal("sending the submission: %v", err)
	}
	time.Sleep(3 * time.Millisecond)
	r.cmd.kill9()
	conn.Close()
	if err := r.cmd.restart(r.ctx); err != nil {
		c.fatal("restarting the plugin: %v", err)
	}
	r.refreshDescription()
	if r.desc != nil && r.desc.Account.Binding != binding {
		c.fail("account.binding changed after a restart with the same data directory")
	}
	j := r.submitWithRetry(c, "the replay after the restart", key, req, 30*time.Second)
	if j == nil {
		return
	}
	if j.Status == "failed" && j.errorCode() == "submission_unknown" {
		c.note("the replay ended the job failed with submission_unknown")
	}
	for i := 0; i < 2; i++ {
		again := r.submitWithRetry(c, "another replay", key, req, 30*time.Second)
		if again != nil && again.ID != j.ID {
			c.fail("replay %d returned job %s instead of %s", i+2, again.ID, j.ID)
		}
	}
	c.note("job %s, %s", j.ID, j.Status)
}

// b7Attempts is how many jobs B7 submits at most to catch one running. The budget counts them all.
const b7Attempts = 3

// b7WaitForRunning bounds how long B7 waits for one job to leave queued or pending_approval.
const b7WaitForRunning = time.Minute

// B7: kill -9 while a job runs, restart, and query the same id: it reaches a terminal state. A job
// that ends before it is seen running is replaced by a new one; when none is seen running, the
// restart is still checked on the last job but the check only warns.
func checkB7(r *runner, c *checkCtx) {
	_, req := r.liveRequest(c)
	var first *job
	var obs []observation
	running := false
	for attempt := 1; attempt <= b7Attempts && !running; attempt++ {
		resp, err := r.submitJob(newKey("b7"), req)
		if err != nil {
			c.fatal("submitting: %v", err)
		}
		first = r.decodeJob(c, "POST /v1/jobs", resp)
		if first == nil {
			return
		}
		obs = []observation{{*first, "submit"}}
		cur := first
		deadline := time.Now().Add(b7WaitForRunning)
		for cur.Status != "running" && !terminalStates[cur.Status] && time.Now().Before(deadline) {
			if !r.sleep(50 * time.Millisecond) {
				c.fatal("the run was cancelled")
			}
			if j := r.getJob(c, "GET /v1/jobs/"+first.ID, first.ID); j != nil {
				cur = j
				obs = append(obs, observation{*j, "query"})
			}
		}
		running = cur.Status == "running"
		if !running {
			c.note("attempt %d: job %s was %s, not running, when the suite looked", attempt, first.ID, cur.Status)
		}
	}
	if running {
		c.note("killed the plugin while the job was running")
	} else {
		c.warn("never saw a job running in %d attempts, so the plugin was not killed during a run; checked only that the last job survives a restart", b7Attempts)
	}
	r.cmd.kill9()
	if err := r.cmd.restart(r.ctx); err != nil {
		c.fatal("restarting the plugin: %v", err)
	}
	r.refreshDescription()
	resp, err := r.send(request{method: "GET", path: "/v1/jobs/" + first.ID, class: "query"})
	if err != nil {
		c.fatal("querying the job after the restart: %v", err)
	}
	if resp.status == 404 {
		c.fatal("after the restart the plugin does not know job %s (HTTP 404)", first.ID)
	}
	final := r.poll(c, first.ID, &obs, nil)
	for _, issue := range stateIssues(obs) {
		c.fail("%s", issue)
	}
	if final != nil {
		c.note("states seen: %s", stateTrail(obs))
	}
}

// B8: the client sends the whole body and disconnects; a replay with the same key returns the job,
// and another replay the same id.
func checkB8(r *runner, c *checkCtx) {
	_, req := r.liveRequest(c)
	key := newKey("b8")
	if err := r.sendAndHangUp(key, req.body()); err != nil {
		c.fatal("sending the request: %v", err)
	}
	if !r.sleep(time.Second) {
		c.fatal("the run was cancelled")
	}
	j := r.submitWithRetry(c, "the replay after the disconnect", key, req, 30*time.Second)
	if j == nil {
		return
	}
	again := r.submitWithRetry(c, "a second replay", key, req, 30*time.Second)
	if again != nil && again.ID != j.ID {
		c.fail("the second replay returned job %s instead of %s", again.ID, j.ID)
	}
	c.note("job %s", j.ID)
}

// sendAndHangUp writes a complete POST /v1/jobs request and closes the connection without reading
// the response.
func (r *runner) sendAndHangUp(key string, body []byte) error {
	conn, err := r.writeRequest(key, body)
	if err != nil {
		return err
	}
	return conn.Close()
}

// writeRequest opens a connection and writes a complete POST /v1/jobs request to it.
func (r *runner) writeRequest(key string, body []byte) (net.Conn, error) {
	u, err := url.Parse(r.t.baseURL())
	if err != nil {
		return nil, err
	}
	host := u.Host
	if u.Port() == "" {
		if u.Scheme == "https" {
			host += ":443"
		} else {
			host += ":80"
		}
	}
	var conn net.Conn
	if u.Scheme == "https" {
		conn, err = tls.DialWithDialer(&net.Dialer{Timeout: 10 * time.Second}, "tcp", host, &tls.Config{ServerName: u.Hostname()})
	} else {
		conn, err = net.DialTimeout("tcp", host, 10*time.Second)
	}
	if err != nil {
		return nil, err
	}
	var head strings.Builder
	fmt.Fprintf(&head, "POST %s/v1/jobs HTTP/1.1\r\n", strings.TrimRight(u.Path, "/"))
	fmt.Fprintf(&head, "Host: %s\r\n", u.Host)
	fmt.Fprintf(&head, "Authorization: Bearer %s\r\n", r.t.token())
	fmt.Fprintf(&head, "Idempotency-Key: %s\r\n", key)
	fmt.Fprintf(&head, "Cuelor-Protocol: %s\r\n", ProtocolVersion)
	fmt.Fprintf(&head, "Content-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", len(body))
	if _, err := conn.Write(append([]byte(head.String()), body...)); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

// B9: cancelling a running job ends it cancelled or leaves the state unchanged; cancelling again is
// not an error.
func checkB9(r *runner, c *checkCtx) {
	_, req := r.liveRequest(c)
	resp, err := r.submitJob(newKey("b9"), req)
	if err != nil {
		c.fatal("submitting: %v", err)
	}
	first := r.decodeJob(c, "POST /v1/jobs", resp)
	if first == nil {
		return
	}
	obs := []observation{{*first, "submit"}}
	cancel := func(what string) *job {
		resp, err := r.send(request{method: "POST", path: "/v1/jobs/" + first.ID + "/cancel"})
		if err != nil {
			c.fail("%s: %v", what, err)
			return nil
		}
		j := r.decodeJob(c, what, resp)
		if j != nil {
			if j.ID != first.ID {
				c.fail("%s returned job %s instead of %s", what, j.ID, first.ID)
			}
			obs = append(obs, observation{*j, "cancel"})
		}
		return j
	}
	if j := cancel("cancelling"); j != nil {
		c.note("the job was %s when cancelled; the cancel returned %s", first.Status, j.Status)
	}
	cancel("cancelling again")
	final := r.poll(c, first.ID, &obs, nil)
	if final == nil {
		return
	}
	if final.Status == "cancelled" {
		if final.errorCode() != "cancelled" {
			c.fail("the cancelled job's error.code is %q, expected cancelled", final.errorCode())
		}
	} else {
		c.note("the job ended %s; the upstream could not cancel it", final.Status)
	}
	if j := cancel("cancelling the ended job"); j != nil && j.Status != final.Status {
		c.fail("cancelling the ended job changed its state from %s to %s", final.Status, j.Status)
	}
	for _, issue := range stateIssues(obs) {
		c.fail("%s", issue)
	}
}

// B11: an estimate has a valid format and creates no job: submitting the same body with a new key
// afterwards creates a new job.
func checkB11(r *runner, c *checkCtx) {
	_, req := r.liveRequest(c)
	resp := r.mustSend(c, request{method: "POST", path: "/v1/estimates", body: req.body(), contentType: "application/json"})
	if resp.status != 200 {
		c.fatal("POST /v1/estimates: HTTP %d (%s)", resp.status, snippet(resp.body))
	}
	if err := r.schemas.validate("estimate", resp.json); err != nil {
		c.fail("POST /v1/estimates: the response %v", err)
	}
	var e estimate
	_ = json.Unmarshal(resp.body, &e)
	if e.Estimate.Unit != r.desc.Billing.Unit {
		c.note("the estimate is in %s, billing.unit is %s", e.Estimate.Unit, r.desc.Billing.Unit)
	}
	resp, err := r.submitJob(newKey("b11"), req)
	if err != nil {
		c.fatal("submitting after the estimate: %v", err)
	}
	r.mu.Lock()
	known := map[string]bool{}
	for id := range r.jobIDs {
		known[id] = true
	}
	r.mu.Unlock()
	j := r.decodeJob(c, "the submission after the estimate", resp)
	if j == nil {
		return
	}
	if known[j.ID] {
		c.fail("the submission after the estimate returned job %s, which existed before", j.ID)
	}
	if !initialStates[j.Status] {
		c.fail("the job submitted after the estimate is already %s; a new job starts queued, running or pending_approval", j.Status)
	}
	c.note("estimate %g %s (%s)", e.Estimate.Amount, e.Estimate.Unit, e.Estimate.Basis)
}

func decodeAny(b []byte) (any, error) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}
