import * as vscode from 'vscode';
import { TemplateMcpIde } from './strategy';

/** Cursor: 자체 cursor.mcp 확장 API로 서버를 등록·해제한다. */
export class CursorMcpIde extends TemplateMcpIde {
    /** Cursor 전용 MCP API(타입 정의 없음). */
    private get api(): any {
        const api = (vscode as any).cursor?.mcp;
        if (!api) throw new Error('이 Cursor 버전은 cursor.mcp API를 지원하지 않습니다.');
        return api;
    }
    /** 서버를 Cursor에 등록한다. */
    protected start(name: string, script: string, root: string): void {
        this.api.registerServer({ name, server: { command: process.execPath, args: [script, root], env: { ELECTRON_RUN_AS_NODE: '1' } } });
    }
    /** 등록된 서버를 해제한다. */
    protected stop(name: string): void { this.api.unregisterServer(name); }
}

