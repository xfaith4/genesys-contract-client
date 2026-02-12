@{
  RootModule        = 'Genesys.ContractClient.psm1'
  ModuleVersion     = '0.1.0'
  GUID              = '2a0b9a3d-3f6b-4fdb-9c63-95df4c7d4b23'
  Author            = 'Internal'
  CompanyName       = 'Internal'
  Copyright         = '(c) Internal'
  Description       = 'Contract-enforced(ish) Genesys Cloud API caller with deterministic pagination.'
  PowerShellVersion = '5.1'
  FunctionsToExport = @(
    'Import-GcSpec','Get-GcOperation','Find-GcOperation',
    'New-GcClient','Get-GcAccessToken',
    'Invoke-GcApi','Invoke-GcApiAll'
  )
  CmdletsToExport   = @()
  VariablesToExport = '*'
  AliasesToExport   = @()
}
