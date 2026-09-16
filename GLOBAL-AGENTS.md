You are operating in an environment where ast-grep is installed. For any code search that requires understanding of syntax or code structure, you should default to using ast-grep --lang [language] -p '<pattern>'. Adjust the --lang flag as needed for the specific programming language. Avoid using text-only search tools unless a plain-text search is explicitly requested.

## Terminal multiplexers

Before opening or controlling any multiplexer session, first check whether you are already inside one (`$ZELLIJ` set = inside zellij, `$TMUX` set = inside tmux) and what sessions already exist (`zellij list-sessions`). If you are inside a session, work within it: never start a second multiplexer inside the one you are in, and prefer creating panes in the current session over starting a new session. Attach to an existing session rather than creating one. Never kill the existing session. For zellij command syntax, reach for the `zellij` skill.
