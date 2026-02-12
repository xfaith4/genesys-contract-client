### BEGIN FILE: golden-scripts/30-Convo-ForensicsById.ps1
<#
Conversations forensics by conversationId.

Uses operationIds:
  - getConversation
  - getConversationsCall
  - getConversationsCallParticipantWrapup
  - getConversationsCallParticipantCommunicationWrapup
  - getAnalyticsConversationDetails
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

param(
    [Parameter(Mandatory)]
    [string]$ConversationId
)

. (Join-Path $PSScriptRoot '00-Setup.ps1')

function Invoke-SafeGcApi {
    param(
        [Parameter(Mandatory)][string]$OperationId,
        [hashtable]$Params = @{},
        $Body = $null
    )
    try {
        [pscustomobject]@{
            ok = $true
            data = Invoke-GcApi -Client $Global:GcClient -OperationId $OperationId -Params $Params -Body $Body
            error = $null
        }
    } catch {
        [pscustomobject]@{
            ok = $false
            data = $null
            error = $_.Exception.Message
        }
    }
}

$audit = New-Object System.Collections.Generic.List[object]

$base = Invoke-SafeGcApi -OperationId 'getConversation' -Params @{ conversationId = $ConversationId }
$audit.Add([pscustomobject]@{ operationId='getConversation'; ok=$base.ok; error=$base.error })
if (-not $base.ok) { throw "Unable to fetch conversation '$ConversationId': $($base.error)" }

$call = Invoke-SafeGcApi -OperationId 'getConversationsCall' -Params @{ conversationId = $ConversationId }
$audit.Add([pscustomobject]@{ operationId='getConversationsCall'; ok=$call.ok; error=$call.error })

$analytics = Invoke-SafeGcApi -OperationId 'getAnalyticsConversationDetails' -Params @{ conversationId = $ConversationId }
$audit.Add([pscustomobject]@{ operationId='getAnalyticsConversationDetails'; ok=$analytics.ok; error=$analytics.error })

$rows = New-Object System.Collections.Generic.List[object]
$participants = @($base.data.participants)

foreach ($p in $participants) {
    $participantId = [string]$p.id
    $participantWrap = Invoke-SafeGcApi -OperationId 'getConversationsCallParticipantWrapup' -Params @{
        conversationId = $ConversationId
        participantId  = $participantId
    }
    $audit.Add([pscustomobject]@{
        operationId = 'getConversationsCallParticipantWrapup'
        participantId = $participantId
        ok = $participantWrap.ok
        error = $participantWrap.error
    })

    $comms = @()
    if ($call.ok -and $call.data -and $call.data.participants) {
        $match = @($call.data.participants | Where-Object { $_.id -eq $participantId })
        foreach ($mp in $match) {
            foreach ($s in @($mp.sessions)) {
                foreach ($c in @($s.communications)) {
                    $comms += $c
                }
            }
        }
    }

    if ($comms.Count -eq 0) {
        $rows.Add([pscustomobject]@{
            conversationId = $ConversationId
            participantId = $participantId
            communicationId = $null
            purpose = $p.purpose
            state = $p.state
            mediaType = $null
            participantWrapCode = $participantWrap.data.code
            participantWrapupNote = $participantWrap.data.notes
            communicationWrapCode = $null
            communicationWrapupNote = $null
            analyticsSegmentCount = if ($analytics.ok -and $analytics.data.segments) { @($analytics.data.segments).Count } else { $null }
            apiError = if ($participantWrap.ok) { $null } else { $participantWrap.error }
        })
        continue
    }

    foreach ($c in $comms) {
        $commId = [string]$c.id
        $commWrap = Invoke-SafeGcApi -OperationId 'getConversationsCallParticipantCommunicationWrapup' -Params @{
            conversationId = $ConversationId
            participantId = $participantId
            communicationId = $commId
        }
        $audit.Add([pscustomobject]@{
            operationId = 'getConversationsCallParticipantCommunicationWrapup'
            participantId = $participantId
            communicationId = $commId
            ok = $commWrap.ok
            error = $commWrap.error
        })

        $rows.Add([pscustomobject]@{
            conversationId = $ConversationId
            participantId = $participantId
            communicationId = $commId
            purpose = $p.purpose
            state = $p.state
            mediaType = $c.mediaType
            participantWrapCode = $participantWrap.data.code
            participantWrapupNote = $participantWrap.data.notes
            communicationWrapCode = $commWrap.data.code
            communicationWrapupNote = $commWrap.data.notes
            analyticsSegmentCount = if ($analytics.ok -and $analytics.data.segments) { @($analytics.data.segments).Count } else { $null }
            apiError = if ($commWrap.ok) { $null } else { $commWrap.error }
        })
    }
}

if ($rows.Count -eq 0) {
    $rows.Add([pscustomobject]@{
        conversationId = $ConversationId
        participantId = $null
        communicationId = $null
        purpose = $null
        state = $null
        mediaType = $null
        participantWrapCode = $null
        participantWrapupNote = $null
        communicationWrapCode = $null
        communicationWrapupNote = $null
        analyticsSegmentCount = if ($analytics.ok -and $analytics.data.segments) { @($analytics.data.segments).Count } else { $null }
        apiError = "No participant rows returned"
    })
}

$export = Export-GoldenReport -Name '30-Convo-ForensicsById' -Data $rows -OutFolder $Global:GoldenOut
$export | Format-List

Write-Host ""
Write-Host "Operation audit:"
$audit | Format-Table -AutoSize
### END FILE
