#!/bin/zsh

cd "$(dirname "$0")" || exit 1

base_url="http://localhost:4173"
page_url="$base_url/"

if curl --silent --fail "$base_url/api/health" >/dev/null 2>&1; then
  open "$page_url"
  exit 0
fi

CI=true npm run db:local || exit 1
npm start &
server_pid=$!

for attempt in {1..40}; do
  if curl --silent --fail "$base_url/api/health" >/dev/null 2>&1; then
    open "$page_url"
    wait "$server_pid"
    exit $?
  fi
  sleep 0.25
done

echo "เปิด Face Shelf ไม่สำเร็จ กรุณาตรวจสอบข้อความ error ด้านบน"
wait "$server_pid"
