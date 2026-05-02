!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping running SuperAI Agent sidecars..."
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-sidecar-x86_64-pc-windows-msvc.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-sidecar-aarch64-pc-windows-msvc.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-sidecar.exe'
  Pop $0
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping running SuperAI Agent processes..."
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-desktop.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-sidecar-x86_64-pc-windows-msvc.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-sidecar-aarch64-pc-windows-msvc.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM superai-agent-sidecar.exe'
  Pop $0
  Sleep 1000
!macroend
