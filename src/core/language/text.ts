import * as path from 'path';
import { inflateSync } from 'zlib';
import { Language, Relation, SymbolInfo, SymbolKind } from '../../common/types';
import { CodeParser } from '../parser';
import { AstLanguageAnalyzer, LanguageAnalysis } from './base';
import { NodeDeclaration } from '../declarations';
/** 전용 WASM이 없는 텍스트 형식의 명시적 선언과 의존성을 보수적으로 읽는다. */
export class TextLanguageAnalyzer extends AstLanguageAnalyzer {
    public readonly caseInsensitive: boolean;
    /** 폼은 Pascal 심볼 계열과 연결하고 나머지 형식은 독립시킨다. */
    constructor(language: Language) {
        super(language, language === 'delphi_form' ? 'pascal' : language, ['vbnet', 'dreammaker'].includes(language));
        this.caseInsensitive = ['vbnet', 'cobol', 'robot', 'delphi_form'].includes(language);
    }
    /** 이 분석기는 AST 선언 훅을 사용하지 않는다. */
    public getDeclaration(_node: any): NodeDeclaration | null { return null; }
    /** 구조 분석은 원본 텍스트의 줄 단위로 관계를 생성한다. */
    protected extractNodeRelations(_node: any, _filePath: string, _receiverTypes: Map<string, string>): Relation[] { return []; }
    /** DMI PNG 메타데이터는 압축 해제 상한을 적용하고 이미지 픽셀은 읽지 않는다. */
    private dmiMetadata(content: string): string {
        const buffer = Buffer.from(content, 'latin1');
        if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new Error('DMI PNG 서명이 올바르지 않습니다.');
        for (let offset = 8; offset + 12 <= buffer.length;) {
            const length = buffer.readUInt32BE(offset);
            if (offset + length + 12 > buffer.length)
                throw new Error('DMI PNG 청크가 잘렸습니다.');
            const type = buffer.toString('ascii', offset + 4, offset + 8);
            if (type === 'tEXt' || type === 'zTXt') {
                const bytes = buffer.subarray(offset + 8, offset + 8 + length);
                const separator = bytes.indexOf(0);
                if (separator >= 0 && bytes.toString('latin1', 0, separator) === 'Description') {
                    if (type === 'tEXt')
                        return bytes.toString('utf8', separator + 1);
                    if (bytes[separator + 1] !== 0)
                        throw new Error('지원하지 않는 DMI 압축 방식입니다.');
                    return inflateSync(bytes.subarray(separator + 2), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8');
                }
            }
            offset += length + 12;
        }
        return '';
    }
    /** 선언된 블록·문단·키워드 범위 안에서만 호출과 정적 파일 참조를 추출한다. */
    public analyze(content: string, filePath: string, _parser: CodeParser): LanguageAnalysis {
        const symbols: SymbolInfo[] = [];
        const relations: Relation[] = [];
        const scopes: string[] = [];
        const source = this.language === 'dmi' ? this.dmiMetadata(content) : this.language === 'dreammaker'
            ? content.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\r\n]/g, ' ')) : content;
        const lines = source.split(/\r?\n/);
        let robotSection = '';
        let paragraph = '';
        let dmIndent = -1;
        let currentLine = 0;
        /** 원문 줄을 근거로 선언 ID와 범위를 만든다. */
        function addSymbol(name: string, kind: SymbolKind, language: Language, owner = scopes.join('::')): void {
            symbols.push({ id: `${filePath}::${owner ? owner + '::' : ''}${name}`, name, kind, filePath, language,
                range: { start: { line: currentLine, character: 0 }, end: { line: currentLine, character: lines[currentLine].length } } });
        }
        /** 원격 파일을 읽거나 코드를 실행하지 않고 명시적 의존성만 기록한다. */
        function addRelation(name: string, kind: 'import' | 'call' | 'reference', owner = scopes.join('::'), receiver?: string): void {
            const target = kind === 'import' ? path.resolve(path.dirname(filePath), name.replace(/\\/g, path.sep)) : `unknown::${name}`;
            relations.push({ id: `${filePath}::${kind}::${owner}->${name}@${currentLine}`, sourceId: kind === 'import' ? filePath : `${filePath}::${owner || 'global'}`,
                targetId: target, kind, certainty: 'EXTRACTED', ...(receiver ? { receiver } : {}), range: { start: { line: currentLine, character: 0 }, end: { line: currentLine, character: lines[currentLine].length } } });
        }
        for (currentLine = 0; currentLine < lines.length; currentLine++) {
            const raw = lines[currentLine];
            const line = raw.trim();
            if (!line)
                continue;
            if (this.language === 'sln') {
                const project = line.match(/^Project\("[^"]+"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/);
                if (project && /\.(?:[a-z]*proj|sln)$/i.test(project[2])) {
                    addSymbol(project[1], 'module', this.language);
                    addRelation(project[2], 'import');
                }
            }
            else if (this.language === 'vbnet') {
                // 문자열 안의 괄호와 주석은 호출·선언으로 오인하지 않는다.
                const code = line.replace(/"(?:""|[^"])*"/g, '""').replace(/'.*$/, '');
                if (/^End\s+(?:Module|Class|Interface|Sub|Function)\b/i.test(code)) {
                    scopes.pop();
                    continue;
                }
                const imported = code.match(/^Imports\s+(?:\w+\s*=\s*)?([\w.]+)/i);
                if (imported) {
                    relations.push({ id: `${filePath}::import::${imported[1]}@${currentLine}`, sourceId: filePath, targetId: imported[1], kind: 'import', certainty: 'EXTRACTED' });
                    continue;
                }
                const declaration = code.match(/^(?:(?:Public|Private|Protected|Friend|Shared|Partial|Async|Overrides|Overridable|MustOverride|NotInheritable)\s+)*(Module|Class|Interface|Sub|Function)\s+(\w+)/i);
                if (declaration) {
                    const kind = /Module/i.test(declaration[1]) ? 'module' : /Class|Interface/i.test(declaration[1]) ? 'class' : 'function';
                    addSymbol(declaration[2], kind, this.language);
                    scopes.push(declaration[2]);
                    continue;
                }
                for (const match of code.matchAll(/\b(?:(\w+)\.)?(\w+)\s*\(/g)) {
                    if (!/^(?:If|While|For|Select|GetType|CType)$/i.test(match[2]))
                        addRelation(match[2], 'call', undefined, match[1] ? /^Me$/i.test(match[1]) ? 'this' : 'member' : undefined);
                }
            }
            else if (this.language === 'cobol') {
                if (raw[6] === '*' || raw[6] === '/')
                    continue;
                const code = (/^[\d ]{6}/.test(raw) ? raw.slice(6) : raw).replace(/\*>.*$/, '').trim();
                const program = code.match(/^PROGRAM-ID\.\s+([\w-]+)/i);
                if (program) {
                    addSymbol(program[1], 'module', this.language, '');
                    continue;
                }
                const label = code.match(/^([\w-]+)\.(?:\s*)$/);
                if (label && !/^(?:CONTINUE|EXIT|GOBACK|STOP|END-PERFORM|END-IF)$/i.test(label[1])) {
                    paragraph = label[1];
                    addSymbol(paragraph, 'function', this.language, '');
                    continue;
                }
                for (const match of code.matchAll(/\b(?:PERFORM|CALL)\s+['"]?([\w-]+)/gi)) {
                    if (!/^(?:UNTIL|VARYING|WITH|TEST|TIMES)$/i.test(match[1]))
                        addRelation(match[1], 'call', paragraph);
                }
                const copy = code.match(/^COPY\s+['"]?([\w./\\-]+)/i);
                if (copy)
                    addRelation(copy[1].replace(/\.$/, ''), 'import');
            }
            else if (this.language === 'dreammaker') {
                if (line.startsWith('//'))
                    continue;
                const include = line.match(/^#include\s+"([^"]+)"/);
                if (include) {
                    addRelation(include[1], 'import');
                    continue;
                }
                const definition = line.match(/^(\/?(?:\w+\/)*)(\w+)\s*\([^)]*\)\s*$/);
                if (definition && (definition[1] || !/^\s/.test(raw))) {
                    if (definition[1].startsWith('/')) {
                        scopes.length = 0;
                        const owner = definition[1].replace(/\/?proc\/$/, '').replace(/\/$/, '');
                        if (owner)
                            scopes.push(owner);
                    }
                    else if (scopes.length > 1)
                        scopes.pop();
                    addSymbol(definition[2], 'function', this.language);
                    scopes.push(definition[2]);
                    dmIndent = raw.search(/\S/);
                    continue;
                }
                const type = line.match(/^(\/[\w/]+)$/);
                if (type) {
                    scopes.length = 0;
                    addSymbol(type[1], 'class', this.language);
                    continue;
                }
                if (scopes.length && raw.search(/\S/) <= dmIndent)
                    scopes.length = 0;
                const form = line.match(/^(window|elem|macro|menu)\s+"([^"]+)"/);
                if (form) {
                    if (form[1] === 'window')
                        scopes.length = 0;
                    addSymbol(form[2], 'module', this.language);
                    if (form[1] === 'window')
                        scopes.push(form[2]);
                    continue;
                }
                const tile = line.match(/^"([^"]+)"\s*=\s*\(/);
                if (tile)
                    addSymbol(`mapkey:${tile[1]}`, 'variable', this.language);
                if (tile) {
                    for (const match of line.matchAll(/\/\w+(?:\/\w+)*/g))
                        addRelation(match[0], 'reference', `mapkey:${tile[1]}`);
                    continue;
                }
                const code = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').replace(/\/\/.*$/, '');
                for (const match of code.matchAll(/\b(\w+)\s*\(/g))
                    if (!/^(?:if|for|while|switch|return|list)$/.test(match[1]))
                        addRelation(match[1], 'call');
            }
            else if (this.language === 'robot') {
                if (line.startsWith('#'))
                    continue;
                const section = line.match(/^\*{3}\s*(.*?)\s*\*{3}$/);
                if (section) {
                    robotSection = section[1].toLowerCase();
                    scopes.length = 0;
                    continue;
                }
                const cells = raw.trim().split(/\t+| {2,}/);
                if (robotSection === 'settings' && /^(?:Resource|Library|Variables)$/i.test(cells[0]) && cells[1])
                    addRelation(cells[1], 'import');
                else if (['keywords', 'test cases', 'tasks'].includes(robotSection)) {
                    if (!/^\s/.test(raw)) {
                        scopes.length = 0;
                        addSymbol(cells[0], 'function', this.language);
                        scopes.push(cells[0]);
                    }
                    else if (!/^(?:\[|\.{3}|#|\$|IF\b|END\b|FOR\b)/.test(cells[0]))
                        addRelation(cells[0], 'call');
                }
            }
            else if (this.language === 'delphi_form') {
                const component = line.match(/^(?:object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/i);
                if (component) {
                    addSymbol(component[1], 'class', this.language);
                    scopes.push(component[1]);
                }
                else if (/^end\b/i.test(line))
                    scopes.pop();
                else {
                    const event = line.match(/^On\w+\s*=\s*(\w+)$/);
                    if (event)
                        addRelation(event[1], 'reference');
                }
            }
            else if (this.language === 'dmi') {
                const state = line.match(/^state\s*=\s*"([^"]*)"/);
                if (state)
                    addSymbol(state[1], 'variable', this.language);
            }
            else if (this.language === 'lua' && !line.startsWith('#') && /\.(?:lua|xml)$/i.test(line)) {
                addRelation(line, 'import');
            }
        }
        // shortcut: 텍스트 전략은 동적 디스패치와 전체 문법 검증을 제공하지 않는다. 전용 WASM 확보 시 교체한다.
        return { symbols, relations, hasError: ['vbnet', 'cobol', 'dreammaker', 'robot'].includes(this.language) };
    }
}
