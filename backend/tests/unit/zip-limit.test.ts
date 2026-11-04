import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { archiveXmlWithinLimit } from '../../src/modules/extract/zipLimit.js';

describe('압축 문서 XML 크기 제한', () => {
  it('압축된 크기가 작아도 실제로 풀린 XML이 한도를 넘으면 거절한다', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '가'.repeat(20_000));
    const compressed = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const loaded = await JSZip.loadAsync(compressed);
    expect(compressed.length).toBeLessThan(10_000);
    expect(await archiveXmlWithinLimit(loaded, 10_000)).toBe(false);
    expect(await archiveXmlWithinLimit(loaded, 100_000)).toBe(true);
  });
  it('HTML은 파싱 전에 별도 크기 한도를 적용한다', async () => {
    process.env.RAW_FILE_KEY ??= '0'.repeat(64); // 사전 검사 모듈의 테스트용 환경 값
    const { HTML_MAX_BYTES, precheck } = await import('../../src/modules/intake/precheck.js');
    const oversized = Buffer.concat([Buffer.from('<html>'), Buffer.alloc(HTML_MAX_BYTES, 0x61)]);
    const result = await precheck(oversized, 'terms.html', ['html']);
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('too_large');
    expect(result.checks.find((c) => c.check === 'size')?.passed).toBe(false);
  });
});
