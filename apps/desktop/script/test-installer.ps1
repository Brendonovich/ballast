# Installs a Ballast setup silently for this user, checks the install and its receipt
# (install.json, which lets the app update itself), then uninstalls it and checks the
# receipt is gone. The release workflow runs it on every Windows setup it builds.
#
#   apps/desktop/script/test-installer.ps1 -Setup <setup.exe> -Channel <stable|beta|dev>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Setup,
    [Parameter(Mandatory)] [string] $Channel
)
$ErrorActionPreference = 'Stop'

function Check($condition, $message) {
    if (-not $condition) { throw "not ok - $message" }
    Write-Output "ok - $message"
}

$process = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
Check ($process.ExitCode -eq 0) "the setup exits 0 (got $($process.ExitCode))"

$exe = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Filter 'Ballast.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
Check ($null -ne $exe) 'Ballast.exe is installed under %LOCALAPPDATA%\Programs'
$root = $exe.DirectoryName
Check (Test-Path -LiteralPath (Join-Path $root 'resources\service\main.mjs')) 'the agent service is installed outside app.asar'
Check (Test-Path -LiteralPath (Join-Path $root 'resources\service\node_modules\effect\package.json')) 'the agent service has its node_modules'

$receiptPath = Join-Path $root 'install.json'
Check (Test-Path -LiteralPath $receiptPath) 'install.json is written'
$bytes = [IO.File]::ReadAllBytes($receiptPath)
Check ($bytes.Length -gt 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) 'install.json is UTF-16LE with a byte order mark'
$receipt = [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2) | ConvertFrom-Json
Check ($receipt.app -eq 'ballast' -and $receipt.artifact -eq 'desktop' -and $receipt.method -eq 'direct') 'install.json marks a direct install of ballast desktop'
Check ($receipt.channel -eq $Channel) "install.json names channel $Channel (got $($receipt.channel))"
Check ((Resolve-Path -LiteralPath $receipt.root).Path -eq (Resolve-Path -LiteralPath $root).Path) "install.json names the install root ($($receipt.root))"

$uninstaller = Join-Path $root 'Uninstall Ballast.exe'
Check (Test-Path -LiteralPath $uninstaller) 'the uninstaller is installed'
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
Check ($process.ExitCode -eq 0) "the uninstaller exits 0 (got $($process.ExitCode))"
# The uninstaller copies itself to a temporary folder and finishes from there.
for ($i = 0; $i -lt 60 -and (Test-Path -LiteralPath $exe.FullName); $i++) { Start-Sleep -Seconds 1 }
Check (-not (Test-Path -LiteralPath $exe.FullName)) 'Ballast.exe is removed'
Check (-not (Test-Path -LiteralPath $receiptPath)) 'install.json is removed'
