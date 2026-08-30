@echo off
REM Daily price ingestion task — runs every weekday at 16:30 ET
REM Installed via: D:\DEV_ON_D\rich_tracker\scripts\register-task.bat
set "NODE=C:\Program Files\nodejs\node.exe"
set "PNPM_CMD=C:\Users\taylo\AppData\Roaming\npm\pnpm.cmd"
set "WORKDIR=D:\DEV_ON_D\rich_tracker"
%NODE% "%WORKDIR%\node_modules\.bin\tsx" "%WORKDIR%\src\lib\cron\worker.ts"
