import { describe, expect, test } from 'vitest';
import { buildPrompt, validateAgentReport, type SnapshotFileInput } from '../../src/main/agents/report';

function makeFile(overrides: Partial<SnapshotFileInput> = {}): SnapshotFileInput {
  return {
    path: 'src/app.ts',
    fingerprint: 'fp-1',
    previousContent: 'old\n',
    currentContent: 'line1\nline2\nline3\n',
    diff: '@@ -1 +1,3 @@\n-old\n+line1\n+line2\n+line3\n',
    ...overrides
  };
}

const VALID_REPORT = {
  summary: '审查了一处修改',
  coverage: ['src/app.ts'],
  limitations: [],
  findings: [
    {
      kind: 'issue',
      severity: 'P1',
      path: 'src/app.ts',
      start_line: 2,
      end_line: 3,
      title: '缺少错误处理',
      body: '当请求失败时会抛出未处理异常',
      evidence: 'line2 直接返回 res.json()',
      suggestion: '补充 try/catch'
    }
  ]
};

describe('validateAgentReport', () => {
  test('maps a valid report to contract findings bound to file fingerprints', () => {
    const report = validateAgentReport(VALID_REPORT, [makeFile()]);
    expect(report.summary).toBe('审查了一处修改');
    expect(report.coverage).toEqual(['src/app.ts']);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0]!;
    expect(finding).toMatchObject({
      kind: 'issue',
      priority: 'P1',
      fileId: 'src/app.ts',
      side: 'current',
      startLine: 2,
      endLine: 3,
      disposition: 'open'
    });
    expect(finding.id).not.toBe('');
    expect(finding.fingerprint).toBe('fp-1');
  });

  test('zero findings with complete coverage is a valid empty report', () => {
    const report = validateAgentReport({...VALID_REPORT, findings: []}, [makeFile()]);
    expect(report.findings).toEqual([]);
  });

  test('incomplete coverage is rejected', () => {
    const file = makeFile({path: 'b.ts'});
    expect(() =>
      validateAgentReport({...VALID_REPORT, coverage: []}, [file])
    ).toThrow(/覆盖不完整/);
  });

  test('coverage outside the provided file set is rejected', () => {
    expect(() =>
      validateAgentReport({...VALID_REPORT, coverage: ['src/app.ts', 'other.ts']}, [makeFile()])
    ).toThrow(/覆盖不完整/);
  });

  test('finding path outside scope is rejected', () => {
    const report = structuredClone(VALID_REPORT) as typeof VALID_REPORT;
    (report.findings[0] as {path: string}).path = 'nope.ts';
    expect(() => validateAgentReport(report, [makeFile()])).toThrow(/不在本次范围/);
  });

  test('line numbers beyond current content are rejected', () => {
    const report = structuredClone(VALID_REPORT) as typeof VALID_REPORT;
    (report.findings[0] as {end_line: number}).end_line = 99;
    expect(() => validateAgentReport(report, [makeFile()])).toThrow(/行号/);
  });

  test('invalid kind or severity is rejected', () => {
    const report = structuredClone(VALID_REPORT) as typeof VALID_REPORT;
    (report.findings[0] as {kind: string}).kind = 'tip';
    expect(() => validateAgentReport(report, [makeFile()])).toThrow(/类型或优先级/);
    const report2 = structuredClone(VALID_REPORT) as typeof VALID_REPORT;
    (report2.findings[0] as {severity: string}).severity = 'P0';
    expect(() => validateAgentReport(report2, [makeFile()])).toThrow(/类型或优先级/);
  });

  test('duplicate findings are rejected', () => {
    const duplicated = {...VALID_REPORT, findings: [VALID_REPORT.findings[0], VALID_REPORT.findings[0]]};
    expect(() => validateAgentReport(duplicated as typeof VALID_REPORT, [makeFile()])).toThrow(/重复/);
  });

  test('non-object input like truncated JSON is rejected', () => {
    expect(() => validateAgentReport('半个 JSON' as unknown, [makeFile()])).toThrow(/格式不完整/);
    expect(() => validateAgentReport(null, [makeFile()])).toThrow(/格式不完整/);
  });

  test('empty required finding text is rejected', () => {
    const report = structuredClone(VALID_REPORT) as typeof VALID_REPORT;
    (report.findings[0] as {evidence: string}).evidence = '  ';
    expect(() => validateAgentReport(report, [makeFile()])).toThrow(/缺少意见内容/);
  });
});

describe('buildPrompt', () => {
  test('embeds numbered current lines, base content and diff; declares untrusted data', () => {
    const prompt = buildPrompt([makeFile()], 'abc123');
    expect(prompt).toContain('不可信的数据');
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('"n":1');
    expect(prompt).toContain('line1');
    expect(prompt).toContain('"previous_content":"old');
    expect(prompt).toContain('"diff"');
    expect(prompt).toContain('abc123');
  });

  test('files without diff (untracked) are still fully described', () => {
    const prompt = buildPrompt([makeFile({diff: null, previousContent: null})], null);
    expect(prompt).toContain('"diff":null');
    expect(prompt).toContain('"previous_content":null');
  });
});
