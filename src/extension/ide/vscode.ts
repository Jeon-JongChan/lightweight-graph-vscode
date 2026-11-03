import * as vscode from 'vscode';
import { McpIdeStrategy } from './strategy';

/** VS Code: 내장 MCP 서버 목록 명령에 위임한다(시작·중지는 그 UI에서 수행). */
export class VscodeMcpIde implements McpIdeStrategy {
    /** 내장 MCP 관리 화면을 연다. */
    public async manage(): Promise<void> {
        try {
            // shortcut: 설치 버전에서 확인한 내부 명령이다. 제거되면 MCP 관리 진입 경로를 갱신한다.
            await vscode.commands.executeCommand('workbench.mcp.listServer');
        } catch (error) {
            vscode.window.showErrorMessage(`MCP 관리 화면을 열지 못했습니다. 확장 보기의 MCP 서버를 확인하세요. ${error}`);
        }
    }
}

