### BEGIN FILE: golden-scripts/01-Users.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'getUsers' -PageSize 100 -Limit 200000

$rows = $result.items | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        name = $_.name
        email = $_.email
        username = $_.username
        state = $_.state
        department = $_.department
        title = $_.title
        divisionId = $_.division.id
        divisionName = $_.division.name
        primaryStationId = $_.primaryStation.id
    }
}

$export = Export-GoldenReport -Name '01-Users' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List
### END FILE
