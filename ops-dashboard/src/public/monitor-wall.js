import { wallSummary, chartSegments } from './monitor-data.js'
import { topContainerMetrics } from './metric-display.js'
import { httpChartData } from './http-chart.js'
const $ = id => document.getElementById(id)
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const number = value => Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : '—'
const memory = bytes => Number.isFinite(bytes) ? bytes >= 1073741824 ? `${number(bytes / 1073741824)} GiB` : `${number(bytes / 1048576)} MiB` : '—'
const time = at => new Date(at).toLocaleTimeString('en-GB', { hour12:false })
const colors = { '1xx':'#8da3ad', '2xx':'#28ce82', '3xx':'#89a7ee', '4xx':'#f4b858', '5xx':'#ff6c7d' }
let lastAvailable = false
let data = null, failed = false, metric = 'cpu', page = 0, samples = [], lastSample = null
let fleetPages = 1, fleetTimer
try { const saved=JSON.parse(sessionStorage.getItem('rm-wall-history')||'[]'); if(Array.isArray(saved))samples=saved.filter(item=>Number.isFinite(item?.at)&&item.at>Date.now()-300000).slice(-100) } catch {}
lastSample=samples.at(-1)?.at??null
try { const cached=JSON.parse(sessionStorage.getItem('rm-overview-cache')||'null');if(cached&&Date.now()-cached.observedAt<20000)data=cached } catch {}
function renderFleet(available) {
  const containers = available ? [...data.containers].sort((a,b)=>Number(b.running)-Number(a.running)||a.name.localeCompare(b.name)) : []
  fleetPages = Math.max(1, Math.ceil(containers.length / 3))
  page = Math.min(page, fleetPages - 1)
  const visible = containers.slice(page * 3, page * 3 + 3)
  const signature = `${page}:${JSON.stringify(visible.map(item => [item.id, item.name, item.composeService, item.state, item.status, item.running]))}`
  if ($('fleet').dataset.signature !== signature) {
    $('fleet').dataset.signature = signature
    $('fleet').innerHTML = visible.map(item=>{const bad=item.status?.includes('unhealthy')||['restarting','dead'].includes(item.state);return `<div class="fleet-row"><div><b title="${escape(item.name)}">${escape(item.name)}</b><small>${escape(item.composeService||item.state||'컨테이너')}</small></div><span class="badge ${bad?'bad':item.running?'':'off'}">${bad?'확인 필요':item.running?'실행 중':'중지'}</span></div>`}).join('')||'<div class="quiet">표시할 관측 데이터가 없습니다</div>'
  }
  $('fleet-count').textContent=`전체 ${containers.length}개 · 3개씩 표시`; $('fleet-page').textContent=`${page+1} / ${fleetPages}`
  $('fleet-prev').disabled=page===0; $('fleet-next').disabled=page===fleetPages-1
}
function scheduleFleetRotation() {
  clearTimeout(fleetTimer)
  fleetTimer = setTimeout(() => {
    if (fleetPages > 1 && !document.hidden) {
      page = (page + 1) % fleetPages
      renderFleet(lastAvailable)
    }
    scheduleFleetRotation()
  }, 3000)
}
function render() {
  const summary = wallSummary(failed ? null : data)
  const available = summary.available
  lastAvailable = available
  const alerts = data?.alerts || []
  $('freshness').textContent = available ? '● LIVE · 실시간 연결' : '○ 관측 연결 확인 필요'
  $('status-tile').dataset.state = !available ? 'unknown' : alerts.length ? 'warning' : 'normal'
  $('system-status').textContent = !available ? '관측 확인 필요' : alerts.length ? `경고 ${alerts.length}건` : summary.running === 0 ? '실행 대상 없음' : '감지된 경고 없음'
  $('status-detail').textContent = !available ? '연결 실패 또는 20초 이상 갱신 지연' : alerts.length ? '오른쪽 경고에서 원인을 확인하세요' : '현재 감지된 활성 경고가 없습니다'
  $('running').textContent = number(summary.running)
  $('running-note').textContent = `전체 ${number(summary.total)}개 중`
  $('cpu').innerHTML = `${number(summary.cpu)}<small>%</small>`
  $('memory').textContent = memory(summary.memory)
  $('observed').textContent = `마지막 관측 ${data?.observedAt ? time(data.observedAt) : '—'}`
  const at = available ? data.observedAt : Date.now()
  if (available && at !== lastSample) { if(lastSample && at-lastSample>20000)samples.push({at:at-1,cpu:null,memory:null}); samples.push({at,cpu:summary.cpu,memory:summary.memory}); lastSample=at }
  else if (!available && samples.at(-1)?.cpu !== null) samples.push({at,cpu:null,memory:null})
  samples = samples.filter(item => item.at >= Date.now() - 300000).slice(-100)
  try { sessionStorage.setItem('rm-wall-history',JSON.stringify(samples)) } catch {}
  drawChart('cpu', 'var(--cyan)'); drawChart('memory', 'var(--violet)')
  $('history-start').textContent = time(Date.now()-300000)
  $('history-end').textContent = time(Date.now())
  $('history-note').textContent = samples.filter(item => Number.isFinite(item.cpu) || Number.isFinite(item.memory)).length < 2 ? '관측 데이터를 모으는 중입니다' : '빈 구간은 미수집 · 좌우 차트의 세로축 단위가 다릅니다'
  const ranking = topContainerMetrics(available ? data : null,metric)
  const max = ranking.items[0]?.value || 1
  // Keep bars alive between samples so changing widths transition smoothly.
  const order = metric + ':' + ranking.items.map(item=>item.id).join('|')
  if ($('rankings').dataset.order !== order) {
    $('rankings').dataset.order=order
    $('rankings').innerHTML = ranking.items.map(item=>`<div class="rank-row"><div class="rank-label"><span title="${escape(item.name)}">${escape(item.name)}</span><b></b></div><div class="track"><i style="width:0"></i></div></div>`).join('') || '<div class="quiet">측정된 컨테이너가 없습니다</div>'
  }
  ranking.items.forEach((item, index) => {
    const row = $('rankings').children[index]
    row.querySelector('b').textContent = metric === 'cpu' ? number(item.value) + '%' : memory(item.value)
    row.querySelector('i').style.width = item.value / max * 100 + '%'
  })
  const retained = available && data.containers.some(container => container.statsRetained)
  $('ranking-note').textContent = '측정 ' + ranking.measuredCount + '/' + ranking.runningCount + '개 · ' + (retained ? '일부 최근 측정값' : '1위 사용량 기준')
  renderFleet(available)
  const http=httpChartData(data?.statusCodes,available)
  $('http-total').textContent=http.state==='empty'?'0':number(http.total)
  if (!$('http-bar').children.length) $('http-bar').innerHTML=Object.entries(colors).map(([label,color])=>`<span data-class="${label}" style="background:${color};width:0"></span>`).join('')
  for(const node of $('http-bar').children){const value=http.bars.find(item=>item.label===node.dataset.class);node.hidden=!value;node.style.width=`${value?.percent||0}%`;node.title=`${node.dataset.class}: ${value?.count||0}건`}
  $('http-legend').innerHTML=Object.entries(colors).map(([label,color])=>{const item=http.bars.find(bar=>bar.label===label);return `<div class="legend-item"><span><i class="dot" style="color:${color}"></i>${label}</span><b>${http.state==='unavailable'?'—':`${number(item?.count||0)}건 · ${number(item?.percent||0)}%`}</b></div>`}).join('')
  $('http-note').textContent=http.state==='partial'?'일부 로그 수집 실패 · 수집된 응답만 표시':http.state==='unavailable'?'응답 데이터를 수집할 수 없습니다':http.state==='empty'?'수집 범위에서 HTTP 응답이 발견되지 않았습니다':'컨테이너 로그 수집 범위 기준 · 전체 요청량과 다를 수 있음'
  $('alert-count').textContent=available?alerts.length:'—'
  const html = !available ? '<div class="quiet"><strong>관측 상태 확인 필요</strong><span>운영 화면에서 Docker 연결을 확인하세요.</span></div>' : alerts.length ? alerts.map(item=>`<div class="alert-item"><b>${escape(item.containerName||item.code)}</b><p>${escape(item.message)}</p></div>`).join('') : '<div class="quiet"><span class="check">✓</span><strong>지금은 평온합니다</strong><span>감지된 경고가 이곳에 표시됩니다.</span></div>'
  if($('alerts').innerHTML!==html)$('alerts').innerHTML=html
}
function drawChart(field,color){
  const values=samples.map(item=>item[field]).filter(Number.isFinite)
  const max=Math.max(field==='cpu'?10:1048576,...values)*1.15
  const paths=chartSegments(samples,field,Date.now(),max)
  $(field+'-axis').textContent=`0 – ${field==='cpu'?number(max)+'%':memory(max)}`
  $(field+'-chart').innerHTML=[10,55,100,145].map(y=>`<line x1="0" x2="600" y1="${y}" y2="${y}" stroke="var(--border)" stroke-dasharray="3 5"/>`).join('')+paths.map(points=>`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`).join('')+(values.length<2?'<text x="300" y="85" text-anchor="middle">관측 데이터 수집 중</text>':'')
}
async function poll(){
  try{const response=await fetch('/api/overview',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('수집 실패');data=await response.json();try{sessionStorage.setItem('rm-overview-cache',JSON.stringify(data))}catch{};failed=false}catch{failed=true}
  render();setTimeout(poll,5000)
}
document.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{metric=button.dataset.metric;document.querySelectorAll('[data-metric]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));render()}))
$('fleet-prev').addEventListener('click',()=>{page--;renderFleet(lastAvailable);scheduleFleetRotation()});$('fleet-next').addEventListener('click',()=>{page++;renderFleet(lastAvailable);scheduleFleetRotation()})
$('fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{$('freshness').textContent='전체 화면을 지원하지 않습니다 · F11을 사용하세요'}})
document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'전체 화면 종료':'전체 화면으로 보기')})
function clock(){ $('clock').textContent=time(Date.now());$('date').textContent=new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'long'});if(lastAvailable && Date.now()-data.observedAt>20000)render() }
clock();setInterval(clock,1000);render();poll();scheduleFleetRotation()
