package format

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestHeader(t *testing.T) {
	cases := []struct {
		name   string
		fields []Field
		want   string
	}{
		{"no fields", nil, "[agb]"},
		{"plain values", []Field{{Key: "space", Value: "sp_1"}, {Key: "tab", Value: "t_2"}}, "[agb] space=sp_1 tab=t_2"},
		{"empty values are skipped", []Field{{Key: "space", Value: ""}, {Key: "tab", Value: "t_2"}, {Key: "url", Value: ""}}, "[agb] tab=t_2"},
		{"spaces are quoted", []Field{{Key: "title", Value: "Sign in to GitHub"}}, `[agb] title="Sign in to GitHub"`},
		{"quotes are escaped", []Field{{Key: "title", Value: `Say "hi"`}}, `[agb] title="Say \"hi\""`},
		{"tabs are quoted", []Field{{Key: "title", Value: "a\tb"}}, `[agb] title="a\tb"`},
		{"URLs stay unquoted", []Field{{Key: "url", Value: "https://example.com/a?b=1&c=2"}}, "[agb] url=https://example.com/a?b=1&c=2"},
		{"raw values are not quoted", []Field{{Key: "space", Value: "sp_1 (new, isolated)", Raw: true}, {Key: "tab", Value: "t_1"}}, "[agb] space=sp_1 (new, isolated) tab=t_1"},
		{"order is kept", []Field{{Key: "b", Value: "2"}, {Key: "a", Value: "1"}}, "[agb] b=2 a=1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Header(c.fields...); got != c.want {
				t.Fatalf("Header() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestErrorWithHint(t *testing.T) {
	var b bytes.Buffer
	Error(&b, "E_STALE_REF", "@e12 no longer exists", "run `agb snapshot` again")
	want := "[agb] error E_STALE_REF: @e12 no longer exists\nhint: run `agb snapshot` again\n"
	if b.String() != want {
		t.Fatalf("got %q, want %q", b.String(), want)
	}
}

func TestErrorWithoutHint(t *testing.T) {
	var b bytes.Buffer
	Error(&b, "E_USAGE", "--timeout needs a value", "")
	if want := "[agb] error E_USAGE: --timeout needs a value\n"; b.String() != want {
		t.Fatalf("got %q, want %q", b.String(), want)
	}
}

func TestJSONIsIndentedAndValid(t *testing.T) {
	var b bytes.Buffer
	JSON(&b, map[string]any{"ok": true, "tabs": 3})
	want := "{\n  \"ok\": true,\n  \"tabs\": 3\n}\n"
	if b.String() != want {
		t.Fatalf("got %q, want %q", b.String(), want)
	}
	var v map[string]any
	if err := json.Unmarshal(b.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
}

func TestJSONDoesNotEscapeHTMLCharacters(t *testing.T) {
	// URLs with & and < > should stay readable for agents.
	var b bytes.Buffer
	JSON(&b, map[string]string{"url": "https://example.com/?a=1&b=<2>"})
	if want := "{\n  \"url\": \"https://example.com/?a=1&b=<2>\"\n}\n"; b.String() != want {
		t.Fatalf("got %q, want %q", b.String(), want)
	}
}
