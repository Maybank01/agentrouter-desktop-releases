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

; A running release prepares a downloaded release's runtime in the background:
; `--agentrouter-stage` plus AGENTROUTER_STAGE_DIR extracts this installer's own
; application (the same embedded package, stored once) and quits before any
; install, registry, shortcut or uninstall step. The running release then asks
; the staged application to build its runtime beside the active profile.
!macro agentrouterStageApplication
  ${GetParameters} $R9
  ClearErrors
  ${GetOptions} $R9 "--agentrouter-stage" $R8
  ${IfNot} ${Errors}
    ReadEnvStr $R7 AGENTROUTER_STAGE_DIR
    ${If} $R7 == ""
      SetErrorLevel 2
      Quit
    ${EndIf}
    InitPluginsDir
    !ifdef COMPRESS
      SetCompress off
    !endif
    File /oname=$PLUGINSDIR\agentrouter-stage.${COMPRESSION_METHOD} "${APP_64}"
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    CreateDirectory "$R7"
    SetOutPath "$R7"
    ClearErrors
    Nsis7z::Extract "$PLUGINSDIR\agentrouter-stage.${COMPRESSION_METHOD}"
    SetOutPath "$PLUGINSDIR"
    Delete "$PLUGINSDIR\agentrouter-stage.${COMPRESSION_METHOD}"
    ${If} ${FileExists} "$R7\${APP_EXECUTABLE_FILENAME}"
      SetErrorLevel 0
    ${Else}
      SetErrorLevel 3
    ${EndIf}
    Quit
  ${EndIf}
!macroend

!macro customInit
  !insertmacro agentrouterStageApplication
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
  ; A fresh or manual per-user installation materializes the runtime here, with
  ; installer progress, so launching only starts it. Updates prepared their runtime
  ; in the background before the restart. On failure startup still prepares it.
  ${IfNot} ${isUpdated}
  ${AndIf} $installMode != "all"
    DetailPrint "Preparing the AgentRouter runtime..."
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --agentrouter-prepare-runtime "--user-data-dir=$PLUGINSDIR\agentrouter-prepare"' $R0
    ${If} ${Errors}
    ${OrIf} $R0 != 0
      DetailPrint "The runtime will be prepared on first launch ($R0)."
    ${EndIf}
  ${EndIf}
  ${If} ${isUpdated}
    ; All files, registry entries and shortcuts are now committed. Keep the
    ; update automatic: launch as the original user and skip the finish page.
    HideWindow
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
    !insertmacro quitSuccess
  ${EndIf}
!macroend
