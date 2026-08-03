#!/bin/sh
# Transparent egress allow-list for the harness (shared netns).
#
#   1. dnsmasq (port 5353) is the only resolver: it forwards ONLY ALLOW_DOMAINS to
#      UPSTREAM_DNS (tagging the resolved IPs into ipset `allowed`) and answers
#      NXDOMAIN for every other name — an unlisted lookup never reaches upstream, so
#      a DNS-tunnel query name cannot exfiltrate.
#   2. iptables redirects all :53 in this netns to dnsmasq (inserted ABOVE Docker's
#      DOCKER_OUTPUT, which special-cases 127.0.0.11), and default-DENIES egress
#      except lo, established, DNS, and destinations in `allowed`.
#
# Net effect: the harness reaches ONLY anthropic.com (Telegram optional, behind
# EGRESS_ALLOW_TELEGRAM=1); anything else (incl. a prompt-injected exfil attempt) is
# dropped at both the DNS and the IP layer. Fail-closed: unlisted names resolve to
# nothing and unlisted IPs are refused, not leaked.
set -e

ALLOW_DOMAINS_DEFAULT="anthropic.com"
ALLOW_DOMAINS="$(printf '%s' "${ALLOW_DOMAINS:-$ALLOW_DOMAINS_DEFAULT}" | tr -d '[:space:]')"
UPSTREAM_DNS="${UPSTREAM_DNS:-1.1.1.1}"
EGRESS_SELF_TEST="${EGRESS_SELF_TEST:-1}"
EGRESS_SELF_TEST_BLOCKED_URL="${EGRESS_SELF_TEST_BLOCKED_URL:-https://example.com/}"
EGRESS_SELF_TEST_ALLOW_URLS="${EGRESS_SELF_TEST_ALLOW_URLS:-}"
# Static (non-DNS) allow-list: extra IPs/CIDRs the harness may reach, plus an opt-in to
# auto-allow the host gateway (host.docker.internal) for a host-side local model
# (LLM_PROVIDER=local). host.docker.internal resolves via /etc/hosts, not dnsmasq, so its
# IP never lands in the DNS-driven `allowed` set. The ipset entry authorizes the PROXY's
# forward leg to the host model; the worker itself only ever dials loopback.
EGRESS_ALLOW_CIDRS="${EGRESS_ALLOW_CIDRS:-}"
EGRESS_ALLOW_HOST_DOCKER_INTERNAL="${EGRESS_ALLOW_HOST_DOCKER_INTERNAL:-0}"
# Telegram egress is off by default; the tg-bot profile sets EGRESS_ALLOW_TELEGRAM=1 to
# append api.telegram.org to the allow-list (the proxy still pins the recipient chat_id).
EGRESS_ALLOW_TELEGRAM="${EGRESS_ALLOW_TELEGRAM:-0}"

log() {
  echo "egress-gw: $*" >&2
}

provider_probe_url() {
  case "${LLM_PROVIDER:-claude}" in
    anthropic|claude)
      echo "https://api.anthropic.com/"
      ;;
    local|*)
      # No fixed cloud endpoint (local's host model may not be up at gateway start),
      # so the self-test does not probe it — the blocked-probe still runs.
      echo ""
      ;;
  esac
}

curl_reaches() {
  curl --noproxy '*' -sS -o /dev/null --connect-timeout 3 --max-time 8 "$1"
}

assert_reaches() {
  url="$1"
  if curl_reaches "$url"; then
    log "self-test allowed ok: $url"
    return 0
  fi
  log "self-test allowed FAILED: $url"
  return 1
}

assert_blocked() {
  url="$1"
  if curl --noproxy '*' -sS -o /dev/null --connect-timeout 1 --max-time 3 "$url" >/dev/null 2>&1; then
    log "self-test blocked FAILED: $url was reachable"
    return 1
  fi
  log "self-test blocked ok: $url"
}

run_self_test() {
  if [ -n "$EGRESS_SELF_TEST_ALLOW_URLS" ]; then
    for url in $(printf '%s' "$EGRESS_SELF_TEST_ALLOW_URLS" | tr ',' ' '); do
      assert_reaches "$url"
    done
  else
    probe_url="$(provider_probe_url)"
    [ -n "$probe_url" ] && assert_reaches "$probe_url"
  fi
  assert_blocked "$EGRESS_SELF_TEST_BLOCKED_URL"
}

run_healthcheck() {
  ipset list allowed >/dev/null 2>&1
  ipset list allowed_cidrs >/dev/null 2>&1
  pgrep dnsmasq >/dev/null
  # The credential-custody proxy is a hard dependency for claude/Telegram: a dead proxy
  # means the worker silently cannot reach its provider, so fail the healthcheck loudly.
  curl --noproxy '*' -sf -o /dev/null --max-time 3 "http://127.0.0.1:${PROXY_HEALTH_PORT:-8790}/"
  [ "$EGRESS_SELF_TEST" = "0" ] || run_self_test
}

if [ "${1:-}" = "healthcheck" ]; then
  run_healthcheck
  exit 0
fi

# Telegram egress is opt-in (tg-bot profile). Append it here so it flows into both the
# ipset tag (IPSET_ARG) and the dnsmasq allow (DNS_SERVER_ARGS) built below.
if [ "$EGRESS_ALLOW_TELEGRAM" = "1" ]; then
  ALLOW_DOMAINS="$ALLOW_DOMAINS,api.telegram.org"
fi

ipset create allowed hash:ip timeout 3600 2>/dev/null || ipset flush allowed
ipset create allowed_cidrs hash:net family inet 2>/dev/null || ipset flush allowed_cidrs
IPSET_ARG="/$(echo "$ALLOW_DOMAINS" | tr ',' '/')/allowed"

# Resolve ONLY the allow-listed domains (and their subdomains) upstream; a matching
# --server=/dom/ takes precedence over the bare --address=/#/ added at dnsmasq
# start, so unlisted names answer NXDOMAIN locally and never forward their query
# name upstream (closes the DNS-tunnel exfil channel).
DNS_SERVER_ARGS=""
for _d in $(printf '%s' "$ALLOW_DOMAINS" | tr ',' ' '); do
  [ -n "$_d" ] && DNS_SERVER_ARGS="$DNS_SERVER_ARGS --server=/$_d/$UPSTREAM_DNS"
done

# Static IP/CIDR allow-list for NON-DNS destinations (e.g. a host-side local model
# reached as host.docker.internal). That name resolves via /etc/hosts (compose
# extra_hosts: host-gateway), NOT via dnsmasq, so its IP never lands in the DNS-driven
# `allowed` set — add it (and any EGRESS_ALLOW_CIDRS) to a set the firewall also accepts.
if [ "$EGRESS_ALLOW_HOST_DOCKER_INTERNAL" = "1" ]; then
  host_gw_ip="$(grep -m1 'host.docker.internal' /etc/hosts 2>/dev/null | awk '{print $1}')"
  if [ -n "$host_gw_ip" ]; then
    ipset add allowed_cidrs "$host_gw_ip" -exist
    log "allowed host.docker.internal -> $host_gw_ip"
    log "local model endpoint: 127.0.0.1:${PROXY_LOCAL_PORT:-11434} -> ${LOCAL_UPSTREAM_HOST:-host.docker.internal}:${LOCAL_UPSTREAM_PORT:-11434} (proxy forward; firewall opened for $host_gw_ip)"
  else
    log "warning: EGRESS_ALLOW_HOST_DOCKER_INTERNAL=1 but host.docker.internal is not in /etc/hosts (set compose extra_hosts: \"host.docker.internal:host-gateway\")"
  fi
fi
for cidr in $(printf '%s' "$EGRESS_ALLOW_CIDRS" | tr ',' ' '); do
  [ -n "$cidr" ] && ipset add allowed_cidrs "$cidr" -exist && log "allowed cidr $cidr"
done

# dnsmasq runs as this unprivileged user (NOT root); it keeps CAP_NET_ADMIN for the
# ipset writes. We exclude ITS uid (not root) from the DNS redirect so its own
# upstream queries reach UPSTREAM_DNS instead of looping back into itself.
DNS_UID="$(id -u egw)"

# ── DNS: send everyone's :53 to dnsmasq. INSERT at the top so it runs before
# Docker's DOCKER_OUTPUT (which intercepts 127.0.0.11:53).
iptables -t nat -I OUTPUT 1 -p udp --dport 53 -j REDIRECT --to-ports 5353
iptables -t nat -I OUTPUT 1 -p tcp --dport 53 -j REDIRECT --to-ports 5353
iptables -t nat -I OUTPUT 1 -p udp --dport 53 -m owner --uid-owner "$DNS_UID" -j RETURN
iptables -t nat -I OUTPUT 1 -p tcp --dport 53 -m owner --uid-owner "$DNS_UID" -j RETURN

# ── Egress filter: default-deny, allow only lo / established / DNS / allow-listed.
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed dst -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed_cidrs dst -j ACCEPT
iptables -A OUTPUT -j DROP

# Block IPv6 egress (the allow-list is IPv4/ipset only), forcing clients onto the
# allow-listed IPv4 path. If the container actually has a global IPv6 address the
# DROP must succeed — otherwise egress would bypass the allow-list over an
# unfiltered AAAA route the IPv4 self-test cannot see — so fail closed. With no
# IPv6 stack (or no ip6tables), stay best-effort.
if ip -6 addr show scope global 2>/dev/null | grep -q 'inet6'; then
  ip6tables -A OUTPUT -o lo -j ACCEPT || { log "FATAL: ip6tables lo ACCEPT failed with IPv6 present"; exit 1; }
  ip6tables -A OUTPUT -j DROP || { log "FATAL: IPv6 present but ip6tables DROP failed — egress would bypass the allow-list"; exit 1; }
else
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -j DROP 2>/dev/null || true
fi

# shellcheck disable=SC2086  # intentional word-splitting of DNS_SERVER_ARGS
dnsmasq -k --user=egw --pid-file= --port=5353 --no-resolv \
  $DNS_SERVER_ARGS --address=/#/ \
  --ipset="$IPSET_ARG" --log-facility=- &
DNSMASQ_PID="$!"
trap 'kill "$DNSMASQ_PID" 2>/dev/null || true' INT TERM EXIT
sleep 1
pgrep dnsmasq >/dev/null

# Credential-custody origin proxy: holds the anthropic + Telegram secrets and terminates
# plain HTTP on loopback for the worker (which shares this netns). Runs as the entrypoint
# uid (root), NOT egw — the DNS-redirect RETURN exemption at the top is scoped to egw, so a
# root-owned proxy IS redirected through dnsmasq and its api.anthropic.com lookup lands in
# the `allowed` ipset (an egw-owned proxy would bypass tagging and be default-denied).
node --max-old-space-size=64 /proxy.mjs &
PROXY_PID="$!"
trap 'kill "$DNSMASQ_PID" "$PROXY_PID" 2>/dev/null || true' INT TERM EXIT

[ "$EGRESS_SELF_TEST" = "0" ] || run_self_test

log "allow-list [$ALLOW_DOMAINS] upstream=$UPSTREAM_DNS (dnsmasq uid $DNS_UID); proxy pid $PROXY_PID"
wait "$DNSMASQ_PID"
