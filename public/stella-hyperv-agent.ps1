# =====================================================================
# STELLA HYPER-V CONTROLLER AGENT (Port 5555) - Enhanced & Robust
# =====================================================================

Write-Host "[1/4] Mengatur Windows Firewall untuk Port 5555..." -ForegroundColor Cyan
netsh advfirewall firewall delete rule name="StellaPort5555" >$null 2>&1
netsh advfirewall firewall add rule name="StellaPort5555" dir=in action=allow protocol=TCP localport=5555 profile=any >$null 2>&1

$masterVHD = "C:\ProgramData\Microsoft\Windows\Virtual Hard Disks\Ubuntu-Master.vhdx"
$baseDir = "C:\VM-Siswa"
$dirTKJ1 = "$baseDir\XI-TKJ-1"
$dirTKJ2 = "$baseDir\XI-TKJ-2"

Write-Host "[2/4] Menyiapkan direktori profil kelas..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $dirTKJ1 | Out-Null
New-Item -ItemType Directory -Force -Path $dirTKJ2 | Out-Null

Write-Host "[3/4] Menyiapkan disk cadangan XI-TKJ-1 & XI-TKJ-2..." -ForegroundColor Cyan
1..15 | ForEach-Object {
    $num = "{0:D2}" -f $_
    $vmName = "TKJ-Kelompok-$num"
    $vhdTKJ1 = "$dirTKJ1\$vmName.vhdx"
    $vhdTKJ2 = "$dirTKJ2\$vmName.vhdx"
    
    if (-not (Test-Path $vhdTKJ1)) {
        New-VHD -ParentPath $masterVHD -Path $vhdTKJ1 -Differencing | Out-Null
    }
    if (-not (Test-Path $vhdTKJ2)) {
        New-VHD -ParentPath $masterVHD -Path $vhdTKJ2 -Differencing | Out-Null
    }
}

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
    $targetDir = if ($targetClass -eq "XI-TKJ-2") { $dirTKJ2 } else { $dirTKJ1 }
    Write-Host "[SWITCH] Menukar disk 15 VM ke sesi: $targetClass..." -ForegroundColor Yellow

    # Step 1: Turn off all VMs
    1..15 | ForEach-Object {
        $num = "{0:D2}" -f $_
        $vmName = "TKJ-Kelompok-$num"
        Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
    }

    # Step 2: Wait until all VMs are stopped
    $maxWait = 25
    while ($maxWait -gt 0) {
        $active = Get-VM -Name "TKJ-Kelompok-*" | Where-Object { $_.State -ne 'Off' }
        if (-not $active) { break }
        Start-Sleep -Seconds 1
        $maxWait--
    }
    Start-Sleep -Seconds 2

    # Step 3: Swap attached hard disks to target session and power on
    1..15 | ForEach-Object {
        $num = "{0:D2}" -f $_
        $vmName = "TKJ-Kelompok-$num"
        $newVhd = "$targetDir\$vmName.vhdx"

        try {
            if (-not (Test-Path $newVhd)) {
                New-VHD -ParentPath $masterVHD -Path $newVhd -Differencing -Force | Out-Null
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
    $targetDir = if ($targetClass -eq "XI-TKJ-2") { $dirTKJ2 } else { $dirTKJ1 }
    $vhdPath = "$targetDir\$vmName.vhdx"

    Write-Host "[REBUILD] Mereset VM $vmName ($targetClass) ke master bersih..." -ForegroundColor Magenta

    # 1. Matikan VM secara paksa dan tunggu sampai benar-benar 'Off'
    Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
    $isOff = Wait-VMState -vmName $vmName -targetState 'Off' -timeoutSec 20
    if (-not $isOff) {
        Write-Host "[WARN] VM $vmName belum dalam status Off, mencoba stop lagi..." -ForegroundColor Yellow
        Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    # Jeda ekstra agar file lock pada .vhdx dilepas oleh proses Hyper-V (vmwp.exe)
    Start-Sleep -Seconds 2

    # 2. Hapus differencing disk lama dengan retry loop
    $removed = $false
    for ($i = 0; $i -lt 15; $i++) {
        try {
            if (Test-Path $vhdPath) {
                Remove-Item -Path $vhdPath -Force -ErrorAction Stop
            }
            $removed = $true
            break
        } catch {
            Write-Host "[LOCK] Menunggu pelepasan file lock $vhdPath (percobaan ke-$($i+1))..." -ForegroundColor Yellow
            Start-Sleep -Seconds 1
        }
    }

    # Jika file masih terkunci, coba rename agar path target bisa dibuatkan VHD baru
    if (-not $removed -and (Test-Path $vhdPath)) {
        try {
            $orphanPath = "$vhdPath.old." + (Get-Date -Format "yyyyMMddHHmmss")
            Move-Item -Path $vhdPath -Destination $orphanPath -Force -ErrorAction Stop
            Write-Host "[MOVE] Disk lama dipindahkan ke $orphanPath" -ForegroundColor Yellow
            $removed = $true
        } catch {
            Write-Host "[ERROR] Gagal memindahkan disk terkunci: $_" -ForegroundColor Red
            return "Gagal me-reset disk $vmName karena file masih terkunci oleh Hyper-V. Silakan ulangi dalam beberapa detik."
        }
    }

    # 3. Buat differencing VHD baru dari Ubuntu Master
    try {
        New-VHD -ParentPath $masterVHD -Path $vhdPath -Differencing -Force -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "[ERROR] Gagal membuat differencing VHD: $_" -ForegroundColor Red
        return "Gagal membuat disk differencing baru: $_"
    }

    # 4. Pastikan VM Hard Disk Drive terhubung ke path VHD yang baru
    try {
        $drive = Get-VMHardDiskDrive -VMName $vmName -ErrorAction Stop
        Set-VMHardDiskDrive -VMHardDiskDrive $drive -Path $vhdPath -ErrorAction Stop
    } catch {
        Write-Host "[ERROR] Gagal memasang VHD ke $vmName: $_" -ForegroundColor Red
        return "Gagal memasang hard disk baru ke $vmName: $_"
    }

    # 5. Nyalakan kembali VM
    Start-VM -Name $vmName -AsJob -ErrorAction SilentlyContinue | Out-Null
    Write-Host "[OK] $vmName ($targetClass) berhasil di-rebuild 100% bersih ke master!" -ForegroundColor Green
    return "$vmName berhasil di-rebuild bersih ke kondisi master!"
}

# 6. HTTP Listener Ringan (Port 5555)
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:5555/")

try {
    $listener.Start()
    Write-Host "`n=======================================================" -ForegroundColor Green
    Write-Host " STELLA HYPER-V CONTROLLER AKTIF DI PORT 5555" -ForegroundColor Green
    Write-Host " Siap menerima perintah Start, Shutdown, Rebuild & Sesi" -ForegroundColor Green
    Write-Host "=======================================================`n" -ForegroundColor Green
} catch {
    Write-Host "Gagal menyalakan listener di port 5555: $_" -ForegroundColor Red
    return
}

$currentSession = "XI-TKJ-1"

while ($listener.IsListening) {
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
    elseif ($url -match "/api/query-vms") {
        $vmsInfo = @()
        1..15 | ForEach-Object {
            $num = "{0:D2}" -f $_
            $vmName = "TKJ-Kelompok-$num"
            $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
            $drive = Get-VMHardDiskDrive -VMName $vmName -ErrorAction SilentlyContinue
            $diskSizeMB = 0
            $lastMod = $null
            if ($drive.Path -and (Test-Path $drive.Path)) {
                $f = Get-Item $drive.Path
                $diskSizeMB = [Math]::Round($f.Length / 1MB, 2)
                $lastMod = $f.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
            }
            $vmsInfo += @{
                name = $vmName
                state = if ($vm) { $vm.State.ToString() } else { "NotFound" }
                attachedVhd = if ($drive) { $drive.Path } else { $null }
                sizeMB = $diskSizeMB
                lastModified = $lastMod
            }
        }
        $resObj = @{
            success = $true
            currentSession = $currentSession
            vms = $vmsInfo
        }
    }
    elseif ($url -match "/api/switch-session") {
        $targetClass = $request.QueryString["class"]
        if ($targetClass -in @("XI-TKJ-1", "XI-TKJ-2")) {
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
                Write-Host "[POWER] Menyalakan $vmName (Background Job)" -ForegroundColor Green
            } elseif ($action -eq "stop") {
                Stop-VM -Name $vmName -TurnOff -Force -ErrorAction SilentlyContinue
                $resObj = @{ success = $true; message = "$vmName berhasil dimatikan" }
                Write-Host "[POWER] Mematikan $vmName" -ForegroundColor Yellow
            }
        }
    }
    elseif ($url -match "/api/power-all") {
        $action = $request.QueryString["action"]
        if ($action -eq "start-all") {
            Write-Host "[POWER] Menyalakan seluruh 15 VM secara PARALEL..." -ForegroundColor Green
            1..15 | ForEach-Object {
                $num = "{0:D2}" -f $_
                Start-VM -Name "TKJ-Kelompok-$num" -AsJob -ErrorAction SilentlyContinue | Out-Null
            }
            $resObj = @{ success = $true; message = "Semua 15 VM sedang dinyalakan secara paralel" }
        } elseif ($action -eq "stop-all") {
            Write-Host "[POWER] Mematikan seluruh 15 VM..." -ForegroundColor Yellow
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

    $json = $resObj | ConvertTo-Json -Depth 3
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.ContentType = "application/json"
    $response.ContentLength64 = $buffer.Length
    $response.OutputStream.Write($buffer, 0, $buffer.Length)
    $response.OutputStream.Close()
}
