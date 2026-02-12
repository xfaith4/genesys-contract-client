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
$script:GcDefinitions = $null
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
    $script:GcDefinitions = $script:GcSpec.definitions
}

function Get-GcOperation {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$OperationId)
    if (-not $script:GcOperations) { throw "Spec not loaded. Call Import-GcSpec first." }
    $op = $script:GcOperations.$OperationId
    if (-not $op) {
        foreach ($prop in $script:GcOperations.PSObject.Properties) {
            $candidate = $prop.Value
            if ($candidate.operationId -eq $OperationId) {
                $op = $candidate
                break
            }
        }
    }
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
        $summary = if ($null -ne $op.summary) { [string]$op.summary } else { '' }
        $description = if ($null -ne $op.description) { [string]$op.description } else { '' }
        $hay = @($op.operationId, $op.method, $op.path, $summary, $description, ($op.tags -join ' ')) -join ' '
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

    $secretHash = [System.BitConverter]::ToString(
        [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$Client.ClientSecret))
    ).Replace("-", "").Substring(0, 16)
    $scopePart = if ([string]::IsNullOrWhiteSpace($Client.Scope)) { "" } else { $Client.Scope }
    $cacheKey = "{0}|{1}|{2}|{3}" -f $Client.TokenUrl, $Client.ClientId, $scopePart, $secretHash
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

    $expiresIn = if ($null -ne $resp.expires_in) { [int]$resp.expires_in } else { 1800 }
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
        if ($p.required -and $Params.ContainsKey($p.name)) {
            $v = $Params[$p.name]
            if ($null -eq $v -or ([string]::Equals([string]$v, "", [StringComparison]::Ordinal))) {
                throw "Required parameter '$($p.name)' for operationId '$($Operation.operationId)' is null/empty."
            }
        }
    }

    # unknown
    foreach ($k in ($Params.Keys | ForEach-Object { [string]$_ })) {
        if (-not $declared.ContainsKey($k)) {
            throw "Unknown parameter '$k' for operationId '$($Operation.operationId)'. Refusing to guess."
        }
    }
}

function Get-GcSchemaValue {
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) {
        if ($Object.ContainsKey($Name)) { return $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Resolve-GcSchema {
    param([Parameter(Mandatory)]$Schema)

    if ($null -eq $Schema) { return $null }
    $ref = Get-GcSchemaValue -Object $Schema -Name '$ref'
    if ($ref) {
        $ref = [string]$ref
        if ($ref -match '^#/definitions/(.+)$') {
            $name = $Matches[1]
            $resolved = Get-GcSchemaValue -Object $script:GcDefinitions -Name $name
            if ($resolved) {
                return $resolved
            }
        }
    }
    return $Schema
}

function Test-GcSchemaValue {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)]$Schema,
        [string]$Path = '$body'
    )

    $errs = New-Object System.Collections.Generic.List[string]
    $resolved = Resolve-GcSchema -Schema $Schema
    if ($null -eq $resolved) { return $errs.ToArray() }

    $type = [string](Get-GcSchemaValue -Object $resolved -Name 'type')
    $props = Get-GcSchemaValue -Object $resolved -Name 'properties'
    $required = @(Get-GcSchemaValue -Object $resolved -Name 'required')

    if ($type -eq 'object' -or $props -or $required.Count -gt 0) {
        $isObj = $Value -is [hashtable] -or $Value -is [pscustomobject]
        if (-not $isObj) {
            $errs.Add("${Path}: expected object")
            return $errs.ToArray()
        }

        $actual = @{}
        if ($Value -is [hashtable]) {
            foreach ($k in $Value.Keys) { $actual[[string]$k] = $Value[$k] }
        } else {
            foreach ($p in $Value.PSObject.Properties) { $actual[$p.Name] = $p.Value }
        }

        foreach ($r in $required) {
            $rn = [string]$r
            if (-not $actual.ContainsKey($rn)) { $errs.Add("${Path}.${rn}: missing required field") }
        }

        $known = @{}
        if ($props) {
            foreach ($p in $props.PSObject.Properties) { $known[$p.Name] = $p.Value }
        }

        foreach ($k in $actual.Keys) {
            if ($known.ContainsKey($k)) {
                $childErrs = Test-GcSchemaValue -Value $actual[$k] -Schema $known[$k] -Path "$Path.$k"
                foreach ($e in $childErrs) { $errs.Add($e) }
            } elseif ((Get-GcSchemaValue -Object $resolved -Name 'additionalProperties') -ne $true) {
                $errs.Add("${Path}.${k}: unknown field")
            }
        }

        return $errs.ToArray()
    }

    if ($type -eq 'array') {
        if ($Value -is [string] -or -not ($Value -is [System.Collections.IEnumerable])) {
            $errs.Add("${Path}: expected array")
            return $errs.ToArray()
        }
        $itemsSchema = Get-GcSchemaValue -Object $resolved -Name 'items'
        if ($itemsSchema) {
            $i = 0
            foreach ($item in $Value) {
                $childErrs = Test-GcSchemaValue -Value $item -Schema $itemsSchema -Path "$Path[$i]"
                foreach ($e in $childErrs) { $errs.Add($e) }
                $i++
            }
        }
        return $errs.ToArray()
    }

    if ($type -eq 'string' -and -not ($Value -is [string])) { $errs.Add("${Path}: expected string") }
    if ($type -eq 'integer' -and -not ($Value -is [int] -or $Value -is [long])) { $errs.Add("${Path}: expected integer") }
    if ($type -eq 'number' -and -not ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal])) { $errs.Add("${Path}: expected number") }
    if ($type -eq 'boolean' -and -not ($Value -is [bool])) { $errs.Add("${Path}: expected boolean") }
    $enumValues = Get-GcSchemaValue -Object $resolved -Name 'enum'
    if ($enumValues) {
        $allowed = @($enumValues)
        if ($allowed.Count -gt 0 -and ($allowed -notcontains $Value)) {
            $errs.Add("${Path}: invalid enum value")
        }
    }

    return $errs.ToArray()
}

function Assert-BodyAgainstSpec {
    param(
        [Parameter(Mandatory)]$Operation,
        $Body
    )

    $bodyParam = @($Operation.parameters) | Where-Object { $_.in -eq 'body' } | Select-Object -First 1
    $isGet = ([string]$Operation.method).ToUpperInvariant() -eq 'GET'

    if ($isGet -and $null -ne $Body) {
        throw "Operation '$($Operation.operationId)' is GET and does not accept a body."
    }
    if (-not $bodyParam -and $null -ne $Body) {
        throw "Operation '$($Operation.operationId)' does not declare a body."
    }
    if ($bodyParam -and $bodyParam.required -and $null -eq $Body) {
        throw "Missing required body for operationId '$($Operation.operationId)'."
    }

    $bodySchema = if ($bodyParam) { Get-GcSchemaValue -Object $bodyParam -Name 'schema' } else { $null }
    if ($bodyParam -and $null -ne $Body -and $bodySchema) {
        $errs = Test-GcSchemaValue -Value $Body -Schema $bodySchema -Path '$body'
        if ($errs.Count -gt 0) {
            $preview = ($errs | Select-Object -First 12) -join '; '
            throw "Body schema validation failed for operationId '$($Operation.operationId)': $preview"
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
    $safeParams = if ($null -ne $Params) { $Params } else { @{} }
    Assert-ParamsAgainstSpec -Operation $op -Params $safeParams
    Assert-BodyAgainstSpec -Operation $op -Body $Body

    # build url with path params
    $path = $op.path
    foreach ($p in $op.parameters) {
        if ($p.in -eq "path") {
            if (-not $safeParams.ContainsKey($p.name)) { throw "Missing required path param '$($p.name)'." }
            $path = $path.Replace("{"+$p.name+"}", [Uri]::EscapeDataString([string]$safeParams[$p.name]))
        }
    }

    # query params
    $query = @{}
    foreach ($p in $op.parameters) {
        if ($p.in -eq "query" -and $safeParams.ContainsKey($p.name)) {
            $query[$p.name] = $safeParams[$p.name]
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
        [int]$MaxRuntimeMs = 120000,
        [bool]$IncludeItems = $true,
        [ValidateSet("Auto","Query","BodyPaging")][string]$PagingMode = "Auto"
    )

    $op = Get-GcOperation -OperationId $OperationId
    $safeParams = if ($null -ne $Params) { $Params } else { @{} }
    Assert-ParamsAgainstSpec -Operation $op -Params $safeParams
    Assert-BodyAgainstSpec -Operation $op -Body $Body
    $map = $script:GcPagingMap.$OperationId
    if (-not $map) { $map = [pscustomobject]@{ type = $op.pagingType; itemsPath = $op.responseItemsPath } }

    $ptype = $map.type
    $itemsPath = if ($map.itemsPath) { [string]$map.itemsPath } elseif ($op.responseItemsPath) { [string]$op.responseItemsPath } else { '$.entities' }
    if ($ptype -eq "UNKNOWN") {
        throw "OperationId '$OperationId' has unknown pagination type. Add it to registry/paging-registry.yaml (or regenerate map) before using -All."
    }

    $hardLimit = if ($env:GC_HARD_MAX_LIMIT) { [int]$env:GC_HARD_MAX_LIMIT } else { 100000 }
    $hardPages = if ($env:GC_HARD_MAX_PAGES) { [int]$env:GC_HARD_MAX_PAGES } else { 500 }
    $hardRuntime = if ($env:GC_HARD_MAX_RUNTIME_MS) { [int]$env:GC_HARD_MAX_RUNTIME_MS } else { 300000 }
    if ($hardLimit -lt 1) { $hardLimit = 100000 }
    if ($hardPages -lt 1) { $hardPages = 500 }
    if ($hardRuntime -lt 1000) { $hardRuntime = 300000 }

    if ($Limit -le 0) { $Limit = [Math]::Min(5000, $hardLimit) } else { $Limit = [Math]::Min($Limit, $hardLimit) }
    if ($MaxPages -le 0) { $MaxPages = [Math]::Min(50, $hardPages) } else { $MaxPages = [Math]::Min($MaxPages, $hardPages) }
    if ($MaxRuntimeMs -le 0) { $MaxRuntimeMs = [Math]::Min(120000, $hardRuntime) } else { $MaxRuntimeMs = [Math]::Min($MaxRuntimeMs, $hardRuntime) }

    $items = New-Object System.Collections.Generic.List[object]
    $audit = New-Object System.Collections.Generic.List[object]
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

    $page = 1
    $cursor = $null
    $after = $null
    $next = $null
    $pageNumber = 1
    $totalFetched = 0

    function Get-ItemsFromResponse($resp) {
        if ($null -eq $resp) { return @() }

        $path = [string]$itemsPath
        if ([string]::IsNullOrWhiteSpace($path)) { $path = '$.entities' }
        $normalized = $path -replace '^\$\.', '' -replace '^\$', ''

        if (-not [string]::IsNullOrWhiteSpace($normalized)) {
            $cur = $resp
            $ok = $true
            foreach ($seg in ($normalized -split '\.')) {
                if ([string]::IsNullOrWhiteSpace($seg)) { continue }
                if ($cur -and $cur.PSObject.Properties[$seg]) {
                    $cur = $cur.$seg
                } else {
                    $ok = $false
                    break
                }
            }
            if ($ok) {
                if ($cur -is [string] -or -not ($cur -is [System.Collections.IEnumerable])) {
                    throw "itemsPath '$itemsPath' resolved to non-array value."
                }
                return @($cur)
            }
        }

        $allowArrayFallback = if ($env:GC_ALLOW_ARRAY_FALLBACK) { [string]$env:GC_ALLOW_ARRAY_FALLBACK } else { 'false' }
        if ($allowArrayFallback.ToLowerInvariant() -eq 'true') {
            foreach ($p in $resp.PSObject.Properties) {
                if ($p.Value -is [System.Collections.IEnumerable] -and -not ($p.Value -is [string])) {
                    return @($p.Value)
                }
            }
        }
        return @()
    }

    while ($true) {
        $elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startedAt
        if ($elapsed -gt $MaxRuntimeMs) {
            $audit.Add([pscustomobject]@{ page=$page; stop="maxRuntimeMs"; maxRuntimeMs=$MaxRuntimeMs })
            break
        }

        if ($page -gt $MaxPages) {
            $audit.Add([pscustomobject]@{ page=$page; stop="maxPages"; })
            break
        }

        $localParams = @{}
        if ($safeParams) { $safeParams.Keys | ForEach-Object { $localParams[$_] = $safeParams[$_] } }

        $localBody = $Body
        if ($ptype -in @("PAGE_NUMBER","TOTALHITS")) {
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
            $u = [string]$next
            if ($u.StartsWith("/")) { $u = "$($Client.BaseUrl)$u" }

            $baseUri = [Uri]$Client.BaseUrl
            $nextUri = [Uri]$u
            if ($baseUri.Scheme -ne $nextUri.Scheme -or $baseUri.Host -ne $nextUri.Host -or $baseUri.Port -ne $nextUri.Port) {
                throw "Refusing to follow pagination link off-host: $($nextUri.GetLeftPart([System.UriPartial]::Authority)) (expected $($baseUri.GetLeftPart([System.UriPartial]::Authority)))."
            }

            Invoke-RestMethod -Method GET -Uri $u -Headers $headers
        } else {
            Invoke-GcApi -Client $Client -OperationId $OperationId -Params $localParams -Body $localBody
        }

        $batch = Get-ItemsFromResponse $resp
        $totalFetched += $batch.Count
        if ($IncludeItems) {
            $remaining = [Math]::Max(0, $Limit - $items.Count)
            if ($remaining -gt 0) {
                foreach ($it in ($batch | Select-Object -First $remaining)) { $items.Add($it) }
            }
        }

        $nextUriVal = if ($resp.PSObject.Properties["nextUri"]) { $resp.nextUri } else { $null }
        $nextPageVal = if ($resp.PSObject.Properties["nextPage"]) { $resp.nextPage } else { $null }
        $cursorVal = if ($resp.PSObject.Properties["cursor"]) { $resp.cursor } else { $null }
        $afterVal = if ($resp.PSObject.Properties["after"]) { $resp.after } else { $null }
        $pageNumberVal = if ($resp.PSObject.Properties["pageNumber"]) { $resp.pageNumber } else { $null }
        $pageCountVal = if ($resp.PSObject.Properties["pageCount"]) { $resp.pageCount } else { $null }
        $totalHitsVal = if ($resp.PSObject.Properties["totalHits"]) { $resp.totalHits } else { $null }

        $audit.Add([pscustomobject]@{
            page = $page
            fetched = $batch.Count
            totalFetched = $totalFetched
            nextUri = if ($nextUriVal) { "***" } else { $null }
            nextPage = if ($nextPageVal) { "***" } else { $null }
            cursor = if ($cursorVal) { "***" } else { $null }
            after = if ($afterVal) { "***" } else { $null }
            pageNumber = $pageNumberVal
            pageCount = $pageCountVal
            totalHits = $totalHitsVal
        })

        if ($totalFetched -ge $Limit) {
            $audit.Add([pscustomobject]@{ page=$page; stop="limit"; limit=$Limit })
            break
        }

        # stop conditions + next token
        $next = $null
        if ($ptype -eq "NEXT_URI") {
            $next = $resp.nextUri
            if (-not $next) { $audit.Add([pscustomobject]@{ page=$page; stop="missingNextUri" }); break }
            $marker = "NEXT_URI:$next"
            if ($seen.Contains($marker)) { $audit.Add([pscustomobject]@{ page=$page; stop="repeatNextUri" }); break }
            [void]$seen.Add($marker)
        }
        elseif ($ptype -eq "NEXT_PAGE") {
            $next = $resp.nextPage
            if (-not $next) { $audit.Add([pscustomobject]@{ page=$page; stop="missingNextPage" }); break }
            $marker = "NEXT_PAGE:$next"
            if ($seen.Contains($marker)) { $audit.Add([pscustomobject]@{ page=$page; stop="repeatNextPage" }); break }
            [void]$seen.Add($marker)
        }
        elseif ($ptype -eq "CURSOR") {
            $cursor = $resp.cursor
            if (-not $cursor) { $audit.Add([pscustomobject]@{ page=$page; stop="missingCursor" }); break }
            $marker = "CURSOR:$cursor"
            if ($seen.Contains($marker)) { $audit.Add([pscustomobject]@{ page=$page; stop="repeatCursor" }); break }
            [void]$seen.Add($marker)
        }
        elseif ($ptype -eq "AFTER") {
            $after = $resp.after
            if (-not $after) { $audit.Add([pscustomobject]@{ page=$page; stop="missingAfter" }); break }
            $marker = "AFTER:$after"
            if ($seen.Contains($marker)) { $audit.Add([pscustomobject]@{ page=$page; stop="repeatAfter" }); break }
            [void]$seen.Add($marker)
        }
        elseif ($ptype -eq "PAGE_NUMBER") {
            $pn = $resp.pageNumber
            $pc = $resp.pageCount
            if ($pc -and $pn -and ($pn -ge $pc)) { $audit.Add([pscustomobject]@{ page=$page; stop="reachedPageCount"; pageNumber=$pn; pageCount=$pc }); break }
            $pageNumber++
        }
        elseif ($ptype -eq "TOTALHITS") {
            $th = $resp.totalHits
            if (-not $th) { $audit.Add([pscustomobject]@{ page=$page; stop="missingTotalHits" }); break }
            if (($pageNumber * $PageSize) -ge $th) { $audit.Add([pscustomobject]@{ page=$page; stop="reachedTotalHits"; totalHits=$th }); break }
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
        itemsPath   = $itemsPath
        limit       = $Limit
        maxPages    = $MaxPages
        maxRuntimeMs = $MaxRuntimeMs
        totalFetched = $totalFetched
        includeItems = [bool]$IncludeItems
        items       = $items.ToArray()
        audit       = $audit.ToArray()
    }
}
### END FILE
