#Requires -Version 7.4
param(
    [Parameter(Mandatory)][string]$CandidateInstaller,
    [Parameter(Mandatory)][string]$ReportPath,
    [string]$BaselineInstaller,
    [switch]$FirstUse
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:stage = 'runner'
$script:action = $null
$script:failure = 'CHECK_FAILED'
$script:children = [Collections.Generic.List[Diagnostics.Process]]::new()
$report = [ordered]@{
    schemaVersion = 1
    status = 'failed'
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    candidateSha = $env:GITHUB_SHA
    scenario = if ($FirstUse) { 'clean_install_grid_copy' } else { 'replacement' }
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
    $info = New-ProcessInfo $Binary @()
    # Enable Chromium's native accessibility provider for this CI-launched app.
    $info.Environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--force-renderer-accessibility --enable-features=UiaProvider'
    $process = Start-OwnedProcess $info
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

function Find-Control($Scope, $Type, [string]$Name, [switch]$ContainsName, [switch]$FieldLabel, [switch]$AllowOffscreen) {
    $typeConditions = [Windows.Automation.Condition[]]@(
        foreach ($controlType in @($Type)) {
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
        }
    )
    $condition = if ($typeConditions.Count -eq 1) { $typeConditions[0] }
        else { [Windows.Automation.OrCondition]::new($typeConditions) }
    if ($Name -and -not $ContainsName -and -not $FieldLabel) {
        $condition = [Windows.Automation.AndCondition]::new($condition,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name))
    }
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        try {
            foreach ($control in $Scope.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
                if ($control.Current.IsEnabled -and ($AllowOffscreen -or -not $control.Current.IsOffscreen) -and
                    (-not $ContainsName -or $control.Current.Name.Contains($Name, [StringComparison]::Ordinal)) -and
                    (-not $FieldLabel -or $control.Current.Name.TrimEnd([char[]]' *') -ceq $Name)) {
                    return $control
                }
            }
        } catch [Windows.Automation.ElementNotAvailableException] {
            # WebView2 may replace an element during a Vue render.
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    if ($script:action -eq 'open_connection_form') {
        $controls = $Scope.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        $summary = [ordered]@{
            descendants = $controls.Count; buttons = 0; documents = 0; matching = 0; enabled = 0; visible = 0
            appDocument = $false; workbenchText = $false; browserError = $false
            browserCode = $null; tauriOrigin = $false; developmentOrigin = $false
            windowWidth = [int]$Scope.Current.BoundingRectangle.Width
            windowHeight = [int]$Scope.Current.BoundingRectangle.Height
        }
        foreach ($control in $controls) {
            try {
                $controlName = $control.Current.Name
                if ($control.Current.ControlType -eq [Windows.Automation.ControlType]::Document) {
                    $summary.documents++
                    if ($controlName -eq 'dbstudio') { $summary.appDocument = $true }
                }
                if ($controlName -like '*数据库工作台*') { $summary.workbenchText = $true }
                if ($controlName -match '\b(ERR_[A-Z_]+)\b') { $summary.browserCode = $Matches[1] }
                if ($controlName -match 'ERR_[A-Z_]+|can.t reach this page|无法访问此页面|应用启动预检失败') {
                    $summary.browserError = $true
                }
                if ($controlName -like '*tauri.localhost*') { $summary.tauriOrigin = $true }
                if ($controlName -like '*127.0.0.1:1420*') { $summary.developmentOrigin = $true }
                if ($control.Current.ControlType -ne [Windows.Automation.ControlType]::Button) { continue }
                $summary.buttons++
                if ($control.Current.Name -notlike '*新建连接*') { continue }
                $summary.matching++
                if ($control.Current.IsEnabled) { $summary.enabled++ }
                if (-not $control.Current.IsOffscreen) { $summary.visible++ }
            } catch [Windows.Automation.ElementNotAvailableException] {
                # The probe reports only controls still present in the window.
            }
        }
        $report.uiProbe = $summary
    }
    Stop-Acceptance 'UI_CONTROL_TIMEOUT'
}

function Invoke-Button($Window, [string]$Name, [switch]$ContainsName) {
    $button = Find-Control $Window ([Windows.Automation.ControlType]::Button) $Name -ContainsName:$ContainsName -AllowOffscreen
    $scroll = $null
    if ($button.Current.IsOffscreen -and $button.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scroll)) {
        $scroll.ScrollIntoView()
    }
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Send-ControlKeys($Control, [string]$Keys) {
    $Control.SetFocus()
    $focused = [Windows.Automation.AutomationElement]::FocusedElement
    if (-not $focused -or -not $focused.Equals($Control)) { Stop-Acceptance 'UI_CONTROL_NOT_FOCUSED' }
    [Windows.Forms.SendKeys]::SendWait($Keys)
}

function Set-EditText($Edit, [string]$Value) {
    $pattern = $null
    if ($Edit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
        $pattern.SetValue($Value)
        return
    }
    if ($Value -match '^\d+$' -and
        $Edit.TryGetCurrentPattern([Windows.Automation.RangeValuePattern]::Pattern, [ref]$pattern) -and -not $pattern.Current.IsReadOnly) {
        $pattern.SetValue([double]$Value)
        return
    }
    Stop-Acceptance 'UI_EDIT_PATTERN_UNAVAILABLE'
}

function Select-MySql($Window) {
    $combo = Find-Control $Window ([Windows.Automation.ControlType]::ComboBox) '数据库类型'
    $expand = $null
    if (-not $combo.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
        Stop-Acceptance 'UI_DIALECT_EXPAND_UNAVAILABLE'
    }
    $expand.Expand()
    $choice = Find-Control $Window @([Windows.Automation.ControlType]::ListItem, [Windows.Automation.ControlType]::DataItem) 'MySQL / MariaDB'
    $selection = $null
    if (-not $choice.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        Stop-Acceptance 'UI_DIALECT_SELECTION_UNAVAILABLE'
    }
    $selection.Select()
    if ($expand.Current.ExpandCollapseState -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $expand.Collapse() }
}

function Connect-Saved($App) {
    $script:action = 'find_saved_connection'
    $tree = Find-Control $App.Window ([Windows.Automation.ControlType]::Tree) '数据库对象'
    $row = Find-Control $tree ([Windows.Automation.ControlType]::TreeItem) $profile -ContainsName
    $invoke = $null
    if ($row.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
    } else {
        Send-ControlKeys $row ' '
    }
    $script:action = 'connect_saved_profile'
    Invoke-Button $App.Window '连接'
}

function Assert-AppProbe($App) {
    $script:action = 'edit_probe_sql'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor $probe
    $script:action = 'execute_probe_sql'
    Invoke-Button $App.Window '执行 SQL'
    $script:action = 'read_probe_result'
    $null = Find-Control $App.Window @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem) $expected
}

function Assert-GridClipboard($App, [string]$Expected) {
    $script:action = 'query_clipboard_fixture'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor 'SELECT id, body FROM dbstudio_ci.copy_rows ORDER BY id;'
    Invoke-Button $App.Window '执行 SQL'
    $script:action = 'select_result_rows'
    foreach ($position in @(3, 1)) {
        $label = "选择第 $position 行"
        $row = Find-Control $App.Window ([Windows.Automation.ControlType]::CheckBox) $label
        $toggle = $row.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { Stop-Acceptance 'RESULT_ROW_ALREADY_SELECTED' }
        $toggle.Toggle()
        $deadline = [datetime]::UtcNow.AddSeconds(5)
        do {
            $row = Find-Control $App.Window ([Windows.Automation.ControlType]::CheckBox) $label
            $state = $row.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
            if ($state -eq [Windows.Automation.ToggleState]::On) { break }
            Start-Sleep -Milliseconds 100
        } while ([datetime]::UtcNow -lt $deadline)
        if ($state -ne [Windows.Automation.ToggleState]::On) { Stop-Acceptance 'RESULT_ROW_NOT_SELECTED' }
    }
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { Stop-Acceptance 'BLOCKED_CLIPBOARD_STA' }
    $script:action = 'copy_result_rows'
    [Windows.Forms.Clipboard]::SetText('dbstudio-fixture-before-copy')
    Invoke-Button $App.Window '复制选中行'
    $deadline = [datetime]::UtcNow.AddSeconds(25)
    do {
        try {
            $clipboard = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText)
            if ($clipboard -ceq $Expected) { return }
        } catch [Runtime.InteropServices.ExternalException] {
            # Another process can briefly hold the runner clipboard open.
        }
        Start-Sleep -Milliseconds 200
    } while ([datetime]::UtcNow -lt $deadline)
    Stop-Acceptance 'CLIPBOARD_CONTENT_MISMATCH'
}

function Assert-GridPage($App, [string[]]$Expected, [string]$MarkerPrefix) {
    $types = @([Windows.Automation.ControlType]::Text, [Windows.Automation.ControlType]::DataItem)
    $null = Find-Control $App.Window $types $Expected[-1] -AllowOffscreen
    $condition = [Windows.Automation.OrCondition]::new([Windows.Automation.Condition[]]@(
        foreach ($type in $types) {
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
        }
    ))
    $pattern = '^' + [regex]::Escape($MarkerPrefix) + '[0-9]{4}$'
    $text = [Collections.Generic.List[string]]::new()
    $cells = [Collections.Generic.List[string]]::new()
    foreach ($control in $App.Window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
        $value = $control.Current.Name
        if ($value -cnotmatch $pattern) { continue }
        if ($control.Current.ControlType -eq [Windows.Automation.ControlType]::Text) { $text.Add($value) }
        else { $cells.Add($value) }
    }
    # The provider may expose the same value as a cell and as its child text.
    $actual = if ($text.Count) { @($text.ToArray()) } else { @($cells.ToArray()) }
    if (($actual -join '|') -cne ($Expected -join '|')) {
        $report.pageMismatch = @{ expectedRows = $Expected.Count; renderedRows = @($actual).Count }
        Stop-Acceptance 'PAGE_CONTENT_MISMATCH'
    }
}

function Assert-GridPaging($App, [string[]]$Expected, [string]$MarkerPrefix) {
    $script:action = 'query_paging_fixture'
    $editor = Find-Control $App.Window ([Windows.Automation.ControlType]::Edit) 'SQL 编辑器'
    Set-EditText $editor 'SELECT marker FROM dbstudio_ci.paging_rows ORDER BY id;'
    Invoke-Button $App.Window '执行 SQL'
    $script:action = 'first_page'
    Assert-GridPage $App $Expected[0..199] $MarkerPrefix
    $script:action = 'second_page'
    Invoke-Button $App.Window '下一页'
    Assert-GridPage $App $Expected[200..399] $MarkerPrefix
    $script:action = 'last_page'
    Invoke-Button $App.Window '下一页'
    Assert-GridPage $App $Expected[400..404] $MarkerPrefix
    $script:action = 'back_to_second_page'
    Invoke-Button $App.Window '上一页'
    Assert-GridPage $App $Expected[200..399] $MarkerPrefix
    $script:action = 'back_to_first_page'
    Invoke-Button $App.Window '上一页'
    Assert-GridPage $App $Expected[0..199] $MarkerPrefix
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
    $report.candidateInstallerSha256 = (Get-FileHash -LiteralPath $CandidateInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $FirstUse) {
        $report.baselineInstallerSha256 = (Get-FileHash -LiteralPath $BaselineInstaller -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($report.baselineInstallerSha256 -ne '41403e3117aaade4dd8c9b9eb433684cb2bc925da8a489e89d726e1c6e9da292') {
            Stop-Acceptance 'BASELINE_HASH_MISMATCH'
        }
        if ($report.candidateInstallerSha256 -eq $report.baselineInstallerSha256) { Stop-Acceptance 'INSTALLERS_IDENTICAL' }
    }

    $script:stage = 'fixture'
    $run = [guid]::NewGuid().ToString('N')
    $root = Join-Path $env:RUNNER_TEMP "dbstudio-install-$run"
    $null = New-Item -ItemType Directory -Path $root
    $dataDir = Join-Path $root 'mysql-data'
    $installDir = Join-Path $root 'app'
    $profile = "dbstudio-ci-$run"
    $marker = $run.Substring(0, 16)
    $pagingMarkerPrefix = "pg-$marker-"
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
CREATE TABLE dbstudio_ci.copy_rows (id BIGINT NOT NULL PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO dbstudio_ci.copy_rows VALUES
(9007199254740993, CONCAT('$marker', CHAR(9), CHAR(34), 'quoted', CHAR(34), CHAR(13,10), REPEAT('x', 1400))),
(9007199254740994, 'not-selected'),
(9007199254740995, 'third-row');
CREATE TABLE dbstudio_ci.paging_rows (id INT NOT NULL PRIMARY KEY, marker VARCHAR(32) NOT NULL);
INSERT INTO dbstudio_ci.paging_rows (id, marker)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 405)
SELECT n, CONCAT('$pagingMarkerPrefix', LPAD(n, 4, '0')) FROM seq;
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
    if ($FirstUse) {
        $copyRows = Invoke-FixtureSql 'dbstudio_ci' 'SELECT id, HEX(body) FROM dbstudio_ci.copy_rows WHERE id IN (9007199254740993, 9007199254740995) ORDER BY id;' $syntheticSecret
        $expectedLines = @("id`tbody")
        if ($copyRows.ExitCode -ne 0) { Stop-Acceptance 'CLIPBOARD_OBSERVER_QUERY_FAILED' }
        foreach ($line in ($copyRows.Out -split '\r?\n')) {
            if ($line -cnotmatch '^(9007199254740993|9007199254740995)\t([0-9A-F]+)$') { Stop-Acceptance 'CLIPBOARD_OBSERVER_ROW_INVALID' }
            $id = $Matches[1]
            $body = [Text.Encoding]::UTF8.GetString([Convert]::FromHexString($Matches[2]))
            if ($body -match '["\t\r\n]') { $body = '"' + $body.Replace('"', '""') + '"' }
            $expectedLines += "$id`t$body"
        }
        if ($expectedLines.Count -ne 3) { Stop-Acceptance 'CLIPBOARD_OBSERVER_COUNT' }
        $expectedClipboard = $expectedLines -join "`r`n"
        $pagingRows = Invoke-FixtureSql 'dbstudio_ci' 'SELECT marker FROM dbstudio_ci.paging_rows ORDER BY id;' $syntheticSecret
        $expectedPaging = @($pagingRows.Out -split '\r?\n')
        if ($pagingRows.ExitCode -ne 0 -or $expectedPaging.Count -ne 405 -or
            ($expectedPaging -join '|') -cne ((1..405 | ForEach-Object { '{0}{1:D4}' -f $pagingMarkerPrefix, $_ }) -join '|')) {
            Stop-Acceptance 'PAGING_OBSERVER_MISMATCH'
        }
    }

    if ($env:DBSTUDIO_PROBE_CANDIDATE_STARTUP -eq '1') {
        $script:stage = 'candidate_clean_install'
        $installed = Install-App $CandidateInstaller
        $report.checks.candidateInstalled = $true
        $script:stage = 'candidate_clean_startup'
        $app = Open-App $installed
        $script:action = 'open_connection_form'
        Invoke-Button $app.Window '新建连接' -ContainsName
        $null = Find-Control $app.Window ([Windows.Automation.ControlType]::Edit) '连接名'
        Close-App $app
        $report.checks.candidateConnectionFormOpened = $true
        $report.status = 'passed'
        return
    }

    if ($FirstUse) {
        $script:stage = 'candidate_clean_install'
        $binary = Install-App $CandidateInstaller
        $report.checks.candidateInstalled = $true
        $script:stage = 'candidate_connect_and_copy'
    } else {
        $script:stage = 'baseline_install'
        $baseline = Install-App $BaselineInstaller
        $report.baselineBinarySha256 = (Get-FileHash -LiteralPath $baseline -Algorithm SHA256).Hash.ToLowerInvariant()
        $report.checks.baselineInstalled = $true
        $script:stage = 'baseline_save_and_query'
        $binary = $baseline
    }
    $script:action = 'launch_application'
    $app = Open-App $binary
    $script:action = 'open_connection_form'
    Invoke-Button $app.Window '新建连接' -ContainsName
    $script:action = 'select_mysql'
    Select-MySql $app.Window
    $fields = [ordered]@{
        connection_name = @('连接名', $profile)
        host = @('主机', '127.0.0.1')
        port = @('端口', [string]$port)
        database = @('数据库', 'dbstudio_ci')
        username = @('用户名', 'dbstudio_ci')
    }
    foreach ($field in $fields.GetEnumerator()) {
        $script:action = 'fill_' + $field.Key
        $types = @([Windows.Automation.ControlType]::Edit)
        if ($field.Key -eq 'port') { $types += [Windows.Automation.ControlType]::Spinner }
        Set-EditText (Find-Control $app.Window $types $field.Value[0] -FieldLabel) $field.Value[1]
    }
    $script:action = 'fill_credential'
    $secretEdit = Find-Control $app.Window ([Windows.Automation.ControlType]::Edit) '密码'
    if (-not $secretEdit.Current.IsPassword) { Stop-Acceptance 'UI_CREDENTIAL_FIELD_NOT_PROTECTED' }
    $valuePattern = $null
    if (-not $secretEdit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        Stop-Acceptance 'UI_CREDENTIAL_FIELD_NOT_WRITABLE'
    }
    $valuePattern.SetValue($syntheticSecret)
    $syntheticSecret = $null
    $script:action = 'save_and_connect'
    Invoke-Button $app.Window '保存并连接'
    Assert-AppProbe $app
    if ($FirstUse) {
        $report.checks.mysqlConnectedAndQueried = $true
        Assert-GridClipboard $app $expectedClipboard
        Close-App $app
        $report.checks.selectedRowsClipboard = $true

        $script:stage = 'candidate_same_version_restart'
        $script:action = 'relaunch_candidate'
        $firstProcessId = $app.Process.Id
        $app = Open-App $binary
        if ($app.Process.Id -eq $firstProcessId) { Stop-Acceptance 'APP_PROCESS_NOT_REPLACED' }
        Connect-Saved $app
        $probe = "SELECT CONCAT(marker, ':restart:', CURRENT_USER()) AS proof FROM dbstudio_ci.probe;"
        $expected = "${marker}:restart:dbstudio_ci@127.0.0.1"
        Assert-AppProbe $app
        $report.checks.sameVersionReconnect = $true
        $script:stage = 'candidate_paging'
        Assert-GridPaging $app $expectedPaging $pagingMarkerPrefix
        $report.checks.paging = $true
        $script:action = 'close_restarted_candidate'
        Close-App $app
        $report.status = 'passed'
        return
    }
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
    if ($script:action) { $report.action = $script:action }
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
