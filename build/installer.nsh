# NSIS uninstall hook for Tafreegh.
#
# Everything the app downloads — Jais-ASR GGUF weights, the Nemotron diarizer,
# the nemo-speech runtime, the Python runtime and the finished jobs — lives in
# %LOCALAPPDATA%\Tafreegh, which the stock uninstaller leaves alone. Remove it
# on a real uninstall so the user gets their space back, but keep it when this
# uninstall is the first half of an upgrade: the new version must find the
# models it already paid for.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\Tafreegh"
  ${endif}
!macroend
