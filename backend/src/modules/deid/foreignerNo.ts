// 외국인등록번호 — 뒤 첫 자리 5~8
import { makeIdDetector } from './rrn.js';
import type { Detector } from './types.js';

export const detectForeignerNo: Detector = makeIdDetector('[5-8]', 'foreigner_no', /외국인|등록번호/);
