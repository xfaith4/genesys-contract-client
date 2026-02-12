### BEGIN FILE: golden-scripts/04-RoutingWrapupCodes.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getRoutingWrapupcodes' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        name = $_.name
        divisionId = $_.division.id
        divisionName = $_.division.name
        defaultCode = $_.default
        endOfCall = $_.endOfCall
        type = $_.type
    }
}

$export = Export-GoldenReport -Name '04-RoutingWrapupCodes' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
