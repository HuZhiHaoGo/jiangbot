param([Parameter(Mandatory = $true)][string]$ConfigPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$connection = $null
$command = $null
$exitCode = 0

function Add-Parameter($name, [System.Data.SqlDbType]$type, $value, [int]$size = 0) {
  $parameter = if ($size -gt 0) {
    $command.Parameters.Add($name, $type, $size)
  } else {
    $command.Parameters.Add($name, $type)
  }
  $parameter.Value = if ($null -eq $value) { [DBNull]::Value } else { $value }
}

function Find-SqlError([Exception]$exception) {
  while ($null -ne $exception) {
    if ($exception -is [System.Data.SqlClient.SqlException]) { return $exception }
    $exception = $exception.InnerException
  }
  return $null
}

try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  # Windows PowerShell returns the JSON array as one pipeline object.
  $rows = [object[]](ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()))
  $settings = ConvertFrom-Json -InputObject (Get-Content -Raw -LiteralPath $ConfigPath -Encoding UTF8)
  if ([string]::IsNullOrWhiteSpace($settings.user) -or
      [string]::IsNullOrWhiteSpace($settings.password) -or
      [string]::IsNullOrWhiteSpace($settings.server)) {
    throw 'Invalid SQL usage configuration'
  }

  $login = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $employee = ($login -split '\\')[-1]
  if ($rows.Count -lt 1 -or $rows.Count -gt 20 -or $login.Length -gt 128) {
    throw 'Invalid usage batch'
  }
  foreach ($row in $rows) {
    if ($employee -ine $row.employeeNo) { throw 'Windows identity mismatch' }
  }

  $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
  $builder.DataSource = $settings.server
  $builder.InitialCatalog = 'hbcshdb'
  $builder.ConnectTimeout = 3
  $builder.ConnectRetryCount = 0
  $builder.Encrypt = $true
  $builder.TrustServerCertificate = $false
  $builder.Pooling = $false
  $builder.ApplicationName = 'Jiangbot Token Usage'
  $password = ConvertTo-SecureString $settings.password -AsPlainText -Force
  $password.MakeReadOnly()
  $credential = New-Object System.Data.SqlClient.SqlCredential($settings.user, $password)
  $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString, $credential)
  $connection.Open()

  $command = $connection.CreateCommand()
  $command.CommandTimeout = 5
  $command.CommandText = @'
INSERT INTO [dbo].[ModelTokenUsage] (
    [EventId], [EmployeeNo], [WindowsLogin], [SessionId], [ModelName],
    [RequestKind], [UsedAtUtc], [InputTokens], [OutputTokens],
    [CacheReadTokens], [CacheWriteTokens], [TotalTokens]
) VALUES (
    @EventId, @EmployeeNo, @WindowsLogin, @SessionId, @ModelName,
    @RequestKind, @UsedAtUtc, @InputTokens, @OutputTokens,
    @CacheReadTokens, @CacheWriteTokens, @TotalTokens
);
'@

  foreach ($row in $rows) {
    $command.Parameters.Clear()
    Add-Parameter '@EventId' UniqueIdentifier ([Guid]$row.eventId)
    Add-Parameter '@EmployeeNo' NVarChar $row.employeeNo 64
    Add-Parameter '@WindowsLogin' NVarChar $login 128
    Add-Parameter '@SessionId' NVarChar $row.sessionId 128
    Add-Parameter '@ModelName' NVarChar $row.modelName 256
    Add-Parameter '@RequestKind' VarChar $row.requestKind 32
    Add-Parameter '@UsedAtUtc' DateTime2 ([DateTimeOffset]::Parse($row.usedAtUtc).UtcDateTime)
    Add-Parameter '@InputTokens' BigInt $row.inputTokens
    Add-Parameter '@OutputTokens' BigInt $row.outputTokens
    Add-Parameter '@CacheReadTokens' BigInt $row.cacheReadTokens
    Add-Parameter '@CacheWriteTokens' BigInt $row.cacheWriteTokens
    Add-Parameter '@TotalTokens' BigInt $row.totalTokens
    try {
      [void]$command.ExecuteNonQuery()
    } catch [System.Data.SqlClient.SqlException] {
      # A previously committed EventId is a successful retry.
      $errorInfo = Find-SqlError $_.Exception
      if ($null -eq $errorInfo -or $errorInfo.Number -notin @(2601, 2627) -or
          -not $errorInfo.Message.Contains('UQ_ModelTokenUsage_EventId')) { throw }
    }
  }
} catch [System.Data.SqlClient.SqlException] {
  # Return a classification only. SQL errors can contain connection details.
  $sqlError = Find-SqlError $_.Exception
  $exitCode = if ($null -ne $sqlError -and
      $sqlError.Number -in @(-2, 2, 20, 53, 64, 121, 233, 1205, 10053, 10054, 10060, 11001)) { 2 } else { 1 }
} catch {
  $exitCode = 1
} finally {
  if ($null -ne $command) { $command.Dispose() }
  if ($null -ne $connection) { $connection.Dispose() }
}
exit $exitCode
