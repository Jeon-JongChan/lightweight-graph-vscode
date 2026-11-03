import * as vscode from 'vscode';
import { McpIdeStrategy } from './strategy';
import { VscodeMcpIde } from './vscode';
import { CursorMcpIde } from './cursor';

/** 파사드: 실행 중인 IDE에 맞는 전략을 골라 MCP 관리를 시작한다. 이 폴더를 지우려면 호출부 한 줄만 바꾸면 된다. */
export function manageMcp(context: vscode.ExtensionContext): Promise<void> {
    const strategy: McpIdeStrategy = /cursor/i.test(vscode.env.appName)
        ? new CursorMcpIde(context) : new VscodeMcpIde();
    return strategy.manage();
}

