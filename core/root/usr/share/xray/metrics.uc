#!/usr/bin/ucode
"use strict";

/* 把 xray 的 per-outbound 计数累加进 /var/run/xray/metrics.json。
   为什么需要它：xray 的 stats 只存在内存里，进程一停（healthcheck 自愈、手动
   restart、刷机）就清零；这里在停止前把当前值归档进去，Nodes 标签页再把
   归档值 + 本次的值相加显示。

   用法：
     ucode metrics.uc                 # 自己去问 xray 的 api（stop 时由 init 脚本调用）
     ucode metrics.uc <stats.json>    # 用现成的 statsquery 输出（便于离线测试）
   注意：/var/run/xray 在 tmpfs 上，所以只跨 xray 重启，不跨路由器重启。/var/etc/xray
   每次启动都会被清理（gen_config_file 的 rm -f），所以放 /var/run/xray 更合适。 */

import { readfile, writefile, popen } from "fs";

const METRICS = getenv("XRAY_METRICS") || "/var/run/xray/metrics.json";
const API_BIN = "/usr/bin/xray";
const API_ADDR = "127.0.0.1:8080";

/* "outbound>>><tag>>>traffic>>>(uplink|downlink)" → { <节点名>: { up, down } } */
function aggregate(stats) {
    let nodes = {};
    for (let s in stats) {
        let m = match(s["name"] || "", /^outbound>>>(.+)>>>traffic>>>(uplink|downlink)$/);
        if (m == null)
            continue;
        let tag = m[1];
        let node = index(tag, ":") >= 0 ? substr(tag, rindex(tag, ":") + 1) : tag;
        let cur = nodes[node];
        if (cur == null)
            cur = nodes[node] = { up: 0, down: 0 };
        cur[m[2] == "uplink" ? "up" : "down"] += int(s["value"] || 0);
    }
    return nodes;
};

function load_total() {
    let raw = readfile(METRICS);
    if (raw == null)
        return { since: null, nodes: {} };
    let parsed = null;
    try {
        parsed = json(raw);
    } catch (e) {
        parsed = null;
    }
    return (parsed != null && parsed["nodes"] != null) ? parsed : { since: null, nodes: {} };
};

function live_stats(path) {
    if (path != null)
        return readfile(path);
    let p = popen(`${API_BIN} api statsquery --server=${API_ADDR}`, "r");
    if (p == null)
        return null;
    let out = p.read("all");
    p.close();
    return out;
};

/* ---- 主流程（ucode 里函数必须先声明后使用，所以辅助函数都在上面）---- */
let raw = live_stats(length(ARGV) > 0 ? ARGV[0] : null);
if (raw == null || length(trim(raw)) == 0) {
    warn("metrics.uc: no live statistics (api disabled or xray not running)\n");
    exit(0);
}

let stats = null;
try {
    stats = json(raw)["stat"];
} catch (e) {
    stats = null;
}
if (stats == null)
    exit(0);

let delta = aggregate(stats);
if (length(keys(delta)) == 0)
    exit(0);

let total = load_total();
let now = time();
if (total["since"] == null)
    total["since"] = now;

for (let name in delta) {
    let cur = total["nodes"][name];
    if (cur == null)
        cur = total["nodes"][name] = { up: 0, down: 0 };
    cur["up"] = int(cur["up"] || 0) + delta[name]["up"];
    cur["down"] = int(cur["down"] || 0) + delta[name]["down"];
}
total["updated"] = now;

/* 目录不一定存在（手工直跑时没有 init 脚本的 mkdir），ucode 又没有 mkdir */
let dir = substr(METRICS, 0, rindex(METRICS, "/"));
if (length(dir) > 0)
    system(sprintf("mkdir -p '%s'", dir));

if (writefile(METRICS, sprintf("%.4J\n", total)) == false)
    warn(sprintf("metrics.uc: cannot write %s\n", METRICS));
