param(
  [string]$Path = ".\firebase-service-account.json"
)

if (-not (Test-Path $Path)) {
  Write-Error "Không thấy file: $Path"
  exit 1
}

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path))
$base64 = [Convert]::ToBase64String($bytes)

Write-Host ""
Write-Host "Copy giá trị dưới đây vào Railway variable:"
Write-Host "FIREBASE_SERVICE_ACCOUNT_BASE64"
Write-Host ""
Write-Output $base64
