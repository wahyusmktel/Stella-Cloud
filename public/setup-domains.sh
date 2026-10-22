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

# Update config.php secara presisi menggunakan PHP engine
php -r '
$f = "/var/www/owncloud/config/config.php";
$c = file_get_contents($f);

// Ganti trusted_domains secara presisi
$target = "\x27trusted_domains\x27 => \n  array (\n    0 => \x27localhost\x27,\n    1 => (isset(\$_SERVER[\x27HTTP_HOST\x27]) ? preg_replace(\x27/:[0-9]+$/\x27, \x27\x27, \$_SERVER[\x27HTTP_HOST\x27]) : \x27localhost\x27),\n  ),\n  ";
$c = preg_replace("/\x27trusted_domains\x27\s*=>.*?\x27datadirectory\x27/s", $target . "\x27datadirectory\x27", $c);

// Tambahkan overwriteprotocol untuk HTTPS Cloudflare jika belum ada
if (strpos($c, "overwriteprotocol") === false) {
    $c = str_replace(
        "\x27overwrite.cli.url\x27",
        "\x27overwriteprotocol\x27 => (isset(\$_SERVER[\x27HTTP_X_FORWARDED_PROTO\x27]) && \$_SERVER[\x27HTTP_X_FORWARDED_PROTO\x27] === \x27https\x27) ? \x27https\x27 : \x27\x27,\n  \x27overwrite.cli.url\x27",
        $c
    );
}

file_put_contents($f, $c);
'

# Pastikan permission tetap milik www-data
chown www-data:www-data "$CONFIG"

# Verifikasi sintaks PHP
php -l "$CONFIG" > /dev/null 2>&1
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
