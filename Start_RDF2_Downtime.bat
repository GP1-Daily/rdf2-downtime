@echo off
cd /d "%~dp0"
title RDF2 Downtime Logger (อย่าปิดหน้าต่างนี้ระหว่างใช้งาน)
node server.js
pause
