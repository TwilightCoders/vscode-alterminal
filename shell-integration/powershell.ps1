# Alterminal shell integration for PowerShell (Windows PowerShell 5.1 and pwsh 7+)
# Dot-sourced at startup; wraps the existing prompt so user prompts keep working.

# Report the cwd via OSC 7, the same contract as the bash/zsh scripts.
# Windows paths become file:///C:/Users/me — three slashes, forward separators,
# percent-encoded — which is what the extension's OSC 7 parser expects.
function global:__Alterminal-ReportCwd {
    $p = (Get-Location).Path
    if ($p -eq $global:__AlterminalCwd) { return }
    $global:__AlterminalCwd = $p

    # A PowerShell "location" is not always a filesystem path (Registry::,
    # Env:, a UNC share). Only report real filesystem paths; anything else
    # would decode into a nonsense cwd on the extension side.
    if ($p -notmatch '^[A-Za-z]:') { return }

    $uriPath = ($p -replace '\\', '/')
    # Escape each segment, but never the drive-letter colon.
    $segments = $uriPath -split '/'
    $escaped = @()
    for ($i = 0; $i -lt $segments.Count; $i++) {
        if ($i -eq 0) { $escaped += $segments[$i] }
        else { $escaped += [Uri]::EscapeDataString($segments[$i]) }
    }
    $uri = 'file:///' + ($escaped -join '/')
    [Console]::Write("$([char]27)]7;$uri$([char]7)")
}

# Wrap the existing prompt rather than replacing it — a user's custom prompt
# (oh-my-posh, starship, a profile-defined one) must survive.
if (-not $global:__AlterminalPromptWrapped) {
    $global:__AlterminalPromptWrapped = $true
    $existing = $null
    if (Test-Path function:\prompt) {
        $existing = (Get-Item function:\prompt).ScriptBlock
    }
    $global:__AlterminalInnerPrompt = $existing

    function global:prompt {
        __Alterminal-ReportCwd
        if ($global:__AlterminalInnerPrompt) {
            & $global:__AlterminalInnerPrompt
        } else {
            "PS $((Get-Location).Path)> "
        }
    }
}

# Report the starting directory immediately, before the first prompt.
__Alterminal-ReportCwd
