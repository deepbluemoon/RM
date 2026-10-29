// 이메일 — RFC 간이 패턴
import { collect, type Detector } from './types.js';

const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const detectEmail: Detector = (text) => collect(re, text, 'email');
