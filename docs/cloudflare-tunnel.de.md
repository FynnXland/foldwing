# Eigene Domain mit Cloudflare Tunnel

Stand: Foldwing 1.4.0. [English version](cloudflare-tunnel.md)

Standardmäßig laufen die Links von Foldwing über den öffentlichen Relay `share.fynn.land` und
gehen ohne Einrichtung überall. Diese Anleitung gilt für die dritte Betriebsart, *Eigene
Domain*: Die Links nutzen deine eigene Domain, etwa `https://share.example.com/s/…`, und laufen
durch einen Cloudflare-Tunnel in deinem eigenen Cloudflare-Konto. Der Relay ist dann nicht
beteiligt. Niemand sonst kann deine Links sperren, und du hängst nicht an einem Dienst, den
jemand anderes kostenlos betreibt. Das mitgelieferte cloudflared startet Foldwing selbst und
hält es am Laufen, solange etwas geteilt ist; einen Port am Router musst du nicht öffnen.

Die Menüpunkte von Cloudflare stehen hier so, wie das englische Dashboard sie zeigt. Cloudflare
benennt sie ab und zu um; weicht etwas ab, hilft Cloudflares eigene Anleitung
[Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/).

## Was du brauchst

- Ein Cloudflare-Konto. Der kostenlose Tarif reicht.
- Eine eigene Domain in deinem Cloudflare-Konto: Cloudflare führt dich durchs Hinzufügen, und
  beim Anbieter deiner Domain stellst du die Nameserver auf Cloudflare um. Für eine Domain
  zahlst du meist eine jährliche Gebühr.
- Foldwing, installiert auf dem PC mit deinen Freigaben.

## Was sich für deine Dateien ändert

Gespeichert sind deine Dateien weiterhin nur auf deinem PC. Öffnet jemand einen Link, läuft
der Download von deinem PC durch den Tunnel zu Cloudflare und von dort zum Empfänger, auf
beiden Strecken verschlüsselt. Die Verschlüsselung endet aber bei Cloudflare; technisch könnte
Cloudflare also sehen, was durchläuft. Ist das für eine Datei nicht in Ordnung, teil sie im
Modus *Nur im eigenen Netzwerk*.

## Einrichten

1. **Tunnel anlegen.** Im Cloudflare-Dashboard unter *Networking → Tunnels* auf *Create a
   tunnel* gehen. Einen Namen vergeben, etwa `foldwing`, und *Create Tunnel* wählen.
2. **Token kopieren.** Cloudflare zeigt jetzt einen Installationsbefehl für dein
   Betriebssystem. Führ ihn nicht aus, denn cloudflared startet Foldwing selbst. Kopier nur
   den Token daraus, die lange Zeichenkette, die mit `eyJ` beginnt. Behalt ihn für dich: Wer
   ihn hat, kann deinen Tunnel betreiben.
3. **Foldwing verbinden.** Reiter *Einstellungen* → Karte *Links* → *Über deine eigene Domain*
   wählen. Unter *Adresse* deine Adresse eintragen, zum Beispiel `share.example.com`, unter
   *Tunnel-Token* den Token einfügen und *Speichern und verwenden* drücken. Foldwing startet den Tunnel und
   hält ihn ein paar Minuten offen, auch wenn noch nichts geteilt ist; so bleibt Zeit für den
   nächsten Schritt.
4. **Domain auf Foldwing leiten.** Zurück im Dashboard sieht Cloudflare die Verbindung jetzt;
   *Continue* wählen oder den Tunnel später unter *Networking → Tunnels* öffnen. Im Reiter
   *Routes* auf *Add route* → *Published application* gehen. Eine Subdomain eintragen, etwa
   `share`, die Domain wählen und als *Service URL* `http://localhost:8787` angeben. Mit
   *Add route* bestätigen.
5. **Testen.** In Foldwing auf *Verbindung testen* drücken. Steht dort *Erreichbar*, gehen
   deine Links. Kopierte Links nutzen ab jetzt deine Domain.

Brauchst du den Token später noch einmal, öffne den Tunnel unter *Networking → Tunnels* und
wähl *Add a replica*; der Installationsbefehl dort enthält denselben Token.

## Gut zu wissen

- **Links gehen, solange Foldwing läuft und dein PC wach und online ist.** Das Fenster zu
  schließen ist kein Problem; *Beenden* im Menü des Infobereichs nimmt die Links vom Netz.
- **Ist nichts geteilt, ruht der Tunnel.** Eine Minute nach der letzten Freigabe stoppt
  Foldwing Server und Tunnel, und in den Einstellungen steht *Ruht*. Teilst du wieder etwas,
  starten beide von selbst.
- **Port 8787.** Auf diesem Port lauscht Foldwing. Belegt ihn schon ein anderes Programm,
  weicht Foldwing auf einen zufälligen freien Port aus, und der Tunnel erreicht es nicht mehr.
  Dann das andere Programm schließen und Foldwing neu starten.
- **Der Token liegt im Klartext** in `%APPDATA%\foldwing\foldwing-config.json` (Linux:
  `~/.config/foldwing/foldwing-config.json`). Behandle diese Datei wie ein Passwort. Ist der
  Token nach außen gelangt, öffne den Tunnel im Cloudflare-Dashboard und wähl im Reiter
  *Overview* *Refresh token* (oder lösch den Tunnel und leg einen neuen an); den neuen Token
  trägst du dann in Foldwing ein.
- **Ein Wechsel der Betriebsart ändert deine Links.** Jeder Link enthält die Adresse seiner
  Betriebsart. Was du im Modus *Internet* verschickt hast, geht nach dem Wechsel zur eigenen
  Domain nicht mehr, und umgekehrt.
- **Schon einen Tunnel mit `config.yml`?** Foldwing startet Tunnel nur per Token. Leg für
  Foldwing im Dashboard einen eigenen Tunnel an, wie oben beschrieben.

## Wenn etwas nicht geht

| Problem | Was du tun kannst |
|---|---|
| **Status „Für die eigene Domain fehlen noch Adresse oder Tunnel-Token.“** | Beides eintragen und *Speichern* drücken. Ein gespeicherter Token wird nicht wieder angezeigt; im Feld steht dann *Token ist gespeichert*. |
| **Status „Verbindung zu Cloudflare unterbrochen“** direkt nach dem Speichern | Meist stimmt der Token nicht. Den ganzen Token noch einmal ohne Leerzeichen einfügen und speichern. |
| **„cloudflared fehlt“** | Release-Versionen bringen cloudflared mit. Installier Foldwing neu; in einem eigenen Build `node scripts/fetch-cloudflared.mjs` ausführen. |
| **„Keine Antwort“ oder „Nicht erreichbar“** | Die Domain führt noch nicht zum Tunnel. Prüf die Route (*Service URL* `http://localhost:8787`) und unter *DNS* im Dashboard, ob ein CNAME-Eintrag mit Proxy für deine Subdomain auf `<Tunnel-ID>.cfargotunnel.com` zeigt. Neue DNS-Einträge brauchen manchmal ein paar Minuten. |
| **„Unter der Adresse antwortet etwas anderes“** | Statt Foldwing antwortet Cloudflare oder ein anderer Server. Prüf, ob die Route auf `http://localhost:8787` zeigt und nicht auf einen anderen Port. |
| **Der Test klappt, Empfänger sehen trotzdem manchmal eine Fehlerseite** | Foldwing lief nicht, der PC schlief, oder die Freigabe war abgelaufen. |
