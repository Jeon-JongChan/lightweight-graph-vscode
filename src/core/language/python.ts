import * as path from 'path';
import { Relation } from '../../common/types';
import { AstLanguageAnalyzer, LanguageAnalyzer } from './base';
import { NodeDeclaration, BUILTIN_CALL_NAMES, BUILTIN_TYPE_NAMES, EXTERNAL_RECEIVER_ROOTS, extractCleanType, findLexicalBinding, lookupReceiverType, nodeRange } from '../declarations';
/** Python의 선언·렉시컬 범위·수신자·임포트·호출 규칙을 소유한다. */
export class PythonAnalyzer extends AstLanguageAnalyzer {
    public readonly importExtensions = ['.py'];
    /** Python 문법은 다른 언어와 독립된 호출 계열로 사용한다. */
    constructor() { super('python'); }
    /** 상대 모듈의 점 개수와 절대 모듈의 루트 우선순위를 보존한다. */
    public getModuleCandidates(sourceFile: string, modulePath: string, root: string): string[] {
        if (modulePath.startsWith('.')) {
            // 첫 점은 현재 패키지다. 없는 상대 모듈을 루트의 동명 모듈로 대체하지 않는다.
            const dots = modulePath.match(/^\.+/)![0].length;
            return [path.resolve(path.dirname(sourceFile), ...Array(dots - 1).fill('..'), ...modulePath.slice(dots).split('.').filter(Boolean))];
        }
        if (path.isAbsolute(modulePath)) return [];
        const relative = modulePath.split('.').filter(Boolean).join(path.sep);
        return relative ? [path.join(root, relative), path.join(path.dirname(sourceFile), relative)] : [];
    }
    /** Python 클래스와 함수 선언을 분류한다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        const name = node.childForFieldName('name')?.text || '';
        if (node.type === 'class_definition')
            return { name, kind: 'class' };
        if (node.type === 'function_definition')
            return { name, kind: 'function' };
        return null;
    }
    /** 타입 어노테이션·self 필드·지역 할당과 매개변수 가림을 수집한다. */
    protected collectReceiverTypes(node: any, receiverTypes: Map<string, string>): void {
        const scope = this.getScope(node) || 'global';
        const ownerClass = scope.split('::')[0] || 'global';
        if (node.type === 'import_statement') {
            for (const child of node.namedChildren) {
                const name = child.childForFieldName('alias')?.text || (child.childForFieldName('name') ?? child).text.split('.')[0];
                receiverTypes.set(`${scope}::${name}`, `namespace::${name}`);
            }
        }
        if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
            const nameNode = node.childForFieldName('name') ?? node.namedChild(0);
            const typeNode = node.childForFieldName('type');
            const paramName = nameNode?.text?.trim();
            const resolvedType = extractCleanType(typeNode?.text);
            if (paramName) {
                receiverTypes.set(`${scope}::${paramName}`, resolvedType || 'member');
            }
        }
        else if (node.type === 'assignment') {
            const leftText = node.childForFieldName('left')?.text?.trim() || '';
            const typeNode = node.childForFieldName('type');
            const rightNode = node.childForFieldName('right');
            let resolvedType = extractCleanType(typeNode?.text);
            if (!resolvedType && rightNode?.type === 'call') {
                resolvedType = extractCleanType(rightNode.childForFieldName('function')?.text);
            }
            if (leftText.startsWith('self.')) {
                const fieldName = leftText.slice(5).trim();
                receiverTypes.set(`${ownerClass}::${fieldName}`, resolvedType || 'member');
            }
            else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(leftText)) {
                receiverTypes.set(`${scope}::${leftText}`, resolvedType || 'member');
            }
        }
        if (node.type === 'default_parameter') {
            const name = node.childForFieldName('name')?.text;
            if (name)
                receiverTypes.set(`${scope}::${name}`, 'member');
        }
    }
    /** from/import의 원래 이름과 별칭을 보존한다. */
    private importBindings(node: any): Record<string, string> {
        const bindings: Record<string, string> = Object.create(null);
        const moduleNode = node.childForFieldName('module_name');
        for (const child of node.namedChildren) {
            if (child.startIndex === moduleNode?.startIndex || child.type === 'relative_import')
                continue;
            const original = (child.childForFieldName('name') ?? child).text;
            const local = child.childForFieldName('alias')?.text || original.split('.')[0];
            bindings[local] = node.type === 'import_statement' ? '*' : original;
        }
        return bindings;
    }
    /** Python 호출·타입 참조·임포트·상속을 원시 관계로 추출한다. */
    protected extractNodeRelations(node: any, filePath: string, receiverTypes: Map<string, string>): Relation[] {
        const relations: Relation[] = [];
        const range = nodeRange(node);
        if (node.type === 'call') {
            const funcNode = node.childForFieldName('function');
            if (funcNode) {
                let funcName = funcNode.text;
                let receiver: string | undefined;
                const callerName = (this.getScope(node) || 'global');
                if (funcNode.type === 'attribute') {
                    const objText = funcNode.childForFieldName('object')?.text || '';
                    const attrNode = funcNode.childForFieldName('attribute');
                    const rootObj = objText.split('.')[0].trim();
                    if (EXTERNAL_RECEIVER_ROOTS.has(rootObj) && !findLexicalBinding(callerName, rootObj, receiverTypes)) {
                        return relations;
                    }
                    if (attrNode) {
                        funcName = attrNode.text;
                    }
                    const rawRec = objText === 'self' ? 'this' : objText.replace(/^self\./, '').split('.').pop()?.trim();
                    receiver = lookupReceiverType(callerName, rawRec, receiverTypes, objText.startsWith('self.'));
                }
                if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(funcName)) {
                    const shadowScope = !receiver ? findLexicalBinding(callerName, funcName, receiverTypes) : undefined;
                    relations.push({
                        id: `${filePath}::call::${callerName}->${funcName}@${node.startIndex}`,
                        sourceId: `${filePath}::${callerName}`,
                        targetId: `unknown::${funcName}`,
                        kind: 'call',
                        certainty: 'EXTRACTED',
                        ...(receiver ? { receiver } : {}),
                        ...(shadowScope ? { lexicalBinding: shadowScope === 'global' ? filePath : `${filePath}::${shadowScope}` } : {}),
                        range
                    });
                }
            }
        }
        else if (node.type === 'type') {
            const callerName = (this.getScope(node) || 'global');
            if (callerName !== 'global') {
                const tokens = node.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
                const callerShort = callerName.split('::').pop();
                for (const token of tokens) {
                    if (!BUILTIN_TYPE_NAMES.has(token) && !BUILTIN_CALL_NAMES.has(token) && token !== callerShort) {
                        relations.push({
                            id: `${filePath}::ref::${callerName}->${token}`,
                            sourceId: `${filePath}::${callerName}`,
                            targetId: `unknown::${token}`,
                            kind: 'reference',
                            certainty: 'EXTRACTED',
                            range
                        });
                    }
                }
            }
        }
        else if (node.type === 'import_statement' || node.type === 'import_from_statement') {
            const moduleNode = node.childForFieldName('module_name') || node.children.find((c: any) => c.type === 'dotted_name' || c.type === 'relative_import');
            const modules = node.type === 'import_statement' ? node.namedChildren.map((child: any) => child.childForFieldName('name') ?? child) : moduleNode ? [moduleNode] : [];
            for (const importedModule of modules) {
                const importPath = importedModule.text;
                relations.push({
                    id: `${filePath}::import::${importPath}@${node.startIndex}`,
                    sourceId: filePath,
                    targetId: importPath,
                    kind: 'import',
                    certainty: 'EXTRACTED',
                    bindings: node.type === 'import_statement' ? {
                        [importedModule.parent?.childForFieldName('alias')?.text || importPath.split('.')[0]]: '*'
                    } : this.importBindings(node),
                    bindingScope: (this.getScope(node) || 'global') === 'global' ? filePath : `${filePath}::${(this.getScope(node) || 'global')}`,
                    range
                });
            }
        }
        else if (node.type === 'class_definition') {
            const className = node.childForFieldName('name')?.text || '';
            const superclasses = node.childForFieldName('superclasses');
            if (className && superclasses) {
                const scope = (this.getScope(node) || 'global');
                const owner = scope !== 'global' ? `${scope}::${className}` : className;
                for (const base of superclasses.namedChildren || []) {
                    if (base.type === 'keyword_argument')
                        continue;
                    const targetName = base.text.replace(/\[.*\]$/, '').split('.').pop()?.trim();
                    if (targetName && targetName !== 'object') {
                        relations.push({
                            id: `${filePath}::${owner}::inherit::${targetName}`,
                            sourceId: `${filePath}::${owner}`,
                            targetId: `unknown::${targetName}`,
                            kind: 'inherit',
                            certainty: 'EXTRACTED',
                            range
                        });
                    }
                }
            }
        }
        return relations;
    }
}
/** Python의 실제 분석 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new PythonAnalyzer(); }
