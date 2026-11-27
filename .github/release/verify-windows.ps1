# Checks the Authenticode signatures CI applied through Azure Artifact Signing: every program and
# library (and native addon) under the given folders must be validly signed and timestamped. With
# -Publisher, each must also be signed by that certificate subject (the CN).
#
#   .github/release/verify-windows.ps1 -Folders <folder>... [-Publisher <name>]
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string[]] $Folders,
    [string] $Publisher = ''
)
$ErrorActionPreference = 'Stop'

$roots = @($Folders | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
foreach ($zip in @($roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -Filter *.zip })) {
    $into = Join-Path ([IO.Path]::GetTempPath()) "verify-$($zip.BaseName)-$([guid]::NewGuid())"
    Expand-Archive -LiteralPath $zip.FullName -DestinationPath $into
    $roots += $into
}
$files = @($roots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File | Where-Object Extension -in '.exe', '.dll', '.node' })
if ($files.Count -eq 0) { throw "No programs or libraries in $($Folders -join ', ')." }
foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid') {
        throw "$($file.FullName) is not validly signed: $($signature.Status) $($signature.StatusMessage)"
    }
    # Artifact Signing certificates last days; only the timestamp keeps the signature valid afterwards.
    if (-not $signature.TimeStamperCertificate) { throw "$($file.FullName) has no RFC 3161 timestamp." }
    $name = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($Publisher -and $name -ne $Publisher) { throw "$($file.FullName) is signed by '$name', not '$Publisher'." }
    Write-Output "ok - $($file.FullName) signed by $name"
}
Write-Output "verified $($files.Count) signatures"
