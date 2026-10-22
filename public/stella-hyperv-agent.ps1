# =====================================================================
# STELLA HYPER-V CONTROLLER AGENT (Port 5555) - Bulletproof Service
# =====================================================================
Import-Module Hyper-V -ErrorAction SilentlyContinue

$logFile = "C:\stella-agent.log"
try { Start-Transcript -Path $logFile -Append -Force -ErrorAction SilentlyContinue } catch {}

Write-Host "=======================================================" -ForegroundColor Green
Write-Host " STELLA HYPER-V CONTROLLER AGENT INITIALIZING..." -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green

# 1. Atur Firewall
netsh advfirewall firewall delete rule name="StellaPort5555" >$null 2>&1
netsh advfirewall firewall add rule name="StellaPort5555" dir=in action=allow protocol=TCP localport=5555 profile=any >$null 2>&1

$masterVHD = "C:\ProgramData\Microsoft\Windows\Virtual Hard Disks\Ubuntu-Master.vhdx"
$baseDir = "C:\VM-Siswa"
$dirTKJ1 = "$baseDir\XI-TKJ-1"
$dirTKJ2 = "$baseDir\XI-TKJ-2"

# 2. Direktori Profil Kelas
New-Item -ItemType Directory -Force -Path $dirTKJ1 -ErrorAction SilentlyContinue | Out-Null
New-Item -ItemType Directory -Force -Path $dirTKJ2 -ErrorAction SilentlyContinue | Out-Null

function Wait-VMState($vmName, $targetState, $timeoutSec = 20) {
    $elapsed = 0
    while ($elapsed -lt $timeoutSec) {
        $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
        if ($vm -and $vm.State -eq $targetState) {
            return $true
        }
        Start-Sleep -Milliseconds 500
        $elapsed += 0.5
    }
    return $false
}

function Switch-ClassSession($targetClass) {
    $targetDir = "$baseDir\$targetClass"
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Force -Path $targetDir -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Host "[SWITCH] Menukar disk 15 VM ke sesi: $targetClass..." -ForegroundColor Yellow

    1..15 | ForEach-Object {
        $num = "{0:D2}" -f $_
        $vmName = "TKJ-Kelompok-$num"
        Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
    }

    $maxWait = 25
    while ($maxWait -gt 0) {
        $active = Get-VM -Name "TKJ-Kelompok-*" -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Off' }
        if (-not $active) { break }
        Start-Sleep -Seconds 1
        $maxWait--
    }
    Start-Sleep -Seconds 2

    1..15 | ForEach-Object {
        $num = "{0:D2}" -f $_
        $vmName = "TKJ-Kelompok-$num"
        $newVhd = "$targetDir\$vmName.vhdx"

        try {
            if (-not (Test-Path $newVhd)) {
                New-VHD -ParentPath $masterVHD -Path $newVhd -Differencing -ErrorAction SilentlyContinue | Out-Null
            }
            $drive = Get-VMHardDiskDrive -VMName $vmName -ErrorAction Stop
            Set-VMHardDiskDrive -VMHardDiskDrive $drive -Path $newVhd -ErrorAction Stop
            Start-VM -Name $vmName -AsJob -ErrorAction SilentlyContinue | Out-Null
            Write-Host "  -> $vmName dialihkan ke $targetClass" -ForegroundColor Green
        } catch {
            Write-Host "  -> Gagal pada $($vmName): $_" -ForegroundColor Red
        }
    }
    return "Berhasil beralih ke sesi $targetClass"
}

function Rebuild-VMInstance($vmName, $targetClass) {
    $targetDir = "$baseDir\$targetClass"
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Force -Path $targetDir -ErrorAction SilentlyContinue | Out-Null
    }
    $vhdPath = "$targetDir\$vmName.vhdx"

    Write-Host "[REBUILD] Mereset VM $vmName ($targetClass) ke master bersih..." -ForegroundColor Magenta

    # 1. Matikan VM dan tunggu sampai 'Off'
    Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
    $isOff = Wait-VMState -vmName $vmName -targetState 'Off' -timeoutSec 20
    if (-not $isOff) {
        Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Seconds 2

    # 2. Hapus differencing disk lama dengan retry
    $removed = $false
    for ($i = 0; $i -lt 15; $i++) {
        try {
            if (Test-Path $vhdPath) {
                Remove-Item -Path $vhdPath -Force -ErrorAction Stop
            }
            $removed = $true
            break
        } catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not $removed -and (Test-Path $vhdPath)) {
        try {
            $orphanPath = "$vhdPath.old." + (Get-Date -Format "yyyyMMddHHmmss")
            Move-Item -Path $vhdPath -Destination $orphanPath -Force -ErrorAction Stop
            $removed = $true
        } catch {
            return "Gagal me-reset disk $vmName karena file masih terkunci oleh Hyper-V."
        }
    }

    # 3. Buat differencing VHD baru
    try {
        New-VHD -ParentPath $masterVHD -Path $vhdPath -Differencing -ErrorAction Stop | Out-Null
    } catch {
        return "Gagal membuat disk differencing baru: $_"
    }

    # 4. Pasang disk ke VM
    try {
        $drive = Get-VMHardDiskDrive -VMName $vmName -ErrorAction Stop
        Set-VMHardDiskDrive -VMHardDiskDrive $drive -Path $vhdPath -ErrorAction Stop
    } catch {
        return "Gagal memasang hard disk baru ke $($vmName) - $_"
    }

    # 5. Nyalakan VM
    Start-VM -Name $vmName -AsJob -ErrorAction SilentlyContinue | Out-Null
    Write-Host "[OK] $vmName berhasil di-rebuild bersih ke master!" -ForegroundColor Green
    return "$vmName berhasil di-rebuild bersih ke kondisi master!"
}

# 3. HTTP Listener Ringan (Port 5555)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:5555/")

try {
    $listener.Start()
    Write-Host "STELLA HYPER-V CONTROLLER AKTIF DI PORT 5555" -ForegroundColor Green
} catch {
    Write-Host "Percobaan 1 gagal: $_. Mencoba prefix http://*:5555/..." -ForegroundColor Yellow
    try {
        $listener = New-Object System.Net.HttpListener
        $listener.Prefixes.Add("http://*:5555/")
        $listener.Start()
        Write-Host "STELLA HYPER-V CONTROLLER AKTIF DI PORT 5555 (Prefix *)" -ForegroundColor Green
    } catch {
        Write-Host "FATAL: Gagal menyalakan listener di port 5555: $_" -ForegroundColor Red
        return
    }
}

$currentSession = "XI-TKJ-1"

# 4. Loop Utama Penangan Request
while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $url = $request.RawUrl
        $resObj = @{ success = $true; message = "OK" }

        if ($url -match "/api/status") {
            $resObj = @{
                success = $true
                currentSession = $currentSession
                host = $env:COMPUTERNAME
            }
        }
        elseif ($url -match "/api/switch-session") {
            $targetClass = $request.QueryString["class"]
            if ($targetClass) {
                $msg = Switch-ClassSession $targetClass
                $currentSession = $targetClass
                $resObj = @{ success = $true; message = $msg; currentSession = $currentSession }
            }
        }
        elseif ($url -match "/api/rebuild-vm") {
            $vmName = $request.QueryString["vm"]
            $cls = $request.QueryString["class"]
            if (-not $cls) { $cls = $currentSession }
            
            if ($vmName) {
                $msg = Rebuild-VMInstance $vmName $cls
                $isErr = $msg -match "Gagal"
                $resObj = @{ success = (-not $isErr); message = $msg }
            }
        }
        elseif ($url -match "/api/power-vm") {
            $vmName = $request.QueryString["vm"]
            $action = $request.QueryString["action"]
            
            if ($vmName) {
                if ($action -eq "start") {
                    Start-VM -Name $vmName -AsJob -ErrorAction SilentlyContinue | Out-Null
                    $resObj = @{ success = $true; message = "$vmName sedang dinyalakan" }
                } elseif ($action -eq "stop") {
                    Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
                    $resObj = @{ success = $true; message = "$vmName berhasil dimatikan" }
                }
            }
        }
        elseif ($url -match "/api/power-all") {
            $action = $request.QueryString["action"]
            if ($action -eq "start-all") {
                1..15 | ForEach-Object {
                    $num = "{0:D2}" -f $_
                    Start-VM -Name "TKJ-Kelompok-$num" -AsJob -ErrorAction SilentlyContinue | Out-Null
                }
                $resObj = @{ success = $true; message = "Semua 15 VM sedang dinyalakan secara paralel" }
            } elseif ($action -eq "stop-all") {
                1..15 | ForEach-Object {
                    $num = "{0:D2}" -f $_
                    Stop-VM -Name "TKJ-Kelompok-$num" -TurnOff -Force -ErrorAction SilentlyContinue
                }
                $resObj = @{ success = $true; message = "Semua 15 VM berhasil dimatikan" }
            }
        }
        elseif ($url -match "/api/reboot-vm") {
            $vmName = $request.QueryString["vm"]
            if ($vmName) {
                Restart-VM -Name $vmName -Force -ErrorAction SilentlyContinue
                $resObj = @{ success = $true; message = "$vmName berhasil direstart" }
            }
        }
        elseif ($url -match "/api/update-agent") {
            Write-Host "[UPDATE] Memperbarui script controller dari portal..." -ForegroundColor Cyan
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                $code = (New-Object System.Net.WebClient).DownloadString("https://cloud.smktelkom-lpg.id/stella-hyperv-agent.ps1")
                Set-Content -Path "C:\stella-controller.ps1" -Value $code -Force
                $resObj = @{ success = $true; message = "Controller berhasil diupdate! Silakan jalankan ulang." }
            } catch {
                $resObj = @{ success = $false; message = "Gagal mengunduh update: $_" }
            }
        }

        $json = $resObj | ConvertTo-Json -Depth 3
        $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
        $response.ContentType = "application/json"
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.OutputStream.Close()
    } catch {
        Write-Host "[ERROR REQ] $_" -ForegroundColor Red
    }
}
