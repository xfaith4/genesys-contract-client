### BEGIN FILE: golden-scripts/06-EdgeDids.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getTelephonyProvidersEdgesDids' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        number = $_.number
        state = $_.state
        phoneNumber = $_.phoneNumber
        type = $_.type
        siteId = $_.site.id
        siteName = $_.site.name
        trunkId = $_.trunk.id
        trunkName = $_.trunk.name
    }
}

$export = Export-GoldenReport -Name '06-EdgeDids' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
