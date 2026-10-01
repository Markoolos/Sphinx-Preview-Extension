'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let extensionContext;
let previewProcess;
let previewUrl;
let stopping = false;
let output;
let status;

function documentationPath(candidate, sourceDirectory, folder) {
  const expanded = sourceDirectory.replaceAll('${workspaceFolder}', folder.uri.fsPath);
  return path.resolve(candidate, expanded);
}

function isProjectRoot(candidate, sourceDirectory, folder) {
  return fs.existsSync(path.join(documentationPath(candidate, sourceDirectory, folder), 'conf.py'));
}

function matchingChildProjects(parent, sourceDirectory, folder) {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(parent, entry.name))
      .filter(candidate => isProjectRoot(candidate, sourceDirectory, folder));
  } catch {
    return [];
  }
}

async function findProjectRoot(folder, sourceDirectory) {
  let candidate = folder.uri.fsPath;
  while (true) {
    if (isProjectRoot(candidate, sourceDirectory, folder)) return candidate;

    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  const matches = matchingChildProjects(folder.uri.fsPath, sourceDirectory, folder);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return undefined;

  const selected = await vscode.window.showQuickPick(
    matches.map(projectRoot => ({
      label: path.basename(projectRoot),
      description: projectRoot,
      projectRoot
    })),
    { placeHolder: 'Select the Sphinx project to preview' }
  );
  return selected?.projectRoot;
}

function getWorkspaceFolder() {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return (activeUri && vscode.workspace.getWorkspaceFolder(activeUri)) || vscode.workspace.workspaceFolders?.[0];
}

function expandConfiguredValue(value, folder, projectRoot, documentationRoot) {
  return value
    .replaceAll('${workspaceFolder}', folder.uri.fsPath)
    .replaceAll('${projectRoot}', projectRoot)
    .replaceAll('${documentationRoot}', documentationRoot);
}

function resolveConfiguredPath(value, folder, projectRoot, documentationRoot, basePath = folder.uri.fsPath) {
  if (!value || !value.trim()) return undefined;
  return path.resolve(basePath, expandConfiguredValue(value, folder, projectRoot, documentationRoot));
}

async function runConfiguredCommands(
  commands, powerShellPath, folder, projectRoot, documentationRoot, phase
) {
  for (const configuredCommand of commands) {
    if (!configuredCommand || !configuredCommand.trim()) continue;
    const command = expandConfiguredValue(configuredCommand, folder, projectRoot, documentationRoot);
    output.appendLine(`[extension] Running ${phase} command: ${command}`);
    await runProcess(powerShellPath, [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command
    ], { cwd: projectRoot, log: true });
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    let timer;

    if (options.timeout) {
      timer = setTimeout(() => child.kill(), options.timeout);
    }

    child.stdout.on('data', data => {
      const text = data.toString();
      stdout += text;
      if (options.log) output.append(text);
    });
    child.stderr.on('data', data => {
      const text = data.toString();
      stderr += text;
      if (options.log) output.append(text);
    });
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`${command} failed: ${detail}`));
      }
    });
  });
}

async function isPython312(command, prefixArgs = []) {
  try {
    await runProcess(
      command,
      [...prefixArgs, '-c', 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)'],
      { timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function findPython312() {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'py.exe', args: ['-3.12'] },
        { command: 'python.exe', args: [] },
        { command: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'), args: [] },
        { command: path.join(process.env.ProgramFiles || '', 'Python312', 'python.exe'), args: [] }
      ]
    : [
        { command: 'python3.12', args: [] },
        { command: 'python3', args: [] },
        { command: 'python', args: [] }
      ];

  for (const candidate of candidates) {
    if (candidate.command && await isPython312(candidate.command, candidate.args)) {
      return candidate;
    }
  }
  return undefined;
}

async function installPython312() {
  if (process.platform !== 'win32') {
    throw new Error('Python 3.12 was not found. Install it with your operating system package manager and try again.');
  }

  const choice = await vscode.window.showWarningMessage(
    'Sphinx Preview requires Python 3.12. Install it for the current user using winget?',
    { modal: true },
    'Install Python 3.12'
  );
  if (choice !== 'Install Python 3.12') {
    throw new Error('Python 3.12 installation was cancelled.');
  }

  output.appendLine('[extension] Installing Python 3.12 with winget...');
  await runProcess('winget.exe', [
    'install',
    '--id', 'Python.Python.3.12',
    '--exact',
    '--scope', 'user',
    '--accept-package-agreements',
    '--accept-source-agreements'
  ], { log: true });

  const python = await findPython312();
  if (!python) {
    throw new Error('Python 3.12 was installed but is not visible yet. Restart VS Code and start the preview again.');
  }
  return python;
}

function getVenvPython(venvPath) {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

async function ensurePreviewEnvironment() {
  const requirementsPath = path.join(__dirname, 'requirements.txt');
  const requirements = fs.readFileSync(requirementsPath);
  const requirementsHash = crypto.createHash('sha256').update(requirements).digest('hex');
  const venvPath = path.join(extensionContext.globalStorageUri.fsPath, 'python-3.12');
  const venvPython = getVenvPython(venvPath);
  const markerPath = path.join(venvPath, '.tem-sphinx-requirements');

  if (fs.existsSync(venvPython) && await isPython312(venvPython)) {
    const installedHash = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : '';
    if (installedHash === requirementsHash) {
      output.appendLine(`[extension] Reusing preview environment ${venvPath}`);
      return venvPath;
    }
  } else if (fs.existsSync(venvPath)) {
    fs.rmSync(venvPath, { recursive: true, force: true });
  }

  let python = await findPython312();
  if (!python) {
    python = await installPython312();
  }

  if (!fs.existsSync(venvPython)) {
    fs.mkdirSync(path.dirname(venvPath), { recursive: true });
    output.appendLine(`[extension] Creating Python 3.12 environment ${venvPath}`);
    await runProcess(python.command, [...python.args, '-m', 'venv', venvPath], { log: true });
  }

  const config = vscode.workspace.getConfiguration('sphinxPreview');
  const pipIndexUrl = config.get('pipIndexUrl');
  const pipArgs = [
    '-m', 'pip', 'install', '--disable-pip-version-check',
    '--requirement', requirementsPath
  ];
  if (pipIndexUrl) {
    pipArgs.push('--index-url', pipIndexUrl);
  }

  output.appendLine('[extension] Installing pinned documentation dependencies...');
  await runProcess(venvPython, pipArgs, { log: true });
  fs.writeFileSync(markerPath, requirementsHash, 'utf8');
  return venvPath;
}

async function openPreview() {
  if (!previewUrl) {
    void vscode.window.showInformationMessage('The Sphinx preview is not running.');
    return;
  }

  try {
    await vscode.commands.executeCommand('simpleBrowser.show', previewUrl);
  } catch {
    await vscode.env.openExternal(vscode.Uri.parse(previewUrl));
  }
}

function serverIsReady(url) {
  return new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume();
      resolve(true);
    });
    request.setTimeout(1000, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForServer(
  process, url, openOnStart, postBuildCommands, powerShellPath, folder, projectRoot, documentationRoot
) {
  for (let attempt = 0; attempt < 120 && previewProcess === process; attempt += 1) {
    if (await serverIsReady(url)) {
      output.appendLine(`[extension] Preview ready at ${url}`);
      status.text = '$(book) Sphinx docs';
      status.tooltip = `Open ${url}`;
      try {
        await runConfiguredCommands(
          postBuildCommands, powerShellPath, folder, projectRoot, documentationRoot, 'post-build'
        );
      } catch (error) {
        output.appendLine(`[extension] Post-build command failed: ${error.message}`);
        void vscode.window.showWarningMessage(
          `Sphinx post-build command failed. The preview is still running. See the output for details.`
        );
      }
      if (openOnStart) await openPreview();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (previewProcess === process) {
    void vscode.window.showWarningMessage('Sphinx preview did not become ready. See “Sphinx Preview” output.');
  }
}

async function startPreview() {
  if (previewProcess) {
    await openPreview();
    return;
  }

  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage('Trust this workspace before starting the documentation preview.');
    return;
  }

  const folder = getWorkspaceFolder();
  if (!folder) {
    void vscode.window.showErrorMessage('Open a folder containing a Sphinx documentation project before starting the preview.');
    return;
  }

  const config = vscode.workspace.getConfiguration('sphinxPreview', folder.uri);
  const sourceDirectory = config.get('sourceDirectory');
  const projectRoot = await findProjectRoot(folder, sourceDirectory);
  if (!projectRoot) {
    void vscode.window.showErrorMessage(
      `Could not find conf.py under the configured Sphinx source directory “${sourceDirectory}”.`
    );
    return;
  }

  const documentationRoot = documentationPath(projectRoot, sourceDirectory, folder);
  const outputDirectory = resolveConfiguredPath(
    config.get('outputDirectory'), folder, projectRoot, documentationRoot, projectRoot
  );
  if (!outputDirectory) {
    void vscode.window.showErrorMessage('Configure a non-empty Sphinx preview output directory.');
    return;
  }

  const host = config.get('host');
  const port = config.get('port');
  const powerShellPath = config.get('powerShellPath');
  const openOnStart = config.get('openOnStart');
  const preBuildCommands = config.get('preBuildCommands', []);
  const postBuildCommands = config.get('postBuildCommands', []);
  let plantUmlJarPath = resolveConfiguredPath(
    config.get('plantUmlJarPath'), folder, projectRoot, documentationRoot
  );
  const script = path.join(extensionContext.extensionPath, 'scripts', 'preview_documentation.ps1');

  if (plantUmlJarPath && !fs.existsSync(plantUmlJarPath)) {
    void vscode.window.showWarningMessage(
      `The configured PlantUML JAR does not exist: ${plantUmlJarPath}. The preview will continue without the override.`
    );
    plantUmlJarPath = undefined;
  }

  output.clear();
  output.show(true);
  status.text = '$(sync~spin) Sphinx docs';
  status.tooltip = 'Preparing Sphinx preview';
  status.show();

  let venvPath;
  try {
    venvPath = await ensurePreviewEnvironment();
  } catch (error) {
    output.appendLine(`[extension] Environment setup failed: ${error.message}`);
    status.hide();
    void vscode.window.showErrorMessage(`Could not prepare Sphinx preview: ${error.message}`);
    return;
  }

  try {
    await runConfiguredCommands(
      preBuildCommands, powerShellPath, folder, projectRoot, documentationRoot, 'pre-build'
    );
  } catch (error) {
    output.appendLine(`[extension] Pre-build command failed: ${error.message}`);
    status.hide();
    void vscode.window.showErrorMessage(
      `Sphinx pre-build command failed. Preview was not started. See the output for details.`
    );
    return;
  }

  const args = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-documentationRoot', documentationRoot,
    '-outputDirectory', outputDirectory,
    '-venvPath', venvPath
  ];
  if (plantUmlJarPath) {
    args.push('-plantUmlJarPath', plantUmlJarPath);
  }
  args.push('-hostName', host, '-port', String(port));

  output.appendLine(`[extension] Starting documentation preview with ${powerShellPath}.`);
  stopping = false;
  previewUrl = `http://${host}:${port}/`;
  status.tooltip = 'Starting Sphinx preview';

  const child = spawn(powerShellPath, args, {
    cwd: projectRoot,
    windowsHide: true,
    env: process.env
  });
  previewProcess = child;

  child.stdout.on('data', data => output.append(data.toString()));
  child.stderr.on('data', data => output.append(data.toString()));
  child.on('error', error => {
    output.appendLine(`[extension] Failed to start preview: ${error.message}`);
    void vscode.window.showErrorMessage(`Could not start Sphinx preview: ${error.message}`);
  });
  child.on('close', code => {
    const wasStopping = stopping;
    if (previewProcess === child) {
      previewProcess = undefined;
      previewUrl = undefined;
      status.hide();
    }
    output.appendLine(`[extension] Preview stopped with exit code ${code}.`);
    if (!wasStopping && code !== 0) {
      void vscode.window.showErrorMessage('Sphinx preview stopped unexpectedly. See the output for details.');
    }
  });

  void waitForServer(
    child, previewUrl, openOnStart, postBuildCommands, powerShellPath, folder,
    projectRoot, documentationRoot
  );
}

function stopPreview() {
  if (!previewProcess) return;

  stopping = true;
  const child = previewProcess;
  output.appendLine('[extension] Stopping preview...');
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Sphinx Preview');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'sphinxPreview.open';

  context.subscriptions.push(
    output,
    status,
    vscode.commands.registerCommand('sphinxPreview.start', startPreview),
    vscode.commands.registerCommand('sphinxPreview.stop', stopPreview),
    vscode.commands.registerCommand('sphinxPreview.open', openPreview)
  );
}

function deactivate() {
  stopPreview();
}

module.exports = { activate, deactivate };
