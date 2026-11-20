# albion-dashboard -> GitHub Pages deploy (v22)
# Kullanim:  powershell -ExecutionPolicy Bypass -File deploy.ps1
# Site yayini: https://barisdralabeen-glitch.github.io/albion-dashboard/
$ErrorActionPreference = "Stop"

$src  = $PSScriptRoot
$repo = Join-Path $src "deploy"

# --- Publish edilecek dosyalar ---
$files = @("index.html", "app.js", "scanner.js", "styles.css", "README.md", "data/scan-list.js", "assets/albion-official.jpeg", "assets/knight-official.jpg")
New-Item -ItemType Directory -Force -Path $repo | Out-Null
$deployParent = Split-Path $repo -Parent
$transactionId = [guid]::NewGuid().ToString('N')
$staging = Join-Path $deployParent ".deploy-staging-$transactionId"
$backup = Join-Path $deployParent ".deploy-backup-$transactionId"
$replaced = [System.Collections.Generic.List[string]]::new()
$backedUp = [System.Collections.Generic.List[string]]::new()
$rollbackIncomplete = $false
$committed = $false

try {
    New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null

    # Stage and verify every file before touching the published copies.
    foreach ($f in $files) {
        $s = Join-Path $src $f
        $stagedFile = Join-Path $staging $f
        $stagedDir = Split-Path $stagedFile -Parent
        if (-not (Test-Path -LiteralPath $s -PathType Leaf)) {
            throw "Publish source file is missing: $s"
        }
        if (-not (Test-Path -LiteralPath $stagedDir -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $stagedDir -ErrorAction Stop | Out-Null
        }
        Copy-Item -LiteralPath $s -Destination $stagedFile -ErrorAction Stop
        $sourceHash = (Get-FileHash -LiteralPath $s -Algorithm SHA256 -ErrorAction Stop).Hash
        $stagedHash = (Get-FileHash -LiteralPath $stagedFile -Algorithm SHA256 -ErrorAction Stop).Hash
        if ($sourceHash -ne $stagedHash) {
            throw "SHA256 verification failed for staged '$f' (source: $sourceHash, staged: $stagedHash)."
        }
    }

    # Keep a rollback copy of each existing published file. Only listed files
    # are ever moved; unrelated deploy content (including .git) is untouched.
    foreach ($f in $files) {
        $destination = Join-Path $repo $f
        $stagedFile = Join-Path $staging $f
        $backupFile = Join-Path $backup $f
        $destinationDir = Split-Path $destination -Parent
        $backupDir = Split-Path $backupFile -Parent
        if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $destinationDir -ErrorAction Stop | Out-Null
        }
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            if (-not (Test-Path -LiteralPath $backupDir -PathType Container)) {
                New-Item -ItemType Directory -Force -Path $backupDir -ErrorAction Stop | Out-Null
            }
            Move-Item -LiteralPath $destination -Destination $backupFile -ErrorAction Stop
            $backedUp.Add($f)
        }
        $replaced.Add($f)
        Move-Item -LiteralPath $stagedFile -Destination $destination -ErrorAction Stop
    }
    $committed = $true
} catch {
    $failure = $_
    # Roll back in reverse order. Remove only new published files, then restore
    # files that existed before this transaction.
    for ($i = $replaced.Count - 1; $i -ge 0; $i--) {
        $destination = Join-Path $repo $replaced[$i]
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        }
    }
    for ($i = $backedUp.Count - 1; $i -ge 0; $i--) {
        $f = $backedUp[$i]
        $backupFile = Join-Path $backup $f
        $destination = Join-Path $repo $f
        try {
            Move-Item -LiteralPath $backupFile -Destination $destination -ErrorAction Stop
        } catch {
            $rollbackIncomplete = $true
            throw "Deploy copy failed and rollback could not restore '$f' from '$backupFile'. Original failure: $failure. Rollback failure: $_"
        }
    }
    throw $failure
} finally {
    if ($rollbackIncomplete) {
        Write-Warning "Rollback incomplete. Preserving backup at '$backup' and staging at '$staging'."
    } elseif (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    # Preserve the backup directory if rollback itself could not restore it.
    if ($committed -and (Test-Path -LiteralPath $backup)) {
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    } elseif ($backedUp.Count -eq 0 -and (Test-Path -LiteralPath $backup)) {
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-GitChecked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = & git @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $exitCode."
    }
    return $output
}

function Invoke-GhChecked {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $output = & gh @Arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "gh $($Arguments -join ' ') failed with exit code $exitCode."
    }
    return $output
}

# --- Git hazirlik ---
if (-not (Test-Path (Join-Path $repo ".git"))) {
    $null = Invoke-GitChecked @("-C", $repo, "init")
    $null = Invoke-GitChecked @("-C", $repo, "branch", "-M", "main")
}
# gh token'ini git'e bagla (push'un sifre sorup takilmamasi icin)
$null = Invoke-GhChecked @("auth", "setup-git")
$null = Invoke-GitChecked @("-C", $repo, "add", "-A")
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$dirty = Invoke-GitChecked @("-C", $repo, "status", "--porcelain")
if ($dirty) {
    $null = Invoke-GitChecked @("-C", $repo, "commit", "-m", "Deploy $stamp")
}
$remotes = @(Invoke-GitChecked @("-C", $repo, "remote"))
if ($remotes -notcontains "origin") {
    $null = Invoke-GhChecked @("repo", "create", "albion-dashboard", "--public", "--source", $repo, "--remote", "origin", "--push")
} else {
    $null = Invoke-GitChecked @("-C", $repo, "push", "origin", "main")
}

# --- Pages acik mi, degilse ac ---
$pagesEndpoint = "repos/barisdralabeen-glitch/albion-dashboard/pages"
$null = Invoke-GhChecked @("api", "repos/barisdralabeen-glitch/albion-dashboard")
$pagesResponse = $null
$pagesGetExitCode = 0
$pagesResponse = & gh api $pagesEndpoint 2>$null
$pagesGetExitCode = $LASTEXITCODE
if ($pagesGetExitCode -eq 0) {
    # Existing Pages configuration: GET success is sufficient; do not POST.
} elseif ($pagesGetExitCode -eq 1) {
    # GitHub CLI uses exit 1 for HTTP errors; only a confirmed 404 means Pages is absent.
    $httpStatus = $null
    $ghError = $null
    if ($pagesResponse -is [System.Management.Automation.ErrorRecord]) {
        $ghError = $pagesResponse.ToString()
    } elseif ($pagesResponse) {
        $ghError = ($pagesResponse | Out-String)
    }
    if ($ghError -match '(?i)(?:HTTP\s*)?404\b|Not Found') { $httpStatus = 404 }
    if ($httpStatus -ne 404) {
        throw "GitHub Pages GET failed without a confirmed 404; refusing to attempt enablement. gh response: $ghError"
    }
    $null = Invoke-GhChecked @("api", "-X", "POST", $pagesEndpoint, "-f", "source[branch]=main", "-f", "source[path]=/")
} else {
    throw "GitHub Pages GET failed with exit code $pagesGetExitCode; refusing to attempt enablement."
}

Write-Output ""
Write-Output "Git push: success"
Write-Output "GitHub Pages configuration: success"
Write-Output "Tamam: https://barisdralabeen-glitch.github.io/albion-dashboard/"
