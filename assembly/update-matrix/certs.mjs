/** Disposable test CA and leaf certificate for the intercepted names (OpenSSL from Git for Windows or PATH). */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function findOpenssl(env = process.env) {
  const candidates = [env.OPENSSL, join(env.ProgramFiles ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe'),
    join(env.ProgramFiles ?? 'C:/Program Files', 'Git/mingw64/bin/openssl.exe'), 'openssl'].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate !== 'openssl' && !existsSync(candidate)) continue
    try { execFileSync(candidate, ['version'], { stdio: 'ignore', windowsHide: true }); return candidate } catch {}
  }
  throw new Error('OpenSSL is unavailable on this worker')
}

/** Returns PEM paths; the CA is valid for two days and only names the intercepted hosts. */
export function createCertificates(directory, hosts, openssl = findOpenssl()) {
  assert.ok(hosts.length > 0)
  mkdirSync(directory, { recursive: true })
  const path = name => join(directory, name)
  writeFileSync(path('ca.cnf'), ['[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=ext', '[dn]',
    'CN=AgentRouter update-matrix disposable test CA', '[ext]', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash', ''].join('\n'))
  writeFileSync(path('leaf.cnf'), ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', `CN=${hosts[0]}`, ''].join('\n'))
  writeFileSync(path('leaf.ext'), [`subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`,
    'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', 'authorityKeyIdentifier=keyid', ''].join('\n'))
  const run = args => execFileSync(openssl, args, { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-config', 'ca.cnf', '-keyout', 'ca.key', '-out', 'ca.pem'])
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', 'leaf.cnf', '-keyout', 'leaf.key', '-out', 'leaf.csr'])
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-sha256', '-days', '2',
    '-extfile', 'leaf.ext', '-out', 'leaf.pem'])
  const result = { ca: path('ca.pem'), key: path('leaf.key'), cert: path('leaf.pem') }
  for (const file of Object.values(result)) assert.match(readFileSync(file, 'utf8'), /-----BEGIN /)
  return result
}
