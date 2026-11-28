package main

import (
	"fmt"
	"strings"
)

// cmdArgs is a command's own flags and positional arguments, after the global flags are removed.
type cmdArgs struct {
	flags map[string]string
	pos   []string
}

// parseArgs splits args into flags and positional arguments. spec maps each allowed flag
// (with its leading dashes) to whether it takes a value. Flags may come before or after positionals,
// as "--name value" or "--name=value"; "--" ends flag parsing. Boolean flags are stored as "true".
func parseArgs(args []string, spec map[string]bool) (cmdArgs, error) {
	out := cmdArgs{flags: map[string]string{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out.pos = append(out.pos, args[i+1:]...)
			break
		}
		if len(a) < 2 || a[0] != '-' {
			out.pos = append(out.pos, a)
			continue
		}
		name, val, hasVal := strings.Cut(a, "=")
		takesValue, ok := spec[name]
		if !ok {
			return out, fmt.Errorf("unknown flag %s", name)
		}
		switch {
		case takesValue && hasVal:
			out.flags[name] = val
		case takesValue:
			if i+1 >= len(args) {
				return out, fmt.Errorf("%s needs a value", name)
			}
			i++
			out.flags[name] = args[i]
		case hasVal:
			if val != "true" && val != "false" {
				return out, fmt.Errorf("%s takes no value", name)
			}
			out.flags[name] = val // "false" is kept, so commands can tell --x=false from not given
		default:
			out.flags[name] = "true"
		}
	}
	return out, nil
}

func (a cmdArgs) has(name string) bool { return a.flags[name] == "true" }
