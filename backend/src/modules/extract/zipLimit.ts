import type JSZip from 'jszip';
import type { Readable } from 'node:stream';

// DOCX·HWPX의 XML을 실제로 풀어 보며 제한한다. ZIP 메타데이터의 선언 크기는 신뢰하지 않는다.
export const MAX_ARCHIVE_XML_BYTES = 32 * 1024 * 1024;

export async function archiveXmlWithinLimit(zip: JSZip, maxBytes = MAX_ARCHIVE_XML_BYTES): Promise<boolean> {
  let total = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/\.(?:xml|rels|hpf)$/i.test(file.name)) continue;
    const stream = file.nodeStream() as Readable;
    // JSZip의 nodeStream은 Node Readable 인터페이스지만 async iterator는 제공하지 않는다.
    const withinLimit = await new Promise<boolean>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          resolve(false);
        }
      });
      stream.on('end', () => resolve(true));
      stream.on('error', reject);
    });
    if (!withinLimit) return false;
  }
  return true;
}
