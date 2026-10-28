package conformance

import (
	"encoding/json"
	"strings"
	"time"
)

// The structures below decode only what the checks need. Shapes are validated against the JSON
// Schemas first; these types never reject unknown fields.

type description struct {
	Protocol struct {
		Version string `json:"version"`
	} `json:"protocol"`
	Provider struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"provider"`
	Capabilities struct {
		Generation    []string `json:"generation"`
		Transcription bool     `json:"transcription"`
		Cancel        bool     `json:"cancel"`
		Estimate      bool     `json:"estimate"`
		Webhook       bool     `json:"webhook"`
		Setup         bool     `json:"setup"`
	} `json:"capabilities"`
	Account struct {
		Status  string `json:"status"`
		Binding string `json:"binding"`
	} `json:"account"`
	Billing struct {
		Unit string `json:"unit"`
	} `json:"billing"`
}

type catalog struct {
	Models []model `json:"models"`
}

type model struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Available bool   `json:"available"`
	Output    struct {
		Modality string `json:"modality"`
	} `json:"output"`
	Parameters     []parameter     `json:"parameters"`
	ParameterRules json.RawMessage `json:"parameter_rules"` // shape checked by A5
	Routes         []route         `json:"routes"`
}

func (m *model) param(name string) *parameter {
	for i := range m.Parameters {
		if m.Parameters[i].Name == name {
			return &m.Parameters[i]
		}
	}
	return nil
}

func (m *model) route(id string) *route {
	for i := range m.Routes {
		if m.Routes[i].ID == id {
			return &m.Routes[i]
		}
	}
	return nil
}

type parameter struct {
	Name       string            `json:"name"`
	Kind       string            `json:"kind"`
	Required   bool              `json:"required"`
	Default    json.RawMessage   `json:"default"`
	EnumValues []json.RawMessage `json:"enum_values"`
	Min        *float64          `json:"min"`
	Max        *float64          `json:"max"`
	Step       *float64          `json:"step"`
	MaxLength  *int              `json:"max_length"`
	// Display fields, decoded raw so that A5 can report a wrong shape.
	Widget      json.RawMessage `json:"widget"`
	VisibleWhen json.RawMessage `json:"visible_when"`
}

type route struct {
	ID    string `json:"id"`
	Input struct {
		Slots             []slot `json:"slots"`
		MaxTotalArtifacts *int   `json:"max_total_artifacts"`
	} `json:"input"`
	ParameterNames []string `json:"parameter_names"`
	Output         *struct {
		MediaTypes []string `json:"media_types"`
		Audio      string   `json:"audio"`
	} `json:"output"`
	Pricing *pricing `json:"pricing"`
}

func (r *route) hasParam(name string) bool {
	for _, n := range r.ParameterNames {
		if n == name {
			return true
		}
	}
	return false
}

type slot struct {
	ID            string   `json:"id"`
	Role          string   `json:"role"`
	Modality      string   `json:"modality"`
	MinArtifacts  int      `json:"min_artifacts"`
	MaxArtifacts  int      `json:"max_artifacts"`
	MediaTypes    []string `json:"media_types"`
	MaxBytes      *int64   `json:"max_bytes"`
	MaxDurationMS *int64   `json:"max_duration_ms"`
}

type pricing struct {
	Basis    string  `json:"basis"`
	Unit     string  `json:"unit"`
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

type artifact struct {
	ID        string `json:"id"`
	MediaType string `json:"media_type"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
}

type errorObj struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Reason  string         `json:"reason"`
	Params  map[string]any `json:"params"`
}

type job struct {
	ID        string     `json:"id"`
	Status    string     `json:"status"`
	Model     string     `json:"model"`
	Route     string     `json:"route"`
	CreatedAt string     `json:"created_at"`
	UpdatedAt string     `json:"updated_at"`
	Outputs   []output   `json:"outputs"`
	Error     *errorObj  `json:"error"`
	Usage     *usage     `json:"usage"`
	Warnings  []struct{} `json:"warnings"`
}

func (j *job) updated() time.Time {
	t, _ := time.Parse(time.RFC3339Nano, j.UpdatedAt)
	return t
}

func (j *job) errorCode() string {
	if j.Error == nil {
		return ""
	}
	return j.Error.Code
}

type output struct {
	ArtifactID string `json:"artifact_id"`
	Role       string `json:"role"`
	MediaType  string `json:"media_type"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256"`
	Metadata   *struct {
		DurationMS *int64 `json:"duration_ms"`
		Width      *int   `json:"width"`
		Height     *int   `json:"height"`
	} `json:"metadata"`
}

type usage struct {
	Amount float64 `json:"amount"`
	Unit   string  `json:"unit"`
	Basis  string  `json:"basis"`
}

type estimate struct {
	Estimate struct {
		Amount float64 `json:"amount"`
		Unit   string  `json:"unit"`
		Basis  string  `json:"basis"`
	} `json:"estimate"`
}

type manifest struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Protocol string `json:"protocol"`
	Runtime  struct {
		Kind    string   `json:"kind"`
		Entry   string   `json:"entry"`
		Command []string `json:"command"`
	} `json:"runtime"`
	Test map[string]testEntry `json:"test"`
}

type testEntry struct {
	Model      string         `json:"model"`
	Route      string         `json:"route"`
	Parameters map[string]any `json:"parameters"`
}

type transcript struct {
	SchemaVersion int    `json:"schema_version"`
	Language      string `json:"language"`
	Unit          string `json:"unit"`
	Text          string `json:"text"`
	Segments      []struct {
		Text  string `json:"text"`
		Units []struct {
			Text    string `json:"text"`
			StartMS int64  `json:"start_ms"`
			EndMS   int64  `json:"end_ms"`
		} `json:"timed_text_units"`
	} `json:"segments"`
}

// mediaKind returns the top-level type of a MIME type: "image" for "image/png".
func mediaKind(mediaType string) string {
	kind, _, _ := strings.Cut(strings.ToLower(mediaType), "/")
	return kind
}

// baseMediaType drops parameters and lowercases: "Text/Plain; charset=utf-8" -> "text/plain".
func baseMediaType(mediaType string) string {
	base, _, _ := strings.Cut(mediaType, ";")
	return strings.ToLower(strings.TrimSpace(base))
}

// TranscriptMediaType is the media type of a transcription result.
const TranscriptMediaType = "application/vnd.cuelor.transcript+json"
