'use strict';
'require form';
'require fs';
'require network';
'require rpc';
'require tools.widgets as widgets';
'require uci';
'require view';
'require view.xray.protocol as protocol';
'require view.xray.shared as shared';
'require view.xray.transport as transport';

function server_alias(v) {
    return v.alias || v.server + ":" + v.server_port;
}

function list_folded_format(config_data, k, noun, max_chars, mapping, empty) {
    return function (s) {
        const null_mapping = v => v;
        const records = (uci.get(config_data, s, k) || []).map(mapping || null_mapping);
        if (records.length == 0) {
            return empty || "-";
        }

        const max_items = function () {
            for (const i in records) {
                const pos = parseInt(i);
                if (records.slice(0, pos + 1).join(", ").length > max_chars) {
                    return pos;
                }
            }
            return records.length;
        }() || 1;

        if (records.length <= max_items) {
            return records.join(", ");
        }
        return E([], [
            records.slice(0, max_items).join(", "),
            ", ... ",
            shared.badge(`+<strong>${records.length - max_items}</strong>`, `${records.length} ${noun}\n${records.join("\n")}`)
        ]);
    };
}

function destination_format(config_data, k, e, max_chars) {
    return function (s) {
        if (e) {
            if (!uci.get(config_data, s, e)) {
                return `<i>${_("use global settings")}</i>`;
            }
        }
        return list_folded_format(config_data, k, "outbounds", max_chars, v => uci.get(config_data, v, "alias"), `<i>${_("direct")}</i>`)(s);
    };
}

function extra_outbound_format(config_data, s, select_item) {
    const inbound_addr = uci.get(config_data, s, "inbound_addr") || "";
    const inbound_port = uci.get(config_data, s, "inbound_port") || "";
    if (inbound_addr == "" && inbound_port == "") {
        return "-";
    }
    const destination = (uci.get(config_data, s, "destination") || []).map(x => server_alias(uci.get(config_data, x)));
    if (select_item) {
        if (destination.length == 0) {
            return `${inbound_addr}:${inbound_port} [direct]`;
        }
        return `${inbound_addr}:${inbound_port} (${destination.join(", ")})`;
    }
    return E([], [
        `${inbound_addr}:${inbound_port} `,
        function () {
            if (destination.length == 0) {
                return shared.badge("<strong>...</strong>", "direct");
            }
            return shared.badge("<strong>...</strong>", `${destination.length} outbounds\n${destination.join("\n")}`);
        }()
    ]);
}

function access_control_format(config_data, s, t) {
    return function (v) {
        switch (uci.get(config_data, v, s)) {
            case "tproxy": {
                return _("Enable tproxy");
            }
            case "bypass": {
                return _("Disable tproxy");
            }
        }
        return extra_outbound_format(config_data, uci.get(config_data, v, t), false);
    };
}

function check_resource_files(load_result) {
    let xray_bin_default = false;
    let xray_running = false;
    for (const f of load_result) {
        if (f.name == "xray") {
            xray_bin_default = true;
        }
        if (f.name == "xray.pid") {
            xray_running = true;
        }
    }
    return {
        xray_bin_default: xray_bin_default,
        xray_running: xray_running,
    };
}

/* Logging 标签页：只读展示两个日志，靠 fs 读服务端（ACL 里给了 syslog-wrapper 的 exec 和
   健康检查日志的 read）。DummyValue 的 cfgvalue 走 rawhtml，所以要自己转义；它的 parse
   覆写成 no-op，免得保存页面时把这段 HTML 写进 /etc/config/xray_core。 */
function log_html_escape(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function log_rows(text) {
    return Math.min(40, Math.max(6, String(text || '').split('\n').length + 1));
}

function log_textarea(id, text) {
    return `<textarea id="${id}" readonly wrap="off" rows="${log_rows(text)}" style="width:100%;font-size:12px;font-family:monospace">${log_html_escape(text)}</textarea>`;
}

function log_set(id, text) {
    const el = document.getElementById(id);
    if (el != null) {
        el.value = text || '';
        el.rows = log_rows(text);
    }
}

/* xray 自己的运行日志：系统日志里 xray[pid] 标记的行，去掉 healthcheck 的（它另有日志文件） */
function log_load_xray() {
    return fs.exec_direct('/usr/libexec/syslog-wrapper').then(function (data) {
        return (data || '').split('\n').filter(function (line) {
            return line.indexOf('xray[') !== -1 && line.indexOf('healthcheck') === -1;
        }).join('\n');
    }).catch(function () { return ''; });
}

function log_load_healthcheck() {
    return fs.read('/var/log/xray_healthcheck.log').catch(function () { return ''; });
}

function log_refresh() {
    return Promise.all([ log_load_xray(), log_load_healthcheck() ]).then(function (logs) {
        log_set('log_xray', logs[0]);
        log_set('log_healthcheck', logs[1]);
    });
}

/* Nodes 标签页：从 xray 的 stats API（需要 general.stats=1 且 general.xray_api=1）读每个出站的
   字节数，按节点聚合。注意计数里含 observatory 的探测流量（每节点每秒约一次请求），所以
   占比只能当参考；计数器从 xray 上次启动开始累计。 */
const XRAY_API_SERVER = '127.0.0.1:8080';

/* fs.exec_direct 的返回值形态不固定：可能是字符串、已经解析好的对象，或 {code,stdout}
   这样的包装（不同 LuCI 版本行为不同）—— 三种都吃，别让 JSON.parse(对象) 抛掉。 */
function as_text(v) {
    if (v == null) return '';
    if (typeof v == 'string') return v;
    if (typeof v == 'object' && typeof v.stdout == 'string') return v.stdout;
    return String(v);
}

function as_json(v) {
    if (v == null) return null;
    if (typeof v == 'object' && v.stat == null && typeof v.stdout == 'string')
        v = v.stdout;
    if (typeof v == 'object') return v;
    if (typeof v != 'string') return null;
    try { return JSON.parse(v); } catch (e) { return null; }
}

/* 直接 exec xray 的 api 子命令（rpcd 那个 helper 不接受参数，读不了带 tag 的 `bi`）。
   注意 CLI 的顺序是 `xray api <command> [flags] [args]` —— flag 放前面会被当成命令名。 */
function xray_api_call(command, args) {
    return fs.exec_direct('/usr/bin/xray',
            [ 'api', command, '--server=' + XRAY_API_SERVER ].concat(args || []))
        .catch(function () { return ''; });
}

/* `xray api bi` 的输出是文本、只有 Override/Selects 两段（CLI 不打印 ping），形如：
       - Selects:
         1   tcp_balancer_v4@balancer_outbound:hus
   这里把形如出站 tag 的 token 收集起来，映射成节点名。 */
function collect_selections(text, out) {
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*\d+\s+(\S+)\s*$/.exec(line);
        if (m == null) continue;
        const tag = m[1];
        if (tag.indexOf('@balancer_outbound:') < 0) continue;
        out[tag.split(':').pop()] = true;
    }
}

function node_stats_enabled() {
    return uci.get_first(shared.variant, 'general', 'stats') == '1' &&
           uci.get_first(shared.variant, 'general', 'xray_api') == '1';
}

function node_stats_aggregate(stats, persisted) {
    const rows = {};

    for (const item of (stats || [])) {
        const m = /^outbound>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(item.name || '');
        if (m == null) continue;
        const tag = m[1];
        const node = tag.indexOf(':') >= 0 ? tag.split(':').pop() : tag;
        const row = rows[node] || (rows[node] = { name: node, up: 0, down: 0 });
        row[m[2] == 'uplink' ? 'up' : 'down'] += Number(item.value || 0);
    }

    /* 加上归档的累计值（xray 每次停止时写进 /var/run/xray/metrics.json）：
       xray 的 stats 只在内存里，healthcheck 自愈重启 / 手动 restart 都会清零。 */
    if (persisted != null && persisted.nodes != null) {
        for (const name in persisted.nodes) {
            const p = persisted.nodes[name] || {};
            const row = rows[name] || (rows[name] = { name: name, up: 0, down: 0 });
            row.up += Number(p.up || 0);
            row.down += Number(p.down || 0);
        }
    }

    const list = Object.keys(rows).map(k => rows[k]);
    const total = list.reduce((a, r) => a + r.up + r.down, 0);
    for (const row of list) {
        row.share = total > 0 ? (100 * (row.up + row.down) / total) : 0;
    }

    return list.sort((a, b) => (b.up + b.down) - (a.up + a.down));
}

function node_metrics_load() {
    return fs.read('/var/run/xray/metrics.json').then(function (raw) {
        try { return JSON.parse(raw); } catch (e) { return null; }
    }).catch(function () { return null; });
}

function node_stats_fetch() {
    if (!node_stats_enabled()) return Promise.resolve(null);

    const balancer_tags = [ 'tcp_outbound_v4', 'udp_outbound_v4', 'tcp_outbound_v6', 'udp_outbound_v6' ];

    return Promise.all([
        xray_api_call('statsquery'),
        Promise.all(balancer_tags.map(t => xray_api_call('bi', [ t ]))),
        node_metrics_load()
    ]).then(function (res) {
        const stats = as_json(res[0]);
        if (stats == null) return { error: as_text(res[0]) };

        const selected = {};
        for (const doc of res[1]) collect_selections(as_text(doc), selected);

        const rows = node_stats_aggregate(stats.stat, res[2]);
        for (const row of rows) row.selected = selected[row.name] === true;
        return rows;
    }).catch(function () { return null; });
}

function node_stats_format(bytes) {
    const units = [ 'B', 'KB', 'MB', 'GB' ];
    let n = Number(bytes || 0), u = 0;
    while (n >= 1024 && u < units.length - 1) { n = n / 1024; u++; }
    return '%.1f %s'.format(n, units[u]);
}

function node_stats_html(rows) {
    if (!node_stats_enabled()) {
        return '<em>%s</em>'.format(_('Requires <em>Stats</em> and <em>Xray API</em> to be enabled in the extra options.'));
    }
    if (rows != null && rows.error != null) {
        const raw = String(rows.error || '').trim();
        return '<em>%s</em>%s'.format(_('Unable to read the statistics (is Xray running?).'),
            raw.length > 0 ? '<br><code style="font-size:11px">' + log_html_escape(raw.substr(0, 300)) + '</code>' : '');
    }
    if (!Array.isArray(rows) || rows.length == 0) {
        return '<em>%s</em>'.format(_('Unable to read the statistics (is Xray running?).'));
    }

    const cell = 'padding:2px 10px;border-bottom:1px solid #ddd';
    let html = '<table style="font-size:12px;border-collapse:collapse"><tr>' +
        [ _('Node'), _('Uplink'), _('Downlink'), _('Share'), _('Selected') ].map(h =>
            '<th style="text-align:left;padding:2px 10px;border-bottom:1px solid #999">' + h + '</th>').join('') +
        '</tr>';

    for (const r of rows) {
        const selected = r.selected ? '\u2714' : '\u2014';
        html += '<tr><td style="%s"><strong>%s</strong></td><td style="%s">%s</td><td style="%s">%s</td><td style="%s">%.1f%%</td><td style="%s">%s</td></tr>'
            .format(cell, log_html_escape(r.name), cell, node_stats_format(r.up),
                    cell, node_stats_format(r.down), cell, r.share, cell, selected);
    }

    return html + '</table>';
}

function node_stats_set(rows) {
    const div = document.getElementById('node_stats_box');
    if (div != null) div.innerHTML = node_stats_html(rows);
}

/* 只读展示用：DummyValue/Button 都不该把值写进 UCI */
function log_no_save() {
    return Promise.resolve();
}

return view.extend({
    load: function () {
        /* node_stats_fetch 要先读 general.stats / xray_api，所以必须等 UCI 加载完再跑；
           其余取数不受影响、保持并行。（不等的话首次渲染会拿到 null，点 Refresh 才正常。） */
        const uci_ready = uci.load(shared.variant);

        return Promise.all([
            uci_ready,
            fs.list("/usr/share/xray"),
            network.getHostHints(),
            log_load_xray(),
            log_load_healthcheck(),
            uci_ready.then(function () { return node_stats_fetch(); })
        ]);
    },

    render: function (load_result) {
        const config_data = load_result[0];
        const { xray_bin_default, xray_running } = check_resource_files(load_result[1]);
        const status_text = xray_running ? _("[Xray is running]") : _("[Xray is stopped]");
        const hosts = load_result[2].hosts;
        const xray_log = load_result[3] || '';
        const healthcheck_log = load_result[4] || '';
        const node_stats = load_result[5] || null;

        const firewall_mark = uci.get_first(shared.variant, "general", "mark") || '255';
        const m = new form.Map(shared.variant, _('Xray'), status_text);

        let s, o, ss;

        s = m.section(form.TypedSection, 'general');
        s.addremove = false;
        s.anonymous = true;

        s.tab('general', _('General Settings'));

        o = s.taboption('general', form.Flag, 'transparent_proxy_enable', _('Enable Transparent Proxy'), _('Enable integrations with dnsmasq and nftables. To disable luci-app-xray completely, go to <a href="/cgi-bin/luci/admin/system/startup">Startup</a> and disable <code>xray_core</code>.'));

        let tcp_balancer_v4 = s.taboption('general', form.MultiValue, 'tcp_balancer_v4', _('TCP Server (IPv4)'), _("Select multiple outbound servers to enable load balancing. Select none to disable TCP Outbound."));
        tcp_balancer_v4.datatype = "uciname";

        let udp_balancer_v4 = s.taboption('general', form.MultiValue, 'udp_balancer_v4', _('UDP Server (IPv4)'), _("Select multiple outbound servers to enable load balancing. Select none to disable UDP Outbound."));
        udp_balancer_v4.datatype = "uciname";

        let tcp_balancer_v6 = s.taboption('general', form.MultiValue, 'tcp_balancer_v6', _('TCP Server (IPv6)'), _("Select multiple outbound servers to enable load balancing. Select none to disable TCP Outbound."));
        tcp_balancer_v6.datatype = "uciname";

        let udp_balancer_v6 = s.taboption('general', form.MultiValue, 'udp_balancer_v6', _('UDP Server (IPv6)'), _("Select multiple outbound servers to enable load balancing. Select none to disable UDP Outbound."));
        udp_balancer_v6.datatype = "uciname";

        let general_balancer_strategy = s.taboption('general', form.Value, 'general_balancer_strategy', _('Balancer Strategy'), _('Strategy <code>leastPing</code> requires observatory (see "Extra Options" tab) to be enabled.'));
        general_balancer_strategy.value("random");
        general_balancer_strategy.value("leastPing");
        general_balancer_strategy.value("roundRobin");
        general_balancer_strategy.default = "random";
        general_balancer_strategy.rmempty = false;

        o = s.taboption('general', form.ListValue, 'startup_delay', _('Startup Delay'), _("Wait this long before starting Xray on boot, so that the network and DNS are up first. Only the boot start is delayed; starting or restarting by hand is immediate."));
        o.value("0", _("Not enabled"));
        o.value("3", _("3 seconds"));
        o.value("5", _("5 seconds"));
        o.value("10", _("10 seconds"));
        o.value("15", _("15 seconds"));
        o.value("25", _("25 seconds"));
        o.value("40", _("40 seconds"));
        o.default = "5";
        o.rmempty = false;

        o = s.taboption('general', form.Flag, 'healthcheck_enable', _('Enable HealthCheck'), _("Every minute: check that Xray is running, that the nftables rules are in place and that traffic can actually reach the internet through the proxy. If only the proxy is broken (the network itself works), Xray is restarted; if the local DNS cannot resolve either, dnsmasq-extra is restarted first. Log: <code>/var/log/xray_healthcheck.log</code>, cleared every 3 hours."));
        o.default = "1";

        o = s.taboption('general', form.ListValue, 'healthcheck_interval', _('HealthCheck Interval'), _("Effective when HealthCheck is enabled."));
        o.value("60", _("1 minute"));
        o.value("120", _("2 minutes"));
        o.value("300", _("5 minutes"));
        o.value("600", _("10 minutes"));
        o.default = "60";
        o.depends('healthcheck_enable', '1');

        o = s.taboption('general', form.SectionValue, "xray_servers", form.GridSection, 'servers', _('Xray Servers'), _("Servers are referenced by index (order in the following list). Deleting servers may result in changes of upstream servers actually used by proxy and bridge."));
        ss = o.subsection;
        ss.sortable = false;
        ss.anonymous = true;
        ss.addremove = true;

        ss.tab('general', _('General Settings'));
        ss.nodescriptions = true;

        o = ss.taboption('general', form.Value, "alias", _("Alias (optional)"));
        o.optional = true;

        o = ss.taboption('general', form.Value, 'server', _('Server Hostname'));
        o.datatype = 'host';
        o.rmempty = false;

        o = ss.taboption('general', form.DynamicList, 'server_port', _('Server Port'));
        o.datatype = 'port';
        o.rmempty = false;
        o.modalonly = true;

        o = ss.taboption('general', form.Value, 'username', _('Email / Username'), _('Optional; username for SOCKS / HTTP outbound, email for other outbound.'));
        o.modalonly = true;

        o = ss.taboption('general', form.Value, 'password', _('UserId / Password'), _('Fill user_id for vmess / VLESS, or password for other outbound (also supports <a href="https://github.com/XTLS/Xray-core/issues/158">Xray UUID Mapping</a>)'));
        o.rmempty = false;

        ss.tab('resolving', _("Server Hostname Resolving"));

        o = ss.taboption('resolving', form.ListValue, 'domain_strategy', _('Domain Strategy'), _("Whether to use IPv4 or IPv6 address if Server Hostname is a domain."));
        o.value("UseIP");
        o.value("UseIPv4");
        o.value("UseIPv6");
        o.default = "UseIP";
        o.modalonly = true;

        o = ss.taboption('resolving', form.Value, 'domain_resolve_dns', _('Resolve Domain via DNS'), _("Resolve this server's hostname with the DNS below instead of the system resolver (dnsmasq / smartdns). The query is routed directly, never through the proxy. Accepts <code>ip</code> or <code>ip:port</code>."));
        o.datatype = "or(ipaddr, ipaddrport(1))";
        o.modalonly = true;

        o = ss.taboption('resolving', form.ListValue, 'domain_resolve_dns_method', _('Resolve Domain DNS Method'), _("Effective when DNS above is set. Direct methods will bypass Xray completely so it may get blocked."));
        o.value("udp", _("UDP"));
        o.value("quic+local", _("DNS over QUIC (direct)"));
        o.value("tcp", _("TCP"));
        o.value("tcp+local", _("TCP (direct)"));
        o.value("https", _("DNS over HTTPS"));
        o.value("https+local", _("DNS over HTTPS (direct)"));
        o.default = "udp";
        o.modalonly = true;

        ss.tab('protocol', _('Protocol Settings'));

        o = ss.taboption('protocol', form.ListValue, "protocol", _("Protocol"));
        protocol.add_client_protocol(o, ss, 'protocol');
        o.rmempty = false;

        ss.tab('transport', _('Transport Settings'));

        o = ss.taboption('transport', form.ListValue, 'transport', _('Transport'));
        transport.init(o, ss, 'transport');
        o.rmempty = false;

        let dialer_proxy = ss.taboption('transport', form.ListValue, 'dialer_proxy', _('Dialer Proxy'), _('Similar to <a href="https://xtls.github.io/config/outbound.html#proxysettingsobject">ProxySettings.Tag</a>'));
        dialer_proxy.datatype = "uciname";
        dialer_proxy.value("disabled", _("Disabled"));
        dialer_proxy.modalonly = true;

        ss.tab('custom', _('Custom Options'));

        o = ss.taboption('custom', form.TextValue, 'custom_config', _('Custom Configurations'), _(`Configurations here override settings in the previous tabs with the following rules: <ul><li>Object values will be replaced recursively so settings in previous tabs matter.</li><li>Arrays will be replaced entirely instead of being merged.</li><li>Tag <code>tag</code> and mark <code>streamSettings.sockopt.mark</code> are ignored. </li></ul>Aliases are not handled while merging configurations:<ul><li>Use <code>tcpSettings</code> instead of <code>rawSettings</code>.</li><li>Use <code>splithttpSettings</code> instead of <code>xhttpSettings</code>.</li></ul>Some transports like <code>splithttp</code> may use another <code>streamSettings.sockopt</code>:<ul><li><a href="https://github.com/yichya/luci-app-xray/issues/434">Read instructions here</a>, and use <code>${firewall_mark}</code> as <code>sockopt.mark</code> to avoid loopback traffic.</ul>Override rules here may be changed later. Use this only for experimental or pre-release features.`));
        o.modalonly = true;
        o.monospace = true;
        o.rows = 12;
        o.validate = shared.validate_object;

        s.tab('inbounds', _('Inbounds'));

        o = s.taboption('inbounds', form.Value, 'tproxy_port_tcp_v4', _('Transparent proxy port (TCP4)'));
        o.datatype = 'port';
        o.placeholder = 1082;

        o = s.taboption('inbounds', form.Value, 'tproxy_port_tcp_v6', _('Transparent proxy port (TCP6)'));
        o.datatype = 'port';
        o.placeholder = 1083;

        o = s.taboption('inbounds', form.Value, 'tproxy_port_udp_v4', _('Transparent proxy port (UDP4)'));
        o.datatype = 'port';
        o.placeholder = 1084;

        o = s.taboption('inbounds', form.Value, 'tproxy_port_udp_v6', _('Transparent proxy port (UDP6)'));
        o.datatype = 'port';
        o.placeholder = 1085;

        o = s.taboption('inbounds', form.DynamicList, 'uids_direct', _('Bypass tproxy for uids'), _("Processes started by users with these uids won't be forwarded through Xray."));
        o.datatype = "integer";

        o = s.taboption('inbounds', form.DynamicList, 'gids_direct', _('Bypass tproxy for gids'), _("Processes started by users in groups with these gids won't be forwarded through Xray."));
        o.datatype = "integer";

        let extra_inbounds = s.taboption('inbounds', form.SectionValue, "extra_inbound_section", form.GridSection, 'extra_inbound', _('Extra Inbounds'), _("Add more socks5 / http inbounds and redirect to other outbounds.")).subsection;
        extra_inbounds.sortable = false;
        extra_inbounds.anonymous = true;
        extra_inbounds.addremove = true;
        extra_inbounds.nodescriptions = true;

        let inbound_addr = extra_inbounds.option(form.Value, "inbound_addr", _("Listen Address"));
        inbound_addr.datatype = "ip4addr";

        let inbound_port = extra_inbounds.option(form.Value, "inbound_port", _("Listen Port"));
        inbound_port.datatype = "port";

        let inbound_type = extra_inbounds.option(form.ListValue, "inbound_type", _("Inbound Type"));
        inbound_type.value("socks5", _("Socks5 Proxy"));
        inbound_type.value("http", _("HTTP Proxy"));
        inbound_type.value("tproxy_tcp", _("Transparent Proxy (TCP)"));
        inbound_type.value("tproxy_udp", _("Transparent Proxy (UDP)"));
        inbound_type.rmempty = false;

        let inbound_username = extra_inbounds.option(form.Value, "inbound_username", _("Username (Optional)"));
        inbound_username.depends("inbound_type", "socks5");
        inbound_username.depends("inbound_type", "http");
        inbound_username.modalonly = true;

        let inbound_password = extra_inbounds.option(form.Value, "inbound_password", _("Password (Optional)"));
        inbound_password.depends("inbound_type", "socks5");
        inbound_password.depends("inbound_type", "http");
        inbound_password.modalonly = true;

        let specify_outbound = extra_inbounds.option(form.Flag, 'specify_outbound', _('Specify Outbound'), _('If not selected, this inbound will use global settings (including sniffing settings).'));
        specify_outbound.modalonly = true;

        let destination = extra_inbounds.option(form.MultiValue, 'destination', _('Destination'), _("Select multiple outbounds for load balancing. If none selected, requests will be sent via direct outbound."));
        destination.depends("specify_outbound", "1");
        destination.datatype = "uciname";
        destination.textvalue = destination_format(config_data, "destination", "specify_outbound", 60);

        let balancer_strategy = extra_inbounds.option(form.Value, 'balancer_strategy', _('Balancer Strategy'), _('Strategy <code>leastPing</code> requires observatory (see "Extra Options" tab) to be enabled.'));
        balancer_strategy.depends("specify_outbound", "1");
        balancer_strategy.value("random");
        balancer_strategy.value("leastPing");
        balancer_strategy.value("roundRobin");
        balancer_strategy.default = "random";
        balancer_strategy.rmempty = false;
        balancer_strategy.modalonly = true;

        s.tab("lan_hosts_access_control", _("LAN Hosts Access Control"));

        let tproxy_ifaces_v4 = s.taboption('lan_hosts_access_control', widgets.DeviceSelect, 'tproxy_ifaces_v4', _("Devices to enable IPv4 tproxy"), _("Enable IPv4 transparent proxy on these interfaces / network devices."));
        tproxy_ifaces_v4.noaliases = true;
        tproxy_ifaces_v4.nocreate = true;
        tproxy_ifaces_v4.multiple = true;

        let tproxy_ifaces_v6 = s.taboption('lan_hosts_access_control', widgets.DeviceSelect, 'tproxy_ifaces_v6', _("Devices to enable IPv6 tproxy"), _("Enable IPv6 transparent proxy on these interfaces / network devices."));
        tproxy_ifaces_v6.noaliases = true;
        tproxy_ifaces_v6.nocreate = true;
        tproxy_ifaces_v6.multiple = true;

        let bypass_ifaces_v4 = s.taboption('lan_hosts_access_control', widgets.DeviceSelect, 'bypass_ifaces_v4', _("Devices to disable IPv4 tproxy"), _("This overrides per-device settings below. Manual transparent proxy won't be affected by this option."));
        bypass_ifaces_v4.noaliases = true;
        bypass_ifaces_v4.nocreate = true;
        bypass_ifaces_v4.multiple = true;

        let bypass_ifaces_v6 = s.taboption('lan_hosts_access_control', widgets.DeviceSelect, 'bypass_ifaces_v6', _("Devices to disable IPv6 tproxy"), _("This overrides per-device settings below. Manual transparent proxy won't be affected by this option."));
        bypass_ifaces_v6.noaliases = true;
        bypass_ifaces_v6.nocreate = true;
        bypass_ifaces_v6.multiple = true;

        let lan_hosts = s.taboption('lan_hosts_access_control', form.SectionValue, "lan_hosts_section", form.GridSection, 'lan_hosts', _('LAN Hosts Access Control'), _("Per-device settings here override per-interface enabling settings above. Manual transparent proxy won't be affected by these options.")).subsection;
        lan_hosts.sortable = false;
        lan_hosts.anonymous = true;
        lan_hosts.addremove = true;

        let title = lan_hosts.option(form.DummyValue, "title", _("Alias / MAC Address"));
        title.modalonly = false;
        title.textvalue = function (s) {
            const item = uci.get(config_data, s);
            if (item.alias) {
                return E([], [item.alias, " ", shared.badge("<strong>...</strong>", item.macaddr)]);
            }
            return item.macaddr;
        };

        let alias = lan_hosts.option(form.Value, "alias", _("Alias (optional)"));
        alias.optional = true;
        alias.modalonly = true;

        let macaddr = lan_hosts.option(form.Value, "macaddr", _("MAC Address"));
        macaddr.datatype = "macaddr";
        macaddr.rmempty = false;
        macaddr.modalonly = true;
        L.sortedKeys(hosts).forEach(function (mac) {
            macaddr.value(mac, E([], [mac, ' (', E('strong', [hosts[mac].name || L.toArray(hosts[mac].ipaddrs || hosts[mac].ipv4)[0] || L.toArray(hosts[mac].ip6addrs || hosts[mac].ipv6)[0] || '?']), ')']));
        });

        let access_control_strategy_v4 = lan_hosts.option(form.ListValue, "access_control_strategy_v4", _("Access Control Strategy (IPv4)"));
        access_control_strategy_v4.value("tproxy", _("Enable transparent proxy"));
        access_control_strategy_v4.value("forward", _("Forward via extra inbound"));
        access_control_strategy_v4.value("bypass", _("Disable transparent proxy"));
        access_control_strategy_v4.modalonly = true;
        access_control_strategy_v4.rmempty = false;

        let access_control_forward_tcp_v4 = lan_hosts.option(form.ListValue, "access_control_forward_tcp_v4", _("Extra inbound (TCP4)"));
        access_control_forward_tcp_v4.depends("access_control_strategy_v4", "forward");
        access_control_forward_tcp_v4.textvalue = access_control_format(config_data, "access_control_strategy_v4", "access_control_forward_tcp_v4");

        let access_control_forward_udp_v4 = lan_hosts.option(form.ListValue, "access_control_forward_udp_v4", _("Extra inbound (UDP4)"));
        access_control_forward_udp_v4.depends("access_control_strategy_v4", "forward");
        access_control_forward_udp_v4.textvalue = access_control_format(config_data, "access_control_strategy_v4", "access_control_forward_udp_v4");

        let access_control_strategy_v6 = lan_hosts.option(form.ListValue, "access_control_strategy_v6", _("Access Control Strategy (IPv6)"));
        access_control_strategy_v6.value("tproxy", _("Enable transparent proxy"));
        access_control_strategy_v6.value("forward", _("Forward via extra inbound"));
        access_control_strategy_v6.value("bypass", _("Disable transparent proxy"));
        access_control_strategy_v6.modalonly = true;
        access_control_strategy_v6.rmempty = false;

        let access_control_forward_tcp_v6 = lan_hosts.option(form.ListValue, "access_control_forward_tcp_v6", _("Extra inbound (TCP6)"));
        access_control_forward_tcp_v6.depends("access_control_strategy_v6", "forward");
        access_control_forward_tcp_v6.textvalue = access_control_format(config_data, "access_control_strategy_v6", "access_control_forward_tcp_v6");

        let access_control_forward_udp_v6 = lan_hosts.option(form.ListValue, "access_control_forward_udp_v6", _("Extra inbound (UDP6)"));
        access_control_forward_udp_v6.depends("access_control_strategy_v6", "forward");
        access_control_forward_udp_v6.textvalue = access_control_format(config_data, "access_control_strategy_v6", "access_control_forward_udp_v6");

        for (const v of uci.sections(config_data, "extra_inbound")) {
            switch (v["inbound_type"]) {
                case "tproxy_tcp": {
                    access_control_forward_tcp_v4.value(v[".name"], extra_outbound_format(config_data, v[".name"], true));
                    access_control_forward_tcp_v6.value(v[".name"], extra_outbound_format(config_data, v[".name"], true));
                    break;
                }
                case "tproxy_udp": {
                    access_control_forward_udp_v4.value(v[".name"], extra_outbound_format(config_data, v[".name"], true));
                    access_control_forward_udp_v6.value(v[".name"], extra_outbound_format(config_data, v[".name"], true));
                    break;
                }
            }
        }

        s.tab('outbound_routing', _('Outbound Routing'));


        o = s.taboption('outbound_routing', form.DynamicList, "wan_bp_ips", _("Bypassed IP"), _("Requests to these IPs won't be forwarded through Xray."));
        o.datatype = "ipaddr";

        o = s.taboption('outbound_routing', form.Value, "wan_bp_ip_list", _("Bypassed IP List"), _("Path of a file listing one CIDR per line (for example <code>/etc/dnsmasq-extra.d/chnroute.txt</code>). Addresses in it won't be forwarded through Xray, and the list follows the file."));
        o.placeholder = "/etc/dnsmasq-extra.d/chnroute.txt";
        o.default = "/etc/dnsmasq-extra.d/chnroute.txt";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_fw_ips", _("Forwarded IP"), _("Requests to these IPs will always be handled by Xray (but still might be bypassed by Xray itself, like private addresses).<br/>Useful for some really strange network. If you really need to forward private addresses, try Manual Transparent Proxy below."));
        o.datatype = "ipaddr";

        o = s.taboption('outbound_routing', form.Value, "wan_fw_ip_list", _("Forwarded IP List"), _("Path of a file listing one CIDR per line. Addresses in it will always be handled by Xray, even when the Bypassed IP List would skip them; the list follows the file."));
        o.datatype = "file";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_bp_domains", _("Bypassed Domain"), _("Requests to these domains won't be forwarded through Xray, even if their IPs would be. Accepts Xray rule syntax such as <code>domain:example.com</code> or <code>full:example.com</code>. Requires Sniffing."));
        o.datatype = "string";

        o = s.taboption('outbound_routing', form.Value, "wan_bp_domain_list", _("Bypassed Domain List"), _("Path of a file listing one domain per line; <code>.gz</code> files are decompressed first. For example dnsmasq-extra's <code>/etc/dnsmasq-extra.d/direct.gz</code>."));
        o.placeholder = "/etc/dnsmasq-extra.d/direct.gz";
        o.default = "/etc/dnsmasq-extra.d/direct.gz";
        o.datatype = "file";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_fw_domains", _("Forwarded Domain"), _("Requests to these domains will always be handled by Xray. Same syntax as Bypassed Domain. Requires Sniffing."));
        o.datatype = "string";

        o = s.taboption('outbound_routing', form.Value, "wan_fw_domain_list", _("Forwarded Domain List"), _("Path of a file listing one domain per line; <code>.gz</code> files are decompressed first. For example dnsmasq-extra's <code>/etc/dnsmasq-extra.d/gfwlist.gz</code>."));
        o.datatype = "file";

        o = s.taboption('outbound_routing', form.ListValue, 'transparent_default_port_policy', _('Default Ports Policy'));
        o.value("forwarded", _("Forwarded"));
        o.value("bypassed", _("Bypassed"));
        o.default = "forwarded";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_fw_tcp_ports", _("Forwarded TCP Ports"), _("Requests to these TCP Ports will be forwarded through Xray. Recommended ports: 80, 443, 853"));
        o.depends("transparent_default_port_policy", "bypassed");
        o.datatype = "portrange";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_fw_udp_ports", _("Forwarded UDP Ports"), _("Requests to these UDP Ports will be forwarded through Xray. Recommended ports: 53, 443"));
        o.depends("transparent_default_port_policy", "bypassed");
        o.datatype = "portrange";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_bp_tcp_ports", _("Bypassed TCP Ports"), _("Requests to these TCP Ports won't be forwarded through Xray."));
        o.depends("transparent_default_port_policy", "forwarded");
        o.datatype = "portrange";

        o = s.taboption('outbound_routing', form.DynamicList, "wan_bp_udp_ports", _("Bypassed UDP Ports"), _("Requests to these UDP Ports won't be forwarded through Xray."));
        o.depends("transparent_default_port_policy", "forwarded");
        o.datatype = "portrange";

        o = s.taboption('outbound_routing', form.SectionValue, "access_control_manual_tproxy", form.GridSection, 'manual_tproxy', _('Manual Transparent Proxy'), _('Compared to iptables REDIRECT, Xray could do NAT46 / NAT64 (for example accessing IPv6 only sites).'));

        ss = o.subsection;
        ss.sortable = false;
        ss.anonymous = true;
        ss.addremove = true;
        ss.nodescriptions = true;

        o = ss.option(form.Value, "source_addr", _("Source Address"), _("Fill an IP address or a rule like <code>ext:/geoip/cloudflare.dat:cloudflare</code>."));
        o.validate = shared.validate_ip_or_geoip;
        o.rmempty = false;

        o = ss.option(form.Value, "source_port", _("Source Port"), _("Leave empty to forward all ports."));
        o.textvalue = s => uci.get(config_data, s)?.source_port || _("<i>any</i>");
        o.validate = shared.validate_port_expression;

        o = ss.option(form.Value, "dest_addr", _("Destination Address"), _("Leave empty to keep original address unchanged."));
        o.textvalue = s => uci.get(config_data, s)?.dest_addr || _("<i>original</i>");
        o.datatype = "host";

        o = ss.option(form.Value, "dest_port", _("Destination Port"), _("Fill <code>0</code> to keep original port unchanged."));
        o.datatype = "port";
        o.rmempty = false;

        o = ss.option(form.DynamicList, "domain_names", _("Domain names to associate"), _("Resolve these domains to Source Address above. Only possible when an IP address is used."));
        o.textvalue = list_folded_format(config_data, "domain_names", "domains", 20);

        o = ss.option(form.Flag, 'rebind_domain_ok', _('Exempt rebind protection'), _('Avoid dnsmasq filtering RFC1918 IP addresses (and some TESTNET addresses as well) from result.<br/>Must be enabled for TESTNET addresses (<code>192.0.2.0/24</code>, <code>198.51.100.0/24</code>, <code>203.0.113.0/24</code>). Addresses like <a href="https://www.as112.net/">AS112 Project</a> (<code>192.31.196.0/24</code>, <code>192.175.48.0/24</code>) or <a href="https://www.nyiix.net/technical/rtbh/">NYIIX RTBH</a> (<code>198.32.160.7</code>) can avoid that.'));
        o.modalonly = true;

        o = ss.option(form.Flag, 'force_forward_tcp', _('Force Forward (TCP)'), _('This destination must be forwarded through an outbound server.'));
        o.modalonly = true;

        let force_forward_server_tcp = ss.option(form.ListValue, 'force_forward_server_tcp', _('Force Forward server (TCP)'));
        force_forward_server_tcp.depends("force_forward_tcp", "1");
        force_forward_server_tcp.datatype = "uciname";
        force_forward_server_tcp.modalonly = true;

        o = ss.option(form.Flag, 'force_forward_udp', _('Force Forward (UDP)'), _('This destination must be forwarded through an outbound server.'));
        o.modalonly = true;

        let force_forward_server_udp = ss.option(form.ListValue, 'force_forward_server_udp', _('Force Forward server (UDP)'));
        force_forward_server_udp.depends("force_forward_udp", "1");
        force_forward_server_udp.datatype = "uciname";
        force_forward_server_udp.modalonly = true;

        s.tab('xray_server', _('HTTPS Server'));

        o = s.taboption('xray_server', form.Flag, 'web_server_enable', _('Enable Xray HTTPS Server'), _("This will start a HTTPS server which serves both as an inbound for Xray and a reverse proxy web server."));

        o = s.taboption('xray_server', form.Value, 'web_server_port', _('Xray HTTPS Server Port'), _("This port needs to be set <code>accept input</code> manually in firewall settings."));
        o.datatype = 'port';
        o.placeholder = 443;
        o.depends("web_server_enable", "1");

        o = s.taboption('xray_server', form.ListValue, "web_server_protocol", _("Protocol"), _("Only protocols which support fallback are available. Note that REALITY does not support fallback right now."));
        protocol.add_server_protocol(o, s, 'xray_server');
        o.rmempty = false;
        o.depends("web_server_enable", "1");

        o = s.taboption('xray_server', form.DynamicList, 'web_server_password', _('UserId / Password'), _('Fill user_id for vmess / VLESS, or password for shadowsocks / trojan (also supports <a href="https://github.com/XTLS/Xray-core/issues/158">Xray UUID Mapping</a>)'));
        o.depends("web_server_enable", "1");

        o = s.taboption('xray_server', form.Value, 'web_server_address', _('Default Fallback HTTP Server'), _("Only HTTP/1.1 supported here. For HTTP/2 upstream, use Fallback Servers below"));
        o.datatype = 'hostport';
        o.depends("web_server_enable", "1");

        o = s.taboption('xray_server', form.SectionValue, "xray_server_fallback", form.GridSection, 'fallback', _('Fallback Servers'), _("Specify upstream servers here."));
        o.depends({ "web_server_enable": "1", "web_server_protocol": "trojan" });
        o.depends({ "web_server_enable": "1", "web_server_protocol": "vless", "vless_tls": "tls" });
        o.depends({ "web_server_enable": "1", "web_server_protocol": "vless", "vless_tls": "xtls" });

        ss = o.subsection;
        ss.sortable = false;
        ss.anonymous = true;
        ss.addremove = true;

        o = ss.option(form.Value, "name", _("SNI"));

        o = ss.option(form.Value, "alpn", _("ALPN"));

        o = ss.option(form.Value, "path", _("Path"));

        o = ss.option(form.Value, "xver", _("Xver"));
        o.datatype = "uinteger";

        o = ss.option(form.Value, "dest", _("Destination Address"));
        o.datatype = 'hostport';

        s.tab('extra_options', _('Extra Options'));

        o = s.taboption('extra_options', form.Value, 'xray_bin', _('Xray Executable Path'));
        o.rmempty = false;
        if (xray_bin_default) {
            o.value("/usr/bin/xray", _("/usr/bin/xray (default, exist)"));
        }

        o = s.taboption('extra_options', form.ListValue, 'loglevel', _('Log Level'), _('Read Xray log in the <em>Logging</em> tab or use <code>logread</code> command.'));
        o.value("debug");
        o.value("info");
        o.value("warning");
        o.value("error");
        o.value("none");
        o.default = "warning";

        o = s.taboption('extra_options', form.Flag, 'access_log', _('Enable Access Log'), _('Access log will also be written to System Log.'));


        o = s.taboption('extra_options', form.Flag, 'xray_api', _('Enable Xray API Service'), _('Xray API Service uses port 8080 and GRPC protocol. Also callable via <code>xray api</code> or <code>ubus call xray</code>. See <a href="https://xtls.github.io/document/command.html#xray-api">here</a> for help.'));

        o = s.taboption('extra_options', form.Flag, 'stats', _('Enable Statistics'), _('Enable statistics of inbounds / outbounds data. Use Xray API to query values.'));

        o = s.taboption('extra_options', form.Flag, 'observatory', _('Enable Observatory'), _('Enable latency measurement for TCP and UDP outbounds.'));

        o = s.taboption('extra_options', form.Flag, 'fw4_counter', _('Enable Firewall Counters'), _('Add <a href="/cgi-bin/luci/admin/status/nftables">counters to firewall4</a> for transparent proxy rules. (Not supported in all OpenWrt versions. )'));

        o = s.taboption('extra_options', form.Flag, 'metrics_server_enable', _('Enable Xray Metrics Server'), _("Enable built-in metrics server for pprof and expvar. See <a href='https://github.com/XTLS/Xray-core/pull/1000'>here</a> for details."));

        o = s.taboption('extra_options', form.Value, 'metrics_server_port', _('Xray Metrics Server Port'), _("Metrics may be sensitive so think twice before setting it as Default Fallback HTTP Server."));
        o.depends("metrics_server_enable", "1");
        o.datatype = 'port';
        o.placeholder = '18888';

        o = s.taboption('extra_options', form.Value, 'handshake', _('Handshake Timeout'), _('Policy: Handshake timeout when connecting to upstream. See <a href="https://xtls.github.io/config/policy.html#levelpolicyobject">here</a> for help.'));
        o.datatype = 'uinteger';
        o.placeholder = 4;

        o = s.taboption('extra_options', form.Value, 'conn_idle', _('Connection Idle Timeout'), _('Policy: Close connection if no data is transferred within given timeout. See <a href="https://xtls.github.io/config/policy.html#levelpolicyobject">here</a> for help.'));
        o.datatype = 'uinteger';
        o.placeholder = 300;

        o = s.taboption('extra_options', form.Value, 'uplink_only', _('Uplink Only Timeout'), _('Policy: How long to wait before closing connection after server closed connection. See <a href="https://xtls.github.io/config/policy.html#levelpolicyobject">here</a> for help.'));
        o.datatype = 'uinteger';
        o.placeholder = 2;

        o = s.taboption('extra_options', form.Value, 'downlink_only', _('Downlink Only Timeout'), _('Policy: How long to wait before closing connection after client closed connection. See <a href="https://xtls.github.io/config/policy.html#levelpolicyobject">here</a> for help.'));
        o.datatype = 'uinteger';
        o.placeholder = 5;

        o = s.taboption('extra_options', form.Value, 'buffer_size', _('Buffer Size'), _('Policy: Internal cache size per connection. See <a href="https://xtls.github.io/config/policy.html#levelpolicyobject">here</a> for help.'));
        o.datatype = 'uinteger';
        o.placeholder = 512;

        o = s.taboption('extra_options', form.Flag, 'preview_or_deprecated', _('Preview or Deprecated'), _("Show preview or deprecated features (requires reboot to take effect)."));

        o = s.taboption('extra_options', form.SectionValue, "xray_bridge", form.TableSection, 'bridge', _('Bridge'), _('Reverse proxy tool. Currently only client role (bridge) is supported. See <a href="https://xtls.github.io/config/reverse.html#bridgeobject">here</a> for help.'));

        ss = o.subsection;
        ss.sortable = false;
        ss.anonymous = true;
        ss.addremove = true;

        let bridge_upstream = ss.option(form.ListValue, "upstream", _("Upstream"));
        bridge_upstream.datatype = "uciname";

        o = ss.option(form.Value, "domain", _("Domain"));
        o.rmempty = false;

        o = ss.option(form.Value, "redirect", _("Redirect address"));
        o.datatype = "hostport";
        o.rmempty = false;

        s.tab('custom_options', _('Custom Options'));
        let custom_configuration_hook = s.taboption('custom_options', form.TextValue, 'custom_configuration_hook', _('Custom Configuration Hook'), _('Read <a href="https://ucode.mein.io/">ucode Documentation</a> for the language used. Code filled here may need to change after upgrading luci-app-xray.'));
        custom_configuration_hook.placeholder = "return function(config) {\n    return config;\n};";
        custom_configuration_hook.monospace = true;
        custom_configuration_hook.rows = 20;




        s.tab('statistics', _('Statistics'));

        o = s.taboption('statistics', form.DummyValue, '_node_stats', _('Node Statistics'), _('Bytes per outbound node, from Xray\'s stats API plus the totals archived in <code>/var/run/xray/metrics.json</code> each time Xray stops (so restarts do not lose them; a router reboot clears them). Counters include the observatory\'s probe traffic, so treat the share as indicative.'));
        o.rawhtml = true;
        o.readonly = true;
        o.parse = log_no_save;
        o.cfgvalue = function () {
            return '<div id="node_stats_box">' + node_stats_html(node_stats) + '</div>';
        };

        o = s.taboption('statistics', form.Button, '_node_stats_refresh', _('Refresh'));
        o.inputstyle = 'action';
        o.parse = log_no_save;
        o.onclick = function () { node_stats_fetch().then(node_stats_set); return false; };
        o = s.taboption('statistics', form.DummyValue, '_xray_log', _('Xray Log'), _('Log lines of the running Xray process, taken from the system log (healthcheck lines have their own log below). Raise <em>Log Level</em> to log more.'));
        o.rawhtml = true;
        o.readonly = true;
        o.parse = log_no_save;
        o.cfgvalue = function () { return log_textarea('log_xray', xray_log); };

        o = s.taboption('statistics', form.Button, '_xray_log_refresh', _('Refresh'));
        o.inputstyle = 'action';
        o.parse = log_no_save;
        o.onclick = function () { log_refresh(); return false; };
        o = s.taboption('statistics', form.DummyValue, '_healthcheck_log', _('HealthCheck Log'), _('Output of <code>/etc/init.d/xray_core healthcheck</code> (<code>/var/log/xray_healthcheck.log</code>, cleared daily). It only records state changes: problems every time, healthy at most once an hour.'));
        o.rawhtml = true;
        o.readonly = true;
        o.parse = log_no_save;
        o.cfgvalue = function () { return log_textarea('log_healthcheck', healthcheck_log); };

        o = s.taboption('statistics', form.Button, '_healthcheck_log_refresh', _('Refresh'));
        o.inputstyle = 'action';
        o.parse = log_no_save;
        o.onclick = function () { log_refresh(); return false; };

        const servers = uci.sections(config_data, "servers");
        for (let selection of [destination, tcp_balancer_v4, tcp_balancer_v6, udp_balancer_v4, udp_balancer_v6, bridge_upstream, force_forward_server_tcp, force_forward_server_udp, dialer_proxy]) {
            if (servers.length == 0) {
                selection.value("direct", _("No server configured"));
                selection.readonly = true;
                continue;
            }
            for (const v of servers) {
                selection.value(v[".name"], server_alias(v));
            }
        }
        return m.render();
    }
});
