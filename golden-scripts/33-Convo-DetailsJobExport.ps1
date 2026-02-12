### BEGIN FILE: golden-scripts/33-Convo-DetailsJobExport.ps1
<#
Conversation details async job export for very large datasets.

Uses operationIds:
  - postAnalyticsConversationsDetailsJobs
  - getAnalyticsConversationsDetailsJob
  - getAnalyticsConversationsDetailsJobResults
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

param(
    [Parameter(Mandatory)]
    [string]$Interval,

    [string[]]$QueueIds = @(),
    [string[]]$DivisionIds = @(),

    [ValidateRange(1, 500)]
    [int]$PageSize = 100,

    [ValidateRange(1, 500000)]
    [int]$Limit = 200000,

    [ValidateRange(10, 3600)]
    [int]$PollTimeoutSec = 600,

    [ValidateRange(1, 30)]
    [int]$PollEverySec = 5
)

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

$jobBody = @{
    interval = $Interval
    limit = $Limit
}

$queueClause = New-OrClause -Dimension 'queueId' -Values $QueueIds
if ($queueClause) {
    $jobBody.segmentFilters = @(
        @{
            type = 'and'
            clauses = @($queueClause)
        }
    )
}

$divisionClause = New-OrClause -Dimension 'divisionId' -Values $DivisionIds
if ($divisionClause) {
    $jobBody.conversationFilters = @(
        @{
            type = 'and'
            clauses = @($divisionClause)
        }
    )
}

$submit = Invoke-GcApi -Client $Global:GcClient -OperationId 'postAnalyticsConversationsDetailsJobs' -Body $jobBody
$jobId = [string]$submit.jobId
if ([string]::IsNullOrWhiteSpace($jobId)) {
    throw "Job creation response missing jobId."
}

Write-Host "Submitted details job: $jobId"

$deadline = (Get-Date).AddSeconds($PollTimeoutSec)
$lastState = $null
while ($true) {
    if ((Get-Date) -gt $deadline) {
        throw "Timed out waiting for job '$jobId' after $PollTimeoutSec seconds."
    }

    $status = Invoke-GcApi -Client $Global:GcClient -OperationId 'getAnalyticsConversationsDetailsJob' -Params @{ jobId = $jobId }
    $state = [string]$status.state
    if ($state -ne $lastState) {
        Write-Host "Job state: $state"
        $lastState = $state
    }

    if ($state -in @('FULFILLED', 'COMPLETED', 'SUCCESS')) { break }
    if ($state -in @('FAILED', 'ERROR', 'CANCELED', 'CANCELLED')) {
        throw "Job '$jobId' failed with state '$state'. Error: $($status.errorMessage)"
    }

    Start-Sleep -Seconds $PollEverySec
}

$result = Invoke-GcApiAll `
    -Client $Global:GcClient `
    -OperationId 'getAnalyticsConversationsDetailsJobResults' `
    -Params @{ jobId = $jobId; pageSize = $PageSize } `
    -PageSize $PageSize `
    -Limit $Limit `
    -PagingMode Query

$rows = @($result.items) | ForEach-Object {
    [pscustomobject]@{
        jobId = $jobId
        conversationId = $_.conversationId
        conversationStart = $_.conversationStart
        conversationEnd = $_.conversationEnd
        originatingDirection = $_.originatingDirection
        participantsCount = @($_.participants).Count
        segmentsCount = @($_.segments).Count
        divisionIds = (@($_.divisionIds) -join ',')
    }
}

$export = Export-GoldenReport -Name '33-Convo-DetailsJobExport' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List

Write-Host ""
Write-Host "Paging audit:"
$result.audit | Format-List
### END FILE
