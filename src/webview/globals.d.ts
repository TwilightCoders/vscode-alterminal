// Global type declarations for webview environment

declare const vscode: VSCodeAPI;
declare const Logger: any;
declare const Terminal: any;
declare const FitAddon: any;
declare const CanvasAddon: any;
declare const WebLinksAddon: any;
declare const SerializeAddon: any;
declare const UnicodeAddon: any;
declare const WebglAddon: any;
declare const WebgpuAddon: any;
// VS Code webview API
interface VSCodeAPI {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

// Window extensions for webview globals
interface Window {
    Terminal?: any;
    scrollbackLines?: number;
    tabManager?: any;
    dragDropHandler?: any;
    linkModeState?: {
        isCmdPressed: boolean;
        isCtrlPressed: boolean;
    };
    workspaceFileCache?: Set<string>;
    DEVELOPER_MODE?: boolean;
    __terminalPerf?: {
        samples: any[];
    };
    vscode: VSCodeAPI;
    LinkProvider: any;
}
