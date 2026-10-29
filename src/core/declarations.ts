import * as path from 'path';
import { Range, SymbolKind } from '../common/types';
/** 언어 전략이 발견한 선언의 최소 정보다. */
export interface NodeDeclaration {
    name: string;
    kind: SymbolKind;
}
/** 선언·호출자 추출에 동일한 화살표 함수 이름을 제공한다. */
export function arrowFunctionName(node: any): string {
    const parent = node.parent;
    if (parent?.type === 'variable_declarator')
        return parent.childForFieldName('name')?.text || '';
    if (parent?.type === 'pair')
        return parent.childForFieldName('key')?.text || '';
    if (parent?.type === 'public_field_definition' || parent?.type === 'field_definition') {
        return (parent.childForFieldName('name') ?? parent.childForFieldName('property'))?.text || '';
    }
    return node.childForFieldName('name')?.text || '';
}
/** 이름 필드가 없는 C 선언자를 따라 실제 선언 이름을 찾는다. */
export function declarationName(node: any): string {
    if (!node)
        return '';
    const named = node.childForFieldName('name');
    if (named)
        return named.text;
    const declarator = node.childForFieldName('declarator');
    if (declarator)
        return declarationName(declarator);
    if (node.type === 'reference_declarator')
        return declarationName(node.namedChildren.at(-1));
    if (['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier', 'destructor_name', 'operator_name'].includes(node.type))
        return node.text;
    return '';
}
/** 그래프 잡음을 유발하는 언어 기본 내장 함수·객체 호출 목록이다. */
export const BUILTIN_CALL_NAMES = new Set([
    'log', 'warn', 'error', 'info', 'debug', 'trace',
    'print', 'println', 'printf', 'sprintf', 'len', 'range', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'super', 'type', 'id', 'repr', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs', 'open',
    'require', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Promise', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'RegExp', 'Date', 'Buffer',
    'resolve', 'reject', 'describe', 'it', 'test', 'expect', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach'
]);
/** 외부 런타임·플랫폼 전역 객체 식별자 목록이다. */
export const EXTERNAL_RECEIVER_ROOTS = new Set([
    'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Reflect', 'Symbol', 'Buffer',
    'process', 'fs', 'path', 'cp', 'child_process', 'crypto', 'http', 'https', 'url', 'util', 'events', 'stream',
    'vscode', 'z', 'ts', 'assert', 'jest', 'vi', 'os', 'sys', 're', 'time', 'datetime', 'fmt', 'std'
]);
/** TypeScript 및 Python 기본 내장·유틸리티·컨테이너 타입 목록이다. */
export const BUILTIN_TYPE_NAMES = new Set([
    'string', 'number', 'boolean', 'any', 'void', 'unknown', 'never', 'object', 'symbol', 'bigint',
    'Record', 'Array', 'ReadonlyArray', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'InstanceType',
    'Error', 'RegExp', 'Date', 'Buffer', 'NodeJS', 'ErrnoException',
    'str', 'int', 'float', 'bool', 'bytes', 'bytearray', 'complex', 'list', 'dict', 'set', 'tuple', 'frozenset', 'type',
    'List', 'Dict', 'Tuple', 'FrozenSet', 'Type', 'Optional', 'Union', 'Sequence', 'Iterable', 'Mapping', 'MutableMapping',
    'Iterator', 'Callable', 'Awaitable', 'Coroutine', 'Generator', 'Annotated', 'ClassVar', 'Final', 'Literal', 'TypeVar',
    'None', 'Ellipsis', 'Self', 'Any', 'Path', 'MagicMock', 'Mock', 'AsyncMock'
]);
/** 가까운 렉시컬 바인딩부터 찾으며 타입 미상 바인딩도 바깥 변수의 타입을 가린다. */
export function lookupReceiverType(scope: string, rawReceiver: string | undefined, receiverTypes: Map<string, string>, isField = false): string | undefined {
    if (!rawReceiver || rawReceiver === 'this' || rawReceiver === 'member')
        return rawReceiver;
    if (isField)
        return receiverTypes.get(`${scope.split('::')[0] || 'global'}::${rawReceiver}`) || 'member';
    while (true) {
        const key = `${scope}::${rawReceiver}`;
        if (receiverTypes.has(key))
            return receiverTypes.get(key);
        if (scope === 'global')
            break;
        scope = scope.includes('::') ? scope.slice(0, scope.lastIndexOf('::')) : 'global';
    }
    // shortcut: 타입 없는 정적 수신자는 대문자 클래스명만 허용한다. 소문자 정적 타입은 임포트 바인딩으로 보강한다.
    return /^[A-Z]/.test(rawReceiver) ? rawReceiver : 'member';
}
/** 호출 이름을 가리는 값 바인딩이 현재 또는 바깥 함수에 있는지 확인한다. */
export function findLexicalBinding(scope: string, name: string, receiverTypes: Map<string, string>): string | undefined {
    while (true) {
        if (receiverTypes.has(`${scope}::${name}`))
            return scope;
        if (scope === 'global')
            return undefined;
        scope = scope.includes('::') ? scope.slice(0, scope.lastIndexOf('::')) : 'global';
    }
}
/** 타입 표기의 수식어를 제거하고 내장 타입을 후보에서 제외한다. */
export function extractCleanType(raw?: string): string {
    if (!raw)
        return '';
    const cleaned = raw.replace(/^:\s*/, '').replace(/[&*]/g, '').replace(/^(?:const|struct|class)\s+/, '').replace(/[<[].*$/, '').split('|')[0].split(/\.|::/).pop()?.trim() || '';
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned) && !BUILTIN_TYPE_NAMES.has(cleaned) && !BUILTIN_CALL_NAMES.has(cleaned)
        ? cleaned
        : '';
}
/** AST 위치를 공통 범위로 변환한다. */
export function nodeRange(node: any): Range {
    return {
        start: { line: node.startPosition.row, character: node.startPosition.column },
        end: { line: node.endPosition.row, character: node.endPosition.column }
    };
}
/** 상대 임포트를 현재 파일 기준 경로로 바꾼다. */
export function resolveImportPath(currentFilePath: string, importPath: string): string {
    if (importPath.startsWith('.')) {
        const dir = path.dirname(currentFilePath);
        return path.join(dir, importPath);
    }
    return importPath;
}
/** 언어 분기 없이 깊이 우선 순회하며 각 노드의 방문 콜백을 호출한다. */
export function visitAst(node: any, visit: (node: any) => void): void {
    visit(node);
    for (let index = 0; index < node.childCount; index++) {
        const child = node.child(index);
        if (child)
            visitAst(child, visit);
    }
}
