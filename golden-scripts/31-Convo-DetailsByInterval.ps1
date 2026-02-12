### BEGIN FILE: golden-scripts/31-Convo-DetailsByInterval.ps1
<#
Conversation details by interval.

Uses operationId:
  - postAnalyticsConversationsDetailsQuery
#>

param(
    [Parameter(Mandatory)]
    [string]$Interval,

    [ValidateRange(1, 500)]
    [int]$PageSize = 100,

    [ValidateRange(1, 500000)]
    [int]$Limit = 100000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

$body = @{
    interval = $Interval
    paging = @{
        pageSize = $PageSize
        pageNumber = 1
    }
}

$result = Invoke-GcApiAll `
    -Client $Global:GcClient `
    -OperationId 'postAnalyticsConversationsDetailsQuery' `
    -Body $body `
    -PageSize $PageSize `
    -Limit $Limit `
    -PagingMode BodyPaging

$rows = @($result.items) | ForEach-Object {
    [pscustomobject]@{
        conversationId = $_.conversationId
        conversationStart = $_.conversationStart
        conversationEnd = $_.conversationEnd
        originatingDirection = $_.originatingDirection
        mediaStatsMinMos = $_.mediaStatsMinConversationMos
        participantsCount = @($_.participants).Count
        segmentsCount = @($_.segments).Count
        divisionIds = (@($_.divisionIds) -join ',')
    }
}

$export = Export-GoldenReport -Name '31-Convo-DetailsByInterval' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List

Write-Host ""
Write-Host "Paging audit:"
$result.audit | Format-List
### END FILE
