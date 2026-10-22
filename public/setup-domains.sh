#!/bin/bash
# =====================================================================
# STELLA CLOUD - AUTO CONFIGURE TRUSTED DOMAINS & HTTPS OVERWRITE
# Membuka izin akses penuh untuk IP Lokal Lab & Cloudflare Tunnel Bebas
# =====================================================================

CONFIG="/var/www/owncloud/config/config.php"

if [ ! -f "$CONFIG" ]; then
    echo "[ERROR] File $CONFIG tidak ditemukan. Pastikan langkah occ maintenance:install sudah selesai."
    exit 1
fi

# Update config.php secara presisi menggunakan PHP engine via heredoc
php7.4 << 'EOF'
<?php
$f = "/var/www/owncloud/config/config.php";
$c = file_get_contents($f);

// Match trusted_domains down to datadirectory
$target = "'trusted_domains' => \n  array (\n    0 => 'localhost',\n    1 => (isset(\$_SERVER['HTTP_HOST']) ? preg_replace('/:[0-9]+$/', '', \$_SERVER['HTTP_HOST']) : 'localhost'),\n  ),\n  'datadirectory'";

$c = preg_replace("/'trusted_domains'\\s*=>.*?'datadirectory'/s", $target, $c);

// Inject overwriteprotocol jika belum ada
if (strpos($c, 'overwriteprotocol') === false) {
    $c = str_replace(
        "'overwrite.cli.url'",
        "'overwriteprotocol' => (isset(\$_SERVER['HTTP_X_FORWARDED_PROTO']) && \$_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') ? 'https' : '',\n  'overwrite.cli.url'",
        $c
    );
}

file_put_contents($f, $c);
EOF

# Pastikan permission tetap milik www-data
chown www-data:www-data "$CONFIG"

# Verifikasi sintaks PHP
php7.4 -l "$CONFIG" > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "=========================================================="
    echo " [OK] BERHASIL! Domain Trusted & HTTPS Siap Digunakan!    "
    echo "=========================================================="
    echo " 1. IP Lokal VM (10.219.30.xx)   : Diizinkan Otomatis"
    echo " 2. Cloudflare Quick Tunnel       : Diizinkan Semua Subdomain"
    echo "=========================================================="
else
    echo "[ERROR] Gagal memvalidasi sintaks config.php"
    exit 1
fi
