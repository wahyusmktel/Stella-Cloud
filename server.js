const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  pingTimeout: 30000,
  pingInterval: 15000,
  perMessageDeflate: false // Disable compression for low-latency terminal byte streams
});

// Disable Nagle's algorithm on all incoming HTTP/WebSocket connections
server.on('connection', (sock) => {
  sock.setNoDelay(true);
});

const PORT = 4000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// ---------------------------------------------------------------------
// SECURITY & ADMIN AUTHENTICATION (Brute-Force & Captcha Protected)
// ---------------------------------------------------------------------
const ADMIN_USER = 'admin';
const ADMIN_PASS = '11081995';

const adminSessions = new Map(); // token -> { createdAt, expiresAt }
const captchaStore = new Map();  // id -> { text, createdAt }
const ipLockoutStore = new Map(); // ip -> { failedAttempts, lockedUntil }

const MAX_CAPTCHA_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes lockout
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours session

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['cf-connecting-ip'] || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress || 
         '127.0.0.1';
}

function getIpLockout(ip) {
  let info = ipLockoutStore.get(ip);
  if (!info) {
    info = { failedAttempts: 0, lockedUntil: 0 };
    ipLockoutStore.set(ip, info);
  }
  if (info.lockedUntil && Date.now() > info.lockedUntil) {
    info.failedAttempts = 0;
    info.lockedUntil = 0;
  }
  return info;
}

function generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let text = '';
  for (let i = 0; i < 5; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  const width = 160;
  const height = 50;

  // Background noise lines
  let lines = '';
  const lineColors = ['#0284c7', '#6366f1', '#64748b', '#8b5cf6'];
  for (let i = 0; i < 4; i++) {
    const x1 = Math.floor(Math.random() * width);
    const y1 = Math.floor(Math.random() * height);
    const x2 = Math.floor(Math.random() * width);
    const y2 = Math.floor(Math.random() * height);
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lineColors[i % 4]}" stroke-width="1.5" stroke-opacity="0.35" />`;
  }

  // Noise dots
  let dots = '';
  for (let i = 0; i < 25; i++) {
    const cx = Math.floor(Math.random() * width);
    const cy = Math.floor(Math.random() * height);
    const r = (Math.random() * 1.5 + 0.5).toFixed(1);
    dots += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#94a3b8" opacity="0.3" />`;
  }

  // Wavy text characters
  let charElements = '';
  const charColors = ['#0284c7', '#4338ca', '#0f766e', '#7c3aed', '#b45309'];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const x = 20 + i * 26;
    const y = 34 + (Math.random() * 6 - 3);
    const rot = (Math.random() * 24 - 12).toFixed(1);
    const color = charColors[i % charColors.length];
    charElements += `<text x="${x}" y="${y}" font-family="'JetBrains Mono', monospace" font-size="26" font-weight="700" fill="${color}" transform="rotate(${rot}, ${x}, ${y})">${char}</text>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="background:#f8fafc; border-radius:10px; border:1px solid #cbd5e1; user-select:none;">${lines}${dots}${charElements}</svg>`;
  const id = crypto.randomBytes(16).toString('hex');

  // Clean old captchas (> 5 mins)
  const now = Date.now();
  for (let [k, v] of captchaStore.entries()) {
    if (now - v.createdAt > 5 * 60 * 1000) {
      captchaStore.delete(k);
    }
  }

  captchaStore.set(id, { text, createdAt: now });
  return { id, svg };
}

function getAdminTokenFromReq(req) {
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (let c of cookies) {
      const parts = c.trim().split('=');
      if (parts[0] === 'stella_admin_session') {
        return decodeURIComponent(parts.slice(1).join('='));
      }
    }
  }
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    return auth.substring(7).trim();
  }
  return null;
}

function isValidAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const session = adminSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdminAuth(req, res, next) {
  const token = getAdminTokenFromReq(req);
  if (!isValidAdminToken(token)) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak. Sesi administrator tidak valid atau telah kedaluwarsa. Silakan login kembali.'
    });
  }
  next();
}

app.use(cors());
app.use(express.json());

// Gatekeeper: Protect /admin.html route
app.get('/admin.html', (req, res, next) => {
  const token = getAdminTokenFromReq(req);
  if (!isValidAdminToken(token)) {
    return res.redirect('/admin-login.html');
  }
  next();
});

// Redirect logged in admin if visiting login page
app.get('/admin-login.html', (req, res, next) => {
  const token = getAdminTokenFromReq(req);
  if (isValidAdminToken(token)) {
    return res.redirect('/admin.html');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.pdf') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ---------------------------------------------------------------------
// VM LIVE WEB PREVIEW PROXY (Reverse Proxy for Live Browser & Split Screen)
// Solves Chrome Mixed-Content (HTTPS -> HTTP) and strips X-Frame-Options
// ---------------------------------------------------------------------
app.use('/preview/:ip', (req, res) => {
  const targetIp = req.params.ip;

  // Security check: only allow private lab subnet
  if (!targetIp || !targetIp.startsWith('10.219.')) {
    return res.status(403).send('Akses ditolak: IP VM di luar jangkauan lab sekolah.');
  }

  const targetPort = req.query.__port ? parseInt(req.query.__port) : 80;
  let subpath = req.url || '/';
  subpath = subpath.replace(/[?&]__port=\d+/, '');
  if (!subpath.startsWith('/')) subpath = '/' + subpath;

  const options = {
    hostname: targetIp,
    port: targetPort,
    path: subpath,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetIp
    },
    timeout: 6000
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];

    // Rewrite redirects so student stays inside the proxy
    if (proxyRes.headers.location) {
      let loc = proxyRes.headers.location;
      if (loc.startsWith(`http://${targetIp}`)) {
        loc = loc.replace(`http://${targetIp}`, `/preview/${targetIp}`);
      } else if (loc.startsWith('/')) {
        loc = `/preview/${targetIp}${loc}`;
      }
      headers.location = loc;
    }

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(200).send(`
        <div style="font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 60px 20px; color: #475569;">
          <div style="font-size: 40px; margin-bottom: 12px;">⏳</div>
          <h3 style="color: #0f172a; margin-bottom: 8px;">Koneksi ke VM Timeout</h3>
          <p style="font-size: 13px; color: #64748b;">Server web di IP <strong>${targetIp}</strong> tidak merespons dalam 6 detik.</p>
        </div>
      `);
    }
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(200).send(`
        <div style="font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 50px 24px; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 16px; margin: 24px;">
          <div style="font-size: 44px; margin-bottom: 12px;">🌐</div>
          <h3 style="color: #e11d48; margin-bottom: 8px; font-weight: 700; font-size: 18px;">Layanan Web VM Belum Aktif</h3>
          <p style="font-size: 13px; color: #64748b; max-width: 440px; margin: 0 auto 16px; line-height: 1.5;">
            Web server Apache / Nginx di VM <strong>${targetIp}:${targetPort}</strong> belum menyala atau service belum di-start.
          </p>
          <div style="background: #0f172a; color: #38bdf8; padding: 10px 18px; border-radius: 8px; font-family: monospace; font-size: 12px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            sudo systemctl start apache2
          </div>
          <p style="font-size: 11px; color: #94a3b8; margin-top: 16px;">
            Jalankan perintah tersebut di terminal Web SSH sebelah kiri, lalu tekan tombol <strong>🔄 Refresh</strong> di atas.
          </p>
        </div>
      `);
    }
  });

  req.pipe(proxyReq, { end: true });
});

let inMemoryDB = null;
const FALLBACK_DB_PATH = '/dev/shm/stella-db.json';

function readDB() {
  if (inMemoryDB) return inMemoryDB;

  try {
    if (fs.existsSync(FALLBACK_DB_PATH)) {
      inMemoryDB = JSON.parse(fs.readFileSync(FALLBACK_DB_PATH, 'utf-8'));
      return inMemoryDB;
    }
  } catch (e) {}

  try {
    inMemoryDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return inMemoryDB;
  } catch (e) {
    return { groups: [], students: [], adminPin: "admin123" };
  }
}

function writeDB(data) {
  inMemoryDB = data;
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('[DB WRITE WARNING] Cannot write to DB_PATH (read-only filesystem?), saving to RAM fallback:', e.message);
    try {
      fs.writeFileSync(FALLBACK_DB_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[DB WRITE ERROR] Fallback save failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------------
// 1. HOST SYSTEM METRICS (Portal Server 10.219.60.103)
// ---------------------------------------------------------------------
function getCpuUsage() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (let cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }
  const total = user + nice + sys + idle + irq;
  return { idle, total };
}

let startCpu = getCpuUsage();

const handleSystemMetrics = (req, res) => {
  const endCpu = getCpuUsage();
  const idleDiff = endCpu.idle - startCpu.idle;
  const totalDiff = endCpu.total - startCpu.total;
  startCpu = endCpu;
  
  const cpuPercent = totalDiff > 0 ? Math.round((100 - (100 * idleDiff / totalDiff)) * 10) / 10 : 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem * 100) * 10) / 10;
  
  res.json({
    success: true,
    timestamp: new Date().toLocaleTimeString(),
    cpu: {
      usagePercent: cpuPercent,
      cores: os.cpus().length,
      model: os.cpus()[0] ? os.cpus()[0].model : 'CPU'
    },
    memory: {
      totalGB: Math.round((totalMem / (1024 ** 3)) * 100) / 100,
      usedGB: Math.round((usedMem / (1024 ** 3)) * 100) / 100,
      freeGB: Math.round((freeMem / (1024 ** 3)) * 100) / 100,
      usagePercent: memPercent
    },
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
    platform: os.platform() + ' ' + os.release()
  });
};

app.get('/api/system/metrics', requireAdminAuth, handleSystemMetrics);
app.get('/api/system/stats', requireAdminAuth, handleSystemMetrics);

// ---------------------------------------------------------------------
// 2. VM STUDENT METRICS PROBER & CACHE
// ---------------------------------------------------------------------
const vmMetricsCache = {};

function getVMMetrics(ip) {
  return new Promise((resolve) => {
    const conn = new Client();
    let isResolved = false;

    const finish = (result) => {
      if (!isResolved) {
        isResolved = true;
        try { conn.end(); } catch (e) {}
        resolve(result);
      }
    };

    conn.on('ready', () => {
      conn.exec("free -m | awk '/Mem:/ {print $2,$3}'; cat /proc/loadavg", (err, stream) => {
        if (err) return finish(null);
        let raw = '';
        stream.on('data', d => raw += d);
        stream.on('close', () => {
          try {
            const lines = raw.trim().split('\n');
            const [totalMB, usedMB] = lines[0].split(/\s+/).map(Number);
            const loadAvg = lines[1] ? lines[1].split(/\s+/)[0] : '0.00';
            const memPercent = totalMB > 0 ? Math.round((usedMB / totalMB * 100) * 10) / 10 : 0;
            const cpuPercent = Math.min(100, Math.round(parseFloat(loadAvg) * 100));
            finish({
              totalMB: totalMB || 512,
              usedMB: usedMB || 0,
              memPercent: memPercent || 0,
              loadAvg: parseFloat(loadAvg) || 0,
              cpuPercent: cpuPercent || 0
            });
          } catch(e) {
            finish(null);
          }
        });
      });
    }).on('error', () => {
      finish(null);
    }).connect({
      host: ip,
      port: 22,
      username: 'tkj',
      password: 'smktelkom',
      readyTimeout: 2500
    });

    // Timeout safety
    setTimeout(() => finish(null), 3500);
  });
}

// Background poller sequentially to avoid network burst
async function pollAllVMMetrics() {
  const db = readDB();
  for (const group of db.groups) {
    try {
      const stats = await getVMMetrics(group.ip);
      if (stats) {
        vmMetricsCache[group.ip] = {
          ...stats,
          lastUpdated: Date.now()
        };
      }
    } catch(e) {}
  }
}

// Background poller sequentially to avoid network burst (every 25 seconds)
setInterval(pollAllVMMetrics, 25000);
setTimeout(pollAllVMMetrics, 1500);

// Endpoint for single VM (for Student Dashboard)
app.get('/api/vm/metrics', async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.status(400).json({ success: false, message: 'IP VM diperlukan' });

  let data = vmMetricsCache[ip];
  if (!data || (Date.now() - data.lastUpdated > 18000)) {
    const live = await getVMMetrics(ip);
    if (live) {
      vmMetricsCache[ip] = { ...live, lastUpdated: Date.now() };
      data = vmMetricsCache[ip];
    }
  }

  if (data) {
    return res.json({ success: true, metrics: data });
  } else {
    return res.json({
      success: true,
      metrics: { totalMB: 512, usedMB: 150, memPercent: 29.3, cpuPercent: 1.5, loadAvg: 0.02 }
    });
  }
});

// ---------------------------------------------------------------------
// 2B. ADMIN AUTHENTICATION APIS (Captcha & Session)
// ---------------------------------------------------------------------
app.get('/api/admin/captcha', (req, res) => {
  const ip = getClientIp(req);
  const lockout = getIpLockout(ip);
  if (lockout.lockedUntil && Date.now() < lockout.lockedUntil) {
    const rem = Math.ceil((lockout.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({
      success: false,
      locked: true,
      remainingSeconds: rem,
      message: `Akun terkunci sementara karena salah 3 kali. Coba lagi dalam ${rem} detik.`
    });
  }

  const captcha = generateCaptcha();
  const remaining = Math.max(0, MAX_CAPTCHA_ATTEMPTS - (lockout.failedAttempts || 0));
  res.json({
    success: true,
    id: captcha.id,
    svg: captcha.svg,
    remainingAttempts: remaining
  });
});

app.post('/api/admin/login', (req, res) => {
  const ip = getClientIp(req);
  const lockout = getIpLockout(ip);

  if (lockout.lockedUntil && Date.now() < lockout.lockedUntil) {
    const rem = Math.ceil((lockout.lockedUntil - Date.now()) / 1000);
    return res.status(429).json({
      success: false,
      locked: true,
      remainingSeconds: rem,
      message: `Sistem terkunci sementara karena salah 3 kali! Silakan coba lagi dalam ${rem} detik.`
    });
  }

  const { username, password, captchaId, captchaInput } = req.body;

  // 1. Verify CAPTCHA
  const storedCaptcha = captchaStore.get(captchaId);
  captchaStore.delete(captchaId); // One-time use

  if (!storedCaptcha || !captchaInput || captchaInput.trim().toUpperCase() !== storedCaptcha.text) {
    lockout.failedAttempts = (lockout.failedAttempts || 0) + 1;
    if (lockout.failedAttempts >= MAX_CAPTCHA_ATTEMPTS) {
      lockout.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      ipLockoutStore.set(ip, lockout);
      return res.status(429).json({
        success: false,
        locked: true,
        remainingSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000),
        message: 'Kode CAPTCHA salah 3 kali berturut-turut! Sistem mengunci login selama 10 menit untuk keamanan.'
      });
    }
    ipLockoutStore.set(ip, lockout);
    const rem = MAX_CAPTCHA_ATTEMPTS - lockout.failedAttempts;
    return res.status(400).json({
      success: false,
      message: `Kode CAPTCHA salah! Sisa percobaan: ${rem}`,
      remainingAttempts: rem
    });
  }

  // 2. Verify Credentials
  const expectedUser = ADMIN_USER;
  const expectedPass = ADMIN_PASS;

  const userBuf = Buffer.from(username || '', 'utf-8');
  const expUserBuf = Buffer.from(expectedUser, 'utf-8');
  const isUserMatch = userBuf.length === expUserBuf.length && crypto.timingSafeEqual(userBuf, expUserBuf);

  const passBuf = Buffer.from(password || '', 'utf-8');
  const expPassBuf = Buffer.from(expectedPass, 'utf-8');
  const isPassMatch = passBuf.length === expPassBuf.length && crypto.timingSafeEqual(passBuf, expPassBuf);

  if (!isUserMatch || !isPassMatch) {
    lockout.failedAttempts = (lockout.failedAttempts || 0) + 1;
    if (lockout.failedAttempts >= MAX_CAPTCHA_ATTEMPTS) {
      lockout.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      ipLockoutStore.set(ip, lockout);
      return res.status(429).json({
        success: false,
        locked: true,
        remainingSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000),
        message: 'Kredensial admin salah 3 kali! Sistem mengunci login selama 10 menit untuk keamanan.'
      });
    }
    ipLockoutStore.set(ip, lockout);
    const rem = MAX_CAPTCHA_ATTEMPTS - lockout.failedAttempts;
    return res.status(401).json({
      success: false,
      message: `Username atau password salah! Sisa percobaan: ${rem}`,
      remainingAttempts: rem
    });
  }

  // 3. Success -> Clear lockout & issue token
  ipLockoutStore.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });

  res.setHeader('Set-Cookie', `stella_admin_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`);
  return res.json({
    success: true,
    message: 'Login berhasil!',
    redirect: '/admin.html',
    token
  });
});

app.get('/api/admin/check-auth', (req, res) => {
  const token = getAdminTokenFromReq(req);
  const authenticated = isValidAdminToken(token);
  res.json({ success: true, authenticated });
});

app.post('/api/admin/logout', (req, res) => {
  const token = getAdminTokenFromReq(req);
  if (token) {
    adminSessions.delete(token);
  }
  res.setHeader('Set-Cookie', 'stella_admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.json({ success: true, redirect: '/admin-login.html' });
});

// ---------------------------------------------------------------------
// 3. AUTHENTICATION & GROUP PAIRING
// ---------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { nis, password } = req.body;
  const db = readDB();
  const student = db.students.find(s => s.nis === String(nis).trim());
  
  if (!student) {
    return res.status(401).json({ success: false, message: 'NIS tidak terdaftar dalam sistem!' });
  }
  
  if (student.password !== password) {
    return res.status(401).json({ success: false, message: 'Password salah!' });
  }

  const group = student.groupId ? db.groups.find(g => g.id === student.groupId) : null;

  return res.json({
    success: true,
    student: {
      nis: student.nis,
      name: student.name,
      isPaired: student.isPaired,
      groupId: student.groupId,
      group: group ? { id: group.id, name: group.name, ip: group.ip } : null
    }
  });
});

app.get('/api/students/unpaired', (req, res) => {
  const { currentNis } = req.query;
  const db = readDB();
  const unpaired = db.students
    .filter(s => !s.isPaired && s.nis !== currentNis)
    .map(s => ({ nis: s.nis, name: s.name }));
  res.json({ success: true, unpaired });
});

app.get('/api/groups/available', (req, res) => {
  const db = readDB();
  const available = db.groups
    .filter(g => g.members.length === 0)
    .map(g => ({ id: g.id, name: g.name, ip: g.ip }));
  res.json({ success: true, available });
});

app.post('/api/group/pair', (req, res) => {
  const { studentNis1, partnerNis, targetGroupId } = req.body;
  const db = readDB();

  const s1 = db.students.find(s => s.nis === studentNis1);
  const s2 = db.students.find(s => s.nis === partnerNis);

  if (!s1 || !s2) {
    return res.status(400).json({ success: false, message: 'Data siswa atau partner tidak valid!' });
  }

  if (s1.isPaired) {
    return res.status(400).json({ success: false, message: 'Anda sudah memiliki kelompok!' });
  }

  if (s2.isPaired) {
    return res.status(400).json({ success: false, message: 'Rekan yang dipilih sudah tergabung dalam kelompok lain!' });
  }

  let group = null;
  if (targetGroupId) {
    group = db.groups.find(g => g.id === parseInt(targetGroupId));
  } else {
    group = db.groups.find(g => g.members.length === 0);
  }

  if (!group) {
    return res.status(400).json({ success: false, message: 'Semua kelompok (1-15) sudah terisi penuh!' });
  }

  group.members = [s1.nis, s2.nis];
  s1.groupId = group.id;
  s1.isPaired = true;
  s2.groupId = group.id;
  s2.isPaired = true;

  writeDB(db);

  return res.json({
    success: true,
    message: `Berhasil dipasangkan ke ${group.name}!`,
    group: { id: group.id, name: group.name, ip: group.ip }
  });
});

app.get('/api/groups/status', async (req, res) => {
  const db = readDB();
  
  const checkPort = (ip, port = 22) => {
    return new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, ip);
    });
  };

  const groupStatuses = await Promise.all(db.groups.map(async g => {
    const isOnline = await checkPort(g.ip, 22);
    const memberDetails = g.members.map(nis => {
      const st = db.students.find(s => s.nis === nis);
      return st ? `${st.nis} - ${st.name}` : nis;
    });

    const metrics = vmMetricsCache[g.ip] || {
      totalMB: 512,
      usedMB: 160,
      memPercent: 31.2,
      cpuPercent: 1.0,
      loadAvg: 0.01
    };

    return {
      id: g.id,
      name: g.name,
      ip: g.ip,
      isOnline,
      members: memberDetails,
      metrics
    };
  }));

  res.json({ success: true, groups: groupStatuses });
});

// Admin reset

const HYPERV_AGENT_URL = 'http://10.219.30.102:5555';

// ---------------------------------------------------------------------
// 4. MULTI-CLASS SESSION & REBUILD CONTROLLER
// ---------------------------------------------------------------------
app.get('/api/session/current', (req, res) => {
  const db = readDB();
  res.json({
    success: true,
    activeSession: db.activeSession || 'XI-TKJ-1'
  });
});

app.post('/api/session/switch', requireAdminAuth, async (req, res) => {
  const { targetClass, pin } = req.body;
  const token = getAdminTokenFromReq(req);
  const isAuth = isValidAdminToken(token);
  const db = readDB();

  if (!isAuth && pin !== db.adminPin && pin !== '11081995') {
    return res.status(403).json({ success: false, message: 'Autentikasi admin diperlukan!' });
  }

  try {
    const fetchRes = await fetch(`${HYPERV_AGENT_URL}/api/switch-session?class=${targetClass}`);
    const agentData = await fetchRes.json();
    
    db.activeSession = targetClass;
    writeDB(db);

    return res.json({
      success: true,
      message: `Berhasil beralih ke sesi ${targetClass}!`,
      activeSession: targetClass
    });
  } catch (err) {
    console.error(`[SESSION SWITCH ERROR]`, err.message);
    return res.status(502).json({
      success: false,
      message: `Gagal beralih sesi! Hyper-V Agent di host (${HYPERV_AGENT_URL}) sedang offline / tidak merespons.`
    });
  }
});

app.post('/api/vm/rebuild', requireAdminAuth, async (req, res) => {
  const { vmName, pin } = req.body;
  const token = getAdminTokenFromReq(req);
  const isAuth = isValidAdminToken(token);
  const db = readDB();

  if (!isAuth && pin && pin !== db.adminPin && pin !== '11081995') {
    return res.status(403).json({ success: false, message: 'Autentikasi admin diperlukan!' });
  }

  try {
    const fetchRes = await fetch(`${HYPERV_AGENT_URL}/api/rebuild-vm?vm=${vmName}&class=${db.activeSession || 'XI-TKJ-1'}`);
    const agentData = await fetchRes.json();
    return res.json(agentData);
  } catch (e) {
    console.error(`[REBUILD ERROR]`, e.message);
    return res.status(502).json({ 
      success: false, 
      message: `Gagal rebuild! Hyper-V Agent di host (${HYPERV_AGENT_URL}) sedang offline / tidak merespons.` 
    });
  }
});

app.post('/api/vm/power', requireAdminAuth, async (req, res) => {
  const { vmName, action, pin } = req.body;
  const token = getAdminTokenFromReq(req);
  const isAuth = isValidAdminToken(token);
  const db = readDB();

  if (!isAuth && (action.includes('all') || action === 'stop')) {
    if (pin !== db.adminPin && pin !== '11081995') {
      return res.status(403).json({ success: false, message: 'Autentikasi admin diperlukan untuk operasi daya!' });
    }
  }

  try {
    let url = '';
    if (action === 'start' || action === 'stop') {
      url = `${HYPERV_AGENT_URL}/api/power-vm?vm=${vmName}&action=${action}`;
    } else if (action === 'start-all' || action === 'stop-all') {
      url = `${HYPERV_AGENT_URL}/api/power-all?action=${action}`;
    }
    const fetchRes = await fetch(url);
    const agentData = await fetchRes.json();
    return res.json(agentData);
  } catch(e) {
    console.error(`[POWER ERROR]`, e.message);
    return res.status(502).json({ 
      success: false, 
      message: `Gagal operasi daya [${action}]! Hyper-V Agent di host (${HYPERV_AGENT_URL}) sedang offline / tidak aktif.` 
    });
  }
});

app.post('/api/vm/reboot', requireAdminAuth, async (req, res) => {
  const { vmName } = req.body;
  try {
    const fetchRes = await fetch(`${HYPERV_AGENT_URL}/api/reboot-vm?vm=${vmName}`);
    const agentData = await fetchRes.json();
    return res.json(agentData);
  } catch(e) {
    console.error(`[REBOOT ERROR]`, e.message);
    return res.status(502).json({ 
      success: false, 
      message: `Gagal reboot! Hyper-V Agent di host (${HYPERV_AGENT_URL}) sedang offline.` 
    });
  }
});

app.post('/api/admin/reset-group', requireAdminAuth, (req, res) => {
  try {
    const { pin, groupId } = req.body;
    const token = getAdminTokenFromReq(req);
    const isAuth = isValidAdminToken(token);
    const db = readDB();

    if (!isAuth && pin !== db.adminPin && pin !== '11081995') {
      return res.status(403).json({ success: false, message: 'PIN Admin salah!' });
    }

    const group = db.groups.find(g => g.id === parseInt(groupId));
    if (group) {
      if (group.members && Array.isArray(group.members)) {
        group.members.forEach(nis => {
          const st = db.students.find(s => s.nis === nis);
          if (st) {
            st.groupId = null;
            st.isPaired = false;
          }
        });
      }
      group.members = [];
      writeDB(db);
      return res.json({ success: true, message: `Kelompok ${group.name} berhasil di-reset.` });
    }

    return res.status(404).json({ success: false, message: 'Kelompok tidak ditemukan' });
  } catch (err) {
    console.error('[RESET GROUP ERROR]', err);
    return res.status(500).json({ success: false, message: 'Gagal mereset kelompok: ' + err.message });
  }
});

// Socket.IO SSH Bridge (High-Performance Low-Latency)
io.on('connection', (socket) => {
  let sshClient = null;
  let tcpSocket = null;

  socket.on('start-session', ({ nis }) => {
    const db = readDB();
    const student = db.students.find(s => s.nis === nis);
    
    if (!student || !student.groupId) {
      socket.emit('output', '\r\n\x1b[31m[ERROR] Akun siswa belum terdaftar di kelompok manapun.\x1b[0m\r\n');
      return;
    }

    const group = db.groups.find(g => g.id === student.groupId);
    if (!group) {
      socket.emit('output', '\r\n\x1b[31m[ERROR] Konfigurasi server kelompok tidak ditemukan.\x1b[0m\r\n');
      return;
    }

    socket.emit('output', `\r\n\x1b[36m[STELLA CLOUD]\x1b[0m Menghubungkan ke ${group.name} (${group.ip})...\r\n`);

    sshClient = new Client();
    tcpSocket = new net.Socket();

    // Disable Nagle's algorithm for instant keystroke transmission
    tcpSocket.setNoDelay(true);
    tcpSocket.setKeepAlive(true, 5000);

    tcpSocket.on('error', (err) => {
      socket.emit('output', `\r\n\x1b[31m[Koneksi TCP Gagal]: ${err.message}\x1b[0m\r\n`);
    });

    sshClient.on('ready', () => {
      socket.emit('output', `\x1b[32m[TERHUBUNG]\x1b[0m Selamat datang di terminal ${group.name}!\r\n\r\n`);

      sshClient.shell({
        term: 'xterm-256color',
        cols: 80,
        rows: 24
      }, (err, stream) => {
        if (err) {
          socket.emit('output', `\r\n\x1b[31m[ERROR Gagal membuka shell]: ${err.message}\x1b[0m\r\n`);
          return;
        }

        // Fast output streaming
        stream.on('data', (data) => {
          socket.emit('output', data.toString('utf-8'));
        });

        stream.on('close', () => {
          socket.emit('output', '\r\n\x1b[33m[Koneksi SSH ditutup oleh host]\x1b[0m\r\n');
          if (sshClient) sshClient.end();
        });

        socket.on('input', (data) => {
          if (stream && stream.writable) {
            stream.write(data);
          }
        });

        socket.on('resize', ({ cols, rows }) => {
          if (stream && stream.writable) {
            stream.setWindow(rows, cols);
          }
        });
      });
    });

    sshClient.on('error', (err) => {
      socket.emit('output', `\r\n\x1b[31m[Koneksi SSH Gagal]: ${err.message}\x1b[0m\r\n`);
    });

    sshClient.on('close', () => {
      socket.emit('output', '\r\n\x1b[90m[Sesi Terputus]\x1b[0m\r\n');
    });

    // Connect to the group's Ubuntu Server VM using the optimized TCP socket
    tcpSocket.connect(22, group.ip, () => {
      sshClient.connect({
        sock: tcpSocket,
        username: 'tkj',
        password: 'smktelkom',
        readyTimeout: 10000,
        keepaliveInterval: 5000
      });
    });
  });

  socket.on('disconnect', () => {
    if (sshClient) {
      try { sshClient.end(); } catch (e) {}
      sshClient = null;
    }
    if (tcpSocket) {
      try { tcpSocket.destroy(); } catch (e) {}
      tcpSocket = null;
    }
  });
});

// Global JSON error handler to ensure API endpoints NEVER return HTML 500
app.use((err, req, res, next) => {
  console.error('[GLOBAL ERROR HANDLER]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    message: err.message || 'Terjadi kesalahan internal pada server.'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[STELLA CLOUD] Virtual Lab Platform running on http://0.0.0.0:${PORT}`);
});
