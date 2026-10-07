'use strict';

// Login + remote-access protection.
//
// - With AUTH_USER/AUTH_PASS set: a login page issues a signed, HttpOnly session cookie
//   (stateless HMAC, survives restarts; changing the password logs every device out).
//   Failed logins are rate-limited per IP. HTTP basic auth is still accepted for scripts.
// - Without them: only private/LAN/Tailscale addresses are served, so a stray port-forward
//   or reverse proxy doesn't publish the inventory to the internet.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const COOKIE = 'binv_session';
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

// Reachable without logging in (login page styling, PWA icon/manifest, health check)
const PUBLIC_PATHS = new Set(['/healthz', '/login', '/logout', '/icon.svg', '/icon.png', '/manifest.webmanifest', '/scan.webmanifest']);

function isPrivateIp(ip) {
  ip = String(ip || '').replace(/^::ffff:/i, '').toLowerCase();
  if (ip === '::1' || /^fe[89ab]/.test(ip) || /^f[cd]/.test(ip)) return true; // loopback, link-local, ULA
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127); // CGNAT range used by Tailscale
}

function loadSecret(dataDir) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, 'session.secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function safeNext(n) {
  n = String(n || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/';
}

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loginPage({ next, error, user }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111418"><link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.png"><link rel="manifest" href="/manifest.webmanifest">
<title>Sign in · Binventory</title>
<style>
  :root { --bg:#f4f5f7; --surface:#fff; --text:#15181d; --muted:#6b7280; --line:#e3e5e9; --accent:#f5a524; --danger:#d93a3a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0f12; --surface:#171a1f; --text:#eceef1; --muted:#9099a6; --line:#2a2f37; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text);
    font:16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  form { width:100%; max-width:360px; background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:24px; }
  h1 { display:flex; align-items:center; gap:10px; font-size:22px; margin:0 0 20px; }
  label { display:block; font-size:13px; color:var(--muted); margin:14px 0 6px; }
  input { width:100%; font:inherit; padding:12px; border-radius:10px; border:1px solid var(--line); background:var(--bg); color:var(--text); }
  button { width:100%; margin-top:20px; font:inherit; font-weight:600; padding:13px; border:0; border-radius:10px; background:var(--accent); color:#111418; }
  .err { color:var(--danger); font-size:14px; margin:0 0 4px; }
</style></head>
<body>
<form method="post" action="/login">
  <h1><img src="/icon.svg" alt="" width="30" height="30"> Binventory</h1>
  ${error ? `<p class="err">${escHtml(error)}</p>` : ''}
  <input type="hidden" name="next" value="${escHtml(next)}">
  <label for="u">Username</label>
  <input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" value="${escHtml(user || '')}" required ${user ? '' : 'autofocus'}>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required ${user ? 'autofocus' : ''}>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
}

function setupAuth(app, { dataDir }) {
  const USER = process.env.AUTH_USER || '';
  const PASS = process.env.AUTH_PASS || '';
  const enabled = !!(USER && PASS);
  const days = Math.max(1, parseInt(process.env.SESSION_DAYS || '90', 10) || 90);
  const allowPublic = /^(1|true|yes|on)$/i.test(process.env.ALLOW_PUBLIC_NO_AUTH || '');

  if ((USER || PASS) && !enabled) console.warn('Auth: set BOTH AUTH_USER and AUTH_PASS to enable login. Login is OFF.');
  if (enabled && PASS.length < 10) console.warn('Auth: AUTH_PASS is short. Use 10+ characters if this is reachable from outside your home.');
  if (!enabled) console.log(allowPublic
    ? 'Auth: no login and ALLOW_PUBLIC_NO_AUTH is on. Anyone who can reach this port can see and edit everything.'
    : 'Auth: no login configured, so only LAN/Tailscale addresses are allowed. Set AUTH_USER/AUTH_PASS for remote access.');

  // Security headers on everything
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  app.get('/healthz', (_req, res) => res.send('ok'));

  if (!enabled) {
    app.use((req, res, next) => {
      if (allowPublic || isPrivateIp(req.ip)) return next();
      console.warn(`Auth: blocked ${req.ip} ${req.method} ${req.originalUrl} (no login configured)`);
      res.status(403).type('text').send('Binventory has no login configured, so it only answers on your home network.\n'
        + 'Set AUTH_USER and AUTH_PASS on the container to allow remote access.');
    });
    return { enabled, user: '', days: 0 };
  }

  // Key includes the password, so changing AUTH_PASS invalidates every existing session.
  const key = crypto.createHmac('sha256', loadSecret(dataDir)).update(`${USER}\n${PASS}`).digest();
  const sign = payload => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function makeToken() {
    const payload = Buffer.from(`${USER}|${Date.now() + days * 864e5}`).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }
  // Returns the session's expiry time (ms), or 0 if the cookie isn't a valid live session
  function validToken(tok) {
    const [payload, sig] = String(tok || '').split('.');
    if (!payload || !sig || !safeEqual(sig, sign(payload))) return 0;
    const [user, exp] = Buffer.from(payload, 'base64url').toString().split('|');
    return user === USER && Number(exp) > Date.now() ? Number(exp) : 0;
  }
  function readCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }
  function cookieHeader(req, value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
  }
  function basicOk(req) {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Basic ')) return false;
    const given = Buffer.from(hdr.slice(6), 'base64').toString();
    return safeEqual(given, `${USER}:${PASS}`);
  }

  // Failed-login throttle, per client IP
  const fails = new Map();
  const locked = ip => { const f = fails.get(ip); return f && f.count >= MAX_FAILS && Date.now() < f.until; };
  function recordFail(ip) {
    const f = fails.get(ip);
    const now = Date.now();
    const rec = f && now < f.until ? f : { count: 0, until: 0 };
    rec.count++;
    rec.until = now + LOCK_MS;
    fails.set(ip, rec);
    if (fails.size > 10000) fails.clear(); // bound memory under a spray from many IPs
    if (rec.count === MAX_FAILS) console.warn(`Auth: ${ip} locked out for 15 min after ${MAX_FAILS} failed logins`);
  }

  app.get('/login', (req, res) => {
    if (validToken(readCookie(req))) return res.redirect(safeNext(req.query.next));
    res.type('html').send(loginPage({ next: safeNext(req.query.next) }));
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const next = safeNext(req.body.next);
    const user = String(req.body.username || '').trim();
    if (locked(req.ip)) {
      return res.status(429).type('html').send(loginPage({ next, user, error: 'Too many failed attempts. Try again in 15 minutes.' }));
    }
    // Compare both even if the first fails, so timing doesn't reveal which was wrong
    const ok = [safeEqual(user, USER), safeEqual(String(req.body.password || ''), PASS)].every(Boolean);
    if (!ok) {
      recordFail(req.ip);
      console.warn(`Auth: failed login from ${req.ip}`);
      return setTimeout(() => res.status(401).type('html').send(loginPage({ next, user, error: 'Wrong username or password.' })), 600);
    }
    fails.delete(req.ip);
    res.set('Set-Cookie', cookieHeader(req, makeToken(), days * 86400)).redirect(303, next);
  });

  app.all('/logout', (req, res) => {
    res.set('Set-Cookie', cookieHeader(req, '', 0)).redirect(303, '/login');
  });

  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next();
    const exp = validToken(readCookie(req));
    if (exp) {
      // Sliding session: a device in regular use (e.g. a wall-mounted scan station) never gets logged out
      if (exp - Date.now() < days * 864e5 / 2) res.append('Set-Cookie', cookieHeader(req, makeToken(), days * 86400));
      return next();
    }
    if (basicOk(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/photos/')) {
      return res.status(401).json({ error: 'Sign in required', login: true });
    }
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  });

  return { enabled, user: USER, days };
}

module.exports = { setupAuth, isPrivateIp };
