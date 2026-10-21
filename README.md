# ☁️ Stella Cloud - Virtual Lab Platform

> **Platform Virtual Lab Cloud Computing SMK Telkom Lampung**  
> Didesain khusus untuk pembelajaran praktikum Linux Server & Cloud Computing bagi siswa Kelas XI Teknik Komputer dan Jaringan (TKJ).

---

## 🌟 Latar Belakang & Solusi
Kendala spesifikasi komputer lab (Core i3, RAM 4GB) yang sering mengalami *freeze* saat menjalankan VirtualBox lokal diatasi dengan memindahkan beban komputasi secara terpusat (*Centralized Private Cloud*). 

Siswa tidak perlu menjalankan VM lokal atau memasang PuTTY. Seluruh aktivitas praktikum dilakukan langsung melalui web browser melalui antarmuka **Stella Cloud**.

---

## 🚀 Fitur Utama
1. **Single Sign-On Siswa (NIS & Password):** Autentikasi mudah menggunakan Nomor Induk Siswa.
2. **Setup Pasangan Kelompok (Driver & Navigator):** Siswa dipasangkan berdua untuk mengelola 1 server VM Ubuntu bersama.
3. **In-Browser Web Terminal (xterm.js):** Terminal SSH interaktif langsung di browser dengan dukungan penuh *colors, ANSI, nano, htop, copy-paste*.
4. **Live Telemetry & Resource Monitoring:**
   - **Student Dashboard:** Menampilkan grafik penggunaan CPU & RAM real-time dari VM kelompoknya.
   - **Teacher Monitoring Panel (`/admin.html`):** Grafik interaktif (Chart.js) beban host server serta tabel status live 15 VM siswa lengkap dengan fitur reset kelompok.
5. **Akses Global (Cloudflare Tunnel):** Terintegrasi langsung dengan domain `cloud.smktelkom-lpg.id` sehingga siswa dapat melakukan praktikum dari sekolah maupun dari rumah.

---

## 🏗️ Arsitektur Sistem

```
[ Browser Siswa / HP / PC Lab ]
             │  (HTTPS via Cloudflare Tunnel)
             ▼
   [ cloud.smktelkom-lpg.id ]
             │
             ▼
[ Stella Cloud Portal (Node.js + Socket.io) ]  <--- Port 4000
             │  (SSH Stream Bridge)
             ├── VM Kelompok 01 (10.219.30.84)
             ├── VM Kelompok 02 (10.219.30.86)
             └── ... s/d Kelompok 15
```

---

## 🛠️ Tech Stack
- **Backend:** Node.js, Express.js, Socket.IO, `ssh2`
- **Frontend:** Vanilla JS, Tailwind CSS, xterm.js, Chart.js
- **Database:** JSON-based state store (`data/db.json`)
- **Process Manager:** PM2
- **Networking & Ingress:** Cloudflare Zero Trust Tunnel

---

## 💻 Menjalankan di Lokal / Development

1. **Clone repositori:**
   ```bash
   git clone https://github.com/wahyusmktel/Stella-Cloud.git
   cd Stella-Cloud
   ```

2. **Install dependensi:**
   ```bash
   npm install
   ```

3. **Jalankan aplikasi:**
   ```bash
   npm start
   ```
   Aplikasi akan berjalan di `http://localhost:4000`.

---

## 👨‍🏫 Panel Monitoring Guru
Akses panel monitoring pengajar melalui URL:
- `http://localhost:4000/admin.html` atau `https://cloud.smktelkom-lpg.id/admin.html`
- **PIN Default Guru:** `admin123`

---

© 2026 **SMK Telkom Lampung** • Teknik Komputer dan Jaringan.
