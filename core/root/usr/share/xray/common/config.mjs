"use strict";

import { cursor } from "uci";

export function load_config() {
    const uci = cursor();
    uci.load("xray_core");
    return uci.get_all("xray_core") || {};
};

/* dnsmasq-extra 的 direct_domains：那里维护的"强制直连域名"。dnsmasq-extra
   自己也会把这份列表追加进 homeproxy 的 direct_list.txt；本 app 把它并入
   Bypassed Domain，让开启 Sniffing 后这些域名同样直连出站。
   配置/选项不存在时返回空数组。 */
export function load_dnsmasq_extra_direct_domains() {
    try {
        const uci = cursor();
        uci.load("dnsmasq-extra");
        const config = uci.get_all("dnsmasq-extra") || {};
        const general = filter(values(config), v => v[".type"] == "general")[0] || {};
        const value = general["direct_domains"];
        if (value == null)
            return [];
        return type(value) == "array" ? value : [value];
    } catch (e) {
        return [];
    }
};
