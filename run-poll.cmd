# eLMS -> Discord poll cycle (called by Windows Task Scheduler).
# Location-independent: %~dp0 is this file's own folder.
@echo off
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist data mkdir data
rem rotate the log at 2 MB so it cannot grow forever
for %%F in (logs\poll.log) do if %%~zF GTR 2097152 (
  if exist logs\poll.log.1 del /q logs\poll.log.1
  move /y logs\poll.log logs\poll.log.1 >nul
)
rem Task Scheduler (especially as SYSTEM) may have a PATH without node.
rem install-task.ps1 writes the absolute interpreter path to .node-path.
set "NODE_EXE=node"
if exist ".node-path" set /p NODE_EXE=<.node-path
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo [%DATE% %TIME%] start >> logs\poll.log
"%NODE_EXE%" "%~dp0src\poll.js" >> logs\poll.log 2>&1
set RC=%ERRORLEVEL%
echo [%DATE% %TIME%] exit=%RC% >> logs\poll.log
exit /b %RC%
