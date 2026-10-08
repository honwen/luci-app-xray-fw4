#!/usr/bin/ucode
"use strict";

import { access } from "fs";
import { load_config } from "./common/config.mjs";
import { bridge_outbounds, bridge_rules, bridges } from "./feature/bridge.mjs";
import { dokodemo_inbound, extra_inbound_balancers, extra_inbound_global, extra_inbound_rules, extra_inbounds, http_inbound, https_inbound, socks_inbound } from "./feature/inbound.mjs";
import { manual_tproxy_outbound_tags, manual_tproxy_outbounds, manual_tproxy_rules } from "./feature/manual_tproxy.mjs";
import { blackhole_outbound, direct_outbound, server_outbound } from "./feature/outbound.mjs";
import { api_conf, balancer, logging, metrics_conf, policy, system_route_rules } from "./feature/system.mjs";

function inbounds(proxy, config, extra_inbound) {
    const tproxy_sniffing = proxy["tproxy_sniffing"];
    const route_only = proxy["route_only"];
    const conn_idle = proxy["conn_idle"];

    let i = [
        socks_inbound("0.0.0.0", proxy["socks_port"] || 1080, "socks_inbound"),
        http_inbound("0.0.0.0", proxy["http_port"] || 1081, "http_inbound"),
        dokodemo_inbound("0.0.0.0", proxy["tproxy_port_tcp_v4"] || 1082, "tproxy_tcp_inbound_v4", tproxy_sniffing, route_only, ["http", "tls"], "0", "tcp", "tproxy", conn_idle),
        dokodemo_inbound("0.0.0.0", proxy["tproxy_port_tcp_v6"] || 1083, "tproxy_tcp_inbound_v6", tproxy_sniffing, route_only, ["http", "tls"], "0", "tcp", "tproxy", conn_idle),
        dokodemo_inbound("0.0.0.0", proxy["tproxy_port_udp_v4"] || 1084, "tproxy_udp_inbound_v4", tproxy_sniffing, route_only, ["quic"], "0", "udp", "tproxy", conn_idle),
        dokodemo_inbound("0.0.0.0", proxy["tproxy_port_udp_v6"] || 1085, "tproxy_udp_inbound_v6", tproxy_sniffing, route_only, ["quic"], "0", "udp", "tproxy", conn_idle),
        ...extra_inbounds(proxy, extra_inbound),
    ];
    if (proxy["web_server_enable"] == "1") {
        push(i, https_inbound(proxy, config));
    }
    if (proxy["metrics_server_enable"] == '1') {
        push(i, {
            listen: "0.0.0.0",
            port: int(proxy["metrics_server_port"]) || 18888,
            protocol: "dokodemo-door",
            settings: {
                address: "127.0.0.1"
            },
            tag: "metrics"
        });
    }
    if (proxy["xray_api"] == '1') {
        push(i, {
            listen: "127.0.0.1",
            port: 8080,
            protocol: "dokodemo-door",
            settings: {
                address: "127.0.0.1"
            },
            tag: "api"
        });
    }
    return i;
}

function outbounds(proxy, config, manual_tproxy, bridge, extra_inbound) {
    let result = [
        blackhole_outbound(),
        direct_outbound("direct", null, false),
        direct_outbound("dynamic_direct", null, true),
        ...manual_tproxy_outbounds(config, manual_tproxy),
        ...bridge_outbounds(config, bridge)
    ];
    let outbound_balancers_all = {};
    for (let b in ["tcp_balancer_v4", "udp_balancer_v4", "tcp_balancer_v6", "udp_balancer_v6"]) {
        for (let i in balancer(proxy, b, b)) {
            if (i != "direct") {
                outbound_balancers_all[i] = true;
            }
        }
    }
    for (let e in extra_inbound) {
        if (e["specify_outbound"] == "1") {
            for (let i in balancer(e, "destination", `extra_inbound:${e[".name"]}`)) {
                if (i != "direct") {
                    outbound_balancers_all[i] = true;
                }
            }
        }
    }
    for (let i in keys(outbound_balancers_all)) {
        /* 出站标签形如 tcp_balancer_v4@balancer_outbound:<section>；
           取最后一个冒号之后的部分，别假设 section 名长度（上游原为 substr(i, -9)，
           只对 LuCI 自动生成的 9 字符 cfgXXXXXX 成立）。 */
        push(result, ...server_outbound(config[substr(i, rindex(i, ":") + 1)], i, config));
    }
    return result;
}

/* 服务器域名解析：每个 server 可在 Server → Server Hostname Resolving 里单独指定
   一个 DNS（domain_resolve_dns / _method），这里按 "方法;DNS" 归并成 dns 段里
   带 `domains` 限定的服务器，这样解析节点域名不再依赖 dnsmasq/smartdns——避免
   "解析节点域名要过 smartdns、smartdns 的上游又要过代理"的循环依赖。
   没有任何 server 配置它时不生成 dns 段（回落系统解析器）。不含 DNS 入站、不做
   劫持，客户端 DNS 仍然完全归 dnsmasq-extra。
   tag 用于在路由里把内部 DNS 查询钉到 direct（见 gen_config 末尾）——Xray 内部
   DNS 客户端发出的查询**也走路由表**，本 app 的默认出站是 blackhole_outbound，
   不显式放行的话查询会被黑洞掉（表现为 failed to resolve / record not found）。 */
const server_dns_tag = "xray_server_dns";

/* 与上游 dns.mjs 的 format_dns 同语义：udp 用 address+port，其余拼成 URL */
function format_resolve_dns(method, val) {
    if (method == "udp") {
        const parts = split(val, ":");
        if (length(parts) == 2 && length(parts[1]) > 0)
            return { address: parts[0], port: int(parts[1]) };
        return { address: val, port: 53 };
    }
    return { address: `${method}://${val}${substr(method, 0, 5) == "https" ? "/dns-query" : ""}` };
};

function server_dns_conf(config) {
    let merged = {};
    for (let s in filter(values(config), i => i[".type"] == "servers")) {
        const host = trim(s["server"] || "");
        const dns = trim(s["domain_resolve_dns"] || "");
        if (length(host) == 0 || length(dns) == 0 || iptoarr(host))
            continue;
        const key = `${s["domain_resolve_dns_method"] || "udp"};${dns}`;
        merged[key] = uniq([...(merged[key] || []), `domain:${host}`]);
    }
    if (length(keys(merged)) == 0)
        return null;

    let servers = map(keys(merged), function (k) {
        const parts = split(k, ";");
        let entry = format_resolve_dns(parts[0], parts[1]);
        entry["domains"] = merged[k];
        entry["skipFallback"] = true;
        return entry;
    });
    /* 其余域名（没单独指定 DNS 的 server、bridge 等）仍走系统解析器 */
    push(servers, { address: "localhost" });
    return {
        tag: server_dns_tag,
        servers: servers,
        /* 固定 UseIP（A + AAAA 都查），不提供全局选项：dns.queryStrategy 是"能力上限"，
           限制 dns 段里**所有**服务器能查的记录类型，与子项冲突时子项直接空响应
           （官方文档：全局 UseIPv4 + 子项 UseIPv6 → 该子项空响应）。用 v4 还是 v6 由每个
           server 自己的 domain_strategy（Server → Server Hostname Resolving）决定，
           这里只有留最宽的一档，才不会把选了另一族的节点饿死。 */
        queryStrategy: "UseIP"
    };
};

function rules(proxy, bridge, manual_tproxy, extra_inbound) {
    const tproxy_tcp_inbound_v4_tags = ["tproxy_tcp_inbound_v4"];
    const tproxy_udp_inbound_v4_tags = ["tproxy_udp_inbound_v4"];
    const tproxy_tcp_inbound_v6_tags = ["tproxy_tcp_inbound_v6"];
    const tproxy_udp_inbound_v6_tags = ["tproxy_udp_inbound_v6"];
    const extra_inbound_global_tags = extra_inbound_global();
    const extra_inbound_global_tcp_tags = extra_inbound_global_tags["tproxy_tcp"] || [];
    const extra_inbound_global_udp_tags = extra_inbound_global_tags["tproxy_udp"] || [];
    const extra_inbound_global_http_tags = extra_inbound_global_tags["http"] || [];
    const extra_inbound_global_socks5_tags = extra_inbound_global_tags["socks5"] || [];
    const built_in_tcp_inbounds = [...tproxy_tcp_inbound_v4_tags, ...extra_inbound_global_tcp_tags, ...extra_inbound_global_http_tags, ...extra_inbound_global_socks5_tags, "socks_inbound", "https_inbound", "http_inbound"];
    const built_in_udp_inbounds = [...tproxy_udp_inbound_v4_tags, ...extra_inbound_global_udp_tags, "dns_conf_inbound"];
    let result = [
        ...manual_tproxy_rules(manual_tproxy),
        ...extra_inbound_rules(extra_inbound),
        ...system_route_rules(proxy),
        ...bridge_rules(bridge),
        {
            type: "field",
            inboundTag: tproxy_tcp_inbound_v6_tags,
            balancerTag: "tcp_outbound_v6"
        },
        {
            type: "field",
            inboundTag: tproxy_udp_inbound_v6_tags,
            balancerTag: "udp_outbound_v6"
        },
        {
            type: "field",
            inboundTag: built_in_tcp_inbounds,
            balancerTag: "tcp_outbound_v4"
        },
        {
            type: "field",
            inboundTag: built_in_udp_inbounds,
            balancerTag: "udp_outbound_v4"
        },
    ];
    if (proxy["tproxy_sniffing"] == "1") {
        if (proxy["direct_bittorrent"] == "1") {
            splice(result, 0, 0, {
                type: "field",
                outboundTag: "direct",
                protocol: ["bittorrent"]
            });
        }
    }
    return result;
}

function balancers(proxy, extra_inbound) {
    const general_balancer_strategy = proxy["general_balancer_strategy"] || "random";
    const built_in_outbounds = ["tcp_outbound_v4", "udp_outbound_v4", "tcp_outbound_v6", "udp_outbound_v6"];
    const built_in_balancers = ["tcp_balancer_v4", "udp_balancer_v4", "tcp_balancer_v6", "udp_balancer_v6"];
    return [
        ...map(built_in_balancers, function (balancer_tag, index) {
            return {
                "tag": built_in_outbounds[index],
                "selector": balancer(proxy, balancer_tag, balancer_tag),
                "strategy": {
                    "type": general_balancer_strategy
                }
            };
        }),
        ...extra_inbound_balancers(extra_inbound),
    ];
};

function observatory(proxy, manual_tproxy) {
    if (proxy["observatory"] == "1") {
        return {
            subjectSelector: ["tcp_balancer_v4@balancer_outbound", "udp_balancer_v4@balancer_outbound", "tcp_balancer_v6@balancer_outbound", "udp_balancer_v6@balancer_outbound", "extra_inbound", "direct", ...manual_tproxy_outbound_tags(manual_tproxy)],
            /* 上游写死 100ms + apple.com：间隔实测约 5–10 KB/s 持续走节点，
               1s 时每个 subject 约 6s 探一次，开销约 1/10，leastPing 够用。
               探测地址改用 fw3 的 detectportal.firefox.com/success.txt（比 apple.com
               那个 test/success.html 更适合当探测点）；**用 http 而非 fw3 的 https**：
               1s 一探的话 https 每次都要过一次 TLS 握手，http 省掉这部分开销
               （这个地址本身也是 Firefox 用来做明文门户检测的）。 */
            probeInterval: "1s",
            probeUrl: "http://detectportal.firefox.com/success.txt"
        };
    }
    return null;
}

function gen_config() {
    const config = load_config();
    const bridge = filter(values(config), v => v[".type"] == "bridge") || [];
    const extra_inbound = filter(values(config), v => v[".type"] == "extra_inbound") || [];
    const manual_tproxy = filter(values(config), v => v[".type"] == "manual_tproxy") || [];

    const general = filter(values(config), k => k[".type"] == "general")[0] || {};
    const custom_configuration_hook = loadstring(general["custom_configuration_hook"] || "return i => i;")();
    let result = {
        inbounds: inbounds(general, config, extra_inbound),
        outbounds: outbounds(general, config, manual_tproxy, bridge, extra_inbound),
        api: api_conf(general),
        metrics: metrics_conf(general),
        policy: policy(general),
        log: logging(general),
        stats: general["stats"] == "1" ? {
            place: "holder"
        } : null,
        observatory: observatory(general, manual_tproxy),
        routing: {
            domainStrategy: general["routing_domain_strategy"] || "AsIs",
            rules: rules(general, bridge, manual_tproxy, extra_inbound),
            balancers: balancers(general, extra_inbound)
        }
    };
    /* 服务器域名解析（每 server 可各自指定 DNS）+ 把它的查询钉到 direct 的路由规则：
       Xray 内部 DNS 客户端的查询也走路由表，而本 app 的第一个出站是
       blackhole_outbound（未匹配规则的默认出站），不显式放行就会被黑洞掉。
       这条规则 splice 在最前面，任何用户规则都盖不住它。 */
    const server_dns = server_dns_conf(config);
    if (server_dns != null) {
        result["dns"] = server_dns;
        splice(result["routing"]["rules"], 0, 0, {
            type: "field",
            inboundTag: [server_dns_tag],
            outboundTag: "direct"
        });
    };
    const bridges_deprecated = bridges(bridge);
    if (length(bridges_deprecated) > 0) {
        result["reverse"] = {
            bridges: bridges_deprecated
        };
    };
    return custom_configuration_hook(result);
}

printf("%.4J", gen_config());
