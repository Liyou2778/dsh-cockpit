# DSH Cockpit - Windows tray launcher (ASCII only, PowerShell 5.1 compatible)
# Double-click the .bat in this folder to run.
# Tray menu: Open cockpit / Start gateway / Restart services / Quit.
$ErrorActionPreference = "SilentlyContinue"

$Root = Split-Path -Parent $PSScriptRoot
$Port = 7777
$GatewayPort = 7891
$EdgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
)
$Browser = $EdgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:ServerProcess = $null
$script:GatewayProcess = $null

function Test-Port([int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { return $client.ConnectAsync("127.0.0.1", $port).Wait(300) } catch { return $false } finally { $client.Close() }
}

function Start-CockpitServer {
  if (-not (Test-Port $Port)) {
    $script:ServerProcess = Start-Process node -ArgumentList @("src/cli.mjs", "serve", "--port", "$Port") -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
  }
}

function Start-GatewayServer {
  if (-not (Test-Port $GatewayPort)) {
    $script:GatewayProcess = Start-Process node -ArgumentList @("src/cli.mjs", "gateway", "serve") -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
  }
}

function Open-Cockpit {
  Start-CockpitServer
  if (-not $Browser) { Start-Process "http://127.0.0.1:$Port/"; return }
  Start-Process $Browser -ArgumentList "--app=http://127.0.0.1:$Port/", "--window-size=1440,1000"
}

function Restart-Cockpit {
  foreach ($p in @($script:ServerProcess, $script:GatewayProcess)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  $script:ServerProcess = $null
  $script:GatewayProcess = $null
  Start-Sleep -Milliseconds 500
  Start-CockpitServer
  [System.Windows.Forms.MessageBox]::Show("Cockpit server restarted on 127.0.0.1:$Port", "DSH Cockpit", "OK", "Information") | Out-Null
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "DSH Cockpit (double-click to open)"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open cockpit")
$openItem.add_Click({ Open-Cockpit })
$gatewayItem = $menu.Items.Add("Start gateway (7891)")
$gatewayItem.add_Click({ Start-GatewayServer; [System.Windows.Forms.MessageBox]::Show("Gateway started: http://127.0.0.1:$GatewayPort", "DSH Cockpit", "OK", "Information") | Out-Null })
$menu.Items.Add("-") | Out-Null
$restartItem = $menu.Items.Add("Restart services")
$restartItem.add_Click({ Restart-Cockpit })
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Quit (stop services)")
$exitItem.add_Click({
  foreach ($p in @($script:ServerProcess, $script:GatewayProcess)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Open-Cockpit })

Start-CockpitServer
$notify.ShowBalloonTip(3000, "DSH Cockpit", "Running in tray. Double-click to open (127.0.0.1:$Port).", "Info")
[System.Windows.Forms.Application]::Run()
