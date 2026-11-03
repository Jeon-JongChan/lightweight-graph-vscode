import * as vscode from 'vscode';
import * as path from 'path';

/** IDE별로 달라지는 MCP 서버 제어 방식(전략 인터페이스). */
export interface McpIdeStrategy {
    /** MCP 서버 관리 흐름을 시작한다. */
    manage(): Promise<void>;
}

/** 폴더 선택 → 동작 선택 흐름을 고정하고 IDE별 등록·해제만 하위 클래스에 맡기는 템플릿. */
export abstract class TemplateMcpIde implements McpIdeStrategy {
    constructor(protected readonly context: vscode.ExtensionContext) {}

    /** 템플릿 메서드: 공통 UI 순서는 여기서 고정한다. */
    public async manage(): Promise<void> {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
        const picked = await vscode.window.showQuickPick(
            folders.map(f => ({ label: `Lightweight Graph MCP — ${f.name}`, folder: f })), { placeHolder: 'MCP 서버 선택' });
        if (!picked) return;
        const action = await vscode.window.showQuickPick(['시작(등록)', '중지(해제)'], { placeHolder: picked.label });
        if (!action) return;
        try {
            if (action.startsWith('시작')) await this.start(picked.label, this.serverScript(), picked.folder.uri.fsPath);
            else await this.stop(picked.label);
        } catch (e) { vscode.window.showErrorMessage(`Graph MCP: ${action} 실패. ${e}`); }
    }

    /** 번들된 MCP 서버 진입 스크립트 경로. */
    protected serverScript(): string {
        return path.join(this.context.extensionPath, 'dist', 'mcp', 'server.js');
    }

    /** IDE별 서버 등록 구현. */
    protected abstract start(name: string, script: string, root: string): void | Promise<void>;
    /** IDE별 서버 해제 구현. */
    protected abstract stop(name: string): void | Promise<void>;
}

