import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('twilightcoders.claude-pilot'));
	});

	test('Extension should activate', async () => {
		const extension = vscode.extensions.getExtension('twilightcoders.claude-pilot');
		await extension?.activate();
		assert.ok(extension?.isActive);
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		
		const expectedCommands = [
			'claudePilot.refresh',
			'claudePilot.openTerminal',
			'claudePilot.focus'
		];

		for (const command of expectedCommands) {
			assert.ok(commands.includes(command), `Command ${command} should be registered`);
		}
	});
});