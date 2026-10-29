// 전화번호 — 휴대(010 등), 유선(02·0XX), 인터넷(070), 대표번호(15XX·16XX·18XX, 하이픈 표기만)
import { collect, NA, NB, type Detector } from './types.js';

const mobile = new RegExp(`${NB}01[016789][-. )]?\\s?\\d{3,4}[-. ]?\\d{4}${NA}`, 'g');
const landline = new RegExp(`${NB}\\(?0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70|50\\d)\\)?[-. )]?\\s?\\d{3,4}[-. ]\\d{4}${NA}`, 'g');
const rep = new RegExp(`${NB}1[5-9]\\d{2}-\\d{4}${NA}`, 'g');
const intl = new RegExp(`\\+82[- ]?1?0?[- ]?\\d{1,2}[- ]?\\d{3,4}[- ]?\\d{4}${NA}`, 'g');

export const detectPhone: Detector = (text) => [
  ...collect(mobile, text, 'phone'),
  ...collect(landline, text, 'phone'),
  ...collect(rep, text, 'phone'),
  ...collect(intl, text, 'phone'),
];
