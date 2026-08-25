@echo off
cd /d "%~dp0"
if not exist "control\config.json" copy /Y "control\config.example.json" "control\config.json" >nul
echo AI time sink  (control\config.json)
echo log file      %~dp0tmp\log.jsonl
python sink.py
pause

