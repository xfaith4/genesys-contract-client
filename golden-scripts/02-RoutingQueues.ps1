### BEGIN FILE: golden-scripts/02-RoutingQueues.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getRoutingQueues' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        name = $_.name
        divisionId = $_.division.id
        divisionName = $_.division.name
        acd = $_.acd
        active = $_.active
        memberCount = $_.memberCount
        wrapupPrompt = $_.wrapupPrompt
    }
}

$export = Export-GoldenReport -Name '02-RoutingQueues' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
