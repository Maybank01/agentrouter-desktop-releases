# Answer the real Win32 "Select Workspace Directory" dialog the way a user does:
# wait for the window opened by the Desktop Host's native picker worker, type the
# folder into its "Folder" field and press "Select Folder". Win32 messages reach
# the unowned dialog even when it is not foreground (the failure users hit).
param(
  [Parameter(Mandatory = $true)][string]$Folder,
  [int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class AgentRouterPickerWin32 {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$A = [Windows.Automation.AutomationElement]
$T = [Windows.Automation.TreeScope]
$title = New-Object Windows.Automation.PropertyCondition($A::NameProperty, 'Select Workspace Directory')
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$dialog = $null
while (-not $dialog -and (Get-Date) -lt $deadline) {
  $dialog = $A::RootElement.FindFirst($T::Children, $title)
  if (-not $dialog) { Start-Sleep -Milliseconds 250 }
}
if (-not $dialog) { throw 'The native workspace dialog did not appear.' }
$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($dialog.Current.ProcessId)"
$edit = $null; $button = $null
while ((-not $edit -or -not $button) -and (Get-Date) -lt $deadline) {
  $edit = $dialog.FindFirst($T::Descendants, (New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, '1152')))
  $button = $dialog.FindFirst($T::Children, (New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, '1')))
  if (-not $edit -or -not $button) { Start-Sleep -Milliseconds 250 }
}
if (-not $edit -or -not $button) { throw 'The native workspace dialog has no folder field or select button.' }
[void][AgentRouterPickerWin32]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $Folder)
[void][AgentRouterPickerWin32]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
[pscustomobject]@{ dialogProcess = $owner.Name; commandLine = [string]$owner.CommandLine; folder = $Folder } | ConvertTo-Json -Compress
