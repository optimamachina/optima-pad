; Adds "Opad document" to Explorer's right-click > New menu (an empty .opad file the app opens as a fresh note),
; and offers Optima Pad under "Open with" for plain text files (it never takes over .txt by itself).
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\.opad\ShellNew" "NullFile" ""

  WriteRegStr SHELL_CONTEXT "Software\Classes\OptimaPad.Text" "" "Text Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\OptimaPad.Text\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\OptimaPad.Text\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "OptimaPad.Text" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "OptimaPad.Text" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.log\OpenWithProgids" "OptimaPad.Text" ""

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Optima Pad"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\.opad\ShellNew"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "OptimaPad.Text"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "OptimaPad.Text"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.log\OpenWithProgids" "OptimaPad.Text"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\OptimaPad.Text"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
