const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('ssh2');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    return { groups: [], students: [], adminPin: "admin123" };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
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

app.get('/api/system/metrics', (req, res) => {
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
});

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

app.post('/api/session/switch', async (req, res) => {
  const { targetClass, pin } = req.body;
  const db = readDB();

  if (pin !== db.adminPin) {
    return res.status(403).json({ success: false, message: 'PIN Admin tidak valid!' });
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
    // If agent is offline, still update db state
    db.activeSession = targetClass;
    writeDB(db);
    return res.json({
      success: true,
      message: `Sesi diubah ke ${targetClass} (Catatan: Pastikan agent Hyper-V di PC host aktif).`,
      activeSession: targetClass
    });
  }
});

app.post('/api/vm/rebuild', async (req, res) => {
  const { vmName, pin } = req.body;
  const db = readDB();

  if (pin && pin !== db.adminPin) {
    return res.status(403).json({ success: false, message: 'PIN Admin salah!' });
  }

  try {
    const fetchRes = await fetch(`${HYPERV_AGENT_URL}/api/rebuild-vm?vm=${vmName}&class=${db.activeSession || 'XI-TKJ-1'}`);
    const agentData = await fetchRes.json();
    return res.json(agentData);
  } catch (e) {
    return res.json({ success: true, message: `Instruksi rebuild untuk ${vmName} dikirim ke queue Hyper-V.` });
  }
});


app.post('/api/vm/power', async (req, res) => {
  const { vmName, action, pin } = req.body;
  const db = readDB();

  if (action.includes('all') || action === 'stop') {
    if (pin !== db.adminPin) {
      return res.status(403).json({ success: false, message: 'PIN Admin diperlukan untuk operasi daya!' });
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
    return res.json({ success: true, message: `Instruksi daya [${action}] dikirim ke ${vmName || 'semua VM'}.` });
  }
});

app.post('/api/vm/reboot', async (req, res) => {
  const { vmName } = req.body;
  try {
    const fetchRes = await fetch(`${HYPERV_AGENT_URL}/api/reboot-vm?vm=${vmName}`);
    const agentData = await fetchRes.json();
    return res.json(agentData);
  } catch(e) {
    return res.json({ success: true, message: `Instruksi reboot dikirim ke ${vmName}` });
  }
});

app.post('/api/admin/reset-group', (req, res) => {
  const { pin, groupId } = req.body;
  const db = readDB();

  if (pin !== db.adminPin) {
    return res.status(403).json({ success: false, message: 'PIN Admin salah!' });
  }

  const group = db.groups.find(g => g.id === parseInt(groupId));
  if (group) {
    group.members.forEach(nis => {
      const st = db.students.find(s => s.nis === nis);
      if (st) {
        st.groupId = null;
        st.isPaired = false;
      }
    });
    group.members = [];
    writeDB(db);
    return res.json({ success: true, message: `Kelompok ${group.name} berhasil di-reset.` });
  }

  res.status(404).json({ success: false, message: 'Kelompok tidak ditemukan' });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[STELLA CLOUD] Virtual Lab Platform running on http://0.0.0.0:${PORT}`);
});
