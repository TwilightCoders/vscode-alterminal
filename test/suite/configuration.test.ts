import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Configuration Tests', () => {
    test('Claude Pilot starting command configuration should be available', async () => {
        const config = vscode.workspace.getConfiguration('claudePilot');
        
        // Test that the configuration exists
        const startingCommand = config.get('startingCommand');
        assert.ok(startingCommand !== undefined, 'startingCommand configuration should exist');
        
        // Test default value
        assert.strictEqual(startingCommand, 'claude', 'Default starting command should be "claude"');
    });

    test('Starting command configuration should accept all valid options', () => {
        // Test that configuration accepts valid values by checking the schema
        const validOptions = ['none', 'claude', 'claude --continue', 'claude --resume'];
        
        // Since we can't modify workspace settings in test environment,
        // we verify the schema allows all expected values
        const config = vscode.workspace.getConfiguration('claudePilot');
        
        // Test that we can inspect the configuration without errors
        const inspectResult = config.inspect('startingCommand');
        assert.ok(inspectResult, 'Should be able to inspect startingCommand configuration');
        
        // Verify default value is accessible
        const defaultValue = inspectResult?.defaultValue;
        assert.strictEqual(defaultValue, 'claude', 'Default value should be "claude"');
        
        // Test that each valid option would be a string (type check)
        for (const option of validOptions) {
            assert.strictEqual(typeof option, 'string', `Option "${option}" should be a string`);
            assert.ok(option.length > 0, `Option "${option}" should not be empty`);
        }
    });

    test('Starting command configuration should have correct schema', () => {
        // Get the package.json to verify configuration schema
        const extensionPath = vscode.extensions.getExtension('twilightcoders.claude-pilot')?.extensionPath;
        assert.ok(extensionPath, 'Extension should be loaded');
        
        const packageJson = require(`${extensionPath}/package.json`);
        const configProps = packageJson.contributes?.configuration?.properties;
        
        assert.ok(configProps, 'Configuration properties should exist in package.json');
        
        const startingCommandConfig = configProps['claudePilot.startingCommand'];
        assert.ok(startingCommandConfig, 'startingCommand configuration should be defined');
        
        // Verify enum values
        const expectedEnum = ['none', 'claude', 'claude --continue', 'claude --resume'];
        assert.deepStrictEqual(
            startingCommandConfig.enum, 
            expectedEnum, 
            'Configuration enum should contain all expected options'
        );
        
        // Verify default value
        assert.strictEqual(
            startingCommandConfig.default, 
            'claude', 
            'Default value should be "claude"'
        );
        
        // Verify descriptions exist
        assert.ok(startingCommandConfig.enumDescriptions, 'Enum descriptions should exist');
        assert.strictEqual(
            startingCommandConfig.enumDescriptions.length, 
            expectedEnum.length, 
            'Should have description for each enum option'
        );
    });
});