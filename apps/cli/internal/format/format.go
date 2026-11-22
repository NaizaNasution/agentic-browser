// Package format writes LLM-friendly output: short plain text, a one-line header,
// and errors with a stable code and a hint (docs/SPEC.md §9.1, §9.5).
package format

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// Field is one key=value pair in a header line. Raw values are printed as they are, never quoted.
type Field struct {
	Key, Value string
	Raw        bool
}

// Header renders "[agb] k=v k=v". Values with spaces are quoted.
func Header(fields ...Field) string {
	var b strings.Builder
	b.WriteString("[agb]")
	for _, f := range fields {
		if f.Value == "" {
			continue
		}
		v := f.Value
		if !f.Raw && strings.ContainsAny(v, " \t\"") {
			v = fmt.Sprintf("%q", v)
		}
		fmt.Fprintf(&b, " %s=%s", f.Key, v)
	}
	return b.String()
}

// Error writes an error in the standard two-line form to w (stderr).
func Error(w io.Writer, code, message, hint string) {
	fmt.Fprintf(w, "[agb] error %s: %s\n", code, message)
	if hint != "" {
		fmt.Fprintf(w, "hint: %s\n", hint)
	}
}

// JSON writes v as indented JSON. HTML characters (&, <, >) are not escaped, so URLs stay readable.
func JSON(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
