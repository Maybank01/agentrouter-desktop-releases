param(
  [Parameter(Mandatory = $true)][int]$ClientProcessId,
  [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
  [Parameter(Mandatory = $true)][int]$TimeoutMs
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$client = Get-Process -Id $ClientProcessId -ErrorAction Stop
try {
  if (![String]::Equals([IO.Path]::GetFullPath($client.Path), [IO.Path]::GetFullPath($ExpectedExecutable), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The observed process does not own the expected installed executable'
  }
  # Hold the real process handle before the test triggers the updater. This is
  # independent of Playwright's cmd wrapper, CDP and inherited output pipes.
  $null = $client.Handle
  [Console]::WriteLine('ready')
  if (!$client.WaitForExit($TimeoutMs)) { throw 'The installed client process did not exit within the deadline' }
  [Console]::WriteLine([string]$client.ExitCode)
} finally { $client.Dispose() }
