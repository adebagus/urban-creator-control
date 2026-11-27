; Urban Creator CONTROL - NSIS additions (electron-builder "nsis.include").
;
; No auto-start at Windows login since 2.0.1. Versions up to 2.0.0 registered
; one on every run (Electron setLoginItemSettings, value named after the app's
; AppUserModelId). Remove it on install/update - so an update cleans it up even
; before the new version is first started - and on uninstall.
; "openbuilds.control" belongs to the real OpenBuilds CONTROL and is left alone.

!macro customInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "id.urbancreator.control.dev"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "id.urbancreator.control.dev"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "id.urbancreator.control.dev"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "id.urbancreator.control.dev"
!macroend
