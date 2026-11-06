# Installs Kamapathy from its GitHub releases on Windows. Keep this file ASCII
# and Windows PowerShell 5.1 compatible: site/install.ps1 is a byte-identical
# copy, served from kamapathy.app and run as
# powershell -NoProfile -Command "irm https://kamapathy.app/install.ps1 | iex".
#
# Option: -NoRun downloads and verifies the installer without running it.
# Progress goes to stderr. The last line of output is "installed <path>",
# "already installed <path>" or "downloaded <path>". Exit status: 0 done,
# 1 download, checksum or verification failure, 2 a release source that is not
# allowed.
param([switch]$NoRun)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$REPO = 'shayanmohd/kamapathy'
# The publisher to pin, once builds are signed. Empty means no signer.
$PUBLISHER = ''
$ASSET = 'windows-x64-setup.exe'

function Say($text) {
  [Console]::Error.WriteLine("Kamapathy install: $text")
}

function Stop-Install($text, $code) {
  Say $text
  exit $code
}

# Where Kamapathy is, or $null. The installer lets the person choose a folder,
# for themselves or for everyone, and names it in the uninstall entry it
# writes: DisplayName "Kamapathy <version>" and UninstallString
# '"<folder>\Uninstall Kamapathy.exe" /currentuser' (or /allusers).
function Find-Kamapathy {
  $default = Join-Path $env:LOCALAPPDATA 'Programs\Kamapathy\Kamapathy.exe'
  if (Test-Path -LiteralPath $default -PathType Leaf) { return $default }
  $keys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  # Tests keep their uninstall entries under a throwaway HKCU subkey.
  if ($env:KAMAPATHY_UNINSTALL_KEY) { $keys = @("HKCU:\$env:KAMAPATHY_UNINSTALL_KEY") }
  foreach ($key in $keys) {
    if (-not (Test-Path -LiteralPath $key)) { continue }
    foreach ($entry in Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue) {
      $properties = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
      if ([string]$properties.DisplayName -match '^Kamapathy \d+\.\d+\.\d+\S*$' -and
        [string]$properties.UninstallString -match '^"([^"]+)\\Uninstall Kamapathy\.exe"') {
        # Join-Path fails on a drive that is not there, such as an unplugged one.
        $exe = $Matches[1] + '\Kamapathy.exe'
        if (Test-Path -LiteralPath $exe -PathType Leaf) { return $exe }
      }
    }
  }
  return $null
}

function Start-Kamapathy($path) {
  if (Test-Path -LiteralPath $path) {
    Start-Process -FilePath $path | Out-Null
  }
}

# The file's SHA-256 in hex. Windows PowerShell started by another program
# that PowerShell 7 started, such as an agent, inherits PowerShell 7's module
# folders first in PSModulePath and then cannot load Get-FileHash.
function Get-Sha256($file) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($file)
  try {
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function Invoke-Download($url, $action) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      return & $action
    } catch {
      if ($attempt -eq 3) {
        Stop-Install "could not download $url. $($_.Exception.Message)" 1
      }
      Start-Sleep -Seconds 2
    }
  }
}

$tls = [Net.SecurityProtocolType]::Tls12
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor $tls
} catch {
  Say 'this computer may not support TLS 1.2.'
}

$existing = Find-Kamapathy
if ($existing) {
  Say 'Kamapathy is already installed.'
  if (-not $NoRun) { Start-Kamapathy $existing }
  Write-Output "already installed $existing"
  exit 0
}

# Tests point the script at a local release server. Its assets must share its
# origin, and only 127.0.0.1 may serve them without TLS.
$listUrl = "https://api.github.com/repos/$REPO/releases?per_page=10"
$base = "https://github.com/$REPO/releases/download"
if ($env:KAMAPATHY_RELEASES_API) {
  $source = $null
  $refused = 'KAMAPATHY_RELEASES_API must be an https URL, or http on 127.0.0.1.'
  if (-not [Uri]::TryCreate($env:KAMAPATHY_RELEASES_API, [UriKind]::Absolute, [ref]$source)) {
    Stop-Install $refused 2
  }
  $loopback = $source.Scheme -eq 'http' -and $source.Host -eq '127.0.0.1'
  if ($source.UserInfo -or -not ($source.Scheme -eq 'https' -or $loopback)) {
    Stop-Install $refused 2
  }
  $listUrl = $env:KAMAPATHY_RELEASES_API
  $base = $source.GetLeftPart([UriPartial]::Authority) + '/releases/download'
}

Say 'looking for the newest release'
$releases = Invoke-Download $listUrl { Invoke-RestMethod -Uri $listUrl -UseBasicParsing }
# The first listed release carrying this computer's installer wins. Both
# versions in the URL must agree, and the same release must list SHA256SUMS.txt.
$pattern = '^' + [Regex]::Escape($base) + '/v(\d+\.\d+\.\d+)/Kamapathy-\1-' +
  [Regex]::Escape($ASSET) + '$'
$installer = $null
$sums = $null
foreach ($release in $releases) {
  foreach ($asset in $release.assets) {
    if ([string]$asset.browser_download_url -match $pattern) {
      $installer = [string]$asset.browser_download_url
      break
    }
  }
  if ($installer) {
    $folder = $installer.Substring(0, $installer.LastIndexOf('/'))
    foreach ($asset in $release.assets) {
      if ([string]$asset.browser_download_url -eq "$folder/SHA256SUMS.txt") {
        $sums = "$folder/SHA256SUMS.txt"
      }
    }
    break
  }
}
if (-not $installer) {
  Stop-Install "no listed release carries Kamapathy-<version>-$ASSET. See https://github.com/$REPO/releases." 1
}
if (-not $sums) {
  Stop-Install "the release with $ASSET lists no SHA256SUMS.txt." 1
}

$name = $installer.Substring($installer.LastIndexOf('/') + 1)
$downloads = Join-Path $env:USERPROFILE 'Downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$path = Join-Path $downloads $name
Say "downloading $name"
Invoke-Download $installer { Invoke-WebRequest -Uri $installer -OutFile $path -UseBasicParsing }
$text = Invoke-Download $sums { (Invoke-WebRequest -Uri $sums -UseBasicParsing).Content }
$hash = Get-Sha256 $path
$expected = $null
foreach ($line in ([string]$text) -split "`n") {
  $fields = $line.Trim() -split '\s+'
  if ($fields.Count -eq 2 -and $fields[1] -eq $name) { $expected = $fields[0] }
}
if (-not $expected -or $expected -ne $hash) {
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  Stop-Install "$name does not match SHA256SUMS.txt, so nothing was installed. Report this instead of running the script again." 1
}
if ($PUBLISHER) {
  # Those module folders also hold a PowerShell 7 copy of this command's
  # module that Windows PowerShell cannot load, so load the copy that ships
  # with the PowerShell running this script.
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security')
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Subject -notlike "*$PUBLISHER*") {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    Stop-Install "$name is not signed by $PUBLISHER, so nothing was installed." 1
  }
}
Say 'checksum verified'

if ($NoRun) {
  Write-Output "downloaded $path"
  exit 0
}
Say 'starting the installer, which asks you where to install Kamapathy'
$run = Start-Process -FilePath $path -Wait -PassThru
if ($run.ExitCode -ne 0) {
  Stop-Install "the installer stopped with status $($run.ExitCode). It is at $path." 1
}
$installed = Find-Kamapathy
if (-not $installed) {
  Stop-Install "the installer did not finish, so Kamapathy did not start. It is at $path." 1
}
Start-Kamapathy $installed
Write-Output "installed $installed"
exit 0
