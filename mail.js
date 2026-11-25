import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { z } from 'zod';

const hostName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const mailbox = z.email().max(254);
export const smtpSchema = z.object({
  host: z.string().trim().toLowerCase().refine(v => !!isIP(v) || hostName.test(v)),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls']),
  user: z.string().trim().min(1).max(254).regex(/^[^\u0000-\u001f\u007f]+$/u),
  from: mailbox,
  to: mailbox,
}).strict();

export const smtpEnvelopeSchema = z.object({
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]{1,1366}$/),
}).strict();

const scope = Buffer.from('dsh-lock-gate/smtp/v1');
const smtpKey = key => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), scope, 32));
const aad = smtp => Buffer.from(JSON.stringify([smtp.host, smtp.port, smtp.security, smtp.user, smtp.from, smtp.to]));

export function sameSmtpAccount(a, b) {
  return a && a.host === b.host && a.port === b.port && a.security === b.security && a.user === b.user;
}

export function sealSmtp(key, smtp, password) {
  const derived = smtpKey(key);
  const iv = randomBytes(12);
  const plaintext = Buffer.from(password);
  try {
    const cipher = createCipheriv('aes-256-gcm', derived, iv);
    cipher.setAAD(aad(smtp));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  } finally {
    derived.fill(0);
    plaintext.fill(0);
  }
}

export function openSmtp(key, smtp, envelope) {
  const derived = smtpKey(key);
  let partial;
  let final;
  let plaintext;
  try {
    const cipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(envelope.iv, 'base64url'));
    cipher.setAAD(aad(smtp));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    partial = cipher.update(Buffer.from(envelope.ciphertext, 'base64url'));
    final = cipher.final();
    plaintext = Buffer.concat([partial, final]);
    return plaintext.toString('utf8');
  } finally {
    derived.fill(0);
    partial?.fill(0);
    final?.fill(0);
    plaintext?.fill(0);
  }
}

export async function deliverMail(smtp, password, code) {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls',
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: smtp.host },
    auth: { user: smtp.user, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    dnsTimeout: 8_000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    const result = await transporter.sendMail({
      from: { address: smtp.from, name: 'Stillpoint' },
      to: { address: smtp.to, name: '' },
      subject: code ? 'Stillpoint验证码' : 'Stillpoint SMTP 测试',
      text: code ? `验证码：${code}\n10 分钟内有效。请勿转发或共享。` : 'Stillpoint已通过您配置的 SMTP 服务发送此测试邮件。',
    });
    if (result.accepted?.length !== 1 || result.rejected?.length) throw new Error('SMTP recipient rejected');
  } finally {
    transporter.close();
  }
}
