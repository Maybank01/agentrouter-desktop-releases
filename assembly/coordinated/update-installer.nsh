; Preserve NSIS's existing install/rollback behavior and show its real progress
; during a product update, including updates invoked by older silent clients.
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
