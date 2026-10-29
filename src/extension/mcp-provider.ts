import * as vscode from 'vscode';
import * as path from 'path';

/** 로컬 프로젝트마다 독립적인 MCP 서버 정의를 제공한다. */
export class GraphMcpServerProvider implements vscode.McpServerDefinitionProvider {
    private readonly changed = new vscode.EventEmitter<void>();
    public readonly onDidChangeMcpServerDefinitions = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    /** 폴더와 신뢰 상태 변경 시 서버 정의를 다시 알린다. */
    constructor(private readonly context: vscode.ExtensionContext) {
        this.subscriptions = [
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire()),
            vscode.workspace.onDidGrantWorkspaceTrust(() => this.changed.fire())
        ];
    }
    /** 서버에 고정된 루트만 전달하여 임의 폴더 색인을 막는다. */
    public provideMcpServerDefinitions(): vscode.McpServerDefinition[] {
        if (!vscode.workspace.isTrusted) return [];
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
        const script = path.join(this.context.extensionPath, 'dist', 'mcp', 'server.js');
        return folders.map(folder => new vscode.McpStdioServerDefinition(
            folders.length === 1 ? 'Lightweight Graph MCP' : `Lightweight Graph MCP — ${folder.name}`,
            process.execPath, [script, folder.uri.fsPath], { ELECTRON_RUN_AS_NODE: '1' }, '1.0.1'));
    }
    /** 이벤트 구독과 emitter를 해제한다. */
    public dispose(): void {
        for (const subscription of this.subscriptions) subscription.dispose();
        this.changed.dispose();
    }
}
