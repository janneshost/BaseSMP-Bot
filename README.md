# Discord Bot – Ticket-System, Umfrage, Giveaway

## Was der Bot kann
- **`/ticket-panel`** – postet ein Dropdown-Menü mit den Kategorien *Allgemein*, *Bugs*, *Modbewerbung Discord*, *Modbewerbung Twitch*. Bei Auswahl wird automatisch ein privater Ticket-Kanal erstellt (nur sichtbar für den User + Team-Rolle) mit einem "Ticket schließen"-Button.
- **`/umfrage frage:"..." optionen:"a,b,c"`** – erstellt eine Umfrage mit bis zu 5 Optionen, automatisch mit Zahlen-Reaktionen zum Abstimmen.
- **`/giveaway-start preis:"..." dauer:<Minuten> gewinner:<Anzahl>`** – startet ein Giveaway mit "Teilnehmen"-Button. Beim Klick öffnet sich ein Formular, in dem der Ingame-Name eingetragen werden muss. Ohne Ingame-Name keine Teilnahme.
- **`/giveaway-end message_id:<ID>`** – beendet ein Giveaway manuell vorzeitig. Giveaways enden sonst automatisch nach Ablauf der Zeit (wird alle 15 Sekunden geprüft).

## Setup

1. **Bot im Discord Developer Portal anlegen**: https://discord.com/developers/applications
   - Bot-Tab → Token kopieren
   - Unter "Privileged Gateway Intents": *Server Members Intent* aktivieren
   - OAuth2 → URL Generator: Scopes `bot`, `applications.commands`; Permissions: mind. `Manage Channels`, `Send Messages`, `Manage Roles` — Bot damit auf deinen Server einladen

2. **Dateien vorbereiten**
   ```bash
   npm install
   cp .env.example .env
   ```
   Trage in `.env` ein:
   - `DISCORD_TOKEN` – Bot-Token
   - `CLIENT_ID` – Application ID
   - `GUILD_ID` – deine Server-ID
   - `TICKET_CATEGORY_ID` – ID der Kategorie für Ticket-Kanäle (leer lassen = Kanäle landen ohne Kategorie)
   - `STAFF_ROLE_ID` – Rolle, die alle Tickets sehen darf

3. **Slash-Commands registrieren**
   ```bash
   npm run deploy
   ```

4. **Bot starten**
   ```bash
   npm start
   ```

## 24/7 laufen lassen
Der Code selbst läuft nur, solange der Prozess läuft. Für dauerhaften Betrieb brauchst du einen Host, z. B.:
- ein kleiner **VPS** (z. B. bei Hetzner, Contabo) + `pm2` zum Neustarten bei Absturz
- Plattformen wie **Railway** oder **Render** (Node.js-Projekt deployen)
- Ein Raspberry Pi zuhause, der durchläuft

Auf einem eigenen Server empfiehlt sich `pm2`:
```bash
npm install -g pm2
pm2 start index.js --name discord-bot
pm2 save
pm2 startup
```

## Daten
Ticket-Zähler und Giveaway-Daten (inkl. Ingame-Namen) werden in `data.json` gespeichert. Für den produktiven Einsatz mit vielen Giveaways gleichzeitig könnte man später auf eine echte Datenbank (SQLite/MongoDB) umsteigen – für den Start reicht die JSON-Datei.
