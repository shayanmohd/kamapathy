; Registers Kamapathy for this user as a web browser and as a viewer for the
; file types it opens, without taking any of them over. The default browser
; status reads the StartMenuInternet command, and the uninstaller removes
; exactly these keys and values.

!macro kamapathyFileTypes MACRO
  !insertmacro ${MACRO} pdf
  !insertmacro ${MACRO} png
  !insertmacro ${MACRO} jpg
  !insertmacro ${MACRO} jpeg
  !insertmacro ${MACRO} gif
  !insertmacro ${MACRO} webp
  !insertmacro ${MACRO} avif
  !insertmacro ${MACRO} txt
  !insertmacro ${MACRO} webm
  !insertmacro ${MACRO} html
  !insertmacro ${MACRO} htm
  !insertmacro ${MACRO} xhtml
  !insertmacro ${MACRO} svg
!macroend

!macro kamapathyAddFileType EXT
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\Capabilities\FileAssociations" ".${EXT}" "KamapathyFile"
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "KamapathyFile" ""
!macroend

!macro kamapathyRemoveFileType EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "KamapathyFile"
!macroend

!macro kamapathyProgId PROGID DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0`
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --single-argument %1`
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy" "" "Kamapathy"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\DefaultIcon" "" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0`
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\shell\open\command" "" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\Capabilities" "ApplicationName" "Kamapathy"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\Capabilities" "ApplicationDescription" "A calm browser you share with your agents."
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\Capabilities" "ApplicationIcon" `"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0`
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\Capabilities\URLAssociations" "http" "KamapathyURL"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy\Capabilities\URLAssociations" "https" "KamapathyURL"
  !insertmacro kamapathyFileTypes kamapathyAddFileType
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Kamapathy" "Software\Clients\StartMenuInternet\Kamapathy\Capabilities"
  !insertmacro kamapathyProgId KamapathyURL "Kamapathy URL"
  WriteRegStr SHELL_CONTEXT "Software\Classes\KamapathyURL" "URL Protocol" ""
  !insertmacro kamapathyProgId KamapathyFile "Kamapathy document"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Clients\StartMenuInternet\Kamapathy"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Kamapathy"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\KamapathyURL"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\KamapathyFile"
  !insertmacro kamapathyFileTypes kamapathyRemoveFileType
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
