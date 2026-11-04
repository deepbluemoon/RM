#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
실행 중인 Node 서비스 컨테이너 안에서 CPU 시연 부하를 제어합니다.

사용법:
  bash ops-dashboard/scripts/demo-container-cpu-load.sh start <컨테이너명> [초]
  bash ops-dashboard/scripts/demo-container-cpu-load.sh status <컨테이너명>
  bash ops-dashboard/scripts/demo-container-cpu-load.sh stop <컨테이너명>

start의 기본 시간은 300초이며, 10~1800초만 허용합니다. 부하는 컨테이너 CPU 1개 기준 약 80%를 목표로 합니다.
USAGE
}

action="${1:-}"
container="${2:-}"
duration="${3:-300}"

if [[ "$action" != start && "$action" != status && "$action" != stop ]]; then
  usage >&2
  exit 2
fi
if [[ ! "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  printf '유효한 컨테이너 이름을 지정하세요.\n' >&2
  exit 2
fi
if [[ "$action" == start && ( ! "$duration" =~ ^[0-9]+$ || "$duration" -lt 10 || "$duration" -gt 1800 ) ]]; then
  printf '시간은 10~1800초로 지정하세요.\n' >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { printf 'Docker CLI를 찾을 수 없습니다.\n' >&2; exit 1; }
docker inspect "$container" >/dev/null 2>&1 || { printf '컨테이너를 찾을 수 없습니다: %s\n' "$container" >&2; exit 1; }
running="$(docker inspect --format '{{.State.Running}}' "$container")"
[[ "$running" == true ]] || { printf '실행 중인 컨테이너만 대상으로 할 수 있습니다: %s\n' "$container" >&2; exit 1; }

worker_code='const fs=require("node:fs");
const pidFile="/tmp/rm-ops-demo-cpu-load.pid";
const duration=Number(process.argv[1]);
function log(level,message,fields={}) {
  const line=JSON.stringify({time:new Date().toISOString(),level,message,demo:true,...fields})+"\n";
  try { fs.writeFileSync(level==="ERROR"?"/proc/1/fd/2":"/proc/1/fd/1",line); }
  catch { process.stderr.write(line); }
}
try {
  const fd=fs.openSync(pidFile,"wx");
  fs.writeSync(fd,String(process.pid));
  fs.closeSync(fd);
} catch (error) {
  if (error.code === "EEXIST") { log("WARNING","시연 부하가 이미 실행 중입니다."); process.exit(3); }
  throw error;
}
let stopped=false;
function stop() {
  if (stopped) return;
  stopped=true;
  log("INFO","시연 CPU 부하를 종료합니다.",{pid:process.pid});
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
}
process.on("SIGTERM",stop);
process.on("SIGINT",stop);
setTimeout(stop,duration*1000);
log("INFO","시연 CPU 부하를 시작합니다.",{pid:process.pid,targetPercent:80,durationSeconds:duration});
log("WARNING","CPU 사용률 상승은 시연을 위해 의도된 상태입니다.",{targetPercent:80});
setTimeout(()=>log("ERROR","DEMO ONLY: 예시 오류 로그이며 실제 서비스 오류가 아닙니다.",{code:"DEMO-CPU-LOAD-ERROR"}),Math.min(5000,duration*500));
function cycle() {
  const cycleStart=performance.now();
  const busyUntil=cycleStart+800;
  let value=0;
  while (performance.now()<busyUntil) value=(value+1)|0;
  setTimeout(cycle,Math.max(0,1000-(performance.now()-cycleStart)));
}
cycle();'

case "$action" in
  start)
    docker exec -d "$container" node -e "$worker_code" "$duration"
    sleep 1
    docker exec "$container" node -e 'const fs=require("node:fs"); const p="/tmp/rm-ops-demo-cpu-load.pid"; if (!fs.existsSync(p)) process.exit(1); console.log(`running pid=${fs.readFileSync(p,"utf8")} auto_stop_seconds=${process.argv[1]}`)' "$duration"
    ;;
  status)
    docker exec "$container" node -e 'const fs=require("node:fs"); const p="/tmp/rm-ops-demo-cpu-load.pid"; if (!fs.existsSync(p)) { console.log("stopped"); process.exit(0); } const pid=Number(fs.readFileSync(p,"utf8")); try { process.kill(pid,0); const cmd=fs.readFileSync(`/proc/${pid}/cmdline`,"utf8"); if (!cmd.includes("rm-ops-demo-cpu-load.pid")) throw new Error("not-demo-process"); console.log(`running pid=${pid}`); } catch { console.log("stale pid file"); process.exitCode=1; }'
    ;;
  stop)
    docker exec "$container" node -e 'const fs=require("node:fs"); const p="/tmp/rm-ops-demo-cpu-load.pid"; if (!fs.existsSync(p)) { console.log("stopped"); process.exit(0); } const pid=Number(fs.readFileSync(p,"utf8")); if (!Number.isInteger(pid) || pid<2) { fs.unlinkSync(p); throw new Error("잘못된 PID 파일"); } try { const cmd=fs.readFileSync(`/proc/${pid}/cmdline`,"utf8"); if (!cmd.includes("rm-ops-demo-cpu-load.pid")) { fs.unlinkSync(p); console.log("stopped (stale pid file)"); process.exit(0); } process.kill(pid,"SIGTERM"); console.log(`stop requested pid=${pid}`); } catch (error) { if (error.code!=="ESRCH") throw error; fs.unlinkSync(p); console.log("stopped (process was absent)"); }'
    ;;
esac
