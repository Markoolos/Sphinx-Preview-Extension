param (
    [Parameter(Mandatory = $true)][string]$documentationRoot,
    [Parameter(Mandatory = $true)][string]$outputDirectory,
    [Parameter(Mandatory = $true)][string]$venvPath,
    [string]$plantUmlJarPath = "",
    [string]$hostName = "127.0.0.1",
    [ValidateRange(1, 65535)][int]$port = 8000
)

$ErrorActionPreference = "Stop"

$pythonExe = Join-Path $venvPath "Scripts\python.exe"

if (-not (Test-Path (Join-Path $documentationRoot "conf.py") -PathType Leaf)) {
    throw "The Sphinx configuration cannot be found at $documentationRoot\conf.py."
}

if (-not (Test-Path $pythonExe -PathType Leaf)) {
    throw "The documentation preview virtual environment cannot be found at $venvPath."
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

Write-Output "[Documentation preview] Watching $documentationRoot"
Write-Output "[Documentation preview] Writing HTML to $outputDirectory"
Write-Output "[Documentation preview] Preview URL: http://${hostName}:$port/"

$sphinxArguments = @(
    "--host", $hostName,
    "--port", $port,
    "-b", "html"
)

if ($plantUmlJarPath -and (Test-Path $plantUmlJarPath -PathType Leaf)) {
    $plantUmlCommand = "java -jar `"$plantUmlJarPath`""
    $sphinxArguments += @("-D", "plantuml=$plantUmlCommand")
    Write-Output "[Documentation preview] Using PlantUML JAR $plantUmlJarPath"
} elseif ($plantUmlJarPath) {
    Write-Warning "The configured PlantUML JAR cannot be found at $plantUmlJarPath. Continuing with the path from conf.py."
}

$sphinxArguments += @($documentationRoot, $outputDirectory)
& $pythonExe -m sphinx_autobuild @sphinxArguments

if ($LASTEXITCODE -ne 0) {
    throw "Documentation preview failed with exit code $LASTEXITCODE."
}
