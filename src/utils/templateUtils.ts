/**
 * Template utilities for generating webview HTML with embedded resources.
 * Handles xterm.js integration and VS Code theme compatibility.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { createWebviewLogger } from "./logger";
import { getVersion } from "../version";

export class TemplateUtils {
  public static getHtmlTemplate(
    extensionUri: vscode.Uri,
    webview: vscode.Webview,
    timestamp: number,
  ): string {
    // Get webview URIs for compiled ES6 modules (separate output dir)
    const webviewOutDir = path.join(__dirname, "..", "..", "out-webview");
    const getWebviewScriptUri = (scriptPath: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(vscode.Uri.file(webviewOutDir), "webview", scriptPath),
      );

    // Helper to create webview URIs for node_modules files
    const getNodeModuleUri = (packagePath: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(
          extensionUri,
          "node_modules",
          ...packagePath.split("/"),
        ),
      );

    // Convert all node_modules resources to webview URIs
    const webviewUri =
      webview.asWebviewUri(extensionUri).toString().replace(/\/$/, "") + "/*";
    const codiconCssUri = getNodeModuleUri("@vscode/codicons/dist/codicon.css");
    const xtermUri = getNodeModuleUri("@xterm/xterm/lib/xterm.js");
    const xtermCssUri = getNodeModuleUri("@xterm/xterm/css/xterm.css");
    const fitAddonUri = getNodeModuleUri("@xterm/addon-fit/lib/addon-fit.js");
    const webglAddonUri = getNodeModuleUri(
      "@xterm/addon-webgl/lib/addon-webgl.js",
    );
    const webLinksAddonUri = getNodeModuleUri(
      "@xterm/addon-web-links/lib/addon-web-links.js",
    );
    const serializeAddonUri = getNodeModuleUri(
      "@xterm/addon-serialize/lib/addon-serialize.js",
    );
    const unicodeAddonUri = getNodeModuleUri(
      "@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js",
    );
    const searchAddonUri = getNodeModuleUri(
      "@xterm/addon-search/lib/addon-search.js",
    );
    const linkProviderUri = getNodeModuleUri(
      "xterm-link-provider/lib/esm/index.js",
    );
    // WebGPU renderer addon — vendored as an IIFE bundle (window.WebgpuAddon),
    // loaded like the other addons. Lives in-tree under lib/, not node_modules.
    const webgpuAddonUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "lib", "xterm-addon-webgpu", "dist", "webgpu-addon.umd.js"),
    );

    // Extension version for display (single source of truth in ../version).
    const version = getVersion();

    // Shared constants module (ES6 version for webview import map)
    const constantsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(webviewOutDir), "constants.js"),
    );
    const inputHandlerUri = getWebviewScriptUri("inputHandler.js");
    const tabTitleManagerUri = getWebviewScriptUri("tabTitleManager.js");
    const terminalUri = getWebviewScriptUri("terminal.js");
    const messageHandlerUri = getWebviewScriptUri("messageHandler.js");
    const keyboardManagerUri = getWebviewScriptUri("keyboardManager.js");
    const tabUIManagerUri = getWebviewScriptUri("tabUIManager.js");
    const layoutManagerUri = getWebviewScriptUri("layoutManager.js");
    const tabManagerUri = getWebviewScriptUri("tabManager.js");
    const dragDropHandlerUri = getWebviewScriptUri("dragDropHandler.js");
    const initUri = getWebviewScriptUri("init.js");

    // Renderer selection. "webgl" (default) loads the GPU addon; "dom" skips
    // it and uses xterm's built-in DOM renderer (no glyph atlas — useful for
    // diagnosing atlas artifacts or for GPU-troubled machines).
    const rendererSetting = vscode.workspace
      .getConfiguration("alterminal")
      .get<string>("renderer", "webgl");
    const rendererMode =
      rendererSetting === "dom" || rendererSetting === "webgpu" ? rendererSetting : "webgl";

    // Create logger script inline (no import needed)
    const combinedScript = createWebviewLogger();

    // Read HTML template from file and interpolate variables.
    // Try multiple locations to support both dev and packaged installs.
    const candidateTemplatePaths = [
      // Dev: run from source
      path.join(__dirname, "..", "..", "src", "templates", "webview.html"),
      // Packaged: src included in vsix due to .vscodeignore exception
      path.join(extensionUri.fsPath, "src", "templates", "webview.html"),
      // Fallback: if we ever move it to out/templates
      path.join(__dirname, "..", "templates", "webview.html"),
    ];

    let htmlTemplate: string | null = null;
    for (const p of candidateTemplatePaths) {
      try {
        if (fs.existsSync(p)) {
          htmlTemplate = fs.readFileSync(p, "utf8");
          break;
        }
      } catch {}
    }

    if (!htmlTemplate) {
      throw new Error(
        `Webview template not found in any known location. Tried: \n${candidateTemplatePaths.join(
          "\n",
        )}`,
      );
    }

    // Simple template interpolation - replace {{variableName}} with actual values
    const templateVars = {
      timestamp,
      webviewUri,
      codiconCssUri,
      xtermCssUri,
      version,
      rendererMode,
      xtermUri,
      fitAddonUri,
      webglAddonUri,
      webLinksAddonUri,
      serializeAddonUri,
      unicodeAddonUri,
      searchAddonUri,
      webgpuAddonUri,
      linkProviderUri,
      combinedScript,
      // ES6 module URIs for import map
      constantsUri,
      inputHandlerUri,
      tabTitleManagerUri,
      terminalUri,
      messageHandlerUri,
      keyboardManagerUri,
      tabUIManagerUri,
      layoutManagerUri,
      tabManagerUri,
      dragDropHandlerUri,
      initUri,
    };

    // Replace all template variables
    for (const [key, value] of Object.entries(templateVars)) {
      const placeholder = `{{${key}}}`;
      const stringValue = value.toString(); // Convert URI objects to strings
      htmlTemplate = htmlTemplate.replace(
        new RegExp(placeholder.replace(/[{}]/g, "\\$&"), "g"),
        stringValue,
      );
    }

    return htmlTemplate;
  }

}
