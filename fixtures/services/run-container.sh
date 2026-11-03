set -eu
printf '%s\n' "${LOG_VALUE-}"
printf 'tmpfs' > /data/value
mkdir -p /www
printf '{"port":"%s","origin":"%s","state":"%s"}' "$PORT" "$APP_ORIGIN" "$DATA" > /www/index.html
exec httpd -f -p "$PORT" -h /www
