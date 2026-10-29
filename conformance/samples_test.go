package conformance

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"testing"
)

// riffChunks lists a WAV's chunks and its ICMT comment, and returns the format and duration.
func riffChunks(t *testing.T, b []byte) (chunks []string, infoIDs []string, comment string, rate, channels, bits uint32, durationMS float64) {
	t.Helper()
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		t.Fatal("not a RIFF/WAVE file")
	}
	var dataLen, byteRate uint32
	for off := 12; off+8 <= len(b); {
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		body := b[off+8 : min(off+8+size, len(b))]
		chunks = append(chunks, id)
		switch id {
		case "fmt ":
			if format := binary.LittleEndian.Uint16(body[0:2]); format != 1 {
				t.Errorf("format tag %d, want 1 (PCM)", format)
			}
			channels = uint32(binary.LittleEndian.Uint16(body[2:4]))
			rate = binary.LittleEndian.Uint32(body[4:8])
			byteRate = binary.LittleEndian.Uint32(body[8:12])
			bits = uint32(binary.LittleEndian.Uint16(body[14:16]))
		case "data":
			dataLen = uint32(len(body))
		case "LIST":
			if len(body) >= 4 && string(body[0:4]) == "INFO" {
				for p := 4; p+8 <= len(body); {
					sid := string(body[p : p+4])
					ssz := int(binary.LittleEndian.Uint32(body[p+4 : p+8]))
					infoIDs = append(infoIDs, sid)
					if sid == "ICMT" {
						comment = string(body[p+8 : p+8+ssz])
					}
					p += 8 + ssz + ssz%2
				}
			}
		}
		off += 8 + size + size%2
	}
	return chunks, infoIDs, comment, rate, channels, bits, float64(dataLen) * 1000 / float64(byteRate)
}

// Every speech sample is 16 kHz mono 16-bit PCM, carries its language and text in the ICMT comment
// (the fake upstreams read it), has no other metadata, and lasts what samples.json says.
func TestSpeechSamples(t *testing.T) {
	samples, err := loadSpeechSamples()
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) == 0 {
		t.Fatal("no speech samples")
	}
	for _, s := range samples {
		chunks, infoIDs, comment, rate, channels, bits, ms := riffChunks(t, s.data)
		if rate != 16000 || channels != 1 || bits != 16 {
			t.Errorf("%s: %d Hz, %d channels, %d bits; want 16000, 1, 16", s.File, rate, channels, bits)
		}
		if len(infoIDs) != 1 || infoIDs[0] != "ICMT" {
			t.Errorf("%s: LIST/INFO entries %v; want only ICMT", s.File, infoIDs)
		}
		for _, id := range chunks {
			if id != "fmt " && id != "data" && id != "LIST" {
				t.Errorf("%s: unexpected chunk %q", s.File, id)
			}
		}
		var known struct{ Language, Text string }
		if err := json.Unmarshal([]byte(trimNul(comment)), &known); err != nil {
			t.Errorf("%s: ICMT is not JSON: %v", s.File, err)
			continue
		}
		if known.Language != s.Language || known.Text != s.Text {
			t.Errorf("%s: ICMT %+v differs from samples.json (%q, %q)", s.File, known, s.Language, s.Text)
		}
		if math.Abs(ms-float64(s.DurationMS)) > 5 {
			t.Errorf("%s: lasts %.1f ms, samples.json says %d", s.File, ms, s.DurationMS)
		}
	}
}

func trimNul(s string) string {
	for len(s) > 0 && s[len(s)-1] == 0 {
		s = s[:len(s)-1]
	}
	return s
}
