import { Language, Relation } from '../../common/types';
import { AstLanguageAnalyzer, LanguageAnalyzer } from './base';
import { NodeDeclaration, arrowFunctionName, BUILTIN_TYPE_NAMES, EXTERNAL_RECEIVER_ROOTS, extractCleanType, findLexicalBinding, lookupReceiverType, nodeRange, resolveImportPath } from '../declarations';
/** JS 계열의 선언·스코프·객체 수신자·모듈과 호출을 해석한다. */
export class JavascriptAnalyzer extends AstLanguageAnalyzer {
    public readonly importExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    protected readonly typeReferences: boolean = false;
    protected readonly defaultAssignmentParameters: boolean = true;
    /** 파생 TypeScript 전략도 같은 런타임 문법 규칙을 공유한다. */
    constructor(language: Language = 'javascript') { super(language, 'script'); }
    /** JS 선언과 이름 있는 화살표 함수·모듈 변수를 분류한다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        const name = node.childForFieldName('name')?.text || '';
        if (node.type === 'class_declaration')
            return { name, kind: 'class' };
        if (node.type === 'function_declaration')
            return { name, kind: 'function' };
        if (node.type === 'method_definition')
            return { name, kind: 'method' };
        if (node.type === 'arrow_function')
            return { name: arrowFunctionName(node), kind: ['public_field_definition', 'field_definition'].includes(node.parent?.type) ? 'method' : 'function' };
        if (node.type === 'variable_declarator') {
            const value = node.childForFieldName('value');
            if (value && value.type !== 'arrow_function' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !this.isInsideFunctionLike(node))
                return { name, kind: 'variable' };
        }
        return null;
    }
    /** 클래스·함수·메서드·화살표 함수만 렉시컬 범위를 구성한다. */
    protected scopeName(node: any): string {
        if (['class_declaration', 'function_declaration', 'method_definition'].includes(node.type))
            return node.childForFieldName('name')?.text || '';
        return node.type === 'arrow_function' ? arrowFunctionName(node) : '';
    }
    /** 함수 내부 지역 변수를 모듈 심볼로 잘못 추출하지 않는다. */
    private isInsideFunctionLike(node: any): boolean {
        let current = node.parent;
        while (current) {
            if (current.type === 'function_declaration' ||
                current.type === 'method_definition' ||
                current.type === 'arrow_function' ||
                current.type === 'function_expression' ||
                current.type === 'generator_function_declaration' ||
                current.type === 'generator_function') {
                return true;
            }
            current = current.parent;
        }
        return false;
    }
    /** 필드·생성자 주입·new 할당과 매개변수의 가림을 수집한다. */
    protected collectReceiverTypes(node: any, receiverTypes: Map<string, string>): void {
        const scope = this.getScope(node) || 'global';
        const ownerClass = scope.split('::')[0] || 'global';
        if (node.type === 'namespace_import') {
            const name = node.namedChildren.find((child: any) => child.type === 'identifier')?.text;
            if (name)
                receiverTypes.set(`${scope}::${name}`, `namespace::${name}`);
        }
        if (node.type === 'public_field_definition' || node.type === 'field_definition' || node.type === 'property_signature') {
            const fieldName = (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text?.trim();
            const typeNode = node.childForFieldName('type');
            const valNode = node.childForFieldName('value');
            let resolvedType = extractCleanType(typeNode?.text);
            if (!resolvedType && valNode?.type === 'new_expression') {
                resolvedType = extractCleanType(valNode.childForFieldName('constructor')?.text);
            }
            if (fieldName && resolvedType) {
                receiverTypes.set(`${ownerClass}::${fieldName}`, resolvedType);
            }
        }
        else if (node.type === 'required_parameter' || node.type === 'optional_parameter') {
            const paramName = (node.childForFieldName('pattern') ?? node.childForFieldName('name'))?.text?.replace(/^[a-z]+\s+/, '').trim();
            const resolvedType = extractCleanType(node.childForFieldName('type')?.text);
            if (paramName) {
                receiverTypes.set(`${scope}::${paramName}`, resolvedType || 'member');
                if (scope.endsWith('::constructor') && node.children.some((child: any) => ['accessibility_modifier', 'readonly'].includes(child.type))) {
                    receiverTypes.set(`${ownerClass}::${paramName}`, resolvedType || 'member');
                }
            }
        }
        else if (node.type === 'variable_declarator') {
            const varName = node.childForFieldName('name')?.text?.trim();
            const typeNode = node.childForFieldName('type');
            const valNode = node.childForFieldName('value');
            let resolvedType = extractCleanType(typeNode?.text);
            if (!resolvedType && valNode?.type === 'new_expression') {
                resolvedType = extractCleanType(valNode.childForFieldName('constructor')?.text);
            }
            if (varName) {
                receiverTypes.set(`${scope}::${varName}`, resolvedType || 'member');
            }
        }
        else if (node.type === 'assignment_expression') {
            const leftText = node.childForFieldName('left')?.text?.trim() || '';
            const rightNode = node.childForFieldName('right');
            if (leftText.startsWith('this.') && rightNode?.type === 'new_expression') {
                const fieldName = leftText.slice(5).trim();
                const resolvedType = extractCleanType(rightNode.childForFieldName('constructor')?.text);
                if (fieldName && resolvedType) {
                    receiverTypes.set(`${ownerClass}::${fieldName}`, resolvedType);
                }
            }
        }
        if (this.defaultAssignmentParameters && node.type === 'assignment_pattern' && node.parent?.type === 'formal_parameters') {
            const name = node.childForFieldName('left')?.text;
            if (name)
                receiverTypes.set(`${scope}::${name}`, 'member');
        }
    }
    /** 이름 있는 임포트와 네임스페이스 별칭을 보존한다. */
    private importBindings(node: any): Record<string, string> {
        const bindings: Record<string, string> = Object.create(null);
        if (node.type === 'import_statement') {
            const clause = node.namedChildren.find((child: any) => child.type === 'import_clause');
            for (const specifier of clause?.descendantsOfType('import_specifier') || []) {
                const original = specifier.childForFieldName('name')?.text;
                const local = specifier.childForFieldName('alias')?.text || original;
                if (local && original)
                    bindings[local] = original;
            }
            const namespace = clause?.descendantsOfType('namespace_import')[0]?.namedChild(0)?.text;
            if (namespace)
                bindings[namespace] = '*';
        }
        return bindings;
    }
    /** JS 계열의 생성자·호출·모듈·상속 관계를 추출한다. */
    protected extractNodeRelations(node: any, filePath: string, receiverTypes: Map<string, string>): Relation[] {
        const relations: Relation[] = [];
        const range = nodeRange(node);
        if (node.type === 'new_expression') {
            const ctorNode = node.childForFieldName('constructor');
            if (ctorNode) {
                const rawText = ctorNode.text.replace(/<.*>$/, '').trim();
                const parts = rawText.split('.');
                if (parts.length > 1 && EXTERNAL_RECEIVER_ROOTS.has(parts[0])) {
                    return relations;
                }
                const ctorName = parts.pop() || '';
                if (ctorName && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ctorName)) {
                    const callerName = (this.getScope(node) || 'global');
                    relations.push({
                        id: `${filePath}::call::${callerName}->${ctorName}@${node.startIndex}`,
                        sourceId: `${filePath}::${callerName}`,
                        targetId: `unknown::${ctorName}`,
                        kind: 'call',
                        certainty: 'EXTRACTED',
                        range
                    });
                }
            }
        }
        else if (node.type === 'call_expression') {
            const funcNode = node.childForFieldName('function');
            if (funcNode) {
                let funcName = funcNode.text;
                let receiver: string | undefined;
                if (funcName === 'require') {
                    const argsNode = node.childForFieldName('arguments');
                    if (argsNode && argsNode.namedChildCount > 0) {
                        const argText = argsNode.namedChild(0).text.replace(/['"`]/g, '');
                        const resolvedPath = resolveImportPath(filePath, argText);
                        relations.push({
                            id: `${filePath}::import::${resolvedPath}`,
                            sourceId: filePath,
                            targetId: resolvedPath,
                            kind: 'import',
                            certainty: 'EXTRACTED',
                            range
                        });
                        return relations;
                    }
                }
                const callerName = (this.getScope(node) || 'global');
                if (funcNode.type === 'member_expression') {
                    const objectNode = funcNode.childForFieldName('object');
                    const objText = objectNode?.text || '';
                    const propNode = funcNode.childForFieldName('property');
                    const rootObj = objText.split('.')[0].trim();
                    if (EXTERNAL_RECEIVER_ROOTS.has(rootObj) && !findLexicalBinding(callerName, rootObj, receiverTypes)) {
                        return relations;
                    }
                    if (propNode) {
                        funcName = propNode.text;
                    }
                    const objParts = objText.replace(/^this\./, '').split('.');
                    const lastReceiver = objParts[objParts.length - 1]?.trim();
                    const rawRec = objText === 'this' ? 'this' : (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(lastReceiver) ? lastReceiver : 'member');
                    // new Store().get()도 필드·파라미터와 동일한 생성자 타입 증거를 사용한다.
                    receiver = objectNode?.type === 'new_expression'
                        ? objectNode.childForFieldName('constructor')?.text?.replace(/<.*>$/, '').trim()
                        : lookupReceiverType(callerName, rawRec, receiverTypes, objText.startsWith('this.'));
                }
                // 멤버 이름만으로 내장 함수를 판별하면 사용자 정의 get/set/resolve 호출도 사라진다.
                if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(funcName)) {
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
        else if (node.type === 'import_statement' || node.type === 'export_statement') {
            const sourceNode = node.childForFieldName('source');
            if (sourceNode) {
                const importPath = sourceNode.text.replace(/['"`]/g, '');
                const resolvedPath = resolveImportPath(filePath, importPath);
                relations.push({
                    id: `${filePath}::import::${resolvedPath}@${node.startIndex}`,
                    sourceId: filePath,
                    targetId: resolvedPath,
                    kind: 'import',
                    certainty: 'EXTRACTED',
                    bindings: this.importBindings(node),
                    bindingScope: filePath,
                    range
                });
            }
        }
        else if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
            const className = node.childForFieldName('name')?.text || '';
            if (className) {
                const scope = (this.getScope(node) || 'global');
                const owner = scope !== 'global' ? `${scope}::${className}` : className;
                for (const child of node.namedChildren || []) {
                    if (child.type === 'class_heritage') {
                        for (const clause of child.namedChildren || []) {
                            if (clause.type === 'extends_clause' || clause.type === 'implements_clause') {
                                const kind = clause.type === 'implements_clause' ? 'implement' : 'inherit';
                                for (const target of clause.namedChildren || []) {
                                    const targetName = target.text.replace(/<.*>$/, '').split('.').pop()?.trim();
                                    if (targetName) {
                                        relations.push({
                                            id: `${filePath}::${owner}::${kind}::${targetName}`,
                                            sourceId: `${filePath}::${owner}`,
                                            targetId: `unknown::${targetName}`,
                                            kind,
                                            certainty: 'EXTRACTED',
                                            range
                                        });
                                    }
                                }
                            }
                            else {
                                const targetName = clause.text.replace(/<.*>$/, '').split('.').pop()?.trim();
                                if (targetName) {
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
                    else if (child.type === 'extends_type_clause' || child.type === 'extends_clause') {
                        for (const target of child.namedChildren || []) {
                            const targetName = target.text.replace(/<.*>$/, '').split('.').pop()?.trim();
                            if (targetName) {
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
            }
        }
        else if (this.typeReferences && node.type === 'type_identifier') {
            const typeName = node.text.trim();
            const parentType = node.parent?.type || '';
            if (!BUILTIN_TYPE_NAMES.has(typeName) &&
                !['class_declaration', 'interface_declaration', 'type_alias_declaration', 'extends_clause', 'implements_clause', 'extends_type_clause', 'class_heritage'].includes(parentType)) {
                const callerName = (this.getScope(node) || 'global');
                const callerShort = callerName.split('::').pop();
                if (callerName !== 'global' && callerShort !== typeName) {
                    relations.push({
                        id: `${filePath}::ref::${callerName}->${typeName}`,
                        sourceId: `${filePath}::${callerName}`,
                        targetId: `unknown::${typeName}`,
                        kind: 'reference',
                        certainty: 'EXTRACTED',
                        range
                    });
                }
            }
        }
        return relations;
    }
}
/** JavaScript의 실제 분석 전략을 생성한다. */
export function createAnalyzer(): LanguageAnalyzer { return new JavascriptAnalyzer(); }
