[CmdletBinding()]
param(
  [Parameter()]
  [string[]]$Command = @(),

  [Parameter()]
  [string[]]$LiveCommand = @(),

  [Parameter()]
  [string]$OutDir = "reports/test-runs",

  [Parameter()]
  [string]$SchemaPath = "docs/ai/test-report.schema.json",

  [Parameter()]
  [int]$ExcerptLength = 1500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-VersionLine {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter()]
    [string[]]$Arguments = @()
  )

  try {
    $output = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $output) {
      return $null
    }
    return ($output | Select-Object -First 1).ToString().Trim()
  }
  catch {
    return $null
  }
}

function Get-Excerpt {
  param(
    [Parameter()]
    [string]$Text,
    [Parameter(Mandatory = $true)]
    [int]$MaxLength
  )

  if ([string]::IsNullOrEmpty($Text)) {
    return ""
  }

  if ($Text.Length -le $MaxLength) {
    return $Text
  }

  return $Text.Substring(0, $MaxLength) + "...[truncated]"
}

function Get-RepositoryName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DefaultName
  )

  try {
    $remote = (& git config --get remote.origin.url 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($remote)) {
      return $DefaultName
    }

    if ($remote -match "[:/](?<owner>[^/]+)/(?<repo>[^/.]+)(?:\.git)?$") {
      return "$($Matches.owner)/$($Matches.repo)"
    }

    return $remote
  }
  catch {
    return $DefaultName
  }
}

function Get-GitBranch {
  try {
    $branch = (& git rev-parse --abbrev-ref HEAD 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) {
      return "unknown"
    }
    return $branch
  }
  catch {
    return "unknown"
  }
}

function Get-GitCommit {
  try {
    $sha = (& git rev-parse HEAD 2>$null).Trim()
    if ($LASTEXITCODE -eq 0 -and $sha -match "^[a-fA-F0-9]{7,40}$") {
      return $sha
    }
    return "0000000"
  }
  catch {
    return "0000000"
  }
}

function Invoke-TrackedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CommandText,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = "pwsh"
  $startInfo.ArgumentList.Add("-NoLogo")
  $startInfo.ArgumentList.Add("-NoProfile")
  $startInfo.ArgumentList.Add("-Command")
  $startInfo.ArgumentList.Add($CommandText)
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $stopwatch.Stop()

  return [pscustomobject]@{
    ExitCode = [int]$process.ExitCode
    DurationMs = [int][Math]::Round($stopwatch.Elapsed.TotalMilliseconds)
    Stdout = $stdout
    Stderr = $stderr
  }
}

if (($Command.Count + $LiveCommand.Count) -eq 0) {
  throw "Provide at least one command via -Command or -LiveCommand."
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path

Push-Location $repoRoot
try {
  $schemaFullPath = (Resolve-Path -Path $SchemaPath).Path
}
catch {
  Pop-Location
  throw "Schema file not found: $SchemaPath"
}

try {
  $timestamp = [DateTime]::UtcNow
  $stamp = $timestamp.ToString("yyyyMMddTHHmmssZ")

  $outDirFull = Join-Path $repoRoot $OutDir
  $null = New-Item -ItemType Directory -Path $outDirFull -Force

  $jsonReportPath = Join-Path $outDirFull "$stamp-report.json"
  $mdReportPath = Join-Path $outDirFull "$stamp-report.md"

  $commandsToRun = @()
  foreach ($entry in $Command) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) {
      $commandsToRun += [pscustomobject]@{
        CommandText = $entry.Trim()
        RequiresSandbox = $false
      }
    }
  }
  foreach ($entry in $LiveCommand) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) {
      $commandsToRun += [pscustomobject]@{
        CommandText = $entry.Trim()
        RequiresSandbox = $true
      }
    }
  }

  if ($commandsToRun.Count -eq 0) {
    throw "No executable commands were provided."
  }

  $sandboxEnabled = $env:COPILOT_GENESYS_ENV -eq "sandbox"
  $commandReceipts = @()
  $evidence = @()
  $findings = @()
  $residualRisks = @()
  $skippedCount = 0
  $passedCount = 0
  $failedCount = 0

  $runStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt $commandsToRun.Count; $i++) {
    $index = $i + 1
    $entry = $commandsToRun[$i]
    $logPath = Join-Path $outDirFull ("{0}-cmd-{1:d2}.log" -f $stamp, $index)
    $logRelativePath = [System.IO.Path]::GetRelativePath($repoRoot, $logPath).Replace("\", "/")

    if ($entry.RequiresSandbox -and -not $sandboxEnabled) {
      $skipMessage = "Skipped: requires COPILOT_GENESYS_ENV=sandbox."
      Set-Content -Path $logPath -Value $skipMessage -Encoding UTF8

      $commandReceipts += [pscustomobject]@{
        command = $entry.CommandText
        cwd = $repoRoot
        exitCode = 0
        durationMs = 0
        stdoutExcerpt = $skipMessage
        stderrExcerpt = ""
      }
      $evidence += [pscustomobject]@{
        type = "log"
        path = $logRelativePath
        description = "Command receipt log"
      }
      $findings += [pscustomobject]@{
        severity = "Medium"
        title = "Live command skipped without sandbox approval"
        details = "Live command was skipped because COPILOT_GENESYS_ENV is not sandbox."
        status = "accepted-risk"
        evidenceRef = $logRelativePath
      }
      $residualRisks += "Live Genesys validation skipped: $($entry.CommandText)"
      $skippedCount++
      continue
    }

    $result = Invoke-TrackedCommand -CommandText $entry.CommandText -WorkingDirectory $repoRoot
    $stdoutExcerpt = Get-Excerpt -Text $result.Stdout -MaxLength $ExcerptLength
    $stderrExcerpt = Get-Excerpt -Text $result.Stderr -MaxLength $ExcerptLength

    $logContent = @(
      "# Command",
      $entry.CommandText,
      "",
      "# Working Directory",
      $repoRoot,
      "",
      "# Exit Code",
      $result.ExitCode,
      "",
      "# DurationMs",
      $result.DurationMs,
      "",
      "## STDOUT",
      $result.Stdout,
      "",
      "## STDERR",
      $result.Stderr
    ) -join [Environment]::NewLine
    Set-Content -Path $logPath -Value $logContent -Encoding UTF8

    $commandReceipts += [pscustomobject]@{
      command = $entry.CommandText
      cwd = $repoRoot
      exitCode = $result.ExitCode
      durationMs = $result.DurationMs
      stdoutExcerpt = $stdoutExcerpt
      stderrExcerpt = $stderrExcerpt
    }
    $evidence += [pscustomobject]@{
      type = "log"
      path = $logRelativePath
      description = "Command receipt log"
    }

    if ($result.ExitCode -eq 0) {
      $passedCount++
    }
    else {
      $failedCount++
      $findings += [pscustomobject]@{
        severity = "High"
        title = "Command failed"
        details = "Command exited non-zero ($($result.ExitCode)). Review the linked command log."
        status = "open"
        evidenceRef = $logRelativePath
      }
    }
  }
  $runStopwatch.Stop()

  $summaryStatus = if ($failedCount -gt 0) {
    "fail"
  }
  elseif ($skippedCount -gt 0) {
    "partial"
  }
  else {
    "pass"
  }

  $repoName = Get-RepositoryName -DefaultName (Split-Path $repoRoot -Leaf)
  $branch = Get-GitBranch
  $commitSha = Get-GitCommit
  $actor = if ($env:GITHUB_ACTOR) { $env:GITHUB_ACTOR } elseif ($env:USERNAME) { $env:USERNAME } else { "unknown" }

  $environment = [ordered]@{
    os = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription.Trim()
    pwsh = $PSVersionTable.PSVersion.ToString()
  }

  $nodeVersion = Get-VersionLine -Executable "node" -Arguments @("--version")
  if ($null -ne $nodeVersion) {
    $environment.node = $nodeVersion
  }
  $pythonVersion = Get-VersionLine -Executable "python" -Arguments @("--version")
  if ($null -ne $pythonVersion) {
    $environment.python = $pythonVersion
  }

  $jsonRelativePath = [System.IO.Path]::GetRelativePath($repoRoot, $jsonReportPath).Replace("\", "/")
  $mdRelativePath = [System.IO.Path]::GetRelativePath($repoRoot, $mdReportPath).Replace("\", "/")

  $evidence += [pscustomobject]@{
    type = "report"
    path = $jsonRelativePath
    description = "Machine-readable test run report"
  }
  $evidence += [pscustomobject]@{
    type = "report"
    path = $mdRelativePath
    description = "Human-readable test run report"
  }

  $report = [ordered]@{
    schemaVersion = "1.0.0"
    run = [ordered]@{
      utcTimestamp = $timestamp.ToString("o")
      repository = $repoName
      branch = $branch
      commitSha = $commitSha
      actor = $actor
      environment = $environment
    }
    summary = [ordered]@{
      status = $summaryStatus
      totalChecks = $commandsToRun.Count
      passedChecks = $passedCount
      failedChecks = $failedCount
      durationSeconds = [Math]::Round($runStopwatch.Elapsed.TotalSeconds, 3)
    }
    commands = $commandReceipts
    findings = $findings
    evidence = $evidence
    residualRisks = $residualRisks
  }

  $report | ConvertTo-Json -Depth 20 | Set-Content -Path $jsonReportPath -Encoding UTF8

  $validationErrors = @()
  $isValid = Test-Json -Path $jsonReportPath -SchemaFile $schemaFullPath -ErrorAction SilentlyContinue -ErrorVariable validationErrors
  if (-not $isValid) {
    $messages = if ($validationErrors.Count -gt 0) {
      ($validationErrors | ForEach-Object { $_.ToString() }) -join "; "
    }
    else {
      "Unknown schema validation error."
    }
    throw "Generated JSON report failed schema validation: $messages"
  }

  $mdLines = @()
  $mdLines += "# Test Run Report ($stamp)"
  $mdLines += ""
  $mdLines += "## 1. Scope and commit context"
  $mdLines += "- UTC timestamp: $($report.run.utcTimestamp)"
  $mdLines += "- Repository: $($report.run.repository)"
  $mdLines += "- Branch: $($report.run.branch)"
  $mdLines += "- Commit: $($report.run.commitSha)"
  $mdLines += "- Actor: $($report.run.actor)"
  $mdLines += ""
  $mdLines += "## 2. Findings (ordered by severity)"
  if ($findings.Count -eq 0) {
    $mdLines += "- None."
  }
  else {
    foreach ($finding in $findings) {
      $mdLines += "- [$($finding.severity)] $($finding.title): $($finding.details) (status=$($finding.status), evidence=$($finding.evidenceRef))"
    }
  }
  $mdLines += ""
  $mdLines += "## 3. Commands run and outcomes"
  foreach ($receipt in $commandReceipts) {
    $mdLines += "- $($receipt.command)"
    $mdLines += "  - cwd: $($receipt.cwd)"
    $mdLines += "  - exitCode: $($receipt.exitCode)"
    $mdLines += "  - durationMs: $($receipt.durationMs)"
    if ($receipt.stdoutExcerpt) {
      $stdoutSingleLine = $receipt.stdoutExcerpt.Replace("`r", " ").Replace("`n", " ")
      $mdLines += "  - stdoutExcerpt: $stdoutSingleLine"
    }
    if ($receipt.stderrExcerpt) {
      $stderrSingleLine = $receipt.stderrExcerpt.Replace("`r", " ").Replace("`n", " ")
      $mdLines += "  - stderrExcerpt: $stderrSingleLine"
    }
  }
  $mdLines += ""
  $mdLines += "## 4. Evidence artifacts generated"
  foreach ($item in $evidence) {
    $mdLines += "- [$($item.type)] $($item.path)"
  }
  $mdLines += ""
  $mdLines += "## 5. Residual risks / untested areas"
  if ($residualRisks.Count -eq 0) {
    $mdLines += "- None."
  }
  else {
    foreach ($risk in $residualRisks) {
      $mdLines += "- $risk"
    }
  }
  $mdLines += ""
  $mdLines += "## 6. Recommended next hardening steps"
  if ($failedCount -gt 0) {
    $mdLines += "- Fix failed checks and rerun this command."
  }
  elseif ($skippedCount -gt 0) {
    $mdLines += "- Run skipped live checks in sandbox (COPILOT_GENESYS_ENV=sandbox) when credentials are available."
  }
  else {
    $mdLines += "- Continue with reviewer pass using this report pair."
  }

  Set-Content -Path $mdReportPath -Value $mdLines -Encoding UTF8

  Write-Host "Generated report JSON: $jsonRelativePath"
  Write-Host "Generated report MD:   $mdRelativePath"
  Write-Host "Summary status:        $summaryStatus"

  if ($failedCount -gt 0) {
    exit 1
  }
}
finally {
  Pop-Location
}
