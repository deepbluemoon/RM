import test from 'node:test'
import assert from 'node:assert/strict'
import { wallSummary, chartSegments } from '../src/public/monitor-data.js'
test('모니터링은 누락·중단·오래된 관측을 0으로 표시하지 않는다',()=>{
 const data={observedAt:1000,dockerAvailable:true,containers:[{running:true,stats:{cpuPercent:0,memoryUsedBytes:1048576}},{running:false,stats:{cpuPercent:100}}]}
 assert.equal(wallSummary(data,2000).cpu,0)
 assert.equal(wallSummary(data,2000).memory,1048576)
 assert.equal(wallSummary(data,22000).running,null)
 assert.equal(wallSummary({...data,dockerAvailable:false},2000).cpu,null)
 data.containers.push({running:true,stats:null})
 assert.equal(wallSummary(data,2000).cpu,null)
 assert.equal(wallSummary(data,2000).memory,null)
})
test('미수집 구간은 추이 선으로 연결하지 않는다',()=>{
 const points=chartSegments([{at:1,cpu:1},{at:2,cpu:null},{at:3,cpu:2}],'cpu',300000,10)
 assert.equal(points.length,2)
 assert.ok(points.every(point=>!point.includes('NaN')))
})
