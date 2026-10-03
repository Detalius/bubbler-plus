; Bubbler+ Forms: a second shortcut into the same executable, opening the form
; editor (main.js, FORMS_MODE). Its AppUserModelID matches the one main.js sets
; in forms mode, so Windows pins and groups it as its own app.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\Bubbler+ Forms.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--forms" "$INSTDIR\resources\forms.ico" 0
  WinShell::SetLnkAUMI "$SMPROGRAMS\Bubbler+ Forms.lnk" "com.detalius.bubblerplus.forms"
  CreateShortCut "$DESKTOP\Bubbler+ Forms.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--forms" "$INSTDIR\resources\forms.ico" 0
  WinShell::SetLnkAUMI "$DESKTOP\Bubbler+ Forms.lnk" "com.detalius.bubblerplus.forms"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Bubbler+ Forms.lnk"
  Delete "$DESKTOP\Bubbler+ Forms.lnk"
!macroend
