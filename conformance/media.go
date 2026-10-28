package conformance

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
)

//go:embed samples/*.wav samples/*.mp4 samples/samples.json
var sampleFiles embed.FS

type speechSample struct {
	File       string `json:"file"`
	Language   string `json:"language"`
	Text       string `json:"text"`
	DurationMS int64  `json:"duration_ms"`
	data       []byte
}

type sampleIndex struct {
	Speech []speechSample `json:"speech"`
}

func loadSpeechSamples() ([]speechSample, error) {
	raw, err := sampleFiles.ReadFile("samples/samples.json")
	if err != nil {
		return nil, err
	}
	var idx sampleIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, err
	}
	for i := range idx.Speech {
		data, err := sampleFiles.ReadFile("samples/" + idx.Speech[i].File)
		if err != nil {
			return nil, err
		}
		idx.Speech[i].data = data
	}
	return idx.Speech, nil
}

func speechSampleFor(lang string) speechSample {
	samples, err := loadSpeechSamples()
	if err != nil {
		panic(err)
	}
	for _, s := range samples {
		if s.Language == lang {
			return s
		}
	}
	panic("no speech sample for " + lang)
}

func sampleVideo() []byte {
	data, err := sampleFiles.ReadFile("samples/video.mp4")
	if err != nil {
		panic(err)
	}
	return data
}

// sampleImage returns a small image whose colour depends on seed, so different seeds give different
// bytes.
func sampleImage(mediaType string, seed int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	c := color.RGBA{uint8(40 + seed*37%200), uint8(90 + seed*53%150), uint8(160 + seed*11%90), 255}
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if mediaType == "image/jpeg" {
		_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90})
	} else {
		_ = png.Encode(&buf, img)
	}
	return buf.Bytes()
}

// sampleFor returns bytes of one of the slot's media types, or false when the suite has no sample
// for any of them.
func sampleFor(s slot, seed int) ([]byte, string, bool) {
	for _, mt := range s.MediaTypes {
		switch baseMediaType(mt) {
		case "image/png", "image/jpeg":
			return sampleImage(baseMediaType(mt), seed), baseMediaType(mt), true
		case "audio/wav", "audio/x-wav", "audio/wave":
			return speechSampleFor("en").data, baseMediaType(mt), true
		case "video/mp4":
			return sampleVideo(), "video/mp4", true
		}
	}
	return nil, "", false
}

func extensionFor(mediaType string) string {
	switch baseMediaType(mediaType) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "video/mp4":
		return ".mp4"
	case "audio/wav", "audio/x-wav", "audio/wave":
		return ".wav"
	}
	return ".bin"
}

// headerMatches reports whether the file header agrees with the media type. known is false for
// types the suite cannot identify.
func headerMatches(mediaType string, b []byte) (match, known bool) {
	has := func(off int, sig string) bool {
		return len(b) >= off+len(sig) && string(b[off:off+len(sig)]) == sig
	}
	switch baseMediaType(mediaType) {
	case "image/png":
		return has(0, "\x89PNG\r\n\x1a\n"), true
	case "image/jpeg":
		return has(0, "\xff\xd8\xff"), true
	case "image/webp":
		return has(0, "RIFF") && has(8, "WEBP"), true
	case "image/gif":
		return has(0, "GIF87a") || has(0, "GIF89a"), true
	case "video/mp4", "video/quicktime", "audio/mp4", "audio/m4a", "audio/x-m4a":
		return has(4, "ftyp"), true
	case "video/webm", "audio/webm":
		return has(0, "\x1a\x45\xdf\xa3"), true
	case "audio/wav", "audio/x-wav", "audio/wave":
		return has(0, "RIFF") && has(8, "WAVE"), true
	case "audio/mpeg":
		return has(0, "ID3") || (len(b) > 1 && b[0] == 0xff && b[1]&0xe0 == 0xe0), true
	case "audio/ogg":
		return has(0, "OggS"), true
	case "audio/flac":
		return has(0, "fLaC"), true
	case TranscriptMediaType, "application/json":
		return json.Valid(b), true
	}
	return false, false
}

// probeResult is what ffprobe reported about a file.
type probeResult struct {
	durationMS int64
	frames     int
}

// ffprobePath returns the ffprobe to use, or "" when the decoding check is off or ffprobe is missing.
func (r *runner) ffprobePath() string {
	switch r.opts.FFprobe {
	case "off":
		return ""
	case "":
		p, err := exec.LookPath("ffprobe")
		if err != nil {
			return ""
		}
		return p
	default:
		return r.opts.FFprobe
	}
}

// probe decodes every frame of a file with ffprobe.
func probe(ffprobe string, data []byte, mediaType string) (*probeResult, error) {
	dir, err := os.MkdirTemp("", "cuelor-probe-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "output"+extensionFor(mediaType))
	if err := os.WriteFile(file, data, 0o600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error", "-count_frames",
		"-show_entries", "format=duration:stream=nb_read_frames", "-of", "json", file).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("ffprobe could not decode it: %v: %s", err, strings.TrimSpace(string(out)))
	}
	var parsed struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			Frames string `json:"nb_read_frames"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("unexpected ffprobe output: %s", snippet(out))
	}
	res := &probeResult{}
	if d, err := strconv.ParseFloat(parsed.Format.Duration, 64); err == nil {
		res.durationMS = int64(d * 1000)
	}
	for _, s := range parsed.Streams {
		n, _ := strconv.Atoi(s.Frames)
		res.frames += n
	}
	if res.frames == 0 {
		return nil, fmt.Errorf("ffprobe decoded no frames")
	}
	return res, nil
}

// characterErrorRate is the edit distance between the normalised texts divided by the length of the
// normalised reference. Normalising lowercases and drops spaces, punctuation and symbols.
func characterErrorRate(reference, hypothesis string) float64 {
	ref, hyp := normalizeText(reference), normalizeText(hypothesis)
	if len(ref) == 0 {
		if len(hyp) == 0 {
			return 0
		}
		return 1
	}
	return float64(editDistance(ref, hyp)) / float64(len(ref))
}

func normalizeText(s string) []rune {
	out := []rune{}
	for _, r := range strings.ToLower(s) {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		out = append(out, r)
	}
	return out
}

func editDistance(a, b []rune) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

// primaryLanguage returns the primary subtag of a BCP 47 tag: "zh" for "zh-Hans-CN".
func primaryLanguage(tag string) string {
	p, _, _ := strings.Cut(strings.ToLower(tag), "-")
	return p
}
