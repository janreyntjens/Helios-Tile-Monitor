@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo NPM is niet gevonden in PATH. Installeer Node.js eerst.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dependencies niet gevonden. Eerste installatie wordt uitgevoerd...
  echo Dit kan enkele minuten duren.
  call npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo npm ci is mislukt. Fallback naar npm install...
    call npm install --omit=dev --no-audit --no-fund --loglevel=error
    if errorlevel 1 (
      echo Dependency installatie is mislukt.
      pause
      exit /b 1
    )
  )
)

start "" "http://localhost:3111"
echo Helios Monitor wordt gestart...
call npm start

if errorlevel 1 (
  echo Starten van de app is mislukt.
  pause
  exit /b 1
)

endlocal
