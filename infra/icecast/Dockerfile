# Multi-arch (amd64/arm64) Icecast built on Alpine.
FROM alpine:3.22

RUN apk add --no-cache icecast gettext mailcap \
    && mkdir -p /var/log/icecast \
    && chown -R icecast:icecast /var/log/icecast /usr/share/icecast

COPY icecast.xml.template /etc/icecast/icecast.xml.template
COPY --chown=icecast:icecast stats.xsl /usr/share/icecast/web/stats.xsl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
USER icecast
ENTRYPOINT ["/entrypoint.sh"]
