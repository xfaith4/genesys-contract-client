### BEGIN FILE: golden-scripts/03-RoutingSkills.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getRoutingSkills' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        name = $_.name
        dateCreated = $_.dateCreated
        dateModified = $_.dateModified
        selfUri = $_.selfUri
    }
}

$export = Export-GoldenReport -Name '03-RoutingSkills' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
