import * as path from 'path';
import { Language, Relation } from '../../common/types';
import { AstLanguageAnalyzer } from './base';
import { NodeDeclaration, nodeRange } from '../declarations';
/** JSON·YAML·HCL·SQL·XML·Markdown의 구조와 명시적 의존성을 읽는다. */
export class StructuredLanguageAnalyzer extends AstLanguageAnalyzer {
    public readonly caseInsensitive: boolean;
    /** 데이터 형식마다 독립된 심볼 계열을 유지한다. */
    constructor(language: Language) { super(language); this.caseInsensitive = language === 'sql'; }
    /** 값·비밀정보를 심볼 이름으로 노출하지 않고 선언·키·제목만 반환한다. */
    public getDeclaration(node: any): NodeDeclaration | null {
        if (this.language === 'json' && node.type === 'pair') {
            try {
                return { name: JSON.parse(node.childForFieldName('key').text), kind: 'variable' };
            }
            catch {
                return null;
            }
        }
        if (this.language === 'yaml' && ['block_mapping_pair', 'flow_pair'].includes(node.type)) {
            const key = node.childForFieldName('key')?.text?.replace(/^['"]|['"]$/g, '');
            return key ? { name: key, kind: 'variable' } : null;
        }
        if (this.language === 'terraform' && node.type === 'block' && node.parent?.parent?.type === 'config_file') {
            const kind = node.namedChild(0)?.text;
            const labels = node.namedChildren.filter((child: any) => child.type === 'string_lit').map((child: any) => child.text.slice(1, -1));
            const name = kind === 'variable' ? `var.${labels[0]}` : kind === 'resource' ? labels.join('.') : [kind, ...labels].join('.');
            return labels.length ? { name, kind: 'module' } : null;
        }
        if (this.language === 'terraform' && node.type === 'attribute' && node.parent?.parent?.namedChild(0)?.text === 'locals') {
            const name = node.namedChild(0)?.text;
            return name ? { name: `local.${name}`, kind: 'variable' } : null;
        }
        if (this.language === 'sql' && /^create_(?:table|view|function|procedure|trigger|index)$/.test(node.type)) {
            const reference = node.namedChildren.find((child: any) => child.type === 'object_reference');
            return reference ? { name: reference.text.replace(/["`[\]]/g, ''), kind: /function|procedure|trigger/.test(node.type) ? 'function' : 'class' } : null;
        }
        if (this.language === 'markdown' && node.type === 'section') {
            const heading = node.namedChild(0);
            const name = heading?.childForFieldName('heading_content')?.text;
            return name ? { name, kind: 'module' } : null;
        }
        return null;
    }
    /** 명시적 로컬 참조만 관계로 변환하며 설정의 일반 문자열은 추정하지 않는다. */
    protected extractNodeRelations(node: any, filePath: string, _receiverTypes: Map<string, string>): Relation[] {
        const relations: Relation[] = [];
        const scope = this.getScope(node);
        const range = nodeRange(node);
        let imported = '';
        if (this.language === 'json' && node.type === 'pair' && node.childForFieldName('key')?.text === '"$ref"') {
            try {
                imported = JSON.parse(node.childForFieldName('value').text).split('#')[0];
            }
            catch { /* 비문자열 참조는 무시한다. */ }
        }
        if (this.language === 'terraform') {
            if (node.type === 'attribute' && node.namedChild(0)?.text === 'source' && node.parent?.parent?.namedChild(0)?.text === 'module') {
                const value = node.namedChild(1)?.text;
                if (/^"\.\.?\//.test(value))
                    imported = value.slice(1, -1);
            }
            if (node.type === 'expression' && node.namedChildren.some((child: any) => child.type === 'get_attr')) {
                // data는 종류·이름까지 세 부분이고 다른 참조는 두 부분이 선언 ID다.
                const target = node.text.match(/^(data\.[\w]+\.[\w]+|[\w]+\.[\w]+)/)?.[1];
                if (scope && target && !/^(?:each|count|self|path|terraform)\./.test(target))
                    relations.push({
                        id: `${filePath}::ref::${scope}->${target}@${node.startIndex}`, sourceId: `${filePath}::${scope}`, targetId: `unknown::${target}`, kind: 'reference', certainty: 'EXTRACTED', range
                    });
            }
        }
        if (this.language === 'sql' && node.type === 'relation') {
            const reference = node.namedChildren.find((child: any) => child.type === 'object_reference');
            const name = reference?.text.replace(/["`[\]]/g, '');
            if (scope && name)
                relations.push({ id: `${filePath}::ref::${scope}->${name}@${node.startIndex}`, sourceId: `${filePath}::${scope}`, targetId: `unknown::${name}`, kind: 'reference', certainty: 'EXTRACTED', range });
        }
        if (this.language === 'xml' && ['start_tag', 'self_closing_tag'].includes(node.type)) {
            const tag = node.namedChild(0)?.text;
            if (['ProjectReference', 'Import', 'Project', 'Compile', 'Page', 'Resource', 'None', 'package'].includes(tag)) {
                for (const attribute of node.namedChildren.filter((child: any) => child.type === 'attribute')) {
                    const key = attribute.namedChild(0)?.text;
                    const value = attribute.namedChild(1)?.text?.replace(/^["']|["']$/g, '');
                    if (['Include', 'Project', 'Path', 'filename'].includes(key) && value && !/[$*?]/.test(value)) {
                        relations.push(this.importRelation(value, filePath, node));
                    }
                }
            }
        }
        if (this.language === 'markdown' && node.type === 'inline') {
            const text = node.text.replace(/(`+)[\s\S]*?\1(?!`)/g, '');
            for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
                const target = match[1].split('#')[0];
                if (target && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('//'))
                    relations.push(this.importRelation(target, filePath, node));
            }
        }
        if (imported && !/^[a-z][a-z\d+.-]*:/i.test(imported) && !imported.startsWith('//'))
            relations.push(this.importRelation(imported, filePath, node));
        return relations;
    }
    /** 상대 경로를 정규화하되 원본의 줄·열 근거를 유지한다. */
    private importRelation(target: string, filePath: string, node: any): Relation {
        const imported = path.resolve(path.dirname(filePath), target.replace(/\\/g, path.sep));
        return { id: `${filePath}::import::${imported}@${node.startIndex}`, sourceId: filePath, targetId: imported, kind: 'import', certainty: 'EXTRACTED', range: nodeRange(node) };
    }
}
