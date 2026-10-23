<#
convert_book.ps1 — Run docx_to_entropy.py on a Word document.

Default input is the Travesty of Time manuscript on Dropbox; the .json is
written next to the .docx (same folder, same name).

Usage (from any PowerShell window):
  & "C:\Users\scott\QuarantineZone\Tools to Build\entropy\convert_book.ps1"

  # different document:
  & "...\convert_book.ps1" -Docx "C:\path\to\Other Book.docx"

  # overwrite an existing .json:
  & "...\convert_book.ps1" -Force

  # set title/author explicitly:
  & "...\convert_book.ps1" -Title "The Weft" -Author "Scott DuHadway"
#>

param(
    [string]$Docx = "C:\Users\scott\Dropbox\Personal\Travesty of Time\Book A - The Weft (Lyanna, Pebble, Dark Lord,).docx",
    [string]$Output = "",
    [string]$Title = "",
    [string]$Author = "",
    [switch]$Force
)

$entropyDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$converter  = Join-Path $entropyDir "docx_to_entropy.py"

if (-not (Test-Path $converter)) {
    Write-Error "Converter not found: $converter"
    exit 1
}
if (-not (Test-Path $Docx)) {
    Write-Error "Word document not found: $Docx"
    exit 1
}

if ($Output -eq "") {
    $Output = [System.IO.Path]::ChangeExtension($Docx, ".json")
}

if ($Force -and (Test-Path $Output)) {
    Remove-Item -Path $Output -Confirm:$false
    Write-Host "Removed existing $Output"
}

$pyArgs = @($converter, $Docx, "-o", $Output)
if ($Title  -ne "") { $pyArgs += @("--title",  $Title)  }
if ($Author -ne "") { $pyArgs += @("--author", $Author) }

py @pyArgs
exit $LASTEXITCODE
