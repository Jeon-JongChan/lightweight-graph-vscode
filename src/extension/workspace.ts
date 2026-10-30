import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildProjectIndex, ProjectWatcher, withIndexLock } from '../core/build';
import { GraphCache } from '../storage/cache';

/** 선택한 프로젝트의 그래프 생성과 실시간 감시(Watch)를 관리한다. */
export class WorkspaceManager {
    private busy = false;
    // Watch 갱신이 수동 작업의 busy를 해제하지 않도록 별도로 추적한다.
    private watchBuilding = false;
    private watcher: ProjectWatcher | null = null;
    private lastState = '그래프 생성';
    private readonly subscriptions: vscode.Disposable[] = [];

    /** 상태표시줄과 확장 자산 경로를 보관한다. */
    constructor(private context: vscode.ExtensionContext, private statusBar: vscode.StatusBarItem) {}

    /** 기존 캐시 유무를 반영해 상태를 표시하고 VS Code 문서·폴더 이벤트를 연결한다. */
    public initialize(): void {
        const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
        if (folders.some(f => fs.existsSync(new GraphCache(f.uri.fsPath).getCachePath()))) {
            this.lastState = '준비';
        }
        this.updateStatus(this.lastState);

        // fs.watch recursive 미지원 환경(Linux·WSL·원격)에서도 VS Code 편집기 이벤트를 Watch에 전달한다.
        this.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.scheme === 'file') this.watcher?.notifyFileChanged(doc.uri.fsPath);
            }),
            vscode.workspace.onDidCreateFiles(event => {
                for (const uri of event.files) {
                    if (uri.scheme === 'file') this.watcher?.notifyFileChanged(uri.fsPath);
                }
            }),
            vscode.workspace.onDidDeleteFiles(event => {
                for (const uri of event.files) {
                    if (uri.scheme === 'file') this.watcher?.notifyFileChanged(uri.fsPath);
                }
            }),
            vscode.workspace.onDidRenameFiles(event => {
                for (const { oldUri, newUri } of event.files) {
                    if (oldUri.scheme === 'file') this.watcher?.notifyFileChanged(oldUri.fsPath);
                    if (newUri.scheme === 'file') this.watcher?.notifyFileChanged(newUri.fsPath);
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                if (!this.watcher?.isWatching()) return;
                const watchedRoot = this.watcher.getRoot();
                const activeRoots = (vscode.workspace.workspaceFolders ?? [])
                    .filter(f => f.uri.scheme === 'file')
                    .map(f => fs.existsSync(f.uri.fsPath) ? fs.realpathSync(f.uri.fsPath) : path.resolve(f.uri.fsPath));
                if (!activeRoots.includes(watchedRoot)) {
                    this.watcher.stop();
                    this.watcher = null;
                    this.updateStatus(this.lastState);
                }
            })
        );
    }

    /** 활성 편집기의 루트를 우선 선택하고 다중 프로젝트에서는 선택을 받는다. */
    private async selectRoot(): Promise<string | undefined> {
        if (!vscode.workspace.isTrusted) throw new Error('신뢰한 작업 영역에서 그래프를 생성하세요.');
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (!folders.length) throw new Error('먼저 분석할 프로젝트 폴더를 여세요.');
        const editor = vscode.window.activeTextEditor;
        const active = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
        const folder = active ?? (folders.length === 1 ? folders[0] :
            await vscode.window.showQuickPick(folders.map(folder => ({
                label: folder.name, description: folder.uri.fsPath, folder
            })), { placeHolder: '그래프를 생성·감시할 프로젝트 선택' }).then(item => item?.folder));
        if (folder && folder.uri.scheme !== 'file') throw new Error('로컬 파일 시스템 프로젝트만 지원합니다.');
        return folder?.uri.fsPath;
    }

    /** MCP와 생성 함수를 공유하고 중복 실행과 오류를 표시한다. */
    public async buildIndex(): Promise<void> {
        if (this.busy || this.watchBuilding) {
            vscode.window.showInformationMessage('Graph MCP: 이미 그래프를 생성 중입니다.');
            return;
        }
        this.busy = true;
        try {
            const root = await this.selectRoot();
            if (!root) return;
            this.watcher?.cancelPending();
            this.updateStatus('생성 중', true);
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Graph MCP: ${path.basename(root)} 그래프 생성`
            }, () => buildProjectIndex(root, this.context.extensionPath));
            this.lastState = result.parseErrorFiles.length ? '구문 경고' : '준비';
            this.updateStatus(this.isWatching() ? '감시 중' : this.lastState);
            const message = `Graph MCP: ${result.filesIndexed}개 파일, ${result.symbolsCount}개 심볼 생성 완료. 건너뜀 ${result.filesSkipped}개, 구문 경고 ${result.parseErrorFiles.length}개.`;
            if (result.parseErrorFiles.length) vscode.window.showWarningMessage(message);
            else vscode.window.showInformationMessage(message);
        } catch (error) {
            this.updateStatus('오류');
            vscode.window.showErrorMessage(`Graph MCP: ${error}`);
        } finally { this.busy = false; }
    }

    /** Graphify Watch와 동일하게 소스 파일 변경 시 자동으로 그래프를 갱신하는 실시간 감시를 시작·중지한다. */
    public async toggleWatch(): Promise<void> {
        try {
            if (this.watcher?.isWatching()) {
                const watchedRoot = this.watcher.getRoot();
                this.watcher.stop();
                this.watcher = null;
                this.updateStatus(this.lastState);
                vscode.window.showInformationMessage(`Graph MCP: 실시간 감시(Watch) 중지됨 (${path.basename(watchedRoot)})`);
                return;
            }
            const root = await this.selectRoot();
            if (!root) return;
            this.watcher = new ProjectWatcher(root, this.context.extensionPath, {
                debounceMs: 2500,
                onRebuildStart: () => {
                    this.watchBuilding = true;
                    this.updateStatus('갱신 중', true);
                },
                onRebuildDone: (result) => {
                    this.watchBuilding = false;
                    this.lastState = result.parseErrorFiles.length ? '구문 경고' : '준비';
                    if (this.isWatching()) this.updateStatus('감시 중');
                },
                onRebuildError: (error) => {
                    this.watchBuilding = false;
                    if (this.isWatching()) this.updateStatus('감시 중');
                    if (error instanceof Error && error.message.includes('이미 그래프를 생성 중입니다')) return;
                    vscode.window.showWarningMessage(`Graph MCP Watch 갱신 실패: ${error}`);
                }
            });
            this.watcher.start();
            this.updateStatus('감시 중');
            vscode.window.showInformationMessage(`Graph MCP: 실시간 감시(Watch) 시작됨 (${path.basename(root)} · 변경 후 2.5초 디바운스 자동 갱신)`);
        } catch (error) {
            vscode.window.showErrorMessage(`Graph MCP: 실시간 감시 전환 실패. ${error}`);
        }
    }

    /** 현재 실시간 감시(Watch) 활성화 여부를 반환한다. */
    public isWatching(): boolean {
        return Boolean(this.watcher?.isWatching());
    }

    /** 대상 경로를 먼저 보여주고 승인된 프로젝트 캐시만 초기화한다. */
    public async clearCache(): Promise<void> {
        if (this.busy || this.watchBuilding) {
            vscode.window.showInformationMessage('Graph MCP: 이미 그래프를 생성 중입니다.');
            return;
        }
        this.busy = true;
        try {
            const root = await this.selectRoot();
            if (!root) return;
            const cache = new GraphCache(root);
            const answer = await vscode.window.showWarningMessage(
                `그래프 캐시를 빈 스냅샷으로 초기화합니다: ${cache.getCachePath()}\n기존 조회 결과를 비우며 소스 파일은 변경하지 않습니다.`,
                { modal: true }, '초기화');
            if (answer !== '초기화') return;
            this.watcher?.cancelPending();
            await withIndexLock(root, () => cache.clear());
            this.lastState = '그래프 생성';
            this.updateStatus(this.isWatching() ? '감시 중' : '그래프 생성');
        } catch (error) {
            vscode.window.showErrorMessage(`Graph MCP: 캐시 초기화 실패. ${error}`);
        } finally {
            this.busy = false;
        }
    }

    /** 색인 및 Watch 감시 상태를 하단 상태표시줄 아이콘에 표시한다. */
    private updateStatus(text: string, spinning = false): void {
        const icon = spinning ? '$(sync~spin)' : text === '감시 중' ? '$(eye)' : '$(type-hierarchy)';
        this.statusBar.text = `${icon} Graph: ${text}`;
        this.statusBar.show();
    }

    /** 확장 비활성화 시 실행 중인 파일 감시기와 이벤트 구독을 정리한다. */
    public dispose(): void {
        this.watcher?.stop();
        this.watcher = null;
        for (const sub of this.subscriptions) sub.dispose();
        this.subscriptions.length = 0;
    }
}
