FROM prom/prometheus:latest
COPY prometheus.yml /etc/prometheus/prometheus.yml
EXPOSE 9090
ENTRYPOINT ["prometheus", "--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=7d", "--web.enable-lifecycle"]
