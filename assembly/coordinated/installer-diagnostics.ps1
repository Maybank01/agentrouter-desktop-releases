# Bounded diagnostics from a disposable installer acceptance worker only.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { exit 0 }
Add-Type -AssemblyName UIAutomationClient
$reports = foreach ($item in @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'AgentRouter.exe' -or $_.Name -like '*Setup*.exe' -or $_.Name -like '*Uninstall*.exe'
})) {
  $window = $null
  $labels = @()
  try {
    $process = Get-Process -Id $item.ProcessId
    $window = $process.MainWindowTitle
    if ($process.MainWindowHandle -ne 0 -and $item.Name -ne 'AgentRouter.exe') {
      $element = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      $children = $element.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
      $labels = @($children | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -First 40)
    }
  } catch { }
  [pscustomobject]@{ pid=$item.ProcessId; parent=$item.ParentProcessId; path=$item.ExecutablePath; window=$window; labels=$labels }
}
@($reports) | ConvertTo-Json -Depth 4 -Compress
