# AGENTS.md

本仓库是 [yichya/luci-app-xray](https://github.com/yichya/luci-app-xray) 的分支
（`honwen/luci-app-xray-fw4`），面向 **firewall4 + 预编译 xray** 的部署：
DNS 交给 dnsmasq-extra、国内直连放在 nft 层、不使用 geoip/geosite 数据。

**维护约定**：历史保持「上游 + 少数几个功能提交」，不要把一次功能拆成很多小提交。
下面三节是本分支自己的约定；第四节起是上游原文（仍然适用）。

## 设计目标（本分支相对上游的取舍）

1. **DNS 完全外置**（客户端侧；唯一例外是第 6 条的服务器域名解析）
   - 不提供 DNS 入站（dokodemo 53xx）与 `dns_server_outbound`、不做 DNS 劫持、
     不产出 DNS 路由规则、不写 dnsmasq 片段——客户端 DNS 全归 dnsmasq-extra。
   - 出站服务器域名默认由**系统解析器**解析（`/etc/resolv.conf` → dnsmasq → smartdns）；
     server 单独配了 `domain_resolve_dns` 的走 xray 自己的解析器（同样不碰客户端 DNS）。
   - 因此 `[DNS]` / `[FakeDNS]` 标签页、preview 的 `DNS Hijacking` 标签页、
     `Enable DNS Log` 选项都已移除——没有 xray 自有 DNS，它们无内容可配置/记录。
   - DNS 的防污染、缓存、分流全部由 `openwrt-dnsmasq-extra`（smartdns）负责。

2. **国内直连在 nft 层完成**：`Outbound Routing → Bypassed IP List`
   - 默认 `/etc/dnsmasq-extra.d/chnroute.txt`（每行一条 CIDR，`#` 注释）。
   - 渲染防火墙时读文件 → nft interval 集合 `tp_spec_dv4_ch`/`tp_spec_dv6_ch`
     （`auto-merge`）→ 在 `tp_spec_lan_ac` 链 accept。
   - 排在它前面的是 `Forwarded IP` / `Forwarded IP List`（集合 `tp_spec_dv*_fw`，
     `goto tp_spec_lan_fw` 打 mark 0xfb 强制送 xray）：**转发优先于绕过**。
   - 默认列表是纯 v4，`tp_spec_dv6_ch` 不生成属正常（有 v6 条目才建集合）；
     空集合对应的规则也不渲染。
   - 命中的流量根本不进入 xray；列表跟随文件更新（重载防火墙即可，不必重启 xray）。

3. **不依赖 geoip.dat / geosite.dat**：不再使用 `geoip:*` / `geosite:*`，
   因而不需要 `luci-app-xray-geodata` 或任何 geodata 数据包。
   (`geoip:private` 原先提供的私网直连由 nft 层同链的 `tp_spec_d*_sp` accept 覆盖。)

4. **端口白名单**：`Default Ports Policy = bypassed` + `Forwarded TCP Ports`，
   只代理列表内的目的端口（对齐 homeproxy 的 `infra.common_port`）。
   `Forwarded UDP Ports` 留空则 UDP 不代理。

5. **域名分流**：`Bypassed Domain` / `Forwarded Domain`（各可另指一个文件，
   命名与 `Bypassed IP` / `Forwarded IP` 系列一致：`*_list` 结尾的都是"文件"），
   生成两条 xray 路由规则（直连优先）。
   - **必须开启 sniffing**（`tproxy_sniffing=1`）才有域名可用。
   - `Bypassed Domain List` 默认 `/etc/dnsmasq-extra.d/direct.gz`；
     `Forwarded Domain List` 没有默认值（UI 描述里的 `gfwlist.gz` 只是示例）。
   - 文件每行一个域名、`#` 注释；`.gz` 先用 `zcat` 解到 `/tmp` 再读（ucode 无解压）；
     裸域名统一加 `domain:` 前缀（xray 的 `domain:` 即后缀匹配，含子域），去掉前导 `.`。
   - 读文件的时机不同：**域名列表在 xray 启动时**由 `gen_config.uc` 读取
     （改文件后要重启 xray），**IP 列表在 fw4 重载时**由模板读取（`fw4 reload` 即可）。

6. **服务器域名解析（可选，按 server 配）**：`Server → Server Hostname Resolving`
   - `domain_resolve_dns` + `domain_resolve_dns_method`（udp / tcp / https / quic，
     以及 `+local` 变体）给每个 server **单独指定**解析其域名的 DNS。
   - 生成 `dns` 段：按 `方法;DNS` 归并，条目形如
     `{address, port?, domains: ["domain:ix.xtun.xyz", ...], skipFallback: true}`；
     末尾补一台 catch-all `{address: "localhost"}`（= 系统解析器），所以只给部分
     server 配也没问题。没有任何 server 配置时**不生成** `dns` 段（与旧行为一致）。
   - 目的：**断开循环依赖**——smartdns 的上游（DoH/DoT）万一要经过代理才能访问，
     解析节点域名就不再依赖 smartdns。
   - dns 段的 `queryStrategy` 固定 **UseIP**（A + AAAA 都查），**没有全局选项**：
     它是"能力上限"，会限制 dns 段里所有服务器能查的记录类型，与子项冲突时子项直接
     空响应（官方文档：全局 UseIPv4 + 子项 UseIPv6 → 该子项空响应）。用 v4 还是 v6
     由每个 server 自己的 `domain_strategy`（Server → Server Hostname Resolving）
     决定，全局只有留最宽的一档，才不会把选了另一族的节点饿死。
   - `dns` 段带 `tag: xray_server_dns`，并在路由规则**最前面**插一条
     `inboundTag: [xray_server_dns] → outboundTag: direct`——**Xray 内部 DNS 客户端的
     查询同样要过路由表**，而本 app 的第一个出站是 `blackhole_outbound`（未匹配规则的
     默认出站），不显式放行会被黑洞掉：`failed to resolve ip > app/dns: record not found`
     （实测复现过，整条代理因此全挂）。
   - 上游的 `dns.mjs`（fakeDNS、secure/fast 规则、DNS 入站）仍然**不接线**；本分支只
     自己实现了它的 per-server DNS 部分。`dns_direct_servers()` 保持恒空、
     `tp_spec_dp*_bp` 集合不再生成——"直连"由上面那条路由规则保证，比 nft 兜底更靠前。

7. **依赖预编译包**：上游的 `+xray-core` 由 `openwrt-precompiled-feeds` 的 `xray`
   包以 `PROVIDES:=xray-core` 满足；本分支不改依赖声明。

8. **observatory 的 `probeInterval` 改成 1s**（上游写死 `100ms`）：`leastPing` 必须有
   observatory，而 100ms 轮询（本 app 逐个 subject 轮）实测约 **5–10 KB/s 持续走节点**
   （≈0.5–0.9 GB/天，出口 IP 上约 10 次/秒 GET `apple.com`）；1s 让每个 subject 约 6s
   探一次，开销约 1/10，对 leastPing 足够。**探测地址改用 fw3 的探测点
   `http://detectportal.firefox.com/success.txt`**（fw3 里是
   `PROBE_ENDPOINT='detectportal.firefox.com'` + `probeURL: https://$PROBE_ENDPOINT/success.txt`；
   比上游 apple.com 的 `test/success.html` 更适合当探测点；**协议用 http 而不是 fw3 的
   https**：1s 一探时 https 每次都多一次 TLS 握手，http 省掉这部分开销），
   `subjectSelector` 仍是上游那套（四个 balancer 前缀 + extra_inbound + direct + manual_tproxy）。

## 架构限制（改之前先读）

- **nft 是预筛，域名规则管不到被它放行的流量**：国内 IP（`Bypassed IP List`）
  与端口策略外的端口在进入 xray 之前就被 accept，因此 `Forwarded Domain List` 对这类
  流量无效（homeproxy 的 geoip 判断在 sing-box 内部，所以没有这个限制）。
  要强制它们走代理，用 `Forwarded IP`（`wan_fw_ips`）或 `Forwarded IP List`
  （`wan_fw_ip_list`，文件）——显式转发规则排在 `Bypassed IP List` 之前，因此
  列进去的国内地址确实会被推给 xray（或干脆关闭绕过列表）。
- **sniffing 是域名分流的前提**：不开 sniffing 时 xray 只有目的 IP，域名规则永不命中
  （上游那三个 `*_domain_rules` 选项在默认配置下就是这样变成死配置的）。
- **xray 的 DNS 出站/入站已不存在**：任何依赖 xray 解析域名的功能都要重新设计。

## 开发流程

- **上游同步**：`gh repo sync honwen/luci-app-xray-fw4`，或在克隆里
  `git fetch upstream && git merge upstream/master`（克隆的 `upstream` 指向 yichya）。
- **构建/验证环境**：`chenhw2/openwrt-build-dockerenv` —— 本仓库以
  `workdir/immortalwrt/<ver>/package/feeds/luci-app-xray` 的形式被 `setup.sh` 克隆，
  改完用 `./exec.sh make -j32` 构建、`sysupgrade -n` 刷机。
- **三层验证**（改 `gen_config.uc` 或 `firewall_include.ut` 后必做）：
  1. 生成与自检：`ucode /usr/share/xray/gen_config.uc > /tmp/t.json && xray -test -config /tmp/t.json`
  2. nft 渲染：`utpl /usr/share/xray/firewall_include.ut > /tmp/fw.nft`，包进
     `table inet t { … }` 后 `nft -c -f` 检查语法（模板写坏会让 fw4 拒绝重载）
  3. 设备实测：出口 IP（国内/国外）、`nft list chain inet fw4 tp_spec_lan_ac`、
     必要时临时 `loglevel=info` 看 xray 是否收到该连接
  4. 清单类改动额外看：`nft list set inet fw4 tp_spec_dv4_ch` 的元素数（与源文件条数
     同量级）、`tp_spec_lan_ac` 里 fw 规则确实排在 ch 之前；UI 文案要 grep
     **设备上真正提供的** `/www/luci-static/resources/view/xray/core.js`
     （只改文案的提交也必须重编刷机，浏览器缓存的旧 JS 会掩盖改动）
- **第 1 层验证不必刷机**：构建目标是 x86_64/musl，所以构建树里编给目标的 ucode 和
  `dl/xray-linux-64-<ver>.zip` 里的 xray 都能在宿主机直接跑，用的还是设备上真会跑的那把
  xray（26.x 移除 `allowInsecure` 就是这么提前发现的）：

      W=workdir/immortalwrt/24.10.6
      L=$W/staging_dir/toolchain-x86_64_gcc-13.3.0_musl/lib/ld-musl-x86_64.so.1
      LP="$W/staging_dir/target-x86_64_musl/root-x86/usr/lib:$W/staging_dir/toolchain-x86_64_gcc-13.3.0_musl/lib"
      $L --library-path "$LP" $W/staging_dir/target-x86_64_musl/root-x86/usr/bin/ucode \
         -L $W/staging_dir/target-x86_64_musl/root-x86/usr/lib/ucode /tmp/x/gen_config.uc > /tmp/t.json
      unzip -o $W/dl/xray-linux-64-*.zip xray -d /tmp/xraybin
      /tmp/xraybin/xray -test -config /tmp/t.json

  `-L .../usr/lib/ucode` 不能省，否则 `import { readfile } from "fs"` 报
  "Unable to resolve path for module"；`gen_config.uc` 会 `import common/config.mjs` →
  `uci.load("xray_core")`，所以把 `core/root/usr/share/xray` 拷到 /tmp，再把
  `common/config.mjs` 换成返回假 UCI 表（`.type`/`.name`/选项值）的 stub，就能喂任意节点组合。
- **LuCI JS**（`core/root/www/luci-static/resources/view/xray/*.js`）是「函数体」
  风格（顶层 `return view.extend({...})`），`node --check` 需包一层函数：
  `{ echo "function _w__() {"; cat core.js; echo "}"; } > /tmp/w.mjs && node --check /tmp/w.mjs`
- **删除 UI 块后必做悬空引用扫描**：从 diff 里提取被删代码声明的 `let/const/var`，
  逐个回查现存文件是否仍引用。曾把 `fake_dns_forward_server_tcp/udp` 从标签页里删掉，
  但 extra_inbound 的 selector 数组仍引用它 → 页面直接抛 `ReferenceError`。
- **提交与推送**：组内提交用 `git reset --soft <base> && git commit` 压成一个；
  推送公开仓库用 `git push --force-with-lease=master:<远端当前 SHA> <ssh-url> HEAD:master`
  ——对**显式 URL** 推送时 `--force-with-lease` 没有远端跟踪引用可比对，必须显式给出期望值。

## 已知坑

- **ucode 的函数体只能引用源码中更早声明的名字**（没有 JS 式提升）：把辅助函数放在调用者
  之后会报 `access to undeclared variable`。新加的 helper 一律放在使用它的函数之前。
- **Xray 内部 DNS 查询走路由表**：`app/dns` 的查询带着自己的 inboundTag
  （我们在 dns 段里设成 `xray_server_dns`），匹配不到规则就走**第一个出站**——本 app
  的第一个出站是 `blackhole_outbound`，所以必须在路由最前面显式放行到 `direct`
  （见设计目标 6）。
- **nft 的 `comment` 不要带空格**：BusyBox + nft 组合下、在 shell 里执行时引号会被吞掉
  导致语法错误（写成模板文件里没这个问题——文件不经过 shell）。
- **fw4 的 `accept` 不会跳过同一 hook 的后续链**：另建一张更早优先级的表来"提前放行"
  挡不住 xray 的 tproxy（实测：自家链计数增长的同时 xray 链仍在计数）。规则必须写在
  xray 自己那条链里。
- **fw4 的 include 脚本在规则集加载之前执行**，此时链尚未创建；所以本分支把 IP 绕过
  做进渲染模板（`firewall_include.ut`），而不是外挂脚本 + fw4 include。
- **xray 26.x 已移除 `allowInsecure`**：`tlsSettings.allowInsecure` 只在为 `false` 时被接受，
  为 `true` 直接**拒绝启动**（"The feature allowInsecure has been removed and migrated to
  pinnedPeerCertSha256"）——而 `*_tls_insecure != "0"` 在选项缺失时正好求值为 true，所以
  本分支不再生成该字段，UI 的 `Allow Insecure` 开关也已删除：TLS 节点的证书必须有效
  （reality 节点不受影响，它走 realitySettings）。
- **`/etc/config/xray_core` 是设备运行时状态**：不要用包内 `core/root/etc/config/xray_core`
  （那是新装默认值）覆盖设备上的实时配置，否则会冲掉节点与 balancer 设置。
- 配置类改动（UCI 选项、模板）在 xray 重启后才生效；设备页面若看不到新选项，
  是浏览器缓存了旧 `core.js`（`luci-base` 版本没变则缓存令牌不变），需强刷。

## Repository Shape (upstream)
- This is an OpenWrt package repository, not a standalone JS app. There is no npm/test runner config in this repo.
- Packages live in `core/`, `geodata/`, and `status/`; each has its own OpenWrt `Makefile` and installs files from its `root/` tree.
- The base package name is `luci-app-xray` from `core/Makefile`; optional packages are `luci-app-xray-geodata` and `luci-app-xray-status`.

## Build / Verification (upstream)
- Build from an OpenWrt SDK tree with this repo linked as `package/luci-app-xray`, then run `./scripts/feeds update -a`, `./scripts/feeds install -a`, `make defconfig`.
- CI builds only the status target with `make package/luci-app-xray/status/{clean,compile} V=s` on OpenWrt SDK `23.05.5` x86_64; use that command as the closest verified package build smoke test.
- For full local checks, compile the package subdir you changed, for example `make package/luci-app-xray/core/{clean,compile} V=s`, `make package/luci-app-xray/geodata/{clean,compile} V=s`, or `make package/luci-app-xray/status/{clean,compile} V=s`.

## Runtime Wiring (upstream)
- LuCI views are client-side JS under `*/root/www/luci-static/resources/view/xray/`; menu registration is in `*/root/usr/share/luci/menu.d/*.json`, and ACLs are in `*/root/usr/share/rpcd/acl.d/*.json`.
- Shared LuCI state uses UCI config `xray_core`; `core/root/www/luci-static/resources/view/xray/shared.js` exposes this as `shared.variant`.
- Xray config generation runs on-device via `ucode /usr/share/xray/gen_config.uc`; feature modules live under `core/root/usr/share/xray/feature/`, protocol modules under `core/root/usr/share/xray/protocol/`, and common helpers under `core/root/usr/share/xray/common/`.
- The init script `core/root/etc/init.d/xray_core` generates `/var/etc/xray/config.json`, renders nftables snippets with `utpl`, and starts Xray with `-confdir /var/etc/xray`. (本分支已移除其中的 dnsmasq 集成。)

## Change Gotchas (upstream)
- When adding installed files, update the relevant package `Makefile` install section; files under `root/` are not automatically packaged.
- When adding or moving a LuCI page, update both the menu JSON and ACL JSON if the page needs UCI, file, or exec access.
- Keep package versions in sync across `core/Makefile`, `geodata/Makefile`, and `status/Makefile` when doing a release version bump.
- README states OpenWrt before `22.03` and Lean's OpenWrt source are unsupported because this package depends on firewall4 and client-side-rendered LuCI.
