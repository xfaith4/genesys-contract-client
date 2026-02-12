# Pester tests for contract behavior that does not require live Genesys API calls.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$modulePath = Join-Path $repoRoot 'src\ps-module\Genesys.ContractClient\Genesys.ContractClient.psd1'
$swaggerPath = Join-Path $repoRoot 'specs\swagger.json'
$operationsPath = Join-Path $repoRoot 'generated\operations.json'
$pagingMapPath = Join-Path $repoRoot 'generated\pagination-map.json'

Import-Module $modulePath -Force
Import-GcSpec -SwaggerPath $swaggerPath -OperationsPath $operationsPath -PaginationMapPath $pagingMapPath

Describe "Genesys.ContractClient contract enforcement" {
  BeforeAll {
    $script:dummyClient = New-GcClient `
      -BaseUrl 'https://api.mypurecloud.com' `
      -TokenUrl 'https://login.mypurecloud.com/oauth/token' `
      -ClientId 'dummy-client' `
      -ClientSecret 'dummy-secret'
  }

  It "Finds operations by keyword" {
    $ops = Find-GcOperation -Query 'postAnalyticsConversationsDetailsQuery' -Top 5
    (@($ops).Count) | Should -BeGreaterThan 0
  }

  It "Rejects unknown query/path params before network call" {
    {
      Invoke-GcApi -Client $script:dummyClient -OperationId 'getUsers' -Params @{ madeUpParam = 'x' }
    } | Should -Throw "*Unknown parameter*"
  }

  It "Rejects unknown body fields against schema" {
    {
      Invoke-GcApi -Client $script:dummyClient -OperationId 'postAnalyticsConversationsDetailsQuery' -Body @{
        interval = '2026-02-01T00:00:00.000Z/2026-02-02T00:00:00.000Z'
        invalidField = 'x'
      }
    } | Should -Throw "*Body schema validation failed*"
  }

  It "Refuses callAll when pagination type is UNKNOWN" {
    {
      Invoke-GcApiAll -Client $script:dummyClient -OperationId 'getConversation' -Params @{ conversationId = 'abc' }
    } | Should -Throw "*unknown pagination type*"
  }
}
