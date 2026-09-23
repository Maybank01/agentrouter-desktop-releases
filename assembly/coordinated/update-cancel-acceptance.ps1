# Exercise the real NSIS Cancel action before it changes the installed files.
param([Parameter(Mandatory = $true)][string]$Installer,
      [Parameter(Mandatory = $true)][string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installer UI acceptance requires a disposable hosted Windows worker'
}
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InstallerCancelUi {
  private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr[] Windows(int[] pids) {
    var accepted = new HashSet<int>(pids);
    var windows = new List<IntPtr>();
    EnumWindows((window, parameter) => {
      uint pid; GetWindowThreadProcessId(window, out pid);
      if (accepted.Contains((int)pid)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
$installation = Start-Process -FilePath $Installer -ArgumentList '/currentuser', "/D=$InstallDirectory" -WindowStyle Hidden -PassThru
$owned = [Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($installation.Id)
$clickedCancel = $false
$confirmed = $false
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $deadline) {
  # NSIS may fork its own UI process; admit only descendants of this invocation.
  $processes = @(Get-CimInstance Win32_Process)
  foreach ($item in $processes) {
    if ($owned.Contains([int]$item.ParentProcessId)) { [void]$owned.Add([int]$item.ProcessId) }
  }
  $live = @($processes | Where-Object { $owned.Contains([int]$_.ProcessId) })
  if ($live.Count -eq 0) {
    if (!$clickedCancel) { throw 'Installer exited before the Cancel action was exercised' }
    [pscustomobject]@{ cancelled = $true; confirmationShown = $confirmed } | ConvertTo-Json -Compress
    exit 0
  }
  foreach ($window in [InstallerCancelUi]::Windows([int[]]@($owned))) {
    if (![InstallerCancelUi]::IsWindowEnabled($window)) { continue }
    $yes = [InstallerCancelUi]::GetDlgItem($window, 6)
    $cancel = [InstallerCancelUi]::GetDlgItem($window, 2)
    if ($clickedCancel -and $yes -ne [IntPtr]::Zero) {
      [void][InstallerCancelUi]::PostMessage($window, 0x111, [IntPtr]6, [IntPtr]::Zero)
      $confirmed = $true
    } elseif (!$clickedCancel -and $cancel -ne [IntPtr]::Zero -and [InstallerCancelUi]::IsWindowEnabled($cancel)) {
      [void][InstallerCancelUi]::PostMessage($window, 0x111, [IntPtr]2, [IntPtr]::Zero)
      $clickedCancel = $true
    }
  }
  Start-Sleep -Milliseconds 200
}
throw 'Installer did not complete the real Cancel action within 60 seconds'
