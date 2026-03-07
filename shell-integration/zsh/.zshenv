# Alterminal shell integration for zsh
# Loaded via ZDOTDIR trick — this runs before any user dotfiles.

# Restore ZDOTDIR immediately so .zprofile, .zshrc, .zlogin all
# load from the user's real home directory.
ZDOTDIR="${ALTERMINAL_ORIG_ZDOTDIR:-$HOME}"
unset ALTERMINAL_ORIG_ZDOTDIR

# Source the user's real .zshenv if it exists
[[ -f "$ZDOTDIR/.zshenv" ]] && builtin source "$ZDOTDIR/.zshenv"

# Report CWD via OSC 7 whenever the directory changes.
# chpwd fires only on actual directory changes — not every prompt.
__alterminal_chpwd() {
  builtin printf '\e]7;file://%s%s\a' "$HOST" "$PWD"
}
chpwd_functions+=(__alterminal_chpwd)

# Report initial CWD
__alterminal_chpwd
