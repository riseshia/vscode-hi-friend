'use strict';

import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TextDocumentFilter } from 'vscode-languageclient/node';
import * as net from 'net';
import * as child_process from 'child_process';
import { existsSync } from 'fs';

interface Invoking {
    kind: 'invoking';
    workspaceFolder: vscode.WorkspaceFolder;
    process: child_process.ChildProcessWithoutNullStreams;
}
interface Running {
    kind: 'running';
    workspaceFolder: vscode.WorkspaceFolder;
    client: LanguageClient;
}
type State = Invoking | Running;

const CONFIGURATION_ROOT_SECTION = 'hi-friend';

let statusBarItem: vscode.StatusBarItem;
function addToggleButton(context: vscode.ExtensionContext) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    const disposable = vscode.commands.registerCommand(
        'hi-friend.toggle',
        (arg0: any, arg1: any, arg2: any, arg3: any) => {
            if (statusBarItem.text === 'HiFriend $(eye)') {
                statusBarItem.text = 'HiFriend $(eye-closed)';
                vscode.commands.executeCommand('hi-friend.disableSignature');
            } else {
                statusBarItem.text = 'HiFriend $(eye)';
                vscode.commands.executeCommand('hi-friend.enableSignature');
            }
        },
    );

    context.subscriptions.push(disposable);
}

function showToggleBar() {
    statusBarItem.text = 'HiFriend $(eye)';
    statusBarItem.command = 'hi-friend.toggle';
    statusBarItem.show();
}

function addJumpToRBS(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand(
        'hi-friend.jumpToRBS',
        (arg0: any, arg1: any, arg2: any, arg3: any) => {
            const uri0 = vscode.Uri.parse(arg0);
            const pos0 = new vscode.Position(arg1.line, arg1.character);
            const uri1 = vscode.Uri.parse(arg2);
            const pos1 = new vscode.Position(arg3.start.line, arg3.start.character);
            const pos2 = new vscode.Position(arg3.end.line, arg3.end.character);
            const range = new vscode.Range(pos1, pos2);
            const loc = new vscode.Location(uri1, range);
            vscode.commands.executeCommand('editor.action.peekLocations', uri0, pos0, [loc], 'peek');
        },
    );

    context.subscriptions.push(disposable);
}

let progressBarItem: vscode.StatusBarItem;
function addJumpToOutputChannel(context: vscode.ExtensionContext) {
    progressBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    progressBarItem.command = 'hi-friend.jumpToOutputChannel';

    const disposable = vscode.commands.registerCommand('hi-friend.jumpToOutputChannel', () => {
        outputChannel.show();
        progressBarItem.hide();
    });

    context.subscriptions.push(disposable);
}

function showErrorStatusBar() {
    statusBarItem.text = '$(error) HiFriend';
    statusBarItem.command = 'hi-friend.jumpToOutputChannel';
    statusBarItem.show();
}

function executeHiFriend(folder: vscode.WorkspaceFolder, arg: String): child_process.ChildProcessWithoutNullStreams {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_ROOT_SECTION);
    const customServerPath = configuration.get<string | null>('server.path');
    const cwd = folder.uri.fsPath;

    let cmd: string;
    if (existsSync(`${cwd}/bin/hi-friend`)) {
        cmd = './bin/hi-friend';
    } else if (customServerPath) {
        cmd = customServerPath;
    } else if (existsSync(`${cwd}/Gemfile`)) {
        cmd = 'bundle exec hi-friend';
    } else {
        cmd = 'hi-friend';
    }
    cmd = cmd + ' ' + arg;

    const shell = process.env.SHELL;
    let hiFriend: child_process.ChildProcessWithoutNullStreams;
    if (shell && (shell.endsWith('bash') || shell.endsWith('zsh') || shell.endsWith('fish'))) {
        const args: string[] = [];
        if (shell.endsWith('zsh')) {
            // As the recommended way, initialization commands for rbenv are written in ".zshrc".
            // However, it's not loaded on the non-interactive shell.
            // Thus, we need to run this command as the interactive shell.
            // FYI: https://zsh.sourceforge.io/Guide/zshguide02.html
            args.push('-i');
        }
        args.push('-l', '-c', cmd);
        hiFriend = child_process.spawn(shell, args, { cwd });
    } else if (process.platform === 'win32') {
        hiFriend = child_process.spawn(process.env.SYSTEMROOT + '\\System32\\cmd.exe', ['/c', cmd], { cwd });
    } else {
        const cmds = cmd.split(' ');
        hiFriend = child_process.spawn(cmds[0], cmds.slice(1), { cwd });
    }

    return hiFriend;
}

function getHiFriendVersion(
    folder: vscode.WorkspaceFolder,
    callback: (err: Error | null, version: string) => void,
): child_process.ChildProcessWithoutNullStreams {
    const hiFriend = executeHiFriend(folder, '--version');
    let output = '';

    const log = (msg: string) => {
        outputChannel.appendLine('[vscode] ' + msg);
        console.info(msg);
    };

    hiFriend.stdout?.on('data', (out) => {
        output += out;
    });
    hiFriend.stderr?.on('data', (out: Buffer) => {
        const str = ('' + out).trim();
        for (const line of str.split('\n')) {
            log('stderr: ' + line);
        }
    });
    hiFriend.on('error', (e) => {
        log(`HiFriend is not supported for this folder: ${folder.name}`);
        log(`because: ${e}`);
    });
    hiFriend.on('exit', (code) => {
        if (code === 0) {
            const str = output.trim();
            log(`HiFriend version: ${str}`);
            const version = /^hi-friend (\d+.\d+.\d+)$/.exec(str);
            if (version && version.length === 2) {
                if (compareVersions(version[1], '0.20.0') >= 0) {
                    callback(null, version[1]);
                } else {
                    const err = new Error(
                        `HiFriend version ${str} is too old; please use 0.20.0 or later for IDE feature`,
                    );
                    log(err.message);
                    callback(err, '');
                }
            } else {
                const err = new Error(`hi-friend --version showed unknown message`);
                log(err.message);
                callback(err, '');
            }
        } else {
            const err = new Error(`failed to invoke hi-friend: error code ${code}`);
            log(err.message);
            callback(err, '');
        }
        hiFriend.kill();
    });
    return hiFriend;
}

function getHiFriendStream(
    folder: vscode.WorkspaceFolder,
    error: (msg: string) => void,
): Promise<{ host: string; port: number; pid: number; stop: () => void }> {
    return new Promise((resolve, reject) => {
        const hiFriend = executeHiFriend(folder, '--lsp');

        let buffer = '';
        hiFriend.stdout.on('data', (data) => {
            buffer += data;
            try {
                const json = JSON.parse(data);
                json['stop'] = () => hiFriend.kill('SIGINT');
                resolve(json);
            } catch (err) {}
        });

        let err = '';
        hiFriend.stderr.on('data', (data) => {
            err += data;
            while (true) {
                const i = err.indexOf('\n');
                if (i < 0) {
                    break;
                }
                error(err.slice(0, i));
                err = err.slice(i + 1);
            }
        });

        hiFriend.on('exit', (code) => reject(`error code ${code}`));
    });
}

function invokeHiFriend(version: string, folder: vscode.WorkspaceFolder): LanguageClient {
    const reportError = (msg: string) => client?.info(msg);

    const serverOptions: ServerOptions = async () => {
        const { host, port, stop } = await getHiFriendStream(folder, reportError);
        const socket: net.Socket = net.createConnection(port, host);
        socket.on('close', (_hadError) => stop());

        return {
            reader: socket,
            writer: socket,
        };
    };

    const documentSelector: TextDocumentFilter[] = [
        { scheme: 'file', language: 'ruby' },
        { scheme: 'file', language: 'rbs' },
    ];

    if (compareVersions(version, '0.30.1') < 0) {
        // I don't know why, but this prevents the notification of changes of RBS files.
        // This is needed because the old version of HiFriend does not support RBS changes.
        documentSelector[0].pattern = '**/*.rb';
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector,
        outputChannel,
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('{**/*.rb,**/*.rbs}'),
        },
    };
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_ROOT_SECTION);
    const trace = configuration.get<string>('trace.server');
    if (trace !== 'off') {
        traceOutputChannel = vscode.window.createOutputChannel('Ruby HiFriend(server)', 'hi-friend');
        clientOptions.traceOutputChannel = traceOutputChannel;
    }

    return new LanguageClient('hi-friend', 'Ruby HiFriend', serverOptions, clientOptions);
}

const clientSessions: Map<vscode.WorkspaceFolder, State> = new Map();
const failedTimeoutSec = 10000;

let client: LanguageClient | undefined;
function startHiFriend(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder) {
    const showStatus = (msg: string) => {
        outputChannel.appendLine('[vscode] ' + msg);
        progressBarItem.text = `$(sync~spin) ${msg}`;
    };
    showStatus('Try to start HiFriend for IDE');

    progressBarItem.show();
    const hiFriend = getHiFriendVersion(folder, async (err, version) => {
        if (err !== null) {
            showStatus(`Ruby HiFriend is not configured`);
            setTimeout(() => {
                showFailedStatus();
            }, failedTimeoutSec);
            clientSessions.delete(folder);
            return;
        }
        showStatus(`Starting Ruby HiFriend (${version})...`);
        client = invokeHiFriend(version, folder);
        await client.start();
        showStatus('Ruby HiFriend is running');
        if (compareVersions(version, '0.21.8') >= 0) {
            // When `hi-friend.restart` is executed without opening Ruby program, the message in the progress bar is not hidden.
            // Thus, we need to set timeout here.
            setTimeout(() => progressBarItem.hide(), 3000);
            context.subscriptions.push(
                client.onNotification('hi-friend.enableToggleButton', () => {
                    enableToggleButton();
                }),
                client.onNotification('hi-friend.showErrorStatus', () => {
                    showFailedStatus();
                    client?.stop();
                }),
            );
        } else {
            // The old version does not support `hi-friend.enableToggleButton`.
            // The toggle button is displayed after a few seconds then.
            setTimeout(() => enableToggleButton(), 3000);
        }
        clientSessions.set(folder, { kind: 'running', workspaceFolder: folder, client });
    });

    clientSessions.set(folder, { kind: 'invoking', workspaceFolder: folder, process: hiFriend });
}

function showFailedStatus() {
    progressBarItem.hide();
    showErrorStatusBar();
}

function enableToggleButton() {
    progressBarItem.hide();
    showToggleBar();
}

function stopHiFriend(state: State) {
    switch (state.kind) {
        case 'invoking':
            state.process.kill();

            break;
        case 'running':
            state.client.stop();
            break;
    }
    clientSessions.delete(state.workspaceFolder);
}

function restartHiFriend(context: vscode.ExtensionContext) {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    stopAllSessions();
    for (const folder of vscode.workspace.workspaceFolders) {
        if (folder.uri.scheme === 'file') {
            let state = clientSessions.get(folder);
            if (state) {
                stopHiFriend(state);
            }
            startHiFriend(context, folder);
            break;
        }
    }
}

function ensureHiFriend(context: vscode.ExtensionContext) {
    if (!vscode.workspace.workspaceFolders) {
        return;
    }

    const activeFolders = new Set(vscode.workspace.workspaceFolders);

    clientSessions.forEach((state) => {
        if (!activeFolders.has(state.workspaceFolder)) {
            stopHiFriend(state);
        }
    });

    for (const folder of activeFolders) {
        if (folder.uri.scheme === 'file' && !clientSessions.has(folder)) {
            startHiFriend(context, folder);
            break;
        }
    }
}

function addRestartCommand(context: vscode.ExtensionContext) {
    const disposable = vscode.commands.registerCommand('hi-friend.restart', () => {
        progressBarItem.hide();
        statusBarItem.hide();
        outputChannel.clear();
        if (traceOutputChannel) {
            traceOutputChannel.dispose();
        }
        restartHiFriend(context);
    });
    context.subscriptions.push(disposable);
}

let outputChannel: vscode.OutputChannel;
let traceOutputChannel: vscode.OutputChannel | undefined;
export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Ruby HiFriend');
    addToggleButton(context);
    addJumpToOutputChannel(context);
    addJumpToRBS(context);
    addRestartCommand(context);
    ensureHiFriend(context);
}

function stopAllSessions() {
    clientSessions.forEach((state) => {
        stopHiFriend(state);
    });
}

export function deactivate() {
    progressBarItem.dispose();
    statusBarItem.dispose();
    stopAllSessions();
    if (client !== undefined) {
        return client.stop();
    }
}

const versionRegexp = /^(\d+).(\d+).(\d+)$/;

// compareVersions returns the following values:
// v1 === v2 => return 0
// v1 > v2 => return 1
// v1 < v2 => return -1
function compareVersions(v1: string, v2: string) {
    const v1Versions = versionRegexp.exec(v1);
    const v2Versions = versionRegexp.exec(v2);
    if (v1Versions && v1Versions.length === 4 && v2Versions && v2Versions.length === 4) {
        return (
            compareNumbers(v1Versions[1], v2Versions[1]) ||
            compareNumbers(v1Versions[2], v2Versions[2]) ||
            compareNumbers(v1Versions[3], v2Versions[3])
        );
    }
    throw new Error('The format of version is invalid.');
}

function compareNumbers(v1: string, v2: string) {
    if (v1 === v2) {
        return 0;
    }
    const v1Num = Number(v1);
    const v2Num = Number(v2);
    if (v1Num > v2Num) {
        return 1;
    }
    return -1;
}
