package conformance

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// observation is one state of a job as the suite saw it.
type observation struct {
	job  job
	from string // what returned it: submit, replay, query, cancel
}

// stateIssues checks a sequence of observations against the state machine: valid states,
// transitions in the diagram, terminal states never change, updated_at never decreases.
func stateIssues(obs []observation) []string {
	var out []string
	for i := 1; i < len(obs); i++ {
		prev, cur := obs[i-1].job, obs[i].job
		if terminalStates[prev.Status] && cur.Status != prev.Status {
			out = append(out, fmt.Sprintf("terminal state %s changed to %s (%s)", prev.Status, cur.Status, obs[i].from))
		} else if !reachable(prev.Status, cur.Status) {
			out = append(out, fmt.Sprintf("transition %s -> %s is not in the state diagram (%s)", prev.Status, cur.Status, obs[i].from))
		}
		pt, ct := prev.updated(), cur.updated()
		if !pt.IsZero() && !ct.IsZero() && ct.Before(pt) {
			out = append(out, fmt.Sprintf("updated_at went back from %s to %s (%s)", prev.UpdatedAt, cur.UpdatedAt, obs[i].from))
		}
	}
	return out
}

// submitJob posts a job request with a key.
func (r *runner) submitJob(key string, req jobRequest) (*response, error) {
	return r.sendJSON("POST", "/v1/jobs", req, map[string]string{"Idempotency-Key": key})
}

// decodeJob validates a job response and decodes it. It records a failure and returns nil when the
// response is not a valid job object.
func (r *runner) decodeJob(c *checkCtx, what string, resp *response) *job {
	if resp.status != 200 && resp.status != 201 {
		c.fail("%s: expected a job object, got HTTP %d (%s)", what, resp.status, snippet(resp.body))
		return nil
	}
	if err := r.schemas.validate("job", resp.json); err != nil {
		c.fail("%s: the job %v", what, err)
		return nil
	}
	var j job
	if err := json.Unmarshal(resp.body, &j); err != nil {
		c.fail("%s: %v", what, err)
		return nil
	}
	r.rememberJob(j.ID)
	return &j
}

// submitWithRetry replays a submission the way a client does after an unknown result: on transport
// errors, 5xx and 429 it waits and tries again, for up to the given time.
func (r *runner) submitWithRetry(c *checkCtx, what, key string, req jobRequest, within time.Duration) *job {
	deadline := time.Now().Add(within)
	wait := 250 * time.Millisecond
	var last string
	for {
		resp, err := r.submitJob(key, req)
		switch {
		case err != nil:
			last = err.Error()
		case resp.status >= 500 || resp.status == 429:
			last = fmt.Sprintf("HTTP %d (%s)", resp.status, snippet(resp.body))
		default:
			return r.decodeJob(c, what, resp)
		}
		if time.Now().After(deadline) {
			c.fail("%s: no job after retrying for %s; last answer: %s", what, within, last)
			return nil
		}
		if !r.sleep(wait) {
			c.fail("%s: the run was cancelled; last answer: %s", what, last)
			return nil
		}
		if wait < 2*time.Second {
			wait *= 2
		}
	}
}

// getJob queries a job, retrying transient failures briefly.
func (r *runner) getJob(c *checkCtx, what, id string) *job {
	var last string
	for attempt := 0; attempt < 5; attempt++ {
		resp, err := r.send(request{method: "GET", path: "/v1/jobs/" + id, class: "query"})
		switch {
		case err != nil:
			last = err.Error()
		case resp.status >= 500 || resp.status == 429:
			last = fmt.Sprintf("HTTP %d (%s)", resp.status, snippet(resp.body))
		default:
			return r.decodeJob(c, what, resp)
		}
		if !r.sleep(time.Duration(attempt+1) * 300 * time.Millisecond) {
			break
		}
	}
	c.fail("%s: %s", what, last)
	return nil
}

// poll queries a job until it ends or the job timeout passes. every is called after each query.
func (r *runner) poll(c *checkCtx, id string, obs *[]observation, every func(n int, j *job)) *job {
	deadline := time.Now().Add(r.opts.JobTimeout)
	interval := 250 * time.Millisecond
	for n := 1; ; n++ {
		j := r.getJob(c, "GET /v1/jobs/"+id, id)
		if j == nil {
			return nil
		}
		if j.ID != id {
			c.fail("GET /v1/jobs/%s returned job %s", id, j.ID)
		}
		*obs = append(*obs, observation{*j, "query"})
		if every != nil {
			every(n, j)
		}
		if terminalStates[j.Status] {
			return j
		}
		if time.Now().After(deadline) {
			c.fail("job %s did not end within %s (last state %s)", id, r.opts.JobTimeout, j.Status)
			return nil
		}
		if !r.sleep(interval) {
			c.fail("job %s: the run was cancelled while it was %s", id, j.Status)
			return nil
		}
		if interval < 3*time.Second {
			interval = interval * 3 / 2
		}
	}
}

// verifyOutputs checks a succeeded job's outputs (B5): exactly one of the right role; the content's
// length and SHA-256 match; the file header matches the media type; with ffprobe, video and audio
// decode and their duration is within 5 % of the metadata. It returns the downloaded bytes.
func (r *runner) verifyOutputs(c *checkCtx, label string, tc *testCase, j *job) []byte {
	if j.Status != "succeeded" {
		msg := ""
		if j.Error != nil {
			msg = fmt.Sprintf(" (%s: %s)", j.Error.Code, j.Error.Message)
		}
		c.fail("%s: the job ended %s%s, so its output could not be checked", label, j.Status, msg)
		return nil
	}
	wantRole := "output"
	if tc.capability == "transcription" {
		wantRole = "transcript"
	}
	if len(j.Outputs) != 1 {
		c.fail("%s: a succeeded job must have exactly one output, it has %d", label, len(j.Outputs))
		if len(j.Outputs) == 0 {
			return nil
		}
	}
	out := j.Outputs[0]
	if out.Role != wantRole {
		c.fail("%s: the output's role is %q, expected %q", label, out.Role, wantRole)
	}
	if tc.capability == "transcription" {
		if baseMediaType(out.MediaType) != TranscriptMediaType {
			c.fail("%s: the transcript's media_type is %q, expected %s", label, out.MediaType, TranscriptMediaType)
		}
	} else if mediaKind(out.MediaType) != tc.capability {
		c.fail("%s: the output's media_type %q is not %s", label, out.MediaType, tc.capability)
	}

	resp, err := r.send(request{method: "GET", path: "/v1/artifacts/" + out.ArtifactID + "/content", download: true, timeout: 10 * time.Minute})
	if err != nil {
		c.fail("%s: downloading %s: %v", label, out.ArtifactID, err)
		return nil
	}
	if resp.status != 200 {
		c.fail("%s: downloading %s: HTTP %d (%s)", label, out.ArtifactID, resp.status, snippet(resp.body))
		return nil
	}
	data := resp.body
	if int64(len(data)) != out.Bytes {
		c.fail("%s: the download has %d bytes, the job says %d", label, len(data), out.Bytes)
	}
	if got := sha256Hex(data); !strings.EqualFold(got, out.SHA256) {
		c.fail("%s: the download's SHA-256 is %s, the job says %s", label, got, out.SHA256)
	}
	if ct := baseMediaType(resp.header.Get("Content-Type")); ct != baseMediaType(out.MediaType) {
		c.fail("%s: the download has Content-Type %q, the job says %q", label, resp.header.Get("Content-Type"), out.MediaType)
	}
	if resp.header.Get("Content-Length") == "" {
		c.fail("%s: the download has no Content-Length", label)
	}
	if match, known := headerMatches(out.MediaType, data); !known {
		c.note("%s: the suite cannot identify %s by its header", label, out.MediaType)
	} else if !match {
		c.fail("%s: the file header does not match %s", label, out.MediaType)
	}
	if tc.capability == "transcription" {
		if v, err := decodeAny(data); err != nil {
			c.fail("%s: the transcript is not JSON: %v", label, err)
		} else if err := r.schemas.validate("transcript", v); err != nil {
			c.fail("%s: the transcript %v", label, err)
		}
	}
	kind := mediaKind(out.MediaType)
	if kind == "video" || kind == "audio" {
		if ffprobe := r.ffprobePath(); ffprobe == "" {
			c.note("%s: ffprobe not available; decoding was not checked", label)
		} else if res, err := probe(ffprobe, data, out.MediaType); err != nil {
			c.fail("%s: %v", label, err)
		} else if out.Metadata == nil || out.Metadata.DurationMS == nil {
			c.note("%s: decodes (%d frames, %d ms); the job gives no metadata.duration_ms to compare", label, res.frames, res.durationMS)
		} else {
			want := float64(*out.Metadata.DurationMS)
			diff := float64(res.durationMS) - want
			if diff < 0 {
				diff = -diff
			}
			if want > 0 && diff/want > 0.05 {
				c.fail("%s: ffprobe measures %d ms, metadata.duration_ms is %d (more than 5%% apart)", label, res.durationMS, *out.Metadata.DurationMS)
			} else {
				c.note("%s: decodes, %d ms", label, res.durationMS)
			}
		}
	}
	return data
}

// usageIssues checks a terminal job's usage (B10).
func (r *runner) usageIssues(c *checkCtx, label string, tc *testCase, req jobRequest, j *job) {
	if j.Usage == nil {
		c.fail("%s: the ended job has no usage", label)
		return
	}
	if j.Usage.Unit != r.desc.Billing.Unit {
		c.note("%s: usage is in %s, billing.unit is %s", label, j.Usage.Unit, r.desc.Billing.Unit)
	}
	if !r.desc.Capabilities.Estimate {
		return
	}
	resp, err := r.send(request{method: "POST", path: "/v1/estimates", body: req.body(), contentType: "application/json"})
	if err != nil || resp.status != 200 {
		c.warn("%s: could not get an estimate to compare with the usage", label)
		return
	}
	var e estimate
	if json.Unmarshal(resp.body, &e) != nil {
		return
	}
	est, used := e.Estimate.Amount, j.Usage.Amount
	big := est
	if used > big {
		big = used
	}
	if big > 0 && abs(est-used)/big > 0.5 {
		c.warn("%s: the estimate (%g %s) and the usage (%g %s) differ by more than 50%%", label, est, e.Estimate.Unit, used, j.Usage.Unit)
	}
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
