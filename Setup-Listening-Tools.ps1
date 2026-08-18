$ErrorActionPreference = 'Stop'
Write-Host 'MT EPS Question Factory - Listening Tools Setup' -ForegroundColor Cyan

function Has-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Has-Command 'winget')) {
  Write-Warning 'winget was not found. Install FFmpeg and yt-dlp manually, then reopen the app.'
} else {
  if (-not (Has-Command 'ffmpeg')) {
    Write-Host 'Installing FFmpeg...'
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
  } else { Write-Host 'FFmpeg already available.' -ForegroundColor Green }

  if (-not (Has-Command 'yt-dlp')) {
    Write-Host 'Installing yt-dlp...'
    winget install --id yt-dlp.yt-dlp -e --accept-package-agreements --accept-source-agreements
  } else { Write-Host 'yt-dlp already available.' -ForegroundColor Green }
}

Write-Host ''
Write-Host 'Optional transcript tool:' -ForegroundColor Yellow
Write-Host 'If Python is installed and you want local Korean transcription, run:'
Write-Host '  pip install -U openai-whisper' -ForegroundColor White
Write-Host 'Whisper is optional. The app can still use FFmpeg silence segmentation without it.'
Write-Host ''
Write-Host 'Close and reopen MT EPS Question Factory after installation so PATH is refreshed.' -ForegroundColor Cyan
Read-Host 'Press Enter to finish'
