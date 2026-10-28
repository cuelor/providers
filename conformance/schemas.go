package conformance

import (
	"bytes"
	"embed"
	"fmt"
	"path"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

var printer = message.NewPrinter(language.English)

// The schemas are a copy of spec/schemas, kept identical by `go generate` and checked by
// `make ck-verify` (a Go module cannot embed files outside its directory).
//
//go:generate sh -c "rm -f schemas/*.json && cp ../spec/schemas/*.json schemas/"

//go:embed schemas/*.json
var schemaFiles embed.FS

const schemaBase = "https://cuelor.com/schemas/provider/v1/"

type schemaSet struct {
	byName map[string]*jsonschema.Schema
}

func loadSchemas() (*schemaSet, error) {
	entries, err := schemaFiles.ReadDir("schemas")
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	names := []string{}
	for _, e := range entries {
		raw, err := schemaFiles.ReadFile(path.Join("schemas", e.Name()))
		if err != nil {
			return nil, err
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("schema %s: %w", e.Name(), err)
		}
		if err := compiler.AddResource(schemaBase+e.Name(), doc); err != nil {
			return nil, err
		}
		names = append(names, strings.TrimSuffix(e.Name(), ".json"))
	}
	set := &schemaSet{byName: map[string]*jsonschema.Schema{}}
	for _, name := range names {
		s, err := compiler.Compile(schemaBase + name + ".json")
		if err != nil {
			return nil, fmt.Errorf("schema %s: %w", name, err)
		}
		set.byName[name] = s
	}
	return set, nil
}

// validate checks a decoded JSON value (from jsonschema.UnmarshalJSON) against a named schema and
// returns a short description of the first problems, or nil.
func (s *schemaSet) validate(name string, value any) error {
	schema, ok := s.byName[name]
	if !ok {
		return fmt.Errorf("no schema %s", name)
	}
	err := schema.Validate(value)
	if err == nil {
		return nil
	}
	if ve, ok := err.(*jsonschema.ValidationError); ok {
		return fmt.Errorf("does not match %s.json: %s", name, flattenValidation(ve))
	}
	return fmt.Errorf("does not match %s.json: %v", name, err)
}

// flattenValidation lists the leaf errors as "/path: message", at most five.
func flattenValidation(ve *jsonschema.ValidationError) string {
	leaves := []string{}
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			loc := "/" + strings.Join(e.InstanceLocation, "/")
			leaves = append(leaves, fmt.Sprintf("%s: %s", loc, e.ErrorKind.LocalizedString(printer)))
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	if len(leaves) > 5 {
		leaves = append(leaves[:5], fmt.Sprintf("and %d more", len(leaves)-5))
	}
	return strings.Join(leaves, "; ")
}
