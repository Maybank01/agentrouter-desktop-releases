param([Parameter(Mandatory = $true)][int]$ClientProcessId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Native runtime recovery acceptance requires a disposable hosted worker'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $ClientProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    $controls = @($window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition))
    $message = @($controls | Where-Object { $_.Current.Name -match '\u8fd0\u884c\u6587\u4ef6\u4e0d\u5b8c\u6574\u6216\u65e0\u6cd5\u6267\u884c|Application runtime files are incomplete' })
    if ($message.Count -eq 0) { continue }
    # Electron's Windows message box is a TaskDialog: its choices are native
    # CCPushButton windows that UI Automation exposes as Pane without InvokePattern.
    $choices = @($controls | Where-Object {
      $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -or $_.Current.ClassName -in @('CCPushButton', 'CCCommandLink')
    })
    $buttons = @($choices | ForEach-Object { $_.Current.Name })
    $later = @($choices | Where-Object { $_.Current.Name -match '^(\u7a0d\u540e|Later)$' })
    if ($later.Count -ne 1) { throw "Expected one native recovery cancel button; found: $($buttons -join ', ')" }
    $handle = [IntPtr]$later[0].Current.NativeWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      Add-Type -Namespace AgentRouter -Name NativeButton -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr window, int message, System.IntPtr w, System.IntPtr l);'
      # BM_CLICK presses exactly this choice, as a user click would.
      if (-not [AgentRouter.NativeButton]::PostMessage($handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not press the native recovery cancel button' }
    } else {
      ([Windows.Automation.InvokePattern]$later[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
    }
    [pscustomobject]@{ explicitRuntimeFailure=$true; cancelled=$true; buttons=$buttons } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 150
}
throw 'The native runtime repair dialog did not appear within 30 seconds'
