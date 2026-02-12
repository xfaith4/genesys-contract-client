### BEGIN FILE: golden-scripts/05-EdgeExtensions.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getTelephonyProvidersEdgesExtensions' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        number = $_.number
        state = $_.state
        assigned = $_.assigned
        type = $_.type
        siteId = $_.site.id
        siteName = $_.site.name
        userId = $_.user.id
        userName = $_.user.name
    }
}

$export = Export-GoldenReport -Name '05-EdgeExtensions' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
