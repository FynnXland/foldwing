; Zusatz-Skript für den NSIS-Installer (electron-builder).
;
; Beim echten Deinstallieren aufräumen, was die App selbst im Benutzerprofil anlegt:
; den Rechtsklick-Eintrag „Mit Foldwing teilen" und den Autostart-Eintrag.
;
; WICHTIG: Bei einem Update startet der Installer zuerst den Deinstallierer der alten
; Version (isUpdated ist dann wahr). Dort NICHTS löschen – sonst fehlt der
; Rechtsklick-Eintrag nach jedem Update (so geschehen bis 1.3.0).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\*\shell\Foldwing"
    ; Name, unter dem Electron den Autostart einträgt (setLoginItemSettings).
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Foldwing"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Foldwing"
    ; Reste aus der Zeit, als die App noch FlowShare hieß (bis 1.3.x).
    DeleteRegKey HKCU "Software\Classes\*\shell\FlowShare"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.FlowShare"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.FlowShare"
  ${endIf}
!macroend
