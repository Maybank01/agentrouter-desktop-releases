# Network interception for the update matrix, on a disposable hosted Windows worker only.
# Setup trusts a two-day test CA, maps the release/mirror names to 127.0.0.1 and,
# for the system-proxy mode, sets the current user's WinINet proxy. Restore undoes
# all of it from the recorded state. Nothing here runs on a workstation.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Setup', 'Restore')][string]$Action,
  [Parameter(Mandatory = $true)][string]$StateFile,
  [string]$CaFile,
  [string]$HostNames,
  [string]$ProxyServer
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Update-matrix network interception requires a disposable hosted Windows worker'
}
$hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$marker = '# agentrouter-update-matrix'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UpdateMatrixProxy {
  [StructLayout(LayoutKind.Explicit, Size = 16)]
  struct Option { [FieldOffset(0)] public int Kind; [FieldOffset(8)] public int Number; [FieldOffset(8)] public IntPtr Text; }
  [StructLayout(LayoutKind.Sequential)]
  struct OptionList { public int Size; public IntPtr Connection; public int Count; public int Error; public IntPtr Options; }
  [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool InternetSetOption(IntPtr handle, int option, IntPtr buffer, int length);
  // Per-user WinINet connection settings, as the Windows Settings app writes them.
  public static void Set(string server, string bypass) {
    int count = server == null ? 1 : 3;
    var options = new Option[count];
    options[0].Kind = 1; options[0].Number = server == null ? 1 : 3;
    if (server != null) {
      options[1].Kind = 2; options[1].Text = Marshal.StringToHGlobalUni(server);
      options[2].Kind = 3; options[2].Text = Marshal.StringToHGlobalUni(bypass);
    }
    int size = Marshal.SizeOf(typeof(Option));
    IntPtr buffer = Marshal.AllocHGlobal(size * count);
    for (int i = 0; i < count; i++) Marshal.StructureToPtr(options[i], buffer + i * size, false);
    var list = new OptionList { Size = Marshal.SizeOf(typeof(OptionList)), Connection = IntPtr.Zero, Count = count, Options = buffer };
    IntPtr listBuffer = Marshal.AllocHGlobal(list.Size);
    Marshal.StructureToPtr(list, listBuffer, false);
    try {
      if (!InternetSetOption(IntPtr.Zero, 75, listBuffer, list.Size)) throw new System.ComponentModel.Win32Exception();
      InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);
      InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);
    } finally {
      Marshal.FreeHGlobal(listBuffer); Marshal.FreeHGlobal(buffer);
      for (int i = 1; i < count; i++) Marshal.FreeHGlobal(options[i].Text);
    }
  }
}
'@

if ($Action -eq 'Setup') {
  if (Test-Path -LiteralPath $StateFile) { throw 'Interception is already set up' }
  $state = [ordered]@{ caThumbprint = $null; proxySet = $false }
  $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding utf8
  $ca = Import-Certificate -FilePath $CaFile -CertStoreLocation Cert:\LocalMachine\Root
  $state.caThumbprint = $ca.Thumbprint
  $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding utf8
  $lines = @($HostNames -split ',' | Where-Object { $_ } | ForEach-Object { "127.0.0.1 $_ $marker" })
  if ($lines.Count -eq 0) { throw 'No host names to intercept' }
  $existing = [IO.File]::ReadAllText($hostsFile)
  if ($existing.Length -gt 0 -and !$existing.EndsWith("`n")) { $existing += "`r`n" }
  [IO.File]::WriteAllText($hostsFile, $existing + ($lines -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)
  ipconfig /flushdns | Out-Null
  $proxy = $null
  if ($ProxyServer) {
    $state.proxySet = $true
    $state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding utf8
    [UpdateMatrixProxy]::Set($ProxyServer, '<local>')
    $proxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]'https://github.com/').AbsoluteUri
    if ($proxy -notlike "http://$ProxyServer*") { throw "The Windows system proxy did not take effect: $proxy" }
  }
  # Processes the NSIS installer restarts through Explorer inherit the user environment.
  [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $CaFile, 'User')
  [pscustomobject]@{ caThumbprint = $ca.Thumbprint; hosts = $lines.Count; systemProxy = $proxy } | ConvertTo-Json -Compress
  exit 0
}

if (!(Test-Path -LiteralPath $StateFile)) { '{"restored":false}'; exit 0 }
$state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
if ($state.proxySet) { [UpdateMatrixProxy]::Set($null, $null) }
$kept = @([IO.File]::ReadAllLines($hostsFile) | Where-Object { -not $_.EndsWith($marker) })
[IO.File]::WriteAllText($hostsFile, ($kept -join "`r`n") + "`r`n", [Text.Encoding]::ASCII)
ipconfig /flushdns | Out-Null
if ($state.caThumbprint -match '^[A-F0-9]{40}$') {
  $path = "Cert:\LocalMachine\Root\$($state.caThumbprint)"
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}
[Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $null, 'User')
Remove-Item -LiteralPath $StateFile -Force
'{"restored":true}'
