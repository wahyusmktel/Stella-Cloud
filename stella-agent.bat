@echo off
title STELLA HYPER-V CONTROLLER (PORT 5555)
color 0A

echo =======================================================
echo  MEMPERSIAPKAN STELLA HYPER-V CONTROLLER
echo =======================================================

:: 1. Buka Firewall Port 5555
netsh advfirewall firewall add rule name="Stella-Cloud-Agent" dir=in action=allow protocol=TCP localport=5555 >nul 2>&1

:: 2. Unduh file controller PowerShell murni ke C:\stella-controller.ps1
echo [INFO] Mengunduh script controller terbaru...
powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/wahyusmktel/Stella-Cloud/main/stella-hyperv-agent.ps1' -OutFile 'C:\stella-controller.ps1' -UseBasicParsing"

:: 3. Jalankan script controller
echo [INFO] Menjalankan controller di port 5555...
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\stella-controller.ps1"

pause
