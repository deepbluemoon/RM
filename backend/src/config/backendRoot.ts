// backend/ 폴더 찾기 — 위로 올라가며 package.json 이 있는 첫 폴더. 소스(src/config)·빌드본(dist/src/config)·
// Docker 배치(/app/backend/src/config) 모두 같은 값이 된다(#55). 못 찾으면 fallback
import fs from 'node:fs';
import path from 'node:path';

export function findBackendRoot(from: string, fallback: string): string {
  for (let d = from; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.dirname(d) === d) return fallback;
  }
}
