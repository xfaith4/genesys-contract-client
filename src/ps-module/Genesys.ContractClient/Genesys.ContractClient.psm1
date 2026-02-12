### BEGIN FILE: src/ps-module/Genesys.ContractClient/Genesys.ContractClient.psm1
# Genesys.ContractClient
# Contract-enforced(ish) Genesys Cloud API caller with deterministic pagination.
# NOTE: Full JSON Schema validation is intentionally lightweight to avoid paid schema libs.
#       This module enforces: explicit operationId, required params, and disallows unknown query/path params.

Set-StrictMode -Version Latest

# region: module state
$script:GcSpec = $null
$script:GcOperations = $null
$script:GcPagingMap = $null
$script:TokenCache = @{}  # key -> @{ access_token; expires_at }
# endregion

function Import-GcSpec {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string]$SwaggerPath,
        [Parameter(Mandatory)] [string]$OperationsPath,
        [Parameter(Mandatory)] [string]$PaginationMapPath
    )
    $script:GcSpec       = Get-Content -Raw -Path $SwaggerPath | ConvertFrom-Json
    $script:GcOperations = Get-Content -Raw -Path $OperationsPath | ConvertFrom-Json
    $script:GcPagingMap  = Get-Content -Raw -Path $PaginationMapPath | ConvertFrom-Json
}

function Get-GcOperation {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$OperationId)
    if (-not $script:GcOperations) { throw "Spec not loaded. Call Import-GcSpec first." }
    $op = $script:GcOperations.$OperationId
    if (-not $op) { throw "Unknown operationId '$OperationId'." }
    return $op
}

function Find-GcOperation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Query,
        [int]$Top = 25
    )
    if (-not $script:GcOperations) { throw "Spec not loaded. Call Import-GcSpec first." }

    $q = $Query.ToLowerInvariant()
    $matches = foreach ($prop in $script:GcOperations.PSObject.Properties) {
        $op = $prop.Value
        $hay = @($op.operationId, $op.method, $op.path, ($op.summary ?? ''), ($op.description ?? ''), ($op.tags -join ' ')) -join ' '
        if ($hay.ToLowerInvariant().Contains($q)) { $op }
    }
    $matches | Select-Object -First $Top
}

function New-GcClient {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,   # e.g. https://api.mypurecloud.com
        [Parameter(Mandatory)][string]$TokenUrl,  # e.g. https://login.mypurecloud.com/oauth/token
        [Parameter(Mandatory)][string]$ClientId,
        [Parameter(Mandatory)][string]$ClientSecret,
        [string]$Scope = "",
        [switch]$InsecureSkipTlsVerify
    )
    [pscustomobject]@{
        BaseUrl = $BaseUrl.TrimEnd('/')
        TokenUrl = $TokenUrl
        ClientId = $ClientId
        ClientSecret = $ClientSecret
        Scope = $Scope
        InsecureSkipTlsVerify = [bool]$InsecureSkipTlsVerify
    }
}

function Get-GcAccessToken {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Client)

    $cacheKey = "{0}|{1}" -f $Client.TokenUrl, $Client.ClientId
    $now = [DateTimeOffset]::UtcNow

    if ($script:TokenCache.ContainsKey($cacheKey)) {
        $entry = $script:TokenCache[$cacheKey]
        if ($entry.expires_at -gt $now.AddMinutes(1)) {
            return $entry.access_token
        }
    }

    $pair = "{0}:{1}" -f $Client.ClientId, $Client.ClientSecret
    $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
    $headers = @{ Authorization = "Basic $basic" }

    $body = "grant_type=client_credentials"
    if (-not [string]::IsNullOrWhiteSpace($Client.Scope)) {
        $body += "&scope=$([Uri]::EscapeDataString($Client.Scope))"
    }

    if ($Client.InsecureSkipTlsVerify) {
        add-type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint srvPoint, X509Certificate certificate, WebRequest request, int certificateProblem) { return true; }
}
"@
        [System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
    }

    $resp = Invoke-RestMethod -Method Post -Uri $Client.TokenUrl -Headers $headers -ContentType "application/x-www-form-urlencoded" -Body $body
    if (-not $resp.access_token) { throw "Token response missing access_token." }

    $expiresIn = [int]($resp.expires_in ?? 1800)
    $script:TokenCache[$cacheKey] = @{
        access_token = $resp.access_token
        expires_at = $now.AddSeconds($expiresIn)
    }
    return $resp.access_token
}

function ConvertTo-QueryString {
    param([hashtable]$Params)
    if (-not $Params) { return "" }
    $pairs = foreach ($k in $Params.Keys) {
        $v = $Params[$k]
        if ($null -eq $v) { continue }
        "{0}={1}" -f [Uri]::EscapeDataString([string]$k), [Uri]::EscapeDataString([string]$v)
    }
    if (-not $pairs) { return "" }
    return "?" + ($pairs -join "&")
}

function Assert-ParamsAgainstSpec {
    param(
        [Parameter(Mandatory)]$Operation,
        [hashtable]$Params
    )

    $declared = @{}
    foreach ($p in $Operation.parameters) {
        if ($p.in -in @("query","path")) {
            $declared[$p.name] = $p
        }
    }

    # required
    foreach ($p in $declared.Values) {
        if ($p.required -and (-not $Params.ContainsKey($p.name))) {
            throw "Missing required parameter '$($p.name)' for operationId '$($Operation.operationId)'."
        }
    }

    # unknown
    foreach ($k in ($Params.Keys | ForEach-Object { [string]$_ })) {
        if (-not $declared.ContainsKey($k)) {
            throw "Unknown parameter '$k' for operationId '$($Operation.operationId)'. Refusing to guess."
        }
    }
}

function Invoke-GcApi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Client,
        [Parameter(Mandatory)][string]$OperationId,
        [hashtable]$Params,
        $Body,
        [int]$TimeoutSec = 100
    )

    $op = Get-GcOperation -OperationId $OperationId
    Assert-ParamsAgainstSpec -Operation $op -Params ($Params ?? @{})

    # build url with path params
    $path = $op.path
    foreach ($p in $op.parameters) {
        if ($p.in -eq "path") {
            if (-not $Params.ContainsKey($p.name)) { throw "Missing required path param '$($p.name)'." }
            $path = $path.Replace("{"+$p.name+"}", [Uri]::EscapeDataString([string]$Params[$p.name]))
        }
    }

    # query params
    $query = @{}
    foreach ($p in $op.parameters) {
        if ($p.in -eq "query" -and $Params.ContainsKey($p.name)) {
            $query[$p.name] = $Params[$p.name]
        }
    }

    $uri = "$($Client.BaseUrl)$path$(ConvertTo-QueryString -Params $query)"

    $token = Get-GcAccessToken -Client $Client
    $headers = @{ Authorization = "Bearer $token" }

    $invokeParams = @{
        Method = $op.method
        Uri = $uri
        Headers = $headers
        TimeoutSec = $TimeoutSec
    }

    if ($Body -ne $null -and $op.method -in @("POST","PUT","PATCH")) {
        $invokeParams.ContentType = "application/json"
        $invokeParams.Body = ($Body | ConvertTo-Json -Depth 50)
    }

    try {
        return Invoke-RestMethod @invokeParams
    } catch {
        throw "API call failed for $($op.method) $($op.path) ($OperationId): $($_.Exception.Message)"
    }
}

function Invoke-GcApiAll {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Client,
        [Parameter(Mandatory)][string]$OperationId,
        [hashtable]$Params,
        $Body,
        [int]$PageSize = 100,
        [int]$Limit = 0,          # 0 = no limit
        [int]$MaxPages = 0,       # 0 = no limit
        [ValidateSet("Auto","Query","BodyPaging")][string]$PagingMode = "Auto"
    )

    $op = Get-GcOperation -OperationId $OperationId
    $map = $script:GcPagingMap.$OperationId
    if (-not $map) { $map = [pscustomobject]@{ type = $op.pagingType; itemsPath = $op.responseItemsPath } }

    $ptype = $map.type
    if ($ptype -eq "UNKNOWN") {
        throw "OperationId '$OperationId' has unknown pagination type. Add it to registry/paging-registry.yaml (or regenerate map) before using -All."
    }

    $items = New-Object System.Collections.Generic.List[object]
    $audit = New-Object System.Collections.Generic.List[object]

    $page = 1
    $cursor = $null
    $after = $null
    $next = $null
    $pageNumber = 1

    function Get-ItemsFromResponse($resp) {
        if ($null -eq $resp) { return @() }
        if ($resp.PSObject.Properties["entities"]) { return @($resp.entities) }
        if ($resp.PSObject.Properties["results"])  { return @($resp.results)  }
        # fallback: first array property
        foreach ($p in $resp.PSObject.Properties) {
            if ($p.Value -is [System.Collections.IEnumerable] -and -not ($p.Value -is [string])) {
                return @($p.Value)
            }
        }
        return @()
    }

    while ($true) {
        if ($MaxPages -gt 0 -and $page -gt $MaxPages) {
            $audit.Add([pscustomobject]@{ page=$page; stop="maxPages"; })
            break
        }

        $localParams = @{}
        if ($Params) { $Params.Keys | ForEach-Object { $localParams[$_] = $Params[$_] } }

        $localBody = $Body
        if ($ptype -eq "PAGE_NUMBER") {
            # prefer query pageNumber/pageSize if available
            $hasQueryPageNumber = $op.parameters | Where-Object { $_.in -eq "query" -and $_.name -eq "pageNumber" }
            $hasQueryPageSize   = $op.parameters | Where-Object { $_.in -eq "query" -and $_.name -eq "pageSize" }
            $useQuery = $false
            if ($PagingMode -eq "Query") { $useQuery = $true }
            elseif ($PagingMode -eq "BodyPaging") { $useQuery = $false }
            else { $useQuery = [bool]$hasQueryPageNumber -and [bool]$hasQueryPageSize }

            if ($useQuery) {
                $localParams["pageNumber"] = $pageNumber
                $localParams["pageSize"]   = $PageSize
            } else {
                if ($null -eq $localBody) { $localBody = @{} }
                if (-not ($localBody -is [hashtable] -or $localBody -is [pscustomobject])) { throw "BodyPaging requires object body." }
                # place under paging
                $pagingObj = @{ pageNumber = $pageNumber; pageSize = $PageSize }
                if ($localBody -is [hashtable]) { $localBody["paging"] = $pagingObj } else { $localBody | Add-Member -NotePropertyName "paging" -NotePropertyValue $pagingObj -Force }
            }
        }
        elseif ($ptype -eq "CURSOR" -and $cursor) {
            # cursor can be query or body; prefer query if declared
            $hasCursorQuery = $op.parameters | Where-Object { $_.in -eq "query" -and $_.name -eq "cursor" }
            if ($hasCursorQuery) { $localParams["cursor"] = $cursor }
            else {
                if ($null -eq $localBody) { $localBody = @{} }
                if ($localBody -is [hashtable]) { $localBody["cursor"] = $cursor }
                else { $localBody | Add-Member -NotePropertyName "cursor" -NotePropertyValue $cursor -Force }
            }
        }
        elseif ($ptype -eq "AFTER" -and $after) {
            $hasAfterQuery = $op.parameters | Where-Object { $_.in -eq "query" -and $_.name -eq "after" }
            if ($hasAfterQuery) { $localParams["after"] = $after }
            else {
                if ($null -eq $localBody) { $localBody = @{} }
                if ($localBody -is [hashtable]) { $localBody["after"] = $after }
                else { $localBody | Add-Member -NotePropertyName "after" -NotePropertyValue $after -Force }
            }
        }

        $resp = if ($next) {
            # follow nextUri/nextPage directly; ignore operation path/params
            $token = Get-GcAccessToken -Client $Client
            $headers = @{ Authorization = "Bearer $token" }
            $u = $next
            if ($u.StartsWith("/")) { $u = "$($Client.BaseUrl)$u" }
            Invoke-RestMethod -Method GET -Uri $u -Headers $headers
        } else {
            Invoke-GcApi -Client $Client -OperationId $OperationId -Params $localParams -Body $localBody
        }

        $batch = Get-ItemsFromResponse $resp
        foreach ($it in $batch) { $items.Add($it) }

        $audit.Add([pscustomobject]@{
            page = $page
            fetched = $batch.Count
            total = $items.Count
            nextUri = ($resp.PSObject.Properties["nextUri"]?.Value)
            nextPage = ($resp.PSObject.Properties["nextPage"]?.Value)
            cursor = ($resp.PSObject.Properties["cursor"]?.Value)
            after = ($resp.PSObject.Properties["after"]?.Value)
            pageNumber = ($resp.PSObject.Properties["pageNumber"]?.Value)
            pageCount = ($resp.PSObject.Properties["pageCount"]?.Value)
        })

        if ($Limit -gt 0 -and $items.Count -ge $Limit) {
            break
        }

        # stop conditions + next token
        $next = $null
        if ($ptype -eq "NEXT_URI") {
            $next = $resp.nextUri
            if (-not $next) { break }
        }
        elseif ($ptype -eq "NEXT_PAGE") {
            $next = $resp.nextPage
            if (-not $next) { break }
        }
        elseif ($ptype -eq "CURSOR") {
            $cursor = $resp.cursor
            if (-not $cursor) { break }
        }
        elseif ($ptype -eq "AFTER") {
            $after = $resp.after
            if (-not $after) { break }
        }
        elseif ($ptype -eq "PAGE_NUMBER") {
            $pn = $resp.pageNumber
            $pc = $resp.pageCount
            if ($pc -and $pn -and ($pn -ge $pc)) { break }
            $pageNumber++
        }
        elseif ($ptype -eq "TOTALHITS") {
            $th = $resp.totalHits
            if (-not $th) { break }
            if (($pageNumber * $PageSize) -ge $th) { break }
            $pageNumber++
        }
        else {
            # START_INDEX or other: best effort stop on empty
            if ($batch.Count -eq 0) { break }
        }

        # stop on empty batch (safety)
        if ($batch.Count -eq 0) { break }

        $page++
    }

    [pscustomobject]@{
        operationId = $OperationId
        pagingType  = $ptype
        items       = $items.ToArray()
        audit       = $audit.ToArray()
    }
}
### END FILE
