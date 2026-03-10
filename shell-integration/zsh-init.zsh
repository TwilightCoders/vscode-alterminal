# Alterminal shell integration for zsh
# Sourced after shell startup via PTY write injection.
# Registers hooks that coexist with user's existing hooks.

# CWD reporter via OSC 7 — fires on every directory change
__alterminal_chpwd() {
  builtin printf '\e]7;file://%s%s\a' "$HOST" "$PWD"
}

# Register if not already present (idempotent)
if (( ${chpwd_functions[(I)__alterminal_chpwd]} == 0 )); then
  chpwd_functions+=(__alterminal_chpwd)
fi

# Report current CWD immediately
__alterminal_chpwd

# Clear the injected command line from scrollback
print -n '\e[A\e[2K'
