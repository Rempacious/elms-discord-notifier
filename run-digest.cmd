rem eLMS daily digest (called by Windows Task Scheduler). Args are passed through,
rem e.g. run-digest.cmd --dry-run builds the image without posting.
@echo off
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist data mkdir data

set "NODE_EXE=node"
if exist ".node-path" set /p NODE_EXE=<.node-path
if not exist "%NODE_EXE%" set "NODE_EXE=node"

for %%F in (logs\digest.log) do if %%~zF GTR 2097152 (
  if exist logs\digest.log.1 del /q logs\digest.log.1
  move /y logs\digest.log logs\digest.log.1 >nul
)
echo [%DATE% %TIME%] start >> logs\digest.log
"%NODE_EXE%" "%~dp0src\digest.js" %* >> logs\digest.log 2>&1
set RC=%ERRORLEVEL%
echo [%DATE% %TIME%] exit=%RC% >> logs\digest.log
exit /b %RC%
