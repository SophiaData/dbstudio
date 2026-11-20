#Requires -Version 7.4
param(
    [Parameter(Mandatory)][string]$BaselineInstaller,
    [Parameter(Mandatory)][string]$CandidateInstaller,
    [Parameter(Mandatory)][string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:stage = 'runner'
$script:failure = 'CHECK_FAILED'
$script:children = [Collections.Generic.List[Diagnostics.Process]]::new()
$report = [ordered]@{
    schemaVersion = 1
    status = 'failed'
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    candidateSha = $env:GITHUB_SHA
    baseline = 'v0.8.1'
    checks = [ordered]@{}
}

function Stop-Acceptance([string]$Code) {
    $script:failure = $Code
    throw [InvalidOperationException]::new($Code)
}

function Start-OwnedProcess([Diagnostics.ProcessStartInfo]$Info) {
    $Info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($Info)
    $script:children.Add($process)
    return $process
}

function New-ProcessInfo([string]$File, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($File)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    return $info
}

function Invoke-PrivateProcess($Info, [int]$Timeout, [string]$InputText = '') {
    $Info.CreateNoWindow = $true
    $Info.RedirectStandardInput = $true
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $process = Start-OwnedProcess $Info
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    try {
        if ($InputText) { $process.StandardInput.WriteLine($InputText) }
    } catch [IO.IOException] {
        if (-not $process.HasExited) { throw }
    } finally {
        $process.StandardInput.Dispose()
    }
    if (-not $process.WaitForExit($Timeout * 1000)) { Stop-Acceptance 'PROCESS_TIMEOUT' }
    return @{ ExitCode = $process.ExitCode; Out = $stdout.GetAwaiter().GetResult().Trim(); Err = $stderr.GetAwaiter().GetResult().Trim() }
}

# Use a separate option-free MySQL instance and never log its SQL or output.
function Invoke-FixtureSql([string]$User, [string]$Sql, [string]$SecretValue = '') {
    $info = New-ProcessInfo $mysql @('--no-defaults', '--no-login-paths', '--protocol=TCP',
        '--host=127.0.0.1', "--port=$port", '--connect-timeout=2', "--user=$User", '--batch', '--raw', '--skip-column-names')
    $null = $info.Environment.Remove('MYSQL_PWD')
    if ($SecretValue) { $info.Environment['MYSQL_PWD'] = $SecretValue }
    return Invoke-PrivateProcess $info 15 $Sql
}

function Install-App([string]$Installer, [switch]$Update) {
    $info = [Diagnostics.ProcessStartInfo]::new($Installer)
    $mode = if ($Update) { '/S /UPDATE' } else { '/S' }
    # NSIS expects an unquoted /D switch as the final argument.
    $info.Arguments = "$mode /D=$installDir"
    $installerProcess = Start-OwnedProcess $info
    if (-not $installerProcess.WaitForExit(180000)) { Stop-Acceptance 'INSTALLER_TIMEOUT' }
    if ($installerProcess.ExitCode -ne 0) { Stop-Acceptance 'INSTALLER_NONZERO' }
    $binaries = @(Get-ChildItem -LiteralPath $installDir -File -Filter '*.exe' | Where-Object Name -ne 'uninstall.exe')
    if ($binaries.Count -ne 1 -or ($binaries[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Stop-Acceptance 'INSTALLED_BINARY_NOT_FOUND'
    }
    return $binaries[0].FullName
}

function Open-App([string]$Binary) {
    $process = Start-OwnedProcess (New-ProcessInfo $Binary @())
    $deadline = [datetime]::UtcNow.AddSeconds(45)
    do {
        $process.Refresh()
        if ($process.HasExited) { Stop-Acceptance 'APP_EXITED' }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            return @{ Process = $process; Window = $window }
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'APP_WINDOW_TIMEOUT'
}

function Close-App($App) {
    if (-not $App.Process.CloseMainWindow() -or -not $App.Process.WaitForExit(30000)) {
        Stop-Acceptance 'APP_DID_NOT_CLOSE'
    }
    if ($App.Process.ExitCode -ne 0) { Stop-Acceptance 'APP_EXIT_NONZERO' }
}

function Find-Control($Scope, $Type, [string]$Name, [switch]$ContainsName) {
    $typeConditions = [Windows.Automation.Condition[]]@(
        foreach ($controlType in @($Type)) {
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
        }
    )
    $condition = if ($typeConditions.Count -eq 1) { $typeConditions[0] }
        else { [Windows.Automation.OrCondition]::new($typeConditions) }
    if ($Name -and -not $ContainsName) {
        $condition = [Windows.Automation.AndCondition]::new($condition,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name))
    }
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        try {
            foreach ($control in $Scope.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
                if ($control.Current.IsEnabled -and -not $control.Current.IsOffscreen -and
                    (-not $ContainsName -or $control.Current.Name.Contains($Name, [StringComparison]::Ordinal))) {
                    return $control
                }
            }
        } catch [Windows.Automation.ElementNotAvailableException] {
            # WebView2 may replace an element during a Vue render.
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'UI_CONTROL_TIMEOUT'
}

function Invoke-Button($Window, [string]$Name) {
    $button = Find-Control $Window ([Windows.Automation.ControlType]::Button) $Name
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Send-ControlKeys($Control, [string]$Keys) {
    $Control.SetFocus()
    $focused = [Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused -or -not $focused.Equals($Control)) { Stop-Acceptance 'UI_CONTROL_NOT_FOCUSED' }
    [Windows.Forms.SendKeys]::SendWait($Keys)
}

function Set-EditText($Edit, [string]$Value) {
    $escaped = [regex]::Replace($Value, '[+^%~(){}\[\]]', { param($match) '{' + $match.Value + '}' })
    Send-ControlKeys $Edit ('^a' + $escaped)
}

function Connect-Saved($App) {
    $tree = Find-Control $App.Window ([Windows.Automation.ControlType]::Tree) '数据库对象'
    $row = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) $profile -ContainsName
    Send-ControlKeys $row ' '
    Invoke-Button $App.Window '连接'
}

function Assert-AppProbe($App) {
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor $probe
    Invoke-Button $App.Window '执行 SQL'
    $null = Find-Control $App.Window ([Windows.Automation.ControlType]::Text) $expected
}

try {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
        -not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) {
        Stop-Acceptance 'BLOCKED_INTERACTIVE_WINDOWS_RUNNER'
    }
    foreach ($folder in @([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'))) {
        foreach ($profileName in @('io.dbstudio.desktop', 'dbstudio')) {
            if (Test-Path -LiteralPath (Join-Path $folder $profileName)) { Stop-Acceptance 'BLOCKED_NONEMPTY_PROFILE' }
        }
    }
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AcceptanceDesktop {
    [DllImport("user32.dll")]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr desktop);

    public static bool InputDesktopAvailable() {
        var desktop = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS
        return desktop != IntPtr.Zero && CloseDesktop(desktop);
    }
}
'@
    if (-not [AcceptanceDesktop]::InputDesktopAvailable()) { Stop-Acceptance 'BLOCKED_INPUT_DESKTOP_UNAVAILABLE' }
    $webViewRoot = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\EdgeWebView\Application'
    if (-not (Test-Path -LiteralPath $webViewRoot -PathType Container)) { Stop-Acceptance 'BLOCKED_WEBVIEW2_MISSING' }
    $mysqlCommand = Get-Command mysql.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $mysqlCommand) { Stop-Acceptance 'BLOCKED_MYSQL_CLIENT_MISSING' }
    $mysql = $mysqlCommand.Source
    $mysqlBin = Split-Path -Parent $mysql
    $mysqlBase = Split-Path -Parent $mysqlBin
    $server = Join-Path $mysqlBin 'mysqld.exe'
    if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { Stop-Acceptance 'BLOCKED_MYSQL_SERVER_MISSING' }
    $report.checks.runnerPreflight = $true

    $script:stage = 'installer_integrity'
    $report.baselineInstallerSha256 = (Get-FileHash -LiteralPath $BaselineInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($report.baselineInstallerSha256 -ne '41403e3117aaade4dd8c9b9eb433684cb2bc925da8a489e89d726e1c6e9da292') {
        Stop-Acceptance 'BASELINE_HASH_MISMATCH'
    }
    $report.candidateInstallerSha256 = (Get-FileHash -LiteralPath $CandidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($report.candidateInstallerSha256 -eq $report.baselineInstallerSha256) { Stop-Acceptance 'INSTALLERS_IDENTICAL' }

    $script:stage = 'fixture'
    $run = [guid]::NewGuid().ToString('N')
    $root = Join-Path $env:RUNNER_TEMP "dbstudio-install-$run"
    $null = New-Item -ItemType Directory -Path $root
    $dataDir = Join-Path $root 'mysql-data'
    $installDir = Join-Path $root 'app'
    $profile = "dbstudio-ci-$run"
    $marker = $run.Substring(0, 16)
    $initialization = Invoke-PrivateProcess (New-ProcessInfo $server @('--no-defaults', '--initialize-insecure', "--basedir=$mysqlBase", "--datadir=$dataDir", '--console')) 90
    if ($initialization.ExitCode -ne 0) { Stop-Acceptance 'FIXTURE_INIT_FAILED' }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    $serverInfo = New-ProcessInfo $server @('--no-defaults', "--basedir=$mysqlBase", "--datadir=$dataDir", '--bind-address=127.0.0.1',
        "--port=$port", '--mysqlx=OFF', '--skip-log-bin', '--general-log=OFF', '--slow-query-log=OFF')
    $serverInfo.CreateNoWindow = $true
    $mysqld = Start-OwnedProcess $serverInfo
    $deadline = [datetime]::UtcNow.AddSeconds(45)
    do {
        if ($mysqld.HasExited) { Stop-Acceptance 'FIXTURE_SERVER_EXITED' }
        $ready = Invoke-FixtureSql 'root' 'SELECT @@datadir;'
        if ($ready.ExitCode -eq 0) { break }
        Start-Sleep -Milliseconds 300
    } while ([datetime]::UtcNow -lt $deadline)
    if ($ready.ExitCode -ne 0) { Stop-Acceptance 'FIXTURE_NOT_READY' }
    if ($ready.Out.Replace('/', '\').TrimEnd('\') -ne $dataDir) { Stop-Acceptance 'FIXTURE_IDENTITY_MISMATCH' }

    $syntheticSecret = 'Aa9' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
    $setup = Invoke-FixtureSql 'root' @"
CREATE DATABASE dbstudio_ci;
CREATE TABLE dbstudio_ci.probe (marker VARCHAR(16) NOT NULL);
INSERT INTO dbstudio_ci.probe VALUES ('$marker');
CREATE USER 'dbstudio_ci'@'127.0.0.1' IDENTIFIED BY '$syntheticSecret';
GRANT SELECT ON dbstudio_ci.* TO 'dbstudio_ci'@'127.0.0.1';
"@
    if ($setup.ExitCode -ne 0) { Stop-Acceptance 'FIXTURE_SETUP_FAILED' }
    $probe = "SELECT CONCAT(marker, ':', CURRENT_USER()) AS proof FROM dbstudio_ci.probe;"
    $expected = "${marker}:dbstudio_ci@127.0.0.1"
    $denied = Invoke-FixtureSql 'dbstudio_ci' $probe
    if ($denied.ExitCode -eq 0 -or $denied.Err -notmatch '\b1045\b') { Stop-Acceptance 'FIXTURE_EMPTY_PASSWORD_NOT_DENIED' }
    $observed = Invoke-FixtureSql 'dbstudio_ci' $probe $syntheticSecret
    if ($observed.ExitCode -ne 0 -or $observed.Out -cne $expected) { Stop-Acceptance 'FIXTURE_OBSERVER_MISMATCH' }
    $report.checks.fixtureAuthentication = $true

    $script:stage = 'baseline_install'
    $baseline = Install-App $BaselineInstaller
    $report.baselineBinarySha256 = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.checks.baselineInstalled = $true

    $script:stage = 'baseline_save_and_query'
    $app = Open-App $baseline
    Invoke-Button $app.Window '＋ 新建连接'
    $combo = Find-Control $app.Window ([Windows.Automation.ControlType]::ComboBox) '数据库类型'
    Send-ControlKeys $combo '%{DOWN}m{ENTER}'
    foreach ($field in ([ordered]@{ '连接名' = $profile; '主机' = '127.0.0.1'; '端口' = [string]$port; '数据库' = 'dbstudio_ci'; '用户名' = 'dbstudio_ci' }).GetEnumerator()) {
        $types = @([Windows.Automation.ControlType]::Edit)
        if ($field.Key -eq '端口') { $types += [Windows.Automation.ControlType]::Spinner }
        Set-EditText (Find-Control $app.Window $types $field.Key) $field.Value
    }
    $secretEdit = Find-Control $app.Window ([Windows.Automation.ControlType]::Edit) '密码'
    if (-not $secretEdit.Current.IsPassword) { Stop-Acceptance 'UI_CREDENTIAL_FIELD_NOT_PROTECTED' }
    $valuePattern = $null
    if (-not $secretEdit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        Stop-Acceptance 'UI_CREDENTIAL_FIELD_NOT_WRITABLE'
    }
    $valuePattern.SetValue($syntheticSecret)
    $syntheticSecret = $null
    Invoke-Button $app.Window '保存并连接'
    Assert-AppProbe $app
    Close-App $app
    $report.checks.baselineSavedAndQueried = $true

    $script:stage = 'baseline_relaunch'
    $app = Open-App $baseline
    Connect-Saved $app
    Assert-AppProbe $app
    Close-App $app
    $report.checks.baselineReconnected = $true

    $script:stage = 'candidate_install'
    $candidate = Install-App $CandidateInstaller -Update
    $report.candidateBinarySha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($candidate -ne $baseline -or $report.candidateBinarySha256 -eq $report.baselineBinarySha256) {
        Stop-Acceptance 'INSTALL_DID_NOT_REPLACE_BINARY'
    }
    $report.checks.candidateInstalled = $true

    $script:stage = 'candidate_reconnect'
    $app = Open-App $candidate
    Connect-Saved $app
    Assert-AppProbe $app
    Close-App $app
    $report.checks.candidateReconnected = $true
    $report.status = 'passed'
} catch {
    $report.status = if ($script:failure.StartsWith('BLOCKED_')) { 'blocked' } else { 'failed' }
    $report.stage = $script:stage
    $report.code = $script:failure
} finally {
    foreach ($process in $script:children) {
        try {
            if (-not $process.HasExited) {
                $process.Kill($true)
                if (-not $process.WaitForExit(10000)) { throw 'PROCESS_CLEANUP_TIMEOUT' }
            }
        } catch {
            $report.cleanup = 'failed'
            if ($report.status -eq 'passed') { $report.status = 'failed'; $report.code = 'PROCESS_CLEANUP_FAILED' }
        } finally { $process.Dispose() }
    }
    $json = $report | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($ReportPath, $json + [Environment]::NewLine)
    Write-Output $json
}
if ($report.status -ne 'passed') { exit 1 }
