### BEGIN FILE: golden-scripts/32-Convo-DetailsByQueueOrDivision.ps1
<#
Conversation details filtered by queue and/or division.

Uses operationId:
  - postAnalyticsConversationsDetailsQuery
#>

param(
    [Parameter(Mandatory)]
    [string]$Interval,

    [string[]]$QueueIds = @(),
    [string[]]$DivisionIds = @(),

    [ValidateRange(1, 500)]
    [int]$PageSize = 100,

    [ValidateRange(1, 500000)]
    [int]$Limit = 100000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '00-Setup.ps1')

function New-OrClause {
    param(
        [Parameter(Mandatory)][string]$Dimension,
        [Parameter(Mandatory)][string[]]$Values
    )
    if (-not $Values -or $Values.Count -eq 0) { return $null }
    @{
        type = 'or'
        predicates = @(
            $Values | ForEach-Object {
                @{
                    type = 'dimension'
                    dimension = $Dimension
                    operator = 'matches'
                    value = $_
                }
            }
        )
    }
}

$body = @{
    interval = $Interval
    paging = @{
        pageSize = $PageSize
        pageNumber = 1
    }
}

$queueClause = New-OrClause -Dimension 'queueId' -Values $QueueIds
if ($queueClause) {
    $body.segmentFilters = @(
        @{
            type = 'and'
            clauses = @($queueClause)
        }
    )
}

$divisionClause = New-OrClause -Dimension 'divisionId' -Values $DivisionIds
if ($divisionClause) {
    $body.conversationFilters = @(
        @{
            type = 'and'
            clauses = @($divisionClause)
        }
    )
}

$result = Invoke-GcApiAll `
    -Client $Global:GcClient `
    -OperationId 'postAnalyticsConversationsDetailsQuery' `
    -Body $body `
    -PageSize $PageSize `
    -Limit $Limit `
    -PagingMode BodyPaging

$rows = @($result.items) | ForEach-Object {
    $queueSet = New-Object System.Collections.Generic.HashSet[string]
    foreach ($part in @($_.participants)) {
        foreach ($sess in @($part.sessions)) {
            foreach ($seg in @($sess.segments)) {
                if ($seg.queueId) { [void]$queueSet.Add([string]$seg.queueId) }
            }
        }
    }

    [pscustomobject]@{
        conversationId = $_.conversationId
        conversationStart = $_.conversationStart
        conversationEnd = $_.conversationEnd
        divisionIds = (@($_.divisionIds) -join ',')
        queueIds = (@($queueSet) -join ',')
        originatingDirection = $_.originatingDirection
        participantsCount = @($_.participants).Count
        segmentsCount = @($_.segments).Count
    }
}

$export = Export-GoldenReport -Name '32-Convo-DetailsByQueueOrDivision' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List

Write-Host ""
Write-Host "Paging audit:"
$result.audit | Format-List
### END FILE
