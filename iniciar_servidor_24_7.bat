@echo off
chcp 65001 >nul
title Servidor 24/7 - Telemetria Fotovoltaica (telemetriafv.duckdns.org)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_public_tunnel.ps1"

