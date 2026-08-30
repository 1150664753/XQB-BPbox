!macro preserveProjectDirectory DIRECTORY
  IfFileExists "$INSTDIR\${DIRECTORY}\*.*" 0 preserve_${DIRECTORY}_done
  IfFileExists "$APPDATA\${APP_FILENAME}\${DIRECTORY}\*.*" preserve_${DIRECTORY}_done 0

  CreateDirectory "$APPDATA\${APP_FILENAME}"
  RMDir "$APPDATA\${APP_FILENAME}\${DIRECTORY}"

  ClearErrors
  Rename "$INSTDIR\${DIRECTORY}" "$APPDATA\${APP_FILENAME}\${DIRECTORY}"
  IfErrors 0 preserve_${DIRECTORY}_done

  CreateDirectory "$APPDATA\${APP_FILENAME}\${DIRECTORY}"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\${DIRECTORY}\*.*" "$APPDATA\${APP_FILENAME}\${DIRECTORY}"
  IfErrors 0 preserve_${DIRECTORY}_done

  MessageBox MB_ICONSTOP|MB_OK "XQB-BPBox could not preserve the ${DIRECTORY} directory. Installation was stopped to protect your data."
  Abort

preserve_${DIRECTORY}_done:
!macroend

!macro customInit
  !insertmacro preserveProjectDirectory "config"
  !insertmacro preserveProjectDirectory "results"
  !insertmacro preserveProjectDirectory "assets"
!macroend
