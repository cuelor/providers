package conformance

// The job states of v1 (spec/v1.md section 3.5.3). The set is closed.
var (
	initialStates  = map[string]bool{"queued": true, "running": true, "pending_approval": true}
	terminalStates = map[string]bool{"succeeded": true, "failed": true, "rejected": true, "expired": true, "cancelled": true}
)

// transitions are the direct edges of the diagram in section 3.5.3:
//
//	queued ──> running ──> succeeded
//	  │  ↘        │
//	  │   pending_approval ──> queued | rejected | expired | cancelled
//	  └──────────┴──> failed | rejected | cancelled
//
// plus running -> pending_approval, which the section allows in its text.
var transitions = map[string][]string{
	"queued":           {"running", "pending_approval", "failed", "rejected", "cancelled"},
	"running":          {"succeeded", "failed", "rejected", "cancelled", "pending_approval"},
	"pending_approval": {"queued", "rejected", "expired", "cancelled"},
}

// reachable reports whether a poller may see state to after state from. Polling can miss
// intermediate states, so any path through the diagram is allowed; staying in a state is too.
func reachable(from, to string) bool {
	if from == to {
		return true
	}
	seen := map[string]bool{from: true}
	queue := []string{from}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, next := range transitions[cur] {
			if next == to {
				return true
			}
			if !seen[next] {
				seen[next] = true
				queue = append(queue, next)
			}
		}
	}
	return false
}
