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
        // Get webview URIs for compiled ES6 modules
        const outDir = path.join(__dirname, '..');
        const getWebviewScriptUri = (scriptPath: string) => 
            webview.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(outDir), 'webview', scriptPath));
        
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
        const linkProviderUri = getNodeModuleUri('xterm-link-provider/lib/esm/index.js');

        // Get extension version for display
        const packagePath = path.join(__dirname, '..', '..', 'package.json');
        let version = '0.0.0';
        try {
            const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            version = packageJson.version || '0.0.0';
        } catch (error) {
            console.warn('Could not read package.json version:', error);
        }


        // Get ES6 module URIs
        const inputHandlerUri = getWebviewScriptUri('inputHandler.js');
        const tabTitleManagerUri = getWebviewScriptUri('tabTitleManager.js'); 
        const terminalUri = getWebviewScriptUri('terminal.js');
        const tabManagerUri = getWebviewScriptUri('tabManager.js');
        const dragDropHandlerUri = getWebviewScriptUri('dragDropHandler.js');
        const initUri = getWebviewScriptUri('init.js');
        
        // Create logger script inline (no import needed)
        const combinedScript = createWebviewLogger();

        // Read HTML template from file and interpolate variables (from src, not compiled)
        const srcDir = path.join(__dirname, '..', '..', 'src');
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
            combinedScript,
            // ES6 module URIs for import map
            inputHandlerUri,
            tabTitleManagerUri,
            terminalUri,
            tabManagerUri,
            dragDropHandlerUri,
            initUri
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
            const initScriptPath = path.join(extensionUri.fsPath, 'out', 'webview', 'init.js');
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