param(
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$ExpectedIcon
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$actual = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $Executable).Path)
$expected = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $ExpectedIcon).Path)
try {
  $images = @($actual.ToBitmap(), $expected.ToBitmap())
  try {
    for ($x = 0; $x -lt $images[0].Width; $x++) {
      for ($y = 0; $y -lt $images[0].Height; $y++) {
        if ($images[0].GetPixel($x, $y).ToArgb() -ne $images[1].GetPixel($x, $y).ToArgb()) {
          throw 'The installed executable does not contain the AgentRouter product icon.'
        }
      }
    }
  } finally { foreach ($image in $images) { $image.Dispose() } }
} finally { $actual.Dispose(); $expected.Dispose() }
Write-Output 'Installed AgentRouter executable icon verified.'
