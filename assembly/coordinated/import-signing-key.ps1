$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REF -ne 'refs/heads/main') { throw 'Release keys are only imported on the disposable main release worker' }
$policy = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-signing.json') -Raw | ConvertFrom-Json
$pfxFile = Join-Path $env:RUNNER_TEMP 'agentrouter-signing.pfx'
try {
  [IO.File]::WriteAllBytes($pfxFile, [Convert]::FromBase64String($env:AGENTROUTER_SIGNING_PFX))
  $password = ConvertTo-SecureString -String $env:AGENTROUTER_SIGNING_PASSWORD -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath $pfxFile -Password $password -CertStoreLocation 'Cert:\CurrentUser\My'
  $sha = [Security.Cryptography.SHA256]::Create()
  $fingerprint = ([BitConverter]::ToString($sha.ComputeHash($cert.RawData))).Replace('-','').ToLowerInvariant()
  $sha.Dispose()
  if ($fingerprint -ne $policy.certificateSha256 -or !$cert.HasPrivateKey) { throw 'The imported key differs from the reviewed public signing identity' }
  $tools = @(Get-ChildItem -Path 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' -File | Sort-Object FullName -Descending)
  if ($tools.Count -eq 0) { throw 'Windows SDK SignTool is missing' }
  "AGENTROUTER_SIGNING_CERT_THUMBPRINT=$($cert.Thumbprint)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "AGENTROUTER_SIGNTOOL=$($tools[0].FullName)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  Write-Output "Imported the reviewed self-signed leaf into CurrentUser/My; Windows root trust was not changed."
} finally {
  Remove-Item -LiteralPath $pfxFile -Force -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTROUTER_SIGNING_PFX -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTROUTER_SIGNING_PASSWORD -ErrorAction SilentlyContinue
}
