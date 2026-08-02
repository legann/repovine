# Egress allow-list gateway: the harness shares this container's network namespace
# (network_mode: "service:egress-gw") so ALL its traffic passes this filter.
# dnsmasq resolves only via the upstream and tags allow-listed domains' IPs into an
# ipset; iptables then default-denies egress except to those IPs (+ DNS + lo). A loopback
# origin proxy (proxy.mjs, node) also terminates HTTP for the worker and holds the real
# anthropic/Telegram secrets — transparent filter + secret-injecting proxy, fail-closed.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates curl dnsmasq ipset iptables ip6tables jq nodejs \
  && adduser -D -H -u 65000 egw
COPY entrypoint.sh /entrypoint.sh
COPY proxy.mjs /proxy.mjs
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
