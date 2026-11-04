#!/usr/bin/env bash
set -euo pipefail

compose_file="${1:-${OPS_COMPOSE_FILE:-}}"
if [[ -z "$compose_file" || ! -r "$compose_file" ]]; then
  printf 'active_analysis_check=blocked reason=compose_file_unavailable\n' >&2
  exit 2
fi

backend_id="$(docker compose -f "$compose_file" ps --status running -q backend | sed -n '1p')"
if [[ -z "$backend_id" ]]; then
  printf 'active_analysis_check=blocked reason=backend_not_running\n' >&2
  exit 2
fi

query="$(cat <<'NODE'
const mysql=require("mysql2/promise");
(async()=>{
  const db=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  try {
    const [rows]=await db.query("SELECT (SELECT COUNT(*) FROM analysis_run WHERE stage IN ('detecting','searching','explaining')) AS active_runs, (SELECT COUNT(*) FROM analysis_request WHERE stage IN ('received','deidentifying','structuring')) AS active_requests");
    const {active_runs,active_requests}=rows[0];
    console.log(`active_runs=${active_runs} active_requests=${active_requests}`);
    if (Number(active_runs)+Number(active_requests)>0) process.exitCode=3;
  } finally { await db.end(); }
})().catch(error=>{ console.error(`active_analysis_check=blocked reason=${error.message}`); process.exitCode=2; });
NODE
)"

docker exec "$backend_id" node -e "$query"
