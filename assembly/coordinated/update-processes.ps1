# Close only this installation's executable. Do not use directory prefixes or
# image-name taskkill: other installations and auxiliary programs are unrelated.
param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [ValidateSet('probe', 'close')][string]$Action = 'probe'
)
$ErrorActionPreference = 'Stop'
try {
  $targetExecutable = [IO.Path]::GetFullPath($ExecutablePath)
  if (![IO.Path]::IsPathRooted($ExecutablePath) -or [IO.Path]::GetExtension($targetExecutable) -ine '.exe') { exit 2 }
  if ([IO.Path]::GetFileName($targetExecutable) -ine 'AgentRouter.exe') { exit 2 }
  function Get-TargetProcesses {
    # NSIS can invoke 32-bit PowerShell. CIM still reports 64-bit executable
    # paths, whereas Get-Process.Path can be null across that boundary.
    @(Get-CimInstance Win32_Process -Filter "Name='AgentRouter.exe'" | Where-Object {
      try {
        $candidatePath = $_.ExecutablePath
        $candidatePath -and [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($candidatePath), $targetExecutable)
      } catch { $false }
    })
  }
  $targets = @(Get-TargetProcesses)
  if ($targets.Count -eq 0) { exit 0 }
  if ($Action -eq 'probe') { exit 1 }
  foreach ($targetProcess in $targets) {
    try { [void]([Diagnostics.Process]::GetProcessById($targetProcess.ProcessId)).CloseMainWindow() } catch { }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  do {
    Start-Sleep -Milliseconds 200
    $targets = @(Get-TargetProcesses)
    if ($targets.Count -eq 0) { exit 0 }
  } while ([DateTime]::UtcNow -lt $deadline)
  # Only this installation may need a forced fallback after its windows refuse
  # to close. Check creation time as well, so a reused PID is not selected.
  foreach ($targetProcess in $targets) {
    try {
      $nativeProcess = [Diagnostics.Process]::GetProcessById($targetProcess.ProcessId)
      if ([Math]::Abs(($nativeProcess.StartTime.ToUniversalTime() - $targetProcess.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) {
        $nativeProcess.Kill()
        [void]$nativeProcess.WaitForExit(3000)
      }
    } catch { }
  }
  if (@(Get-TargetProcesses).Count -eq 0) { exit 0 }
  exit 1
} catch { exit 2 }
