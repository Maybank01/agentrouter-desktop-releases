/** Small release adapter around Windows SignTool and a pinned update signature. */
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { manifestName, validateSigningPolicy, verifyUpdateManifest, verifyUpdateFile } from './update-signature.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const execute = promisify(execFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
// A fresh hosted worker may not have registered the Cert: provider yet. Load
// this PowerShell version's security module explicitly, including under pwsh.
const securityModule = 'Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); '
const ps = (command, env = {}) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ' + securityModule + command], {
  env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60000,
}))

export function loadSigningPolicy() {
  const policy = JSON.parse(readFileSync(join(directory, 'windows-signing.json'), 'utf8'))
  validateSigningPolicy(policy)
  const certificate = new X509Certificate(policy.certificate)
  assert.equal(digest(certificate.raw), policy.certificateSha256)
  assert.equal(certificate.publicKey.export({ type: 'spki', format: 'pem' }), policy.publicKey)
  assert.equal(certificate.toLegacyObject().subject.CN, policy.publisher)
  assert.equal(certificate.ca, false)
  assert.ok(certificate.keyUsage.includes('1.3.6.1.5.5.7.3.3'))
  assert.ok(certificate.verify(certificate.publicKey))
  return policy
}

export function signingEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|PFX|API_KEY|AUTH_TOKEN)/i.test(name)))
}

export async function createSelfSigner(upstreamHelpers, policy) {
  const thumbprint = process.env.AGENTROUTER_SIGNING_CERT_THUMBPRINT
  const signTool = process.env.AGENTROUTER_SIGNTOOL
  assert.match(thumbprint ?? '', /^[A-Fa-f0-9]{40}$/)
  assert.ok(signTool, 'The Windows SDK SignTool must be configured')
  const certificate = ps('$ErrorActionPreference="Stop"; $c=Get-Item -LiteralPath "Cert:/CurrentUser/My/$env:AGENTROUTER_SIGNING_CERT_THUMBPRINT"; @{ raw=[Convert]::ToBase64String($c.RawData); privateKey=$c.HasPrivateKey; notBefore=$c.NotBefore.ToUniversalTime().ToString("o"); notAfter=$c.NotAfter.ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress')
  assert.equal(certificate.privateKey, true)
  assert.equal(digest(Buffer.from(certificate.raw, 'base64')), policy.certificateSha256)
  assert.ok(Date.now() >= Date.parse(certificate.notBefore) && Date.now() < Date.parse(certificate.notAfter))
  const sign = async config => {
    assert.equal(config.hash, 'sha256')
    await upstreamHelpers.repairDanglingAuthenticodeDirectory(config.path)
    await execute(signTool, ['sign', '/sha1', thumbprint, '/s', 'My', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256',
      ...(config.isNest ? ['/as'] : []), config.path], { env: signingEnvironment(), windowsHide: true, timeout: 120000 })
  }
  upstreamHelpers.installWindowsNsisBootstrapSigner({ sign })
  return sign
}

/** This report deliberately distinguishes OS trust from our full-file signature.
 * A self-signed leaf is never reported as publicly trusted. Its full file must
 * also match the independently verified signed manifest before acceptance.
 */
export function inspectWindowsSignature(path, policy) {
  const result = ps('$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature -LiteralPath $env:AGENTROUTER_VERIFY_FILE; @{ status=[string]$s.Status; subject=$s.SignerCertificate.Subject; certificate=[Convert]::ToBase64String($s.SignerCertificate.RawData); timestamp=$s.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress', { AGENTROUTER_VERIFY_FILE: path })
  if (policy) {
    assert.ok(['Valid', 'NotTrusted', 'UnknownError'].includes(result.status), `Invalid Authenticode signature: ${result.status}`)
    assert.equal(digest(Buffer.from(result.certificate, 'base64')), policy.certificateSha256)
  } else assert.equal(result.status, 'Valid')
  assert.ok(result.timestamp, 'A release signature must include an RFC3161 timestamp')
  return { status: result.status, subject: result.subject, timestamp: result.timestamp,
    certificateSha256: digest(Buffer.from(result.certificate, 'base64')),
    trust: policy ? 'self-signed' : 'windows-trusted', publiclyTrusted: policy ? false : true }
}

export async function writeSignedManifest(output, productVersion, assets, runtime, policy) {
  const bytes = readFileSync(runtime)
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, productVersion, certificateSha256: policy.certificateSha256,
    assets: [...assets, { name: 'AgentRouter.exe', bytes: bytes.length, sha256: digest(bytes) }] }))
  const input = join(output, 'update-signature-payload.json')
  const signature = join(output, 'update-signature.bin')
  writeFileSync(input, payload)
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'sign-manifest.ps1')], {
    env: { ...signingEnvironment(), AGENTROUTER_SIGNING_MANIFEST_INPUT: input, AGENTROUTER_SIGNING_MANIFEST_OUTPUT: signature },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  })
  const envelope = { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: readFileSync(signature).toString('base64') }
  const manifest = verifyUpdateManifest(envelope, policy, productVersion)
  for (const file of assets) await verifyUpdateFile(manifest, join(output, file.name), file.name)
  await verifyUpdateFile(manifest, runtime, 'AgentRouter.exe')
  writeFileSync(join(output, manifestName), JSON.stringify(envelope, null, 2) + '\n')
  const body = readFileSync(join(output, manifestName))
  return { name: manifestName, bytes: body.length, sha256: digest(body) }
}
