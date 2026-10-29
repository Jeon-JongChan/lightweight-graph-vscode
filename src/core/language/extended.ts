import * as path from 'path';
import { Language, Relation, SymbolKind } from '../../common/types';
import languages from '../../common/languages.json';
import { AstLanguageAnalyzer, LanguageAnalysis } from './base';
import { CodeParser } from '../parser';
import { TextLanguageAnalyzer } from './text';
import { NodeDeclaration, nodeRange, resolveImportPath } from '../declarations';
// 같은 AST 모양만 공유하고 이름·임포트·호출의 언어별 차이는 아래 훅에서 해석한다.
const DECLARATIONS: Partial<Record<Language, Record<string, SymbolKind>>> = {
    ruby: { class: 'class', module: 'module', method: 'method', singleton_method: 'method' },
    kotlin: { class_declaration: 'class', object_declaration: 'class', function_declaration: 'function' },
    scala: { class_definition: 'class', trait_definition: 'interface', object_definition: 'class', function_definition: 'function', function_declaration: 'function' },
    php: { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'interface', function_definition: 'function', method_declaration: 'method' },
    swift: { class_declaration: 'class', protocol_declaration: 'interface', function_declaration: 'function' },
    lua: { function_declaration: 'function', function_definition: 'function' },
    zig: { function_declaration: 'function' },
    powershell: { function_statement: 'function', class_statement: 'class', class_method_definition: 'method', enum_statement: 'class' },
    julia: { function_definition: 'function', short_function_definition: 'function', struct_definition: 'class', module_definition: 'module', abstract_definition: 'interface' },
    groovy: { class_definition: 'class', interface_definition: 'interface', function_definition: 'method' },
    dart: { class_definition: 'class', enum_declaration: 'class', mixin_declaration: 'class', method_signature: 'method', function_signature: 'function' },
    fortran: { subroutine: 'function', function: 'function', module: 'module', derived_type_definition: 'class' },
    bash: { function_definition: 'function' },
    r: { function_definition: 'function' },
    ocaml: { let_binding: 'function', module_definition: 'module', class_definition: 'class', type_binding: 'interface' },
    ocaml_interface: { value_specification: 'function', module_definition: 'module', type_binding: 'interface' },
    commonlisp: { defun: 'function', defmacro: 'function', defclass: 'class' },
    erlang: { fun_decl: 'function' },
    solidity: { contract_declaration: 'class', interface_declaration: 'interface', library_declaration: 'class', function_definition: 'function', modifier_definition: 'method', event_definition: 'function' },
    verilog: { module_declaration: 'class', interface_declaration: 'interface', package_declaration: 'module', function_declaration: 'function', task_declaration: 'function' },
    pascal: { defProc: 'function', declClass: 'class', declIntf: 'interface' },
    razor: { class_declaration: 'class', method_declaration: 'method', local_function_statement: 'function' },
    apex: { class_declaration: 'class', interface_declaration: 'interface', enum_declaration: 'class', method_declaration: 'method', constructor_declaration: 'method' }
};
/** 따옴표로 감싼 AST 리터럴에서 정적인 값만 읽는다. */
function literal(node: any): string {
    if (!node || !['string', 'string_literal', 'str_lit', 'word', 'raw_string'].includes(node.type)) return '';
    if (node.descendantsOfType(['interpolation','expansion','simple_expansion','command_substitution','variable_expansion','string_interpolation','variable','variable_name']).length) return '';
    return node.childForFieldName('content')?.text || node.text.replace(/^(?:@)?["'`]|["'`]$/g, '');
}
/** 추가 언어의 실제 AST에서 선언·호출·임포트·상속을 추출한다. */
export class ExtendedLanguageAnalyzer extends AstLanguageAnalyzer {
    public readonly importExtensions: readonly string[];
    public readonly caseInsensitive: boolean;
    /** 서로 다른 언어의 동명 심볼이 섞이지 않게 계열과 확장자를 고정한다. */
    constructor(language: Language) {
        super(language, language === 'razor' ? 'csharp' : language === 'ocaml_interface' ? 'ocaml' : language, ['ruby', 'kotlin', 'scala', 'php', 'swift', 'groovy', 'dart', 'solidity', 'apex', 'razor'].includes(language));
        this.importExtensions = languages[language].extensions;
        this.caseInsensitive = ['powershell', 'fortran', 'pascal', 'commonlisp'].includes(language);
    }
    /** WoW TOC는 Lua 코드가 아니라 파일 목록이므로 별도 구조 규칙으로 읽는다. */
    public analyze(content: string, filePath: string, parser: CodeParser): LanguageAnalysis {
        return this.language === 'lua' && path.extname(filePath).toLowerCase() === '.toc'
            ? new TextLanguageAnalyzer('lua').analyze(content, filePath, parser) : super.analyze(content, filePath, parser);
    }
    /** 이름 필드가 없는 선언도 해당 언어의 헤더·패턴에서 이름을 찾는다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        if (this.language === 'elixir' && node.type === 'call') {
            const keyword = node.childForFieldName('target')?.text;
            if (!['defmodule', 'defprotocol', 'defimpl', 'def', 'defp', 'defmacro', 'defmacrop'].includes(keyword))
                return null;
            const head = node.namedChildren.find((child: any) => child.type === 'arguments')?.namedChild(0);
            const name = head?.childForFieldName('target')?.text || head?.text;
            return name ? { name, kind: keyword === 'defmodule' || keyword === 'defimpl' ? 'module' : keyword === 'defprotocol' ? 'interface' : 'function' } : null;
        }
        const kind = DECLARATIONS[this.language]?.[node.type];
        if (!kind)
            return null;
        let name = (node.childForFieldName('name') ?? node.childForFieldName('function'))?.text;
        if (this.language === 'kotlin')
            name ||= node.namedChildren.find((child: any) => ['simple_identifier', 'type_identifier'].includes(child.type))?.text;
        if (this.language === 'powershell')
            name ||= node.namedChildren.find((child: any) => ['function_name', 'simple_name'].includes(child.type))?.text;
        if (this.language === 'julia') {
            const signature = node.namedChildren.find((child: any) => child.type === 'signature');
            name ||= signature?.namedChild(0)?.namedChild(0)?.text || node.namedChildren.find((child: any) => child.type === 'type_head')?.namedChild(0)?.text;
        }
        if (this.language === 'lua' && node.type === 'function_definition')
            name = node.parent?.parent?.namedChild(0)?.childForFieldName('name')?.text;
        if (this.language === 'r')
            name = node.parent?.type === 'binary_operator' ? node.parent.childForFieldName('lhs')?.text : '';
        if (this.language === 'ocaml')
            name ||= node.childForFieldName('pattern')?.text;
        if (this.language === 'ocaml_interface')
            name ||= node.namedChild(0)?.text;
        if (this.language === 'commonlisp')
            name ||= node.namedChild(0)?.childForFieldName('function_name')?.text;
        if (this.language === 'erlang')
            name ||= node.namedChild(0)?.childForFieldName('name')?.text;
        if (this.language === 'fortran')
            name ||= node.namedChild(0)?.childForFieldName('name')?.text;
        if (this.language === 'verilog')
            name ||= node.namedChild(0)?.childForFieldName('name')?.text;
        if (this.language === 'pascal')
            name ||= node.childForFieldName('header')?.childForFieldName('name')?.text;
        if (this.language === 'dart') {
            // Dart는 서명과 본문이 형제다. 중복 선언을 만들지 않고 서명에 소유권을 둔다.
            if (node.type === 'function_signature' && node.parent?.type === 'method_signature')
                return null;
            name ||= node.namedChild(0)?.childForFieldName('name')?.text;
        }
        return name ? { name, kind } : null;
    }
    /** Dart의 형제 서명과 Elixir의 모듈도 호출자의 소유 범위로 사용한다. */
    protected scopeName(node: any): string {
        if (this.language === 'dart' && node.type === 'function_body') {
            const previous = node.previousNamedSibling;
            if (previous)
                return this.getDeclaration(previous)?.name || '';
        }
        return super.scopeName(node);
    }
    /** 상대 파일과 점 표기 모듈의 실제 소스 후보를 만든다. */
    public getModuleCandidates(sourceFile: string, modulePath: string, root: string): string[] {
        if (path.isAbsolute(modulePath))
            return [];
        const relative = modulePath.replace(/\\/g, path.sep).replace(/::|\./g, path.sep);
        return [path.resolve(path.dirname(sourceFile), modulePath), path.resolve(root, modulePath),
            path.join(root, relative), path.join(path.dirname(sourceFile), relative)];
    }
    /** 각 언어의 호출 AST에서 대상과 수신자를 읽는다. 선언 헤더는 호출로 세지 않는다. */
    private called(node: any): {
        name: string;
        receiver?: string;
    } | null {
        let target: any;
        let object: any;
        if (['call_expression', 'function_call', 'invocation_expression', 'method_invocation', 'call', 'member_call_expression', 'scoped_call_expression'].includes(node.type)) {
            target = node.childForFieldName('function') ?? node.childForFieldName('method') ?? node.childForFieldName('target')
                ?? node.childForFieldName('name') ?? node.childForFieldName('expr') ?? node.namedChild(0);
            object = node.childForFieldName('object') ?? node.childForFieldName('receiver') ?? node.childForFieldName('scope');
        }
        if (this.language === 'powershell' && node.type === 'command')
            target = node.childForFieldName('command_name');
        if (this.language === 'bash' && node.type === 'command')
            target = node.childForFieldName('name');
        if (this.language === 'fortran' && node.type === 'subroutine_call')
            target = node.childForFieldName('subroutine');
        if (this.language === 'ocaml' && node.type === 'application_expression')
            target = node.childForFieldName('function');
        if (this.language === 'pascal' && node.type === 'exprCall')
            target = node.childForFieldName('entity');
        if (this.language === 'verilog' && node.type === 'module_instantiation')
            target = node.childForFieldName('instance_type');
        if (this.language === 'commonlisp' && node.type === 'list_lit' && node.namedChild(0)?.type === 'sym_lit')
            target = node.namedChild(0);
        if (this.language === 'dart' && node.type === 'expression_statement' && node.namedChildren.some((child: any) => child.type === 'selector'))
            target = node.namedChild(0);
        if (!target)
            return null;
        if (this.language === 'julia' && node.parent?.type === 'signature')
            return null;
        if (this.language === 'elixir') {
            if (this.getDeclaration(node) || node.parent?.type === 'arguments' && this.getDeclaration(node.parent.parent))
                return null;
            if (['import', 'alias', 'use', 'require'].includes(target.text))
                return null;
        }
        if (this.language === 'ruby' && ['require', 'require_relative', 'load'].includes(target.text))
            return null;
        if (this.language === 'lua' && target.text === 'require')
            return null;
        if (this.language === 'r' && ['source', 'library', 'require'].includes(target.text))
            return null;
        if (this.language === 'commonlisp' && ['require', 'load', 'in-package', 'defun', 'defmacro'].includes(target.text))
            return null;
        if (this.language === 'powershell' && ['using', 'import-module', '.'].includes(target.text.toLowerCase()))
            return null;
        if (this.language === 'bash' && ['source', '.'].includes(target.text))
            return null;
        const raw = target.text;
        const name = raw.split(/::|\.|:|->/).pop()?.trim();
        if (!name || !/^[\p{L}_$][\p{L}\p{N}_$!?-]*$/u.test(name))
            return null;
        let receiver: string | undefined;
        if (object || name !== raw) {
            const rawObject = object?.text || raw.slice(0, raw.length - name.length).replace(/[.:]+$/, '');
            receiver = ['this', '$this', 'self'].includes(rawObject) ? 'this' : /^[A-Z]/.test(rawObject) ? rawObject : 'member';
        }
        return { name, ...(receiver ? { receiver } : {}) };
    }
    /** 정적 리터럴·모듈 경로만 임포트로 기록하고 실행식은 추정하지 않는다. */
    private imported(node: any, filePath: string): string[] {
        const text = node.text;
        const stringNode = node.namedChildren.find((child: any) => /string|str_lit|uri/.test(child.type));
        const argumentsNode = node.childForFieldName('arguments') ?? node.namedChildren.find((child: any) => ['arguments', 'argument_list'].includes(child.type));
        const argument = argumentsNode?.namedChild(0);
        if (this.language === 'ruby' && node.type === 'call' && ['require', 'require_relative', 'load'].includes(node.childForFieldName('method')?.text))
            return argument ? [literal(argument)] : [];
        if (this.language === 'kotlin' && node.type === 'import_header')
            return [text.replace(/^import\s+/, '').replace(/\s+as\s+\S+$/, '').trim()];
        if (this.language === 'scala' && node.type === 'import_declaration')
            return [text.replace(/^import\s+/, '').trim()];
        if (this.language === 'php' && ['require_expression', 'require_once_expression', 'include_expression', 'include_once_expression'].includes(node.type))
            return stringNode ? [literal(stringNode)] : [];
        if (this.language === 'swift' && node.type === 'import_declaration')
            return [text.replace(/^import\s+/, '').trim()];
        if (this.language === 'lua' && node.type === 'function_call' && node.childForFieldName('name')?.text === 'require')
            return argument ? [literal(argument)] : [];
        if (this.language === 'zig' && node.type === 'builtin_function' && node.namedChild(0)?.text === '@import')
            return argument ? [literal(argument)] : [];
        if (this.language === 'powershell' && node.type === 'command') {
            const match = text.match(/^(?:using\s+module|Import-Module|\.)\s+(?:"([^"$`]+)"|'([^']+)'|([^\s$@`();'"]+))(?:\s|$)/i);
            return match ? [match[1] || match[2] || match[3]] : [];
        }
        if (this.language === 'powershell' && path.extname(filePath).toLowerCase() === '.psd1' && node.type === 'hash_entry' && /^(?:RootModule|NestedModules|RequiredModules)\s*=/i.test(text)) {
            const values: string[] = [];
            /** 내부 해시의 버전·GUID를 모듈 경로로 오인하지 않는다. */
            function collectValue(current: any): void {
                if (current !== node && current.type === 'hash_entry' && !/^ModuleName\s*=/i.test(current.text)) return;
                if (current.type === 'string_literal') { const value = literal(current); if(value) values.push(value); return; }
                for(const child of current.namedChildren) collectValue(child);
            }
            collectValue(node);
            return values;
        }
        if (this.language === 'elixir' && node.type === 'call' && ['import', 'alias', 'use', 'require'].includes(node.childForFieldName('target')?.text))
            return argument ? [argument.text] : [];
        if (this.language === 'julia' && ['using_statement', 'import_statement'].includes(node.type))
            return node.namedChildren.map((child: any) => child.text);
        if (this.language === 'groovy' && node.type === 'groovy_import')
            return [node.childForFieldName('import')?.text || ''];
        if (this.language === 'dart' && node.type === 'uri')
            return [literal(node.namedChild(0))];
        if (this.language === 'fortran' && node.type === 'use_statement')
            return [node.namedChild(0)?.text || ''];
        if (this.language === 'bash' && node.type === 'command' && ['source', '.'].includes(node.childForFieldName('name')?.text))
            return [literal(node.childForFieldName('argument'))];
        if (this.language === 'r' && node.type === 'call' && ['source', 'library', 'require'].includes(node.childForFieldName('function')?.text))
            return argument ? [literal(argument.childForFieldName('value') ?? argument)] : [];
        if (this.language === 'ocaml' && node.type === 'open_module')
            return [node.childForFieldName('module')?.text || ''];
        if (this.language === 'ocaml_interface' && node.type === 'open_module_signature')
            return [node.childForFieldName('module')?.text || ''];
        if (this.language === 'commonlisp' && node.type === 'list_lit' && ['require', 'load'].includes(node.namedChild(0)?.text))
            return [literal(node.namedChild(1))];
        if (this.language === 'erlang' && ['pp_include', 'pp_include_lib'].includes(node.type))
            return [literal(node.childForFieldName('file'))];
        if (this.language === 'solidity' && node.type === 'import_directive')
            return [literal(node.childForFieldName('source'))];
        if (this.language === 'verilog' && /include_directive/.test(node.type))
            return stringNode ? [literal(stringNode)] : [];
        if (this.language === 'pascal' && node.type === 'declUses')
            return node.namedChildren.filter((child: any) => child.type === 'moduleName').map((child: any) => child.text);
        if (this.language === 'razor' && node.type === 'razor_using_directive')
            return [text.replace(/^@using\s+/, '').replace(/;$/, '').trim()];
        return [];
    }
    /** 호출·의존성·상속을 기존 해석기가 사용하는 공통 사실로 만든다. */
    protected extractNodeRelations(node: any, filePath: string, _receiverTypes: Map<string, string>): Relation[] {
        const relations: Relation[] = [];
        const scope = this.getScope(node) || 'global';
        const range = nodeRange(node);
        const call = this.called(node);
        if (call)
            relations.push({ id: `${filePath}::call::${scope}->${call.name}@${node.startIndex}`, sourceId: `${filePath}::${scope}`,
                targetId: `unknown::${call.name}`, kind: 'call', certainty: 'EXTRACTED', range, ...(call.receiver ? { receiver: call.receiver } : {}) });
        for (let imported of this.imported(node,filePath).filter(Boolean)) {
            if (['ruby', 'php', 'zig', 'powershell', 'bash', 'r', 'erlang', 'solidity'].includes(this.language) && !path.isAbsolute(imported)) {
                imported = this.language === 'ruby' || /^(?:\.|[^.]+\.[a-z]+$)/i.test(imported)
                    ? path.resolve(path.dirname(filePath), imported) : resolveImportPath(filePath, imported);
            }
            relations.push({ id: `${filePath}::import::${imported}@${node.startIndex}`, sourceId: filePath, targetId: imported, kind: 'import', certainty: 'EXTRACTED', range });
        }
        const declaration = this.getDeclaration(node);
        if (declaration && ['class', 'interface'].includes(declaration.kind)) {
            const bases = node.namedChildren.filter((child: any) => ['superclass', 'base_clause', 'extends_clause', 'inheritance_specifier', 'delegation_specifier'].includes(child.type));
            const direct = node.childForFieldName('superclass');
            if (direct && !bases.some((base: any) => base.id === direct.id))
                bases.push(direct);
            for (const base of bases) {
                const name = base.text.replace(/^(?:extends|implements|is|:|<)\s*/, '').replace(/[<(].*$/, '').trim();
                if (!/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name))
                    continue;
                const owner = [this.getScope(node), declaration.name].filter(Boolean).join('::');
                relations.push({ id: `${filePath}::${owner}::inherit::${name}`, sourceId: `${filePath}::${owner}`, targetId: `unknown::${name.split('.').pop()}`, kind: 'inherit', certainty: 'EXTRACTED', range });
            }
        }
        return relations;
    }
}
