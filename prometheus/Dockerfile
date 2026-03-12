FROM prom/prometheus:latest
COPY prometheus.yml /etc/prometheus/prometheus.yml
EXPOSE 9090
# --storage.tsdb.path=/prometheus maps to the Fly volume mount
# Retention extended to 30d since we now have persistent storage
ENTRYPOINT ["prometheus", "--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=30d", "--web.enable-lifecycle"]
