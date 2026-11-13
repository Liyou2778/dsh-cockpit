# DSH Cockpit local code signing (run after dotnet publish)
$ErrorActionPreference = "Stop"
$Exe = Join-Path $PSScriptRoot "DSH-Cockpit-App\DSH-Cockpit.exe"
if (-not (Test-Path $Exe)) { throw "exe not found: $Exe" }
Get-Process -Name 'DSH-Cockpit' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -like "*DSH Cockpit*" } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=DSH Cockpit (Local), O=Local Developer, C=CN" -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10)
}
$cer = Join-Path $env:TEMP "dsh-cockpit-signing.cer"
Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
certutil -addstore -user Root $cer | Out-Null
certutil -addstore -user TrustedPublisher $cer | Out-Null
Remove-Item $cer -Force -ErrorAction SilentlyContinue
Unblock-File -Path $Exe -ErrorAction SilentlyContinue
Set-AuthenticodeSignature -FilePath $Exe -Certificate $cert -HashAlgorithm SHA256 | Out-Null
$verify = Get-AuthenticodeSignature $Exe
Write-Host "signature: $($verify.Status) | publisher: $($verify.SignerCertificate.Subject)"
Start-Process -FilePath $Exe -RedirectStandardOutput (Join-Path $env:TEMP "dsh-cockpit.out") -RedirectStandardError (Join-Path $env:TEMP "dsh-cockpit.err")
Write-Host "restarted."
