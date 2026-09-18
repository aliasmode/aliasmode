; The bundled sidecar owns the browsers, so the app always stops it before an
; update installs. A crash, a forced close, or an interrupted shutdown can still
; leave one running, and the default template only closes the main executable.
; Installing over a running sidecar fails with "Error opening file for writing",
; so stop it here. Cloud sessions survive: every open browser's session is saved
; again from its encrypted local queue after the next start.
!macro NSIS_HOOK_PREINSTALL
  Push $R0

  nsExec::Exec 'taskkill /IM "aliasmode-sidecar.exe"'
  Pop $R0
  Sleep 5000
  nsExec::Exec 'taskkill /F /T /IM "aliasmode-sidecar.exe"'
  Pop $R0
  Sleep 2000

  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  ClearErrors
  ${GetOptions} $CMDLINE "/AMATTEMPT=" $R0
  ${IfNot} ${Errors}
    StrLen $R1 $R0
    ${If} $R1 != 32
      Abort
    ${EndIf}

    StrCpy $R2 0
    aliasmode_attempt_character:
      StrCpy $R3 $R0 1 $R2
      ${StrLoc} $R4 "0123456789abcdef" $R3 ">"
      ${If} $R4 == ""
        Abort
      ${EndIf}
      IntOp $R2 $R2 + 1
      IntCmp $R2 32 aliasmode_attempt_valid aliasmode_attempt_character aliasmode_attempt_invalid

    aliasmode_attempt_invalid:
      Abort

    aliasmode_attempt_valid:
      ClearErrors
      FileOpen $R1 "$INSTDIR\.aliasmode-update-$R0.complete" w
      ${If} ${Errors}
        Abort
      ${EndIf}
      FileWrite $R1 "${VERSION}$\r$\n"
      FileClose $R1
      ${If} ${Errors}
        Abort
      ${EndIf}
  ${EndIf}

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
