# HELIOS MONITOR

Lokale monitorsoftware voor MVR Helios processors met:

- Netwerkscanner voor Helios processors
- Drag-and-drop toewijzing naar `MAIN` en `BACKUP`
- 4 monitorrijen met kleurenstatus
- Knopacties voor `Go Main` en `Go Backup`
- Persistente config (geen herprogrammeren nodig na herstart)

## Vereisten

- Node.js 18+ (Node 20+ aanbevolen)
- Windows of macOS

## Starten

```bash
npm install
npm start
```

Open daarna:

- http://localhost:3111

Snelle launchers:

- Windows: `start-helios-monitor.bat`
- macOS: `start-helios-monitor.command`

## Werking van de 4 rijen

1. Rij 1: toont MAIN processor naam/IP en is klikbaar voor `Go Main`
2. Rij 2: toont MAIN tiles (`gevonden / verwacht`) en knippert rood als gevonden < verwacht
3. Rij 3: toont BACKUP tiles (`gevonden / verwacht`) en knippert rood als gevonden < verwacht
4. Rij 4: toont BACKUP processor naam/IP en is klikbaar voor `Go Backup` (knippert ook rood bij backup tile-tekort)

## Scanner

- Fast scan scant automatisch de relevante lokale IPv4-ranges van alle actieve netwerkadapters
- Tijdens scannen toont de UI een voortgangsbalk

## Commandoconfiguratie

Standaard gebruikt de app:

- `PATCH /api/v1/public` met `dev.display.redundancy.state = "main"`
- `PATCH /api/v1/public` met `dev.display.redundancy.state = "backup"`

Als jouw setup andere commando's nodig heeft, kan dit in de backend worden uitgebreid met custom body/path (basis zit al in `src/heliosClient.js`).

## Data-opslag

Config en toewijzingen worden lokaal opgeslagen in:

- `data/state.json`

## GitHub

Deze map is nu klaar om op GitHub te zetten, maar er staat op dit moment nog geen git-repository in de workspace.

Minimale stappen:

```bash
git init
git add .
git commit -m "v1.0.0"
git branch -M main
git remote add origin https://github.com/janreyntjens/Helios-Tile-Monitor.git
git push -u origin main
```

De `.gitignore` sluit `node_modules`, logs en lokale state uit.

## Windows en macOS releases

Wat nu direct haalbaar is:

- broncode op GitHub publiceren
- op GitHub Actions automatisch laten valideren op Windows en macOS
- gebruikers de app laten starten met Node.js + de meegeleverde launcher

Wat ik niet als "klaar" zou verkopen zonder extra packaging-spike:

- een volledig standalone `.exe` en `.app` zonder Node-installatie

Reden: de app gebruikt `@elgato-stream-deck/node` en `node-hid`, dus er zit native platformafhankelijke code in. Dat maakt echte cross-platform single-binary packaging gevoeliger dan een gewone Express app.

Wel toegevoegd:

- `npm run smoke` voor een snelle platformcheck
- GitHub Actions CI op Windows en macOS via `.github/workflows/ci.yml`

## Release v1

Voor een eerste release:

```bash
git tag v1.0.0
git push origin main
git push origin v1.0.0
```

Bij een tag zoals `v1.0.0` maakt GitHub Actions nu automatisch twee release-assets:

- Windows zip
- macOS zip

Belangrijk: dit zijn platformspecifieke distributiezips van de app-broncode en launchers, geen volledig standalone native app-bundles zonder Node.js.

Als je wilt, kan ik als volgende stap ook nog een echte `v1.0.0` releaseflow toevoegen met versie-tags en zip-artifacts per OS.
