param(
    [switch]$Apply,
    [string]$TaskName = 'TeamMailboxCenter',
    [string]$Root = 'D:\team-mailbox',
    [string]$Node = 'C:\nvm4w\nodejs\node.exe',
    [string]$Db = 'D:\team-mailbox\data\msg.sqlite',
    [string]$Access = 'D:\team-mailbox\access.json',
    [string]$HostAddress = '0.0.0.0',
    [int]$Port = 18787
)
$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $Port -lt 1 -or $Port -gt 65535 -or $HostAddress -notmatch '^[0-9.]+$') { throw 'Invalid task name, host or port' }
$paths = @($Root, $Node, $Db, $Access)
foreach ($p in $paths) {
    if ($p.Contains('"')) { throw 'Quoted paths are not supported' }
    if (-not [IO.Path]::IsPathRooted($p) -or $p -notmatch '^[A-Za-z]:\\' -or $p -match '^\\\\') { throw 'Only fixed local drive paths are allowed' }
    $drive = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='" + $p.Substring(0,2) + "'")
    if (-not $drive -or $drive.DriveType -ne 3) { throw 'All paths must reside on fixed local drives' }
}
$script = Join-Path $Root 'scripts\run-center-foreground.mjs'
$server = Join-Path $Root 'src\server.js'
foreach ($p in @($Root, $Node, $Db, $Access, $script, $server)) {
    $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::Encrypted) -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Encrypted or reparse-point deployment path: blocked' }
}
if ((Get-Item -LiteralPath $Db).Length -eq 0) { throw 'Existing DB is empty' }
# Inspect every existing ancestor: writable ancestors permit replacing protected children.
foreach ($p in @($Root, $Node, $Db, $Access, $script, $server)) {
    $current = Get-Item -LiteralPath $p -Force
    while ($current) {
        if (($current.Attributes -band [IO.FileAttributes]::Encrypted) -or ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Encrypted or reparse-point ancestor: blocked' }
        $acl = Get-Acl -LiteralPath $current.FullName
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -ne 'Allow') { continue }
            $sid = try { $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { '' }
            if ($sid -notin @('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4')) { continue }
            $rights = [int]$rule.FileSystemRights
            if (($rights -band [int][Security.AccessControl.FileSystemRights]::Write) -or
                ($rights -band [int][Security.AccessControl.FileSystemRights]::Modify) -or
                ($rights -band [int][Security.AccessControl.FileSystemRights]::FullControl) -or
                ($rights -band [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)) {
                throw 'Broad user write permission on deployment path: blocked (review ACL manually)'
            }
        }
        $current = if ($current -is [IO.DirectoryInfo]) { $current.Parent } else { $current.Directory }
    }
}
$account = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskUser = $account.Name
$quoted = @('--root', $Root, '--node', $Node, '--db', $Db, '--access', $Access, '--host', $HostAddress, '--port', [string]$Port) | ForEach-Object { '"' + $_ + '"' }
$arguments = '"' + $script + '" ' + ($quoted -join ' ')
$action = New-ScheduledTaskAction -Execute $Node -Argument $arguments -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 30)
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { throw 'A task with this name already exists; no overwrite or replacement performed' }
Write-Output "Preview only: task=$TaskName user=$taskUser trigger=AtStartup delay=30s logon=S4U runlevel=Limited restarts=3/1min execution-limit=none multiple=IgnoreNew batteries=allowed"
Write-Output "Paths: root=$Root node=$Node db=$Db access=$Access; host=$HostAddress port=$Port"
Write-Output 'Review ACLs including Node actual target and replaceable parent directories; this check cannot prove every effective permission or future ACL change.'
if (-not $Apply) { Write-Output 'No task registered; rerun with -Apply in an elevated PowerShell after manual review.'; return }
$admin = [Security.Principal.WindowsPrincipal]$account
if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Apply requires an elevated administrator token for the same account' }
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $account.User.Value) { throw 'Current identity changed; refusing registration' }
Register-ScheduledTask -TaskName $TaskName -InputObject $definition -ErrorAction Stop | Out-Null
Write-Output 'Task registered but not started. Export-ScheduledTask and inspect XML before separate reboot authorization.'
