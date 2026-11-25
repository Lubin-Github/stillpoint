import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const opensslAvailable = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

test('SMTP sends the OTP over certificate-validated TLS', { skip: !opensslAvailable, timeout: 12_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-smtp-'));
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  let server;
  const sockets = new Set();
  const mail = [];
  try {
    const generated = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    assert.equal(generated.status, 0);
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, socket => {
      socket.write('220 localhost test SMTP\r\n');
      socket.setEncoding('utf8');
      let buffer = '';
      let receiving = false;
      let message = '';
      socket.on('data', data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (receiving) {
            if (line !== '.') { message += `${line}\r\n`; continue; }
            mail.push(message);
            receiving = false;
            socket.write('250 queued\r\n');
          } else if (line.startsWith('EHLO ')) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
          else if (line === `AUTH PLAIN ${Buffer.from('\0fixture-user\0fixture-smtp-secret').toString('base64')}`) socket.write('235 authenticated\r\n');
          else if (line === 'MAIL FROM:<origin@example.test>' || line === 'RCPT TO:<inbox@example.test>') socket.write('250 ok\r\n');
          else if (line === 'DATA') { receiving = true; socket.write('354 send message\r\n'); }
          else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('500 unexpected command\r\n');
        }
      });
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, 'localhost');
    await once(server, 'listening');
    const moduleUrl = new URL('../mail.js', import.meta.url).href;
    const script = `const { deliverMail } = await import(${JSON.stringify(moduleUrl)});
await deliverMail({ host: 'localhost', port: ${server.address().port}, security: 'tls',
  user: 'fixture-user', from: 'origin@example.test', to: 'inbox@example.test' }, 'fixture-smtp-secret', '815904');`;
    const run = async ca => {
      const env = { ...process.env, NODE_EXTRA_CA_CERTS: ca };
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'ignore', timeout: 5_000,
      });
      return (await once(child, 'exit'))[0];
    };
    assert.equal(await run(''), 1);
    assert.equal(mail.length, 0);
    assert.equal(await run(cert), 0);
    assert.equal(mail.length, 1);
    const [, encodedBody] = mail[0].split('\r\n\r\n', 2);
    const body = Buffer.from(encodedBody, 'base64').toString('utf8');
    assert.match(body, /815904/);
    assert.doesNotMatch(body, /fixture-smtp-secret/);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
