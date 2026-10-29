/** 경과 초 → mm:ss (60분 이상이면 h:mm:ss) */
export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`
}

/** 'YYYY-MM-DD' 또는 ISO → 'MM-DD' */
export function mmdd(date: string | null | undefined): string {
  if (!date) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  return m ? `${m[2]}-${m[3]}` : date
}

export function ymd(date: string | null | undefined): string {
  if (!date) return ''
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(date)
  return m ? m[1] : date
}

/** ISO → 'YYYY-MM-DD HH:mm' (로컬 시각) */
export function ymdhm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function hm(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 초 → "약 N초" / "약 N분" */
export function approxDuration(sec: number | null | undefined): string {
  if (sec == null) return ''
  if (sec < 90) return `약 ${Math.max(1, Math.round(sec))}초`
  return `약 ${Math.round(sec / 60)}분`
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return ''
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}

/** 공정위 사례 이름(2026-09-30) — 식별번호(FTC-2023-12-18-43165 등)는 보이지 않게 떼고, 이름이 없으면 '공정위 사례' */
export function caseTitle(sourceName: string | null | undefined): string {
  const name = (sourceName ?? '')
    .replace(/\(\s*FTC-[0-9A-Za-z-]+\s*\)/g, '')
    .replace(/FTC-[0-9A-Za-z-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return name || '공정위 사례'
}

/** 근거 이름 한 줄 — 공정위 사례(식별번호가 FTC-…)면 사건 이름만, 그 밖에는 '출처 조항' */
export function evidenceName(sourceName: string | null | undefined, identifier: string | null | undefined): string {
  if (/^FTC-/.test(identifier ?? '') || /FTC-\d/.test(sourceName ?? '')) return caseTitle(sourceName)
  return [sourceName, identifier].filter(Boolean).join(' ')
}
