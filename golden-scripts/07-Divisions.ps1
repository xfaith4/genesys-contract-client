### BEGIN FILE: golden-scripts/07-Divisions.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getAuthorizationDivisions' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        name = $_.name
        description = $_.description
        homeDivision = $_.homeDivision
        selfUri = $_.selfUri
    }
}

$export = Export-GoldenReport -Name '07-Divisions' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
