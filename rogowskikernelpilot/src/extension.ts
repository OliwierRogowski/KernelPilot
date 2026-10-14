import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	console.log('Congratulations, your extension "rogowskikernelpilot" is now active!');

	const disposable = vscode.commands.registerCommand('rogowskikernelpilot.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from KernelPilot!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
