@echo off
title HAPUS SERVICE STELLA AGENT
color 0C

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Harap jalankan script ini dengan cara: Klik Kanan -^> "Run as Administrator"
    pause
    exit /b 1
)

echo ========================================================
echo  MENGHENTIKAN DAN MENGHAPUS SERVICE STELLA AGENT
echo ========================================================
echo.

powershell -NoProfile -Command ^
    "Stop-ScheduledTask -TaskName 'StellaHyperVAgent' -ErrorAction SilentlyContinue;" ^
    "Unregister-ScheduledTask -TaskName 'StellaHyperVAgent' -Confirm:$false -ErrorAction SilentlyContinue;" ^
    "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*stella-controller.ps1*' } | Stop-Process -Force -ErrorAction SilentlyContinue;"

echo Service Stella Hyper-V Agent berhasil dihentikan dan dihapus.
echo.
pause
