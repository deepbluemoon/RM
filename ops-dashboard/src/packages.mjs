import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000
const MAX_OSV_BATCH = 800

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
}

function npmInventory(lock, manifest, service) {
  const direct = new Set(Object.keys(manifest.dependencies || {}))
  const items = []
  for (const [location, entry] of Object.entries(lock.packages || {})) {
    if (!location.startsWith('node_modules/') || entry.dev === true) continue
    const name = location.slice('node_modules/'.length)
    if (name.includes('/node_modules/')) continue
    items.push({ ecosystem: 'npm', name, version: entry.version, service, scope: direct.has(name) ? 'runtime' : 'transitive' })
  }
  return items
}

function pythonInventory(lockText, pyprojectText) {
  const section = (name) => {
    const heading = `[${name}]`
    const start = pyprojectText.indexOf(heading)
    if (start < 0) return ''
    const contentStart = pyprojectText.indexOf('\n', start) + 1
    const next = pyprojectText.slice(contentStart).search(/^\[/m)
    return pyprojectText.slice(contentStart, next < 0 ? undefined : contentStart + next)
  }
  const runtimeNames = new Set()
  const dependencySection = pyprojectText.match(/^dependencies\s*=\s*\[([\s\S]*?)^\]/m)?.[1] || ''
  for (const dependency of dependencySection.matchAll(/"([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?:[<>=!~;\s]|$)/g)) runtimeNames.add(normalizeName(dependency[1]))
  const optionalNames = new Set()
  const optionalSection = section('project.optional-dependencies')
  for (const list of optionalSection.matchAll(/^\s*[A-Za-z0-9_-]+\s*=\s*\[([^\]]*)\]/gm)) {
    for (const dependency of list[1].matchAll(/"([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?:[<>=!~;\s]|$)/g)) optionalNames.add(normalizeName(dependency[1]))
  }
  const devNames = new Set()
  const devSection = section('dependency-groups')
  for (const list of devSection.matchAll(/^\s*[A-Za-z0-9_-]+\s*=\s*\[([^\]]*)\]/gm)) {
    for (const dependency of list[1].matchAll(/"([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?(?:[<>=!~;\s]|$)/g)) devNames.add(normalizeName(dependency[1]))
  }
  const items = []
  const blocks = lockText.split(/^\[\[package\]\]\s*$/m).slice(1)
  for (const block of blocks) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1]
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
    const normalized = normalizeName(name)
    const scope = runtimeNames.has(normalized) ? 'runtime' : optionalNames.has(normalized) ? 'optional' : devNames.has(normalized) ? 'dev' : 'transitive'
    if (name && version) items.push({ ecosystem: 'PyPI', name, version, service: 'model-server', scope })
  }
  return items
}

export async function readPackageInventory(projectRoot) {
  const inventory = []
  for (const service of ['backend', 'frontend']) {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, service, 'package.json'), 'utf8'))
    const lockPath = path.join(projectRoot, service, 'package-lock.json')
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
    inventory.push(...npmInventory(lock, manifest, service))
  }
  const modelDir = path.join(projectRoot, 'model-server')
  inventory.push(...pythonInventory(await fs.readFile(path.join(modelDir, 'uv.lock'), 'utf8'), await fs.readFile(path.join(modelDir, 'pyproject.toml'), 'utf8')))
  const unique = new Map()
  for (const item of inventory) {
    if (item.version) unique.set(`${item.ecosystem}:${normalizeName(item.name)}:${item.version}:${item.service}`, item)
  }
  return [...unique.values()]
}

async function fetchJson(url, fetchImpl, headers = {}) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`upstream returned ${response.status}`)
  return response.json()
}

async function loadAdvisories(packages, fetchImpl) {
  const matches = []
  for (let start = 0; start < packages.length; start += MAX_OSV_BATCH) {
    const batch = packages.slice(start, start + MAX_OSV_BATCH)
    const response = await fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: batch.map((item) => ({ package: { name: item.name, ecosystem: item.ecosystem }, version: item.version })) }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`OSV returned ${response.status}`)
    const body = await response.json()
    for (let index = 0; index < batch.length; index += 1) {
      for (const advisory of body.results?.[index]?.vulns || []) {
        matches.push({
          id: advisory.id,
          package: batch[index].name,
          version: batch[index].version,
          ecosystem: batch[index].ecosystem,
          service: batch[index].service,
          scope: batch[index].scope,
          modified: advisory.modified || null,
        })
      }
    }
  }
  const ids = [...new Set(matches.map((item) => item.id))]
  const details = new Map()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++]
      try { details.set(id, await fetchJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, fetchImpl)) } catch {}
    }
  }))
  const findings = matches.map((item) => {
    const detail = details.get(item.id)
    const summary = detail?.summary || detail?.details?.split(/\n\s*\n/)[0]?.replace(/[#*`]/g, '').slice(0, 320) || '취약점 상세 정보 확인 필요'
    const fixedVersions = [...new Set((detail?.affected || []).flatMap((affected) => (affected.ranges || []).flatMap((range) => (range.events || []).map((event) => event.fixed).filter(Boolean))))]
    return {
      ...item,
      aliases: detail?.aliases || [],
      summary,
      severity: detail?.database_specific?.severity || null,
      fixedVersions,
      modified: detail?.modified || detail?.published || item.modified,
      url: `https://osv.dev/vulnerability/${encodeURIComponent(item.id)}`,
    }
  })
  return findings
}

function githubRepo(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url
  if (!value) return null
  const match = value.match(/github\.com[:/]([^/]+\/[^/#.]+?)(?:\.git)?(?:[#/].*)?$/i)
  return match?.[1] || null
}

async function latestRelease(item, fetchImpl, githubToken) {
  try {
    let metadata
    if (item.ecosystem === 'npm') {
      metadata = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(item.name)}/latest`, fetchImpl)
    } else {
      metadata = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(item.name)}/json`, fetchImpl)
      metadata = { version: metadata.info?.version, description: metadata.info?.summary, project_urls: metadata.info?.project_urls }
    }
    const latestVersion = metadata.version
    if (!latestVersion || latestVersion === item.version) return null
    const urls = metadata.project_urls || {}
    const repo = githubRepo(metadata.repository) || githubRepo(urls.Source) || githubRepo(urls.Repository) || githubRepo(urls['Source Code'])
    let release = null
    if (repo) {
      try {
        const headers = { accept: 'application/vnd.github+json' }
        if (githubToken) headers.authorization = `Bearer ${githubToken}`
        const data = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, fetchImpl, headers)
        release = { title: data.name || data.tag_name, notes: String(data.body || '').trim().slice(0, 1800), url: data.html_url, publishedAt: data.published_at }
      } catch {}
    }
    return {
      package: item.name,
      ecosystem: item.ecosystem,
      service: item.service,
      scope: item.scope,
      installedVersion: item.version,
      latestVersion,
      description: metadata.description || '',
      release: release || { title: `v${latestVersion}`, notes: '', url: urls.Changelog || urls['Release Notes'] || urls.Source || urls.Repository || null, publishedAt: null },
      source: item.ecosystem === 'npm' ? `https://www.npmjs.com/package/${encodeURIComponent(item.name)}` : `https://pypi.org/project/${encodeURIComponent(item.name)}/`,
    }
  } catch {
    return null
  }
}

export function createPackageMonitor({ projectRoot, fetchImpl = fetch, refreshMs = DEFAULT_REFRESH_MS, githubToken = '' }) {
  let snapshot = { status: 'loading', checkedAt: null, packageCount: 0, advisories: [], releases: [], errors: [] }
  let refreshing = false

  async function refresh() {
    if (refreshing) return snapshot
    refreshing = true
    try {
      const inventory = await readPackageInventory(projectRoot)
      const direct = inventory.filter((item) => ['runtime', 'optional'].includes(item.scope))
      const errors = []
      const [advisories, releases] = await Promise.all([
        loadAdvisories(inventory, fetchImpl).catch((error) => { errors.push(`OSV: ${error.message}`); return [] }),
        Promise.all(direct.map((item) => latestRelease(item, fetchImpl, githubToken))),
      ])
      snapshot = {
        status: errors.length === 0 ? 'ready' : advisories.length || releases.some(Boolean) ? 'partial' : 'unavailable',
        checkedAt: new Date().toISOString(),
        packageCount: inventory.length,
        advisories,
        releases: releases.filter(Boolean).sort((a, b) => (b.release.publishedAt || '').localeCompare(a.release.publishedAt || '')),
        errors,
      }
    } catch (error) {
      snapshot = { ...snapshot, status: 'unavailable', checkedAt: new Date().toISOString(), errors: [error.message] }
    } finally {
      refreshing = false
    }
    return snapshot
  }

  const timer = setInterval(() => { void refresh() }, refreshMs)
  timer.unref?.()
  return { getSnapshot: () => snapshot, refresh, close: () => clearInterval(timer) }
}
