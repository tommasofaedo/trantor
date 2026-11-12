; Voce "Apri in Trantor" nel menu contestuale di Esplora file (per l'utente corrente)
; Adds "Open in Trantor" to the Explorer context menu (current user only)

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\Trantor" "" "Apri in Trantor"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Trantor" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Trantor\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Trantor" "" "Apri in Trantor"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Trantor" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Trantor\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  WriteRegStr HKCU "Software\Classes\Drive\shell\Trantor" "" "Apri in Trantor"
  WriteRegStr HKCU "Software\Classes\Drive\shell\Trantor" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Drive\shell\Trantor\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Trantor"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Trantor"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\Trantor"
!macroend
