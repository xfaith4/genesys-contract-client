### BEGIN FILE: golden-scripts/20-AnalyticsConversationDetailsQuery.ps1
<#
Conversations (Details Query) — starter report

Uses:
  operationId: postAnalyticsConversationsDetailsQuery
  path:        /api/v2/analytics/conversations/details/query

Why this exists:
- Pull *sets* of conversations for a time interval
- Optionally filter by queueId and/or divisionId
- Export a flat, engineer-friendly table (CSV/XLSX)

Notes:
- Interval is required and must be an ISO8601 interval string:
    "2026-02-10T00:00:00.000Z/2026-02-11T00:00:00.000Z"
- Paging is handled by Invoke-GcApiAll via TOTALHITS (paging.pageNumber/pageSize).
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

param(
    [Parameter(Mandatory)]
    [string]$Interval,

    # Optional filters
    [string[]]$QueueIds = @(),
    [string[]]$DivisionIds = @(),

    # Safety caps
    [ValidateRange(1,500)]
    [int]$PageSize = 100,

    [ValidateRange(1,2000000)]
    [int]$Limit = 200000
)

. (Join-Path $PSScriptRoot '00-Setup.ps1')

function New-OrClause {
    param(
        [Parameter(Mandatory)][string]$PredicateType,   # 'dimension' (typical here)
        [Parameter(Mandatory)][string]$DimensionName,   # 'queueId' or 'divisionId'
        [Parameter(Mandatory)][string[]]$Values
    )

    if (-not $Values -or $Values.Count -eq 0) { return $null }

    $predicates = foreach ($v in $Values) {
        @{
            type      = $PredicateType
            dimension = $DimensionName
            operator  = 'matches'
            value     = $v
        }
    }

    return @{
        type       = 'or'
        predicates = $predicates
    }
}

# Build ConversationQuery body
$body = @{
    interval = $Interval
    paging   = @{
        pageSize   = $PageSize
        pageNumber = 1
    }
}

# conversationFilters (conversation-level): divisionId
$divClause = New-OrClause -PredicateType 'dimension' -DimensionName 'divisionId' -Values $DivisionIds
if ($divClause) {
    $body.conversationFilters = @(
        @{
            type    = 'and'
            clauses = @($divClause)
        }
    )
}

# segmentFilters (segment-level): queueId
$qClause = New-OrClause -PredicateType 'dimension' -DimensionName 'queueId' -Values $QueueIds
if ($qClause) {
    $body.segmentFilters = @(
        @{
            type    = 'and'
            clauses = @($qClause)
        }
    )
}

$result = Invoke-GcApiAll -Client $Global:GcClient -OperationId 'postAnalyticsConversationsDetailsQuery' -Body $body -PageSize $PageSize -Limit $Limit

# Flatten to report rows
$rows = $result.items | ForEach-Object {
    # The response schema returns objects in $.conversations; fields can vary by org features.
    # Keep this conservative and stable — you can enrich later.
    [pscustomobject]@{
        conversationId        = $_.conversationId
        conversationStart     = $_.conversationStart
        conversationEnd       = $_.conversationEnd
        divisionId            = $_.divisionId
        originatingDirection  = $_.originatingDirection
        conversationInitiator = $_.conversationInitiator
        mediaStatsMinMos      = $_.mediaStatsMinConversationMos
        externalTag           = $_.externalTag
        participantsCount     = (@($_.participants).Count)
        segmentsCount         = (@($_.segments).Count)
    }
}

$export = Export-GoldenReport -Name '20-Conversations-DetailsQuery' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List

# Emit paging audit summary (handy for debugging / governance)
Write-Host ""
Write-Host "Paging audit:"
$result.audit | Format-List
### END FILE
