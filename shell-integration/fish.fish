# Alterminal shell integration for fish
# Loaded via --init-command at shell startup.

function __alterminal_osc7 --on-variable PWD --description "Report CWD to Alterminal"
  printf '\e]7;file://%s%s\a' (hostname) "$PWD"
end

# Report initial CWD
__alterminal_osc7
