import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { GraphMcpServerProvider } from './mcp-provider';
import { WorkspaceManager } from './workspace';

/** 그래프 생성과 실시간 감시(Watch), MCP 관리를 상태표시줄에 등록한다. */
export function activate(context: vscode.ExtensionContext): void {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'graph-mcp.quickActions';
    statusBar.tooltip = '프로젝트 그래프 생성 / 실시간 감시(Watch) / MCP 서버 시작·중지 / Antigravity·Codex 연결 / Llama Agent';
    statusBar.accessibilityInformation = { label: 'Graph MCP 빠른 실행' };
    context.subscriptions.push(statusBar);
    const manager = new WorkspaceManager(context, statusBar);
    manager.initialize();
    context.subscriptions.push(manager);
    context.subscriptions.push(
        vscode.commands.registerCommand('graph-mcp.buildIndex', () => manager.buildIndex()),
        // 완성 후 교체하므로 재생성 전에 기존 캐시를 지울 필요가 없다.
        vscode.commands.registerCommand('graph-mcp.rebuildIndex', () => manager.buildIndex()),
        vscode.commands.registerCommand('graph-mcp.toggleWatch', () => manager.toggleWatch()),
        vscode.commands.registerCommand('graph-mcp.clearCache', () => manager.clearCache()),
        vscode.commands.registerCommand('graph-mcp.showStatus', () =>
            vscode.window.showInformationMessage(`Graph MCP 색인 상태: ${statusBar.text}`)),
        vscode.commands.registerCommand('graph-mcp.openLogs', () =>
            vscode.commands.executeCommand('workbench.action.showLogs')),
        vscode.commands.registerCommand('graph-mcp.manageMcp', async () => {
            try {
                // shortcut: 설치 버전에서 확인한 내부 명령이다. 제거되면 MCP 관리 진입 경로를 갱신한다.
                await vscode.commands.executeCommand('workbench.mcp.listServer');
            } catch (error) {
                vscode.window.showErrorMessage(`MCP 관리 화면을 열지 못했습니다. 확장 보기의 MCP 서버를 확인하세요. ${error}`);
            }
        }),
        vscode.commands.registerCommand('graph-mcp.setupAgents', async () => {
            const scriptPath = path.join(context.extensionPath, 'tools', 'config-graph-mcp.ps1');
            await new Promise<void>((resolve, reject) => {
                execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action', 'Setup'],
                    (err) => err ? reject(err) : resolve());
            });
            vscode.window.showInformationMessage('Graph MCP: Antigravity · Codex 전역 MCP 서버 및 스킬 등록을 완료했습니다.');
        }),
        vscode.commands.registerCommand('graph-mcp.quickActions', async () => {
            const watching = manager.isWatching();
            const selected = await vscode.window.showQuickPick([
                { label: '$(type-hierarchy) 현재 프로젝트 그래프 생성·갱신', command: 'graph-mcp.buildIndex' },
                { label: '$(server) MCP 서버 시작·중지', description: 'Lightweight Graph MCP 선택 → 시작 또는 중지', command: 'graph-mcp.manageMcp' },
                {
                    label: watching ? '$(eye-closed) 실시간 감시(Watch) 중지' : '$(eye) 실시간 감시(Watch) 시작',
                    description: watching ? '현재 감시 중 · 클릭하면 자동 갱신을 중지합니다' : '파일 변경 시 디바운스 후 코드 그래프 자동 갱신 (Graphify Watch)',
                    command: 'graph-mcp.toggleWatch'
                },
                { label: '$(comment-discussion) Llama Agent 열기', command: 'extension.showLlamaWebview' },
                { label: '$(plug) Antigravity · Codex 전역 MCP/스킬 연결', description: '언제든 바로 쓸 수 있도록 전역 설정 자동 등록', command: 'graph-mcp.setupAgents' }
            ], { placeHolder: 'Graph MCP 빠른 실행' });
            if (!selected) return;
            try {
                if (selected.command === 'extension.showLlamaWebview' &&
                    !vscode.extensions.getExtension('ggml-org.llama-vscode')) {
                    throw new Error('llama.vscode 확장을 먼저 설치하세요.');
                }
                await vscode.commands.executeCommand(selected.command);
            } catch (error) { vscode.window.showErrorMessage(`Graph MCP: 실행 실패. ${error}`); }
        })
    );
    try {
        if (vscode.lm?.registerMcpServerDefinitionProvider) {
            const provider = new GraphMcpServerProvider(context);
            context.subscriptions.push(provider,
                vscode.lm.registerMcpServerDefinitionProvider('lightweight-graph-mcp', provider));
        } else { vscode.window.showWarningMessage('Graph MCP: MCP 지원 버전으로 VS Code를 업데이트하세요.'); }
    } catch (error) {
        // MCP 등록 실패가 독립적인 그래프 생성 메뉴까지 비활성화하지 않게 한다.
        vscode.window.showErrorMessage(`Graph MCP: MCP 등록 실패. 그래프 생성 메뉴는 사용할 수 있습니다. ${error}`);
    }
}
/** 구독한 자원은 VS Code가 자동으로 정리한다. */
export function deactivate(): void {}
