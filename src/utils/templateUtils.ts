/**
 * Template utilities for generating webview HTML with embedded resources.
 * Handles xterm.js integration and VS Code theme compatibility.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { createWebviewLogger } from './logger';

export class TemplateUtils {
    public static getHtmlTemplate(
        extensionUri: vscode.Uri, 
        webview: vscode.Webview, 
        timestamp: number
    ): string {
        // Read webview scripts from src directory
        const srcDir = path.join(__dirname, '..', '..', 'src');
        
        // Load and inline the imported classes first
        const inputHandlerScript = fs.readFileSync(path.join(srcDir, 'webview', 'inputHandler.js'), 'utf8')
            .replace('export class InputHandler', 'class InputHandler');
        const indicatorManagerScript = fs.readFileSync(path.join(srcDir, 'webview', 'indicatorManager.js'), 'utf8')
            .replace('export class IndicatorManager', 'class IndicatorManager');
        
        // Load main scripts and remove import statements
        const terminalScript = fs.readFileSync(path.join(srcDir, 'webview', 'terminal.js'), 'utf8')
            .replace(/^import.*from.*;\s*$/gm, ''); // Remove import lines
        const tabManagerScript = `${fs.readFileSync(path.join(srcDir, 'webview', 'tabManager.js'), 'utf8')}`;
        const dragDropHandlerScript = `${fs.readFileSync(path.join(srcDir, 'webview', 'dragDropHandler.js'), 'utf8')}`;
        
        // Helper to create webview URIs for node_modules files
        const getNodeModuleUri = (packagePath: string) => 
            webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', ...packagePath.split('/')));

        // Convert all node_modules resources to webview URIs
        const webviewUri = webview.asWebviewUri(extensionUri).toString().replace(/\/$/, '') + '/*';
        const codiconCssUri = getNodeModuleUri('@vscode/codicons/dist/codicon.css');
        const xtermUri = getNodeModuleUri('@xterm/xterm/lib/xterm.js');
        const xtermCssUri = getNodeModuleUri('@xterm/xterm/css/xterm.css');
        const fitAddonUri = getNodeModuleUri('@xterm/addon-fit/lib/addon-fit.js');
        const webglAddonUri = getNodeModuleUri('@xterm/addon-webgl/lib/addon-webgl.js');
        const canvasAddonUri = getNodeModuleUri('@xterm/addon-canvas/lib/addon-canvas.js');
        const webLinksAddonUri = getNodeModuleUri('@xterm/addon-web-links/lib/addon-web-links.js');
        const serializeAddonUri = getNodeModuleUri('@xterm/addon-serialize/lib/addon-serialize.js');
        const unicodeAddonUri = getNodeModuleUri('@xterm/addon-unicode11/lib/addon-unicode11.js');
        const linkProviderUri = getNodeModuleUri('xterm-link-provider/lib/cjs/index.js');

        // Get extension version for display
        const packagePath = path.join(__dirname, '..', '..', 'package.json');
        let version = '0.0.0';
        try {
            const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            version = packageJson.version || '0.0.0';
        } catch (error) {
            console.warn('Could not read package.json version:', error);
        }

        // Load initialization script
        const initScript = this.loadInitScript(extensionUri);

        // Combine scripts with logger
        const combinedScript = [
            createWebviewLogger(),
            inputHandlerScript,      // Load classes first
            indicatorManagerScript,
            terminalScript,
            tabManagerScript, 
            dragDropHandlerScript,
            initScript
        ].join('\n\n');

        // Read HTML template from file and interpolate variables
        const templatePath = path.join(srcDir, 'templates', 'webview.html');
        let htmlTemplate = fs.readFileSync(templatePath, 'utf8');

        // Simple template interpolation - replace {{variableName}} with actual values
        const templateVars = {
            timestamp,
            webviewUri,
            codiconCssUri,
            xtermCssUri,
            version,
            xtermUri,
            fitAddonUri,
            webglAddonUri,
            canvasAddonUri,
            webLinksAddonUri,
            serializeAddonUri,
            unicodeAddonUri,
            linkProviderUri,
            combinedScript
        };

        // Replace all template variables
        for (const [key, value] of Object.entries(templateVars)) {
            const placeholder = `{{${key}}}`;
            const stringValue = value.toString(); // Convert URI objects to strings
            htmlTemplate = htmlTemplate.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), stringValue);
        }

        return htmlTemplate;
    }

    private static loadInitScript(extensionUri: vscode.Uri): string {
        try {
            const initScriptPath = path.join(extensionUri.fsPath, 'src', 'webview', 'init.js');
            return fs.readFileSync(initScriptPath, 'utf8');
        } catch (error) {
            console.error('Failed to load init script:', error);
            // Fallback to basic initialization
            return `
                Logger.error('Failed to load initialization script');
                Logger.info('🚀 Starting Alterminal initialization (fallback)');
            `;
        }
    }
}