#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is niet gevonden in PATH. Installeer Node.js eerst."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Dependencies niet gevonden. npm install wordt uitgevoerd..."
  npm install
fi

open "http://localhost:3111"
echo "Helios Monitor wordt gestart..."
npm start
