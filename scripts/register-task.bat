@echo off
REM Register RichTracker_PriceLoader in Windows Task Scheduler
REM Run this once to set up the scheduled task

schtasks /create /tn "RichTracker_PriceLoader" /tr "cmd.exe /c D:\DEV_ON_D\rich_tracker\scripts\cron-price.bat" /sc weekly /d MON,TUE,WED,THU,FRI /st 16:30 /ru SYSTEM /f
if %ERRORLEVEL% == 0 (
    echo Task registered successfully
) else (
    echo Failed to register task (error %ERRORLEVEL%)
)
