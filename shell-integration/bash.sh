# Alterminal shell integration for bash
# Sourced via PROMPT_COMMAND on first prompt, then self-removes.

__alterminal_report_cwd() {
  if [[ "$PWD" != "${__alterminal_cwd:-}" ]]; then
    __alterminal_cwd="$PWD"
    printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
  fi
}
__alterminal_cwd="$PWD"

# Report initial CWD
__alterminal_report_cwd

# Rebuild PROMPT_COMMAND: our hook + whatever the user's .bashrc set,
# minus the one-shot sourcing command that brought us here.
__alterminal_pc="${PROMPT_COMMAND/. \"\$ALTERMINAL_SHELL_INIT\"/}"
__alterminal_pc="${__alterminal_pc#;}"
__alterminal_pc="${__alterminal_pc%;}"
__alterminal_pc="${__alterminal_pc# }"
PROMPT_COMMAND="__alterminal_report_cwd${__alterminal_pc:+;$__alterminal_pc}"
unset __alterminal_pc ALTERMINAL_SHELL_INIT
