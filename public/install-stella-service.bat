@echo off
title INSTALASI STELLA AGENT SEBAGAI BACKGROUND SERVICE
color 0B

:: Cek Administrator Privilege
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Script ini memerlukan izin Administrator!
    echo Silakan klik kanan file ini, lalu pilih "Run as Administrator".
    echo.
    pause
    exit /b 1
)

echo ========================================================
echo  MEMASANG STELLA HYPER-V CONTROLLER SEBAGAI SERVICE
echo ========================================================
echo.

:: 1. Atur Firewall Port 5555 dan HTTP URL ACL
echo [1/4] Mengatur Windows Firewall dan HTTP Access Port 5555...
netsh advfirewall firewall delete rule name="StellaPort5555" >nul 2>&1
netsh advfirewall firewall add rule name="StellaPort5555" dir=in action=allow protocol=TCP localport=5555 profile=any >nul 2>&1
netsh http delete urlacl url=http://+:5555/ >nul 2>&1
netsh http add urlacl url=http://+:5555/ user=Everyone >nul 2>&1

:: 2. Unduh Script Controller Terbaru
echo [2/4] Mengunduh script controller terbaru dari GitHub...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/wahyusmktel/Stella-Cloud/main/stella-hyperv-agent.ps1' -OutFile 'C:\stella-controller.ps1' -UseBasicParsing"

:: 3. Hentikan task / service lama jika ada
echo [3/4] Mendaftarkan Windows System Service (Auto-Start saat Booting)...
powershell -NoProfile -Command ^
    "$taskName = 'StellaHyperVAgent';" ^
    "Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;" ^
    "Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue;" ^
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\stella-controller.ps1';" ^
    "$trigger = New-ScheduledTaskTrigger -AtStartup;" ^
    "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;" ^
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0;" ^
    "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null;"

:: 4. Jalankan Service Sekarang
echo [4/4] Menyalakan service Stella Hyper-V Agent...
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'StellaHyperVAgent'"

echo.
echo ========================================================
echo  BERHASIL! STELLA AGENT KINI RESMI BERJALAN SEBAGAI SERVICE
echo ========================================================
echo - Tidak ada lagi jendela hitam CMD/PowerShell yang perlu dibiarkan terbuka.
echo - Otomatis menyala saat komputer server Hyper-V booting / restart (tanpa perlu login).
echo - Berjalan di latar belakang dengan akun SYSTEM.
echo.
pause
