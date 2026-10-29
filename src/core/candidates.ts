import * as path from 'path';
import { SymbolInfo } from '../common/types';

/** 경로가 테스트 디렉터리 또는 테스트 파일 명명 규칙에 해당하는지 판별한다. */
function isTestPath(filePath: string): boolean {
    if (!filePath) return false;
    const norm = filePath.replace(/\\/g, '/');
    const parts = norm.split('/');
    if (parts.some(seg => ['test', 'tests', 'spec', 'specs', '__tests__', '.test'].includes(seg.toLowerCase()))) {
        return true;
    }
    const base = parts[parts.length - 1] || '';
    return /^(test_.*|.*_test\..+|.*\.test\..+|.*\.spec\..+|.*_spec\..+|.*Tests?\.java|.*Tests\.cs)$/i.test(base);
}

/** 다중 동명 심볼 후보를 비테스트 우선 규칙과 경로 근접도(같은 파일 -> 같은 폴더 -> 최장 공통 접두사)로 단일화한다. */
export function disambiguateCandidates(candidates: SymbolInfo[], callSiteFile: string): SymbolInfo | null {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const sourceFile = callSiteFile.replace(/\\/g, '/');
    const files = new Map(candidates.map(candidate => [candidate.id, candidate.filePath.replace(/\\/g, '/')]));

    const callerIsTest = isTestPath(callSiteFile);
    const testCands = candidates.filter(c => isTestPath(c.filePath));
    const nonTestCands = candidates.filter(c => !isTestPath(c.filePath));

    let survivors: SymbolInfo[];
    if (callerIsTest) {
        const sameFileTest = testCands.filter(c => files.get(c.id) === sourceFile);
        if (sameFileTest.length === 1) return sameFileTest[0];
        survivors = testCands.length > 0 ? testCands : nonTestCands;
    } else {
        survivors = nonTestCands;
    }
    if (survivors.length === 1) return survivors[0];
    if (survivors.length === 0) return null;
    if (!sourceFile) return null;

    const sameFile = survivors.filter(c => files.get(c.id) === sourceFile);
    if (sameFile.length === 1) return sameFile[0];
    if (sameFile.length > 1) return null;

    const callDir = path.posix.dirname(sourceFile);
    const sameDir = survivors.filter(c => path.posix.dirname(files.get(c.id)!) === callDir);
    if (sameDir.length === 1) return sameDir[0];
    if (sameDir.length > 1) return null;

    const callParts = callDir.split('/');
    const scored = survivors.map(c => {
        const parts = path.posix.dirname(files.get(c.id)!).split('/');
        let common = 0;
        for (let i = 0; i < Math.min(callParts.length, parts.length); i++) {
            if (callParts[i] === parts[i]) common++;
            else break;
        }
        return { cand: c, common };
    }).sort((a, b) => b.common - a.common);

    if (scored[0].common > 0 && (scored.length === 1 || scored[0].common > scored[1].common)) {
        return scored[0].cand;
    }
    return null;
}
