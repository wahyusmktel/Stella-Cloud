# =====================================================================
# STELLA HYPER-V CONTROLLER AGENT (Port 5555)
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

Write-Host "[3/4] Menyiapkan disk cadangan XI-TKJ-2..." -ForegroundColor Cyan
1..15 | ForEach-Object {
    $num = "{0:D2}" -f $_
    $vmName = "TKJ-Kelompok-$num"
    $vhdTKJ2 = "$dirTKJ2\$vmName.vhdx"
    
    if (-not (Test-Path $vhdTKJ2)) {
        New-VHD -ParentPath $masterVHD -Path $vhdTKJ2 -Differencing | Out-Null
    }
}

function Switch-ClassSession($targetClass) {
    $targetDir = if ($targetClass -eq "XI-TKJ-2") { $dirTKJ2 } else { $dirTKJ1 }
    Write-Host "[SWITCH] Menukar disk 15 VM ke sesi: $targetClass..." -ForegroundColor Yellow

    1..15 | ForEach-Object {
        $num = "{0:D2}" -f $_
        $vmName = "TKJ-Kelompok-$num"
        $newVhd = "$targetDir\$vmName.vhdx"

        try {
            Stop-VM -Name $vmName -TurnOff -ErrorAction SilentlyContinue
            $drive = Get-VMHardDiskDrive -VMName $vmName
            Set-VMHardDiskDrive -VMHardDiskDrive $drive -Path $newVhd
            Start-VM -Name $vmName -AsJob | Out-Null
            Write-Host "  -> $vmName dialihkan ke $targetClass" -ForegroundColor Green
        } catch {
            Write-Host "  -> Gagal pada $($vmName)" -ForegroundColor Red
        }
    }
    return "Berhasil beralih ke sesi $targetClass"
}

function Rebuild-VMInstance($vmName, $targetClass) {
    $targetDir = if ($targetClass -eq "XI-TKJ-2") { $dirTKJ2 } else { $dirTKJ1 }
    $vhdPath = "$targetDir\$vmName.vhdx"

    Write-Host "[REBUILD] Mereset VM $vmName ($targetClass) ke master bersih..." -ForegroundColor Magenta
    Stop-VM -Name $vmName -TurnOff -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    
    if (Test-Path $vhdPath) {
        Remove-Item -Path $vhdPath -Force
    }

    New-VHD -ParentPath $masterVHD -Path $vhdPath -Differencing | Out-Null
    $drive = Get-VMHardDiskDrive -VMName $vmName
    Set-VMHardDiskDrive -VMHardDiskDrive $drive -Path $vhdPath
    Start-VM -Name $vmName -AsJob | Out-Null
    Write-Host "[OK] $vmName berhasil di-rebuild ke kondisi pabrik!" -ForegroundColor Green
    return "$vmName berhasil di-rebuild bersih!"
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
            $resObj = @{ success = $true; message = $msg }
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
                Stop-VM -Name $vmName -TurnOff -ErrorAction SilentlyContinue
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
                Stop-VM -Name "TKJ-Kelompok-$num" -TurnOff -ErrorAction SilentlyContinue
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

    $json = $resObj | ConvertTo-Json
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.ContentType = "application/json"
    $response.ContentLength64 = $buffer.Length
    $response.OutputStream.Write($buffer, 0, $buffer.Length)
    $response.OutputStream.Close()
}
