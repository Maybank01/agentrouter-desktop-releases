; Preserve NSIS's existing install/rollback behavior and show its real progress
; during a product update, including updates invoked by older silent clients.
!define AGENTROUTER_CLOSE_SCRIPT "${__FILEDIR__}\update-processes.ps1"

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\agentrouter-close.ps1 "${AGENTROUTER_CLOSE_SCRIPT}"
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\agentrouter-close.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Action probe`
  Pop $R0
  ${If} $R0 != 0
    ${IfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDCANCEL IDOK agentrouter_close
      Quit
    ${EndIf}
    agentrouter_close:
    DetailPrint "$(appClosing)"
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\agentrouter-close.ps1" -ExecutablePath "$INSTDIR\${APP_EXECUTABLE_FILENAME}" -Action close`
    Pop $R0
    ${If} $R0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY agentrouter_close
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  ${If} ${isUpdated}
    SetSilent normal
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
    ${If} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ${If} ${isUpdated}
    ; All files, registry entries and shortcuts are now committed. Keep the
    ; update automatic: launch as the original user and skip the finish page.
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    !insertmacro quitSuccess
  ${EndIf}
!macroend
