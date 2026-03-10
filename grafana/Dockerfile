FROM grafana/grafana:latest
USER root
RUN mkdir -p /etc/grafana/provisioning/datasources \
             /etc/grafana/provisioning/dashboards
COPY provisioning/datasources/prometheus.yml /etc/grafana/provisioning/datasources/prometheus.yml
COPY provisioning/dashboards/dashboard.yml   /etc/grafana/provisioning/dashboards/dashboard.yml
COPY provisioning/dashboards/solar_farm.json /etc/grafana/provisioning/dashboards/solar_farm.json
USER grafana
EXPOSE 3000
