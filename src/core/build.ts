import * as fs from 'fs';
import * as path from 'path';
import { GraphIndex } from '../storage/index';
import { GraphCache } from '../storage/cache';
import { DEFAULT_EXCLUDED_FOLDERS, MAX_FILE_SIZE_BYTES } from '../common/config';
import { CodeParser } from './parser';
import { writeGraphExport } from '../storage/export';

/** 실시간 감시(Watch) 동작 옵션이다. */
export interface WatchOptions {
    debounceMs?: number;
    onRebuildStart?: (changedFiles: string[]) => void;
    onRebuildDone?: (result: Awaited<ReturnType<typeof buildProjectIndex>>) => void;
    onRebuildError?: (error: unknown) => void;
}

/** 잠금 파일에 기록된 소유 프로세스가 현재 살아있는지 확인한다. */
function isLockOwnerAlive(lockPath: string): boolean {
    try {
        const raw = fs.readFileSync(lockPath, 'utf8').trim();
        const pid = Number(raw);
        if (!raw || !Number.isInteger(pid) || pid <= 0) {
            // 방금 생성되어 PID를 기록 중인 잠금은 최근 5초 이내면 활성 상태로 본다.
            return Date.now() - fs.statSync(lockPath).mtimeMs < 5000;
        }
        if (pid === process.pid) return true;
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** 확장과 MCP가 같은 프로젝트의 캐시를 동시에 쓰지 못하게 하며 죽은 프로세스의 잔류 잠금은 자동 복구한다. */
export async function withIndexLock<T>(root: string, action: () => Promise<T>): Promise<T> {
    if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory()) {
        throw new Error('색인 대상은 존재하는 프로젝트의 절대 경로여야 합니다.');
    }
    // 산출물 디렉터리의 링크를 이용해 프로젝트 밖에 쓰는 것을 막는다.
    for (const target of [path.join(root, '.tools'), path.join(root, '.tools', '.graphify')]) {
        if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
            throw new Error(`산출물 경로에 심볼릭 링크를 사용할 수 없습니다: ${target}`);
        }
    }
    const directory = path.dirname(new GraphCache(root).getCachePath());
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, 'index.lock');
    let lock: number;
    try {
        lock = fs.openSync(lockPath, 'wx');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            if (!isLockOwnerAlive(lockPath)) {
                try { fs.unlinkSync(lockPath); } catch { /* 경쟁 삭제 무시 */ }
                try {
                    lock = fs.openSync(lockPath, 'wx');
                } catch {
                    throw new Error(`이미 그래프를 생성 중입니다. 비정상 종료 후라면 잠금을 확인하세요: ${lockPath}`);
                }
            } else {
                throw new Error(`이미 그래프를 생성 중입니다. 비정상 종료 후라면 잠금을 확인하세요: ${lockPath}`);
            }
        } else {
            throw error;
        }
    }
    try {
        fs.writeSync(lock, String(process.pid));
        return await action();
    } finally {
        fs.closeSync(lock);
        try { fs.unlinkSync(lockPath); } catch { /* 정리 완료 */ }
    }
}

/** 지원 파일만 순회하여 새 스냅샷을 만들고 성공한 결과를 저장한다. */
export async function buildProjectIndex(root: string, extensionPath: string) {
    if (!path.isAbsolute(root)) throw new Error('프로젝트 절대 경로가 필요합니다.');
    root = fs.realpathSync(root);
    return withIndexLock(root, async () => {
        const index = new GraphIndex(root, extensionPath);
        await index.initialize(false);
        let filesIndexed = 0;
        let filesSkipped = 0;

        /** 심볼릭 링크를 따라 프로젝트 밖으로 나가지 않고 파일을 색인한다. */
        async function visit(directory: string): Promise<void> {
            const entries = await fs.promises.readdir(directory, { withFileTypes: true });
            for (const entry of entries) {
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (!DEFAULT_EXCLUDED_FOLDERS.includes(entry.name)) await visit(file);
                } else if (entry.isFile() && CodeParser.getLanguageFromFile(file)) {
                    const stat = await fs.promises.stat(file);
                    if (stat.size > MAX_FILE_SIZE_BYTES) {
                        filesSkipped++;
                        continue;
                    }
                    await index.updateFile(file, true);
                    filesIndexed++;
                    // 확장 호스트 응답성을 유지하면서 파일마다 이벤트 루프를 양보하는 오버헤드를 줄인다.
                    if (filesIndexed % 25 === 0) {
                        await new Promise(resolve => setImmediate(resolve));
                    }
                }
            }
        }

        try {
            await visit(root);
            // 전체 심볼이 모인 뒤 해석해야 순회 순서가 외부 호출 대상을 결정하지 않는다.
            index.resolveRelations();
            const data = index.getGraphData();
            const parseErrorFiles = index.getParseErrorFiles();
            const exports = await writeGraphExport(root, data, parseErrorFiles.length);
            await index.saveCache();
            return {
                workspaceRoot: root,
                cachePath: new GraphCache(root).getCachePath(),
                filesIndexed,
                filesSkipped,
                parseErrorFiles,
                symbolsCount: Object.keys(data.symbols).length,
                relationsCount: Object.keys(data.relations).length,
                ...exports
            };
        } finally {
            index.dispose();
        }
    });
}

/** Graphify Watch와 동일하게 소스 파일 변경을 디바운스 감시하고 코드 그래프를 자동 갱신한다. */
export class ProjectWatcher {
    private fsWatcher: fs.FSWatcher | null = null;
    private timer: NodeJS.Timeout | null = null;
    private changedFiles = new Set<string>();
    private active = false;
    private building = false;
    private pendingRebuild = false;
    private currentRun: Promise<void> | null = null;
    private readonly debounceMs: number;
    private readonly realRoot: string;

    /** 감시할 프로젝트 루트와 확장 자산 경로, 디바운스 옵션을 설정한다. */
    constructor(root: string, private readonly extensionPath: string, private readonly options: WatchOptions = {}) {
        this.realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
        this.debounceMs = options.debounceMs ?? 2500;
    }

    /** 색인 제외 경로를 걸러내고 소스·폴더·삭제된 경로의 변경을 판별한다. */
    public shouldTrackFile(filePath: string): boolean {
        const resolved = path.resolve(filePath);
        const rel = path.relative(this.realRoot, resolved);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
        const parts = rel.split(path.sep);
        if (parts.some(part => DEFAULT_EXCLUDED_FOLDERS.includes(part))) {
            return false;
        }
        if (CodeParser.getLanguageFromFile(resolved)) return true;
        try {
            return fs.lstatSync(resolved).isDirectory();
        } catch (error) {
            // 삭제·이름 변경 뒤에는 확장자로 폴더를 구별할 수 없으므로 재색인한다.
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
    }

    /** 파일 시스템 감시를 시작한다. */
    public start(): void {
        if (this.active) return;
        this.active = true;
        try {
            this.fsWatcher = fs.watch(this.realRoot, { recursive: true }, (_event, filename) => {
                if (!filename) return;
                this.notifyFileChanged(path.join(this.realRoot, filename.toString()));
            });
            this.fsWatcher.on('error', err => this.options.onRebuildError?.(err));
        } catch {
            // fs.watch recursive 미지원 환경에서는 외부 이벤트(notifyFileChanged)로 동작한다.
        }
    }

    /** 단일 파일 변경 이벤트를 등록하고 디바운스 타이머를 재설정한다. */
    public notifyFileChanged(filePath: string): void {
        if (!this.active || !this.shouldTrackFile(filePath)) return;
        this.changedFiles.add(path.resolve(filePath));
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.currentRun = this.runRebuildLoop();
        }, this.debounceMs);
    }

    /** 진행 중인 생성과 대기 중인 변경 사항을 순차 처리한다. */
    private async runRebuildLoop(): Promise<void> {
        if (this.building) {
            this.pendingRebuild = true;
            return;
        }
        this.building = true;
        try {
            do {
                this.pendingRebuild = false;
                const batch = [...this.changedFiles];
                this.changedFiles.clear();
                if (!this.active) break;
                this.options.onRebuildStart?.(batch);
                try {
                    const result = await buildProjectIndex(this.realRoot, this.extensionPath);
                    this.options.onRebuildDone?.(result);
                } catch (error) {
                    // 수동 빌드나 외부 MCP가 잠금을 보유 중이면 오류 대신 다음 디바운스 주기로 재예약한다.
                    if (this.active && error instanceof Error && error.message.includes('이미 그래프를 생성 중입니다')) {
                        for (const file of batch) this.changedFiles.add(file);
                        if (!this.timer) {
                            this.timer = setTimeout(() => {
                                this.timer = null;
                                this.currentRun = this.runRebuildLoop();
                            }, this.debounceMs);
                        }
                        this.options.onRebuildError?.(error);
                        break;
                    }
                    this.options.onRebuildError?.(error);
                }
            } while (this.pendingRebuild && this.active);
        } finally {
            this.building = false;
            this.currentRun = null;
        }
    }

    /** 수동 빌드나 캐시 초기화 전에 예약된 디바운스 갱신을 취소한다. */
    public cancelPending(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.changedFiles.clear();
        this.pendingRebuild = false;
    }

    /** 예약된 디바운스 타이머와 실행 중인 그래프 갱신이 모두 끝날 때까지 대기한다. */
    public async waitForIdle(): Promise<void> {
        while (this.timer || this.building || this.currentRun) {
            if (this.currentRun) {
                await this.currentRun;
            } else {
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
    }

    /** 현재 감시 활성화 여부를 반환한다. */
    public isWatching(): boolean {
        return this.active;
    }

    /** 감시 중인 프로젝트 루트 경로를 반환한다. */
    public getRoot(): string {
        return this.realRoot;
    }

    /** 타이머와 파일 감시 자원을 정리하고 감시를 중지한다. */
    public stop(): void {
        this.active = false;
        this.cancelPending();
        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = null;
        }
    }
}
