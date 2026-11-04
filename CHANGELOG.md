# Changelog

Was sich für Nutzer von Foldwing (bis 1.3.0 FlowShare) geändert hat, neueste zuerst. Technische Details stehen in den Commit-Nachrichten.

Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/).

## [1.4.1] - 2026-11-04

**Internet-Links laufen jetzt über foldwing.online.** Links, die du schon verschickt hast, gehen weiter.

### Geändert

- Neue Links sehen so aus: `https://foldwing.online/…` statt `https://share.fynn.land/…`. Dahinter steckt derselbe Relay, deshalb bleiben ältere Links gültig, und Foldwing 1.4.0 teilt bis zum Update weiter wie bisher.

### Behoben

- „Wirklich löschen?“ bleibt rot, wenn du mit der Maus darüberfährst. Bisher wurde die Schrift dabei fast unsichtbar.
- Während Foldwing verbindet, steht das nur noch einmal da und nicht zusätzlich in einer Leiste darüber.

## [1.4.0] - 2026-11-04

**Foldwing ist Open Source, und deine Links gehen jetzt überall, ohne Konto und ohne Einrichtung.** Die Dateien bleiben dabei auf deinem PC.

### Neu

- Links fürs Internet ohne eigenes Konto: Standardmäßig laufen sie über den öffentlichen Relay share.fynn.land und lassen sich von überall öffnen. Der Relay reicht nur die Seiten durch und schickt Downloads direkt zu deinem Rechner; Dateien speichert er nicht. Bevor sich Foldwing das erste Mal dort anmeldet, erklärt dir ein kurzer Hinweis, was passiert, und du kannst auch nur im eigenen Netzwerk teilen.
- Unter Einstellungen → „Links“ wählst du, wie deine Links die Empfänger erreichen: über das Internet, nur im eigenen Netzwerk oder über deine eigene Domain mit eigenem Cloudflare-Tunnel.
- Auf Seiten, die über share.fynn.land geteilt sind, steht unten „Melden“. Darüber lassen sich Links mit rechtswidrigem Inhalt melden.
- Updates kommen jetzt für alle über GitHub. Installer und AppImage laden neue Versionen selbst und installieren sie auf Knopfdruck oder beim Beenden; die portable Version und das .deb-Paket sagen dir Bescheid und führen zur Download-Seite. Unter „Updates“ lässt sich die Prüfung abschalten.
- Foldwing gibt es jetzt offiziell auch für Linux: Jedes Release enthält ein AppImage und ein .deb-Paket. Getestet wird vor allem unter Windows; unter Linux geht das Wichtigste, Feinheiten können fehlen.
- Findet Foldwing keinen Virenscanner (Windows Defender oder ClamAV), sagen dir das die Einstellungen: Deine Dateien werden dann ungeprüft geteilt. Unter Linux mit Wayland erfährst du dort auch, dass Screenshots in dieser Sitzung nicht gehen; die Taste bleibt dann frei.
- Beim Start zeigt das Fenster eine Ladeanzeige, bis alles bereit ist.
- Fährst du mit der Maus über das Symbol im Infobereich, siehst du dein Screenshot-Kürzel und ob deine Links gerade online sind.
- Der Quellcode steht unter der MIT-Lizenz. Lizenz und Hinweise zu den mitgelieferten Fremdkomponenten liegen der App bei, und zu jedem Release gibt es eine Datei mit Prüfsummen.

### Geändert

- FlowShare heißt jetzt Foldwing, mit einem Papierflieger als neuem Logo. Das Update übernimmt deine Einstellungen, deine Freigaben und deinen bisherigen Screenshot-Ordner. Rechtsklick-Eintrag und Autostart stellt es auf den neuen Namen um.
- Die Oberfläche ist aufgeräumt: Oben wechselst du zwischen „Teilen“ und „Einstellungen“, und über der Ablage zeigt eine Zeile, wohin deine Links führen und ob sie gerade erreichbar sind.
- Bevor eine Freigabe gelöscht wird, fragt Foldwing einmal nach („Wirklich löschen?“).
- Im Hintergrund braucht Foldwing deutlich weniger Arbeitsspeicher. Das Screenshot-Fenster und die Fenster-Erkennung starten erst, wenn du sie brauchst, Excel- und Word-Vorschau und Update-Prüfung werden erst bei Gebrauch geladen, und das Hauptfenster wird beim Schließen ganz beendet.
- Ist nichts geteilt, ruhen Server und Tunnel. Sobald du etwas teilst, starten sie von selbst; in den Einstellungen steht so lange „Ruht“.
- Das Screenshot-Overlay erscheint schneller nach dem Tastendruck.
- Die Einstellungen sind neu geordnet: Statt „Erweitert“ und „Cloud-Verbindung“ gibt es eine Karte „Links“, und die eigene Domain richtest du dort mit Adresse und Tunnel-Token in einem Schritt ein.
- Deine bisherige Einrichtung wird übernommen. Hattest du eine eigene Domain mit Tunnel-Token, bleibt es dabei. Alle anderen teilen ab jetzt über das Internet, und ihre Links ändern sich dabei; wer lieber im eigenen Netzwerk bleibt, stellt das unter „Links“ um.
- Größen erscheinen mit Dezimalkomma, in der App und auf den Seiten für Empfänger: „148,4 KB“ statt „148.4 KB“.
- Die App nennt die Art einer Datei auf Deutsch, etwa „Bild“ oder „Tabelle“. Öffnet ein Empfänger eine einzelne Datei, steht dort ebenfalls ihre Art statt des technischen Dateityps.

### Behoben

- „Mit Foldwing teilen“ verschwand nach jedem Update aus dem Rechtsklick-Menü. Foldwing prüft den Eintrag jetzt bei jedem Start und stellt ihn wieder her.
- Beim Deinstallieren verschwindet jetzt auch der Autostart-Eintrag.
- Nach einer Änderung am Tunnel konnte ein zweites cloudflared weiterlaufen, sogar nach dem Beenden von Foldwing. Das passiert nicht mehr.
- Das Symbol im blauen Kopieren-Knopf ist jetzt gut zu sehen; bisher war es grau auf Blau.
- Nach einem Neustart steht die neueste Freigabe oben und nicht mehr die älteste.

### Entfernt

- Den Team-Modus gibt es nicht mehr. Mit ihm entfallen Team-Builds, die automatischen Subdomains, Updates über einen Team-Rechner und die Impressum-Seite aus der Team-Konfiguration. Wer im Team war, teilt nach dem Update über share.fynn.land; alte Team-Links gehen nicht mehr.
- Ein benannter Tunnel mit `config.yml` lässt sich nicht mehr nutzen. Für die eigene Domain brauchst du einen Tunnel-Token aus dem Cloudflare-Dashboard.
- Die Zugangs-Sperre mit Token und die Betreiber-Rechte. Die App startet ohne Freischaltung und kann überall dasselbe.
- Der Schalter „Server im Hintergrund weiterlaufen lassen“. Das regelt Foldwing jetzt selbst.

### Sicherheit

- Foldwing läuft auf Electron 45. Für das bisherige Electron 33 gab es keine Sicherheitsupdates mehr.
- Teilst du über das Internet, nimmt der eingebaute Server nur noch Verbindungen von deinem eigenen PC an. Aus dem lokalen Netzwerk ist er dann nicht direkt erreichbar.
- Das Geheimnis, mit dem sich dein Rechner beim Relay ausweist, liegt verschlüsselt in den Einstellungen.
- Die Installer entstehen auf GitHub aus dem veröffentlichten Quellcode und nicht mehr auf einem privaten Rechner.

## [1.3.0] - 2026-09-05

**Mehrere Dateien, ein Link.** Ziehst du mehrere Dateien auf einmal ins Fenster, entsteht eine Freigabe mit einem einzigen Link statt eines Links pro Datei. Bestehende Freigaben bleiben unverändert gültig.

### Neu

- Der Empfänger sieht eine Übersicht aller Dateien mit Vorschaubild (bei Bildern) oder Typ-Symbol, Größe und Art. Er kann jede Datei einzeln öffnen und herunterladen oder alle zusammen als ZIP.
- Das ZIP ist unkomprimiert: Jede Datei darin ist bit-identisch mit dem Original, und der Browser zeigt beim Herunterladen den echten Fortschritt.
- Ein Klick auf eine Datei der Übersicht öffnet sie mit voller Vorschau und einem Link zurück zur Übersicht.
- Die Freigabe-Karte in der App listet alle Dateien, und die Suche findet auch deren Namen.
- Eine Sammlung fasst bis zu 100 Dateien. Der Virenscan prüft jede Datei einzeln; stuft er eine als Schadsoftware ein, wird die ganze Freigabe abgelehnt.

## [1.2.0] - 2026-09-05

**FlowShare läuft jetzt auch unter Linux**, und viele Stellen sind sicherer und robuster geworden.

### Neu

- Linux-Version als AppImage und .deb-Paket. Die Fenster-Erkennung für Screenshots funktioniert unter X11, der Virenscan nutzt ClamAV. Unter Wayland sind Screenshots und Tastenkürzel noch nicht getestet.

### Sicherheit

- Vorschauen von Excel- und Word-Dateien werden vor der Anzeige bereinigt. Eine präparierte Datei konnte die Freigabe-Seite bisher auf eine fremde Adresse umleiten.
- Direkte Downloads öffnet der Browser nie als Webseite, auch wenn eine Datei wie HTML aussieht. Ausgenommen sind PDFs, damit sie im Browser lesbar bleiben.
- Das App-Fenster lässt sich nicht mehr auf fremde Seiten umleiten.
- Update-Dateien liefert nur noch die App des Betreibers aus.
- Eine eigene Subdomain bekommt nur noch, wer einen gültigen Zugangs-Token hat oder der Betreiber ist. Für Namen gelten strengere Regeln.
- Viele Aufrufe eines Links zur selben Zeit lassen die App nicht mehr einfrieren.
- Mitgelieferte Bibliotheken mit bekannten Sicherheitslücken wurden aktualisiert.

### Behoben

- Ein Schreibfehler beim Speichern einer Freigabe, etwa bei voller Festplatte, bringt die App nicht mehr zum Absturz oder Hängen.
- Startest du FlowShare ein zweites Mal, während es noch hochfährt (zum Beispiel über „Mit FlowShare teilen“), geht die Datei nicht mehr verloren.
- Beenden funktioniert zuverlässig, auch ohne Symbol im Infobereich.
- Ist der Zugangs-Server nicht erreichbar, bleibt die eingestellte Hauptadresse erhalten.
- CSV-Dateien in UTF-8 zeigen in der Vorschau die Umlaute richtig an.

### Entfernt

- Der Client-Modus mit Upload-Schlüssel, der manuelle Team-Beitritt, das Verbindungspaket und die Cloudflare-Einrichtung direkt in der App. Team-Subdomains richtet jetzt allein der Worker ein. Alte Einstellungen dazu, auch ein gespeicherter Cloudflare-API-Token, werden beim Update gelöscht.

## [1.1.8] - 2026-07-19

### Behoben

- Nur noch die installierte App trägt sich in den Windows-Autostart ein. Entpackte Test-Versionen taten das bisher auch, und nach dem nächsten Neustart startete dann die falsche Programmdatei.

## [1.1.7] - 2026-07-17

### Neu

- FlowShare startet auf Wunsch mit Windows, still im Infobereich. Das ist standardmäßig eingeschaltet.
- Nach dem Hochladen eines Screenshots bleibt die Leiste offen: Du kannst den Link noch einmal kopieren oder direkt im Browser öffnen.

## [1.1.6] - 2026-07-10

### Neu

- Bestehende Zugangs-Token lassen sich nachträglich bearbeiten: Laufzeit setzen oder entfernen und das Geräte-Limit ändern. Wird das Limit kleiner, bleiben die zuerst angemeldeten Geräte freigeschaltet, die übrigen sperren sich bei der nächsten Prüfung.

## [1.1.5] - 2026-07-10

### Neu

- Ein Zugangs-Token kann für mehrere Geräte gelten: 1, 2, 3, 5 oder unbegrenzt, Standard ist 1. „Geräte trennen“ gibt alle Geräte eines Tokens wieder frei.

### Geändert

- Die Beschreibungen in den Einstellungen sind kürzer und direkter.

## [1.1.4] - 2026-07-10

**Die erste Version in diesem Repository.** Ältere Testversionen sind hier nicht einzeln beschrieben.

### Neu

- Datei ins Fenster ziehen und sofort einen Link bekommen. Der Empfänger sieht die Datei im Browser als Vorschau und lädt das unveränderte Original herunter, auch sehr große Dateien. Videos lassen sich direkt abspielen und vorspulen.
- Vorschau für Bilder, Videos, Audio, PDF, Word, Excel und CSV, Text und Code sowie den Inhalt von ZIP-Archiven. Alles wird auf deinem Rechner aufbereitet, ohne fremde Dienste.
- Eigene Adresse über einen Cloudflare-Tunnel, den FlowShare selbst startet und überwacht. cloudflared ist mitgeliefert.
- Team-Modus: Jedes Team-Mitglied bekommt beim ersten Start automatisch eine eigene Subdomain, angemeldet mit seinem Windows-Benutzernamen.
- Zugangs-Sperre (optional): Die App startet erst mit einem Zugangs-Token vom Betreiber. Token sind an ein Gerät gebunden, auf Wunsch befristet und jederzeit widerrufbar.
- Automatische Updates: Neue Versionen werden im Hintergrund geladen und per Klick installiert.
- Screenshots per Tastenkürzel (Standard: Druck) mit Fenster-Erkennung und Pixel-Lupe. Danach hochladen, kopieren, speichern oder mit einem anderen Programm öffnen.
- „Mit FlowShare teilen“ im Rechtsklick-Menü von Dateien.
- Ablaufzeit pro Freigabe, Virenscan der Uploads mit Windows Defender, Betrieb im Infobereich, helles und dunkles Design.
