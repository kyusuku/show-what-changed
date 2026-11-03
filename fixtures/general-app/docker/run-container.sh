set -eu
printf '%s\n' "${LOG_VALUE-}"
printf 'bounded image volume\n' > /data/value
attempts=0
until nc -w 1 "$DB_HOST" "$DB_PORT" </dev/null >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then exit 1; fi
  sleep 1
done
mkdir -p /www
cp /app/index.html /www/index.html
printf 'ready\n' > /www/ready
printf '{"port":"%s","origin":"%s","state":"%s","dbHost":"%s","dbPort":"%s"}' "$PORT" "$APP_ORIGIN" "$DATA" "$DB_HOST" "$DB_PORT" > "$DATA/container-runtime.json"
exec httpd -f -p "$PORT" -h /www
