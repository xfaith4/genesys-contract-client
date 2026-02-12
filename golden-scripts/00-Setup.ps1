### BEGIN FILE: golden-scripts/00-Setup.ps1
<#
Golden Scripts setup for Genesys.ContractClient.

Required env vars:
  GC_CLIENT_ID
  GC_CLIENT_SECRET
Optional:
  GC_BASE_URL      (default: https://api.mypurecloud.com)
  GC_TOKEN_URL     (default: https://login.mypurecloud.com/oauth/token)

Tip: set your region explicitly in GC_BASE_URL / GC_TOKEN_URL.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-GoldenOutFolder {
    param([string]$Root = (Join-Path $PSScriptRoot 'out'))
    if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root | Out-Null }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $folder = Join-Path $Root $stamp
    New-Item -ItemType Directory -Path $folder | Out-Null
    return $folder
}

function Export-GoldenReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] $Data,
        [Parameter(Mandatory)] [string] $OutFolder
    )

    $safe = ($Name -replace '[^A-Za-z0-9\-_]+','_')
    $csvPath = Join-Path $OutFolder "$safe.csv"
    $xlsxPath = Join-Path $OutFolder "$safe.xlsx"

    # Always write CSV (universal)
    $Data | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $csvPath

    # Prefer Excel if ImportExcel is available
    if (Get-Module -ListAvailable -Name ImportExcel) {
        Import-Module ImportExcel -ErrorAction Stop
        $Data | Export-Excel -Path $xlsxPath -WorksheetName $safe -AutoSize -FreezeTopRow -BoldTopRow
        return [pscustomobject]@{ name=$Name; csv=$csvPath; xlsx=$xlsxPath }
    }

    return [pscustomobject]@{ name=$Name; csv=$csvPath; xlsx=$null }
}

# Import module
$modulePath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\src\ps-module\Genesys.ContractClient\Genesys.ContractClient.psd1')).Path ''
Import-Module $modulePath -Force

# Load spec + catalogs (fast; avoids runtime swagger parsing for every script)
Import-GcSpec `
  -SwaggerPath (Resolve-Path (Join-Path $PSScriptRoot '..\specs\swagger.json')).Path `
  -OperationsPath (Resolve-Path (Join-Path $PSScriptRoot '..\generated\operations.json')).Path `
  -PaginationMapPath (Resolve-Path (Join-Path $PSScriptRoot '..\generated\pagination-map.json')).Path

# Build client (token caching happens in module)
$baseUrl = if ($env:GC_BASE_URL) { $env:GC_BASE_URL } else { 'https://api.mypurecloud.com' }
$tokenUrl = if ($env:GC_TOKEN_URL) { $env:GC_TOKEN_URL } else { 'https://login.mypurecloud.com/oauth/token' }

if (-not $env:GC_CLIENT_ID -or -not $env:GC_CLIENT_SECRET) {
    throw "Missing GC_CLIENT_ID and/or GC_CLIENT_SECRET environment variables."
}

$Global:GcClient = New-GcClient -BaseUrl $baseUrl -TokenUrl $tokenUrl -ClientId $env:GC_CLIENT_ID -ClientSecret $env:GC_CLIENT_SECRET
$Global:GoldenOut = New-GoldenOutFolder

Write-Host "✅ Genesys Contract Client ready."
Write-Host "   BaseUrl:  $baseUrl"
Write-Host "   OutDir:   $Global:GoldenOut"
### END FILE
