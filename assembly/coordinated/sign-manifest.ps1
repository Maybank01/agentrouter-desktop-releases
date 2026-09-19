$ErrorActionPreference = 'Stop'
$thumbprint = $env:AGENTROUTER_SIGNING_CERT_THUMBPRINT
if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Missing signing certificate identity' }
$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint"
if (!$cert.HasPrivateKey) { throw 'The signing identity has no private key' }
$key = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
try {
  $bytes = [IO.File]::ReadAllBytes($env:AGENTROUTER_SIGNING_MANIFEST_INPUT)
  $signature = $key.SignData($bytes, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
  [IO.File]::WriteAllBytes($env:AGENTROUTER_SIGNING_MANIFEST_OUTPUT, $signature)
} finally { $key.Dispose() }
