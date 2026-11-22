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
		{"plain values", []Field{{"space", "sp_1"}, {"tab", "t_2"}}, "[agb] space=sp_1 tab=t_2"},
		{"empty values are skipped", []Field{{"space", ""}, {"tab", "t_2"}, {"url", ""}}, "[agb] tab=t_2"},
		{"spaces are quoted", []Field{{"title", "Sign in to GitHub"}}, `[agb] title="Sign in to GitHub"`},
		{"quotes are escaped", []Field{{"title", `Say "hi"`}}, `[agb] title="Say \"hi\""`},
		{"tabs are quoted", []Field{{"title", "a\tb"}}, `[agb] title="a\tb"`},
		{"URLs stay unquoted", []Field{{"url", "https://example.com/a?b=1&c=2"}}, "[agb] url=https://example.com/a?b=1&c=2"},
		{"order is kept", []Field{{"b", "2"}, {"a", "1"}}, "[agb] b=2 a=1"},
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
