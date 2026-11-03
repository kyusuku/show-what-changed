set -eu
printf tmpfs > /data/value
mkdir -p /www
printf '{"port":"%s","origin":"%s","state":"%s","dbHost":"%s","dbPort":"%s","generated":%s}' \
  "$PORT" "$APP_ORIGIN" "$DATA" "$DB_HOST" "$DB_PORT" "$(cat /app/runtime.json)" > /www/index.html
exec httpd -f -p "$PORT" -h /www
