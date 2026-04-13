/*!
powerfullz 的 Substore 订阅转换脚本
https://github.com/powerfullz/override-rules

支持的传入参数：
- loadbalance: 启用负载均衡（url-test/load-balance，默认 false）
- landing: 启用落地节点功能（如机场家宽/星链/落地分组，默认 false）
- ipv6: 启用 IPv6 支持（默认 false）
- full: 输出完整配置（适合纯内核启动，默认 false）
- keepalive: 启用 tcp-keep-alive（默认 false）
- nofakeip: DNS 禁用 FakeIP 模式（默认 false，false 为 FakeIP，true 为 RedirHost）
- noquic: 禁用 QUIC 流量（UDP 443，默认 false，false 表示允许 QUIC）
- threshold: 国家节点数量小于该值时不显示分组 (默认 2)
- regex: 使用正则过滤模式（include-all + filter）写入各国家代理组，而非直接枚举节点名称（默认 false）
- dashboard: 启用 Dashboard 功能（默认 false，启用后会在配置中添加相关设置，以便开启内置 Dashboard）
- frequency: 设置检查检查频率（1: 一般；2：高频）
*/

const NODE_SUFFIX = "节点";

function parseBool(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        return value.toLowerCase() === "true" || value === "1";
    }
    return false;
}

function parseNumber(value, defaultValue = 0) {
    if (value === null || typeof value === "undefined") {
        return defaultValue;
    }
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
}

function getTestPolicy() {
    switch (frequency) {
        case 2:
            return {
                leaf: { interval: 67, tolerance: 30 },
                parent: { interval: 139, tolerance: 50 },
            };
    }
    return {
        leaf: { interval: 193, tolerance: 50 },
        parent: { interval: 397, tolerance: 70 },
    };
}

/**
 * 解析传入的脚本参数，并将其转换为内部使用的功能开关（feature flags）。
 * @param {object} args - 传入的原始参数对象，如 $arguments。
 * @returns {object} - 包含所有功能开关状态的对象。
 *
 * 该函数通过一个 `spec` 对象定义了外部参数名（如 `loadbalance`）到内部变量名（如 `loadBalance`）的映射关系。
 * 它会遍历 `spec` 中的每一项，对 `args` 对象中对应的参数值调用 `parseBool` 函数进行布尔化处理，
 * 并将结果存入返回的对象中。
 */
function buildFeatureFlags(args) {
    const spec = {
        loadbalance: "loadBalance",
        landing: "landing",
        ipv6: "ipv6Enabled",
        full: "fullConfig",
        keepalive: "keepAliveEnabled",
        nofakeip: "noFakeIP",
        noquic: "noQuic",
        regex: "regexFilter",
        dashboard: "dashboardEnabled",
    };

    const flags = Object.entries(spec).reduce((acc, [sourceKey, targetKey]) => {
        acc[targetKey] = parseBool(args[sourceKey]) || false;
        return acc;
    }, {});

    flags.countryThreshold = parseNumber(args.threshold, 2);
    flags.frequency = parseNumber(args.frequency);

    return flags;
}

const rawArgs = typeof $arguments !== "undefined" ? $arguments : {};
const {
    loadBalance,
    landing,
    ipv6Enabled,
    fullConfig,
    keepAliveEnabled,
    noFakeIP,
    noQuic,
    regexFilter,
    countryThreshold,
    dashboardEnabled,
    frequency,
} = buildFeatureFlags(rawArgs);

function getCountryGroupNames(countryInfo, minCount) {
    const filtered = countryInfo.filter((item) => item.nodes.length >= minCount);

    /**
     * 按 `countriesMeta` 中的 `weight` 字段升序排列；
     * 未配置 `weight` 的地区排在末尾（视为 Infinity）。
     */
    filtered.sort((a, b) => {
        const wa = countriesMeta[a.country]?.weight ?? Infinity;
        const wb = countriesMeta[b.country]?.weight ?? Infinity;
        return wa - wb;
    });

    return filtered.map((item) => item.country + NODE_SUFFIX);
}

function stripNodeSuffix(groupNames) {
    const suffixPattern = new RegExp(`${NODE_SUFFIX}$`);
    return groupNames.map((name) => name.replace(suffixPattern, ""));
}

const PROXY_GROUPS = {
    SELECT: "节点选择",
    MANUAL: "手动选择",
    CLEAN: "纯净优选",
    FALLBACK: "故障转移",
    DIRECT: "直连",
    FOREIGN: "境外节点",
    LANDING: "落地节点",
    LOW_COST: "低倍率节点",
};

/**
 * 接受任意数量的元素（包括嵌套数组），展平后过滤掉所有假值（false、null、undefined 等），
 * 用于以声明式风格构建代理列表，让条件项直接写 `condition && value` 即可。
 */
const buildList = (...elements) => elements.flat().filter(Boolean);

function buildBaseLists({ landing, lowCostNodes, countryGroupNames }) {
    const lowCost = lowCostNodes.length > 0 || regexFilter;

    /**
     * "节点选择"组的顶层候选列表：故障转移 → 落地节点（可选）→ 各国家组 → 低倍率（可选）→ 手动 → 直连。
     */
    const defaultSelector = buildList(
        PROXY_GROUPS.CLEAN,
        PROXY_GROUPS.FALLBACK,
        landing && PROXY_GROUPS.LANDING,
        PROXY_GROUPS.FOREIGN,
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.MANUAL,
        "DIRECT"
    );

    /**
     * 大多数策略组的通用候选列表：以"节点选择"为首选，再跟各国家组、低倍率、手动、直连。
     */
    const defaultProxies = buildList(
        PROXY_GROUPS.SELECT,
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.MANUAL,
        PROXY_GROUPS.DIRECT
    );

    /**
     * 直连优先的候选列表，用于 Bilibili 等国内服务：直连排首位，其余顺序与 defaultProxies 一致。
     */
    const defaultProxiesDirect = buildList(
        PROXY_GROUPS.DIRECT,
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.SELECT,
        PROXY_GROUPS.MANUAL
    );

    /**
     * "故障转移"组的候选列表：落地节点（可选）→ 各国家组 → 低倍率（可选）→ 手动 → 直连。
     * 不包含"节点选择"自身，避免循环引用。
     */
    const defaultFallback = buildList(
        landing && PROXY_GROUPS.LANDING,
        countryGroupNames,
        lowCost && PROXY_GROUPS.LOW_COST,
        PROXY_GROUPS.MANUAL,
        "DIRECT"
    );

    return { defaultProxies, defaultProxiesDirect, defaultSelector, defaultFallback };
}

const ruleProviders = {
    ADBlock: {
        type: "http",
        behavior: "domain",
        format: "mrs",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/217heidai/adblockfilters@main/rules/adblockmihomolite.mrs",
        path: "./ruleset/ADBlock.mrs",
    },
    StaticResources: {
        type: "http",
        behavior: "domain",
        format: "text",
        interval: 86400,
        url: "https://ruleset.skk.moe/Clash/domainset/cdn.txt",
        path: "./ruleset/StaticResources.txt",
    },
    CDNResources: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://ruleset.skk.moe/Clash/non_ip/cdn.txt",
        path: "./ruleset/CDNResources.txt",
    },
    AdditionalFilter: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/AlphaV10/metaX@v0.0.1/ruleset/AdditionalFilter.list",
        path: "./ruleset/AdditionalFilter.list",
    },
    AdditionalCDNResources: {
        type: "http",
        behavior: "classical",
        format: "text",
        interval: 86400,
        url: "https://gcore.jsdelivr.net/gh/AlphaV10/metaX@v0.0.1/ruleset/AdditionalCDNResources.list",
        path: "./ruleset/AdditionalCDNResources.list",
    },
};

const baseRules = [
    `IP-CIDR,1.1.1.1/32,${PROXY_GROUPS.SELECT},no-resolve`,
    `IP-CIDR,8.8.8.8/32,${PROXY_GROUPS.SELECT},no-resolve`,
    `GEOSITE,PRIVATE,${PROXY_GROUPS.DIRECT}`,
    `GEOIP,PRIVATE,${PROXY_GROUPS.DIRECT},no-resolve`,
    `RULE-SET,ADBlock,广告拦截`,
    `RULE-SET,AdditionalFilter,广告拦截`,
    `RULE-SET,StaticResources,静态资源`,
    `RULE-SET,CDNResources,静态资源`,
    `RULE-SET,AdditionalCDNResources,静态资源`,
    `DOMAIN,services.googleapis.cn,${PROXY_GROUPS.SELECT}`,
    `DOMAIN-SUFFIX,zeabur.com,${PROXY_GROUPS.FOREIGN}`,
    "GEOSITE,TELEGRAM,Telegram",
    `GEOSITE,GFW,${PROXY_GROUPS.SELECT}`,
    `GEOSITE,CN,${PROXY_GROUPS.DIRECT}`,
    "GEOIP,TELEGRAM,Telegram,no-resolve",
    `GEOIP,CN,${PROXY_GROUPS.DIRECT}`,
    `MATCH,${PROXY_GROUPS.SELECT}`,
];

function buildRules({ noQuic }) {
    const ruleList = [...baseRules];
    if (noQuic) {
        /**
         * 屏蔽 UDP 443（QUIC）流量。
         * 部分网络环境下 UDP 性能不稳定，禁用 QUIC 可强制回退到 TCP，改善整体体验。
         */
        ruleList.unshift("AND,((DST-PORT,443),(NETWORK,UDP)),REJECT");
    }
    return ruleList;
}

const snifferConfig = {
    sniff: {
        HTTP: {
            ports: [80],
        },
        TLS: {
            ports: [443],
        },
        QUIC: {
            ports: [443],
        },
    },
    enable: true,
    "force-dns-mapping": true,
    "parse-pure-ip": true,
    "override-destination": false,
    "skip-domain": ["+.push.apple.com"],
    "skip-dst-address": [
        "91.105.192.0/23",
        "91.108.4.0/22",
        "91.108.8.0/21",
        "91.108.16.0/21",
        "91.108.56.0/22",
        "95.161.64.0/20",
        "149.154.160.0/20",
        "185.76.151.0/24",
        "2001:67c:4e8::/48",
        "2001:b28:f23c::/47",
        "2001:b28:f23f::/48",
        "2a0a:f280:203::/48",
    ],
};

function buildDnsConfig({ mode, fakeIpFilter }) {
    const config = {
        enable: true,
        ipv6: ipv6Enabled,
        "prefer-h3": false,
        "respect-rules": false,
        "enhanced-mode": mode,
        "default-nameserver": ["223.5.5.5"],
        "proxy-server-nameserver": ["https://dns.alidns.com/dns-query&h3=true"],
        "direc-nameserver": ["quic://dns.alidns.com"],
        nameserver: ["quic://dns.alidns.com"],
        fallback: [
            `https://8.8.8.8/dns-query#${PROXY_GROUPS.SELECT}&h3=true`,
            `https://1.1.1.1/dns-query#${PROXY_GROUPS.SELECT}&h3=true`,
        ],
        "fallback-filter": {
            geoip: true,
            "geoip-code": "CN",
            geosite: ["GFW"],
            ipcidr: ["240.0.0.0/4", "0.0.0.0/32"],
        },
    };

    if (fakeIpFilter) {
        config["fake-ip-filter"] = fakeIpFilter;
    }

    return config;
}

const dnsConfig = buildDnsConfig({ mode: "redir-host" });
const dnsConfigFakeIp = buildDnsConfig({
    mode: "fake-ip",
    fakeIpFilter: [
        "geosite:private",
        "geosite:connectivity-check",
        "geosite:cn",
        "+.ntp.org",
        "ntp.*.com",
        "time.*.com",
        "+.msftconnecttest.com",
        "+.msftncsi.com",
        "+.apple.com",
        "+.icloud.com",
        "+.mzstatic.com",
        "+.googleapis.com",
        "+.gstatic.com",
        "cp.cloudflare.com",
    ],
});

const geoxURL = {
    geoip: "https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip-lite.dat",
    geosite: "https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat",
    mmdb: "https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.metadb",
    asn: "https://gcore.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb",
};

/**
 * 各地区的元数据：`weight` 决定在代理组列表中的排列顺序（值越小越靠前，未设置则排末尾）；
 * `pattern` 是用于匹配节点名称的正则字符串；`icon` 为策略组图标 URL。
 */
const countriesMeta = {
    日本: {
        weight: 10,
        pattern: "日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan|🇯🇵",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Japan.png",
    },
    新加坡: {
        weight: 20,
        pattern: "新加坡|坡|狮城|SG|Singapore|🇸🇬",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Singapore.png",
    },
    香港: {
        weight: 30,
        pattern: "香港|港|HK|hk|Hong Kong|HongKong|hongkong|🇭🇰",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Hong_Kong.png",
    },
    澳门: {
        pattern: "澳门|MO|Macau|🇲🇴",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Macao.png",
    },
    台湾: {
        weight: 40,
        pattern: "台|新北|彰化|TW|Taiwan|🇹🇼",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Taiwan.png",
    },
    韩国: {
        pattern: "KR|Korea|KOR|首尔|韩|韓|🇰🇷",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Korea.png",
    },
    美国: {
        weight: 50,
        pattern: "美国|美|US|United States|🇺🇸",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_States.png",
    },
    加拿大: {
        pattern: "加拿大|Canada|CA|🇨🇦",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Canada.png",
    },
    英国: {
        weight: 60,
        pattern: "英国|United Kingdom|UK|伦敦|London|🇬🇧",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/United_Kingdom.png",
    },
    澳大利亚: {
        pattern: "澳洲|澳大利亚|AU|Australia|🇦🇺",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Australia.png",
    },
    德国: {
        weight: 70,
        pattern: "德国|德|DE|Germany|🇩🇪",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Germany.png",
    },
    法国: {
        weight: 80,
        pattern: "法国|法|FR|France|🇫🇷",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/France.png",
    },
    俄罗斯: {
        pattern: "俄罗斯|俄|RU|Russia|🇷🇺",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Russia.png",
    },
    泰国: {
        pattern: "泰国|泰|TH|Thailand|🇹🇭",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Thailand.png",
    },
    印度: {
        pattern: "印度|IN|India|🇮🇳",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/India.png",
    },
    马来西亚: {
        pattern: "马来西亚|马来|MY|Malaysia|🇲🇾",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Malaysia.png",
    },
    巴西: {
        pattern: "巴西|巴|BR|Brazil|🇧🇷",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Brazil.png",
    },
    荷兰: {
        pattern: "荷兰|荷|NL|Netherlands|Holland|🇳🇱",
        icon: "https://gcore.jsdelivr.net/npm/svg-country-flags@latest/png100px/nl.png",
    },
};

const LOW_COST_REGEX = /(?<!\d)0\.[0-5]|低倍率|省流|大流量|实验性/i;
const LANDING_REGEX = /家宽|家庭|家庭宽带|商宽|商业宽带|星链|Starlink|落地/i;
/**
 * `LANDING_PATTERN` 与 `LANDING_REGEX` 描述同一规则，但格式不同：
 * - `LANDING_REGEX`：JS `RegExp` 对象，供脚本内部过滤节点时使用（用 `/i` flag 表示不区分大小写）。
 * - `LANDING_PATTERN`：字符串，写入 YAML 的 `filter` / `exclude-filter` 字段，
 *   其中 `(?i)` 前缀是 Clash/Mihomo 的不区分大小写语法。
 */
const LANDING_PATTERN = "(?i)家宽|家庭|家庭宽带|商宽|商业宽带|星链|Starlink|落地";
// 被污染的节点，使用这些节点可能无法访问部分服务（如 Gemini、ChatGPT 等），不过不一定完全不可用。
// 因此将它们排除在"纯净优选"之外，但不是直接丢弃，用户可根据需要选择是否使用这些节点。
const DIRTY_REGEX = /新加坡专线4/;

function parseLowCost(config) {
    return (config.proxies || [])
        .filter((proxy) => LOW_COST_REGEX.test(proxy.name))
        .map((proxy) => proxy.name);
}

function parseLandingNodes(config) {
    return (config.proxies || [])
        .filter((proxy) => LANDING_REGEX.test(proxy.name))
        .map((proxy) => proxy.name);
}

function parseCleanNodes(config) {
    return (config.proxies || []).flatMap((proxy) => {
        if (DIRTY_REGEX.test(proxy.name) || LOW_COST_REGEX.test(proxy.name)) {
            return [];
        }
        return [proxy.name];
    });
}

/**
 * 遍历订阅中的所有节点，按 `countriesMeta` 中定义的地区进行归类。
 *
 * 归类规则：
 * - 名称匹配 `LANDING_REGEX` 的落地节点和匹配 `LOW_COST_REGEX` 的低倍率节点不参与统计。
 * - 每个节点只归入第一个匹配到的地区，避免重复计入。
 * - 地区正则来自 `countriesMeta[country].pattern`；若旧配置中 pattern 携带 `(?i)` 前缀，
 *   会在编译前自动剥离（JS RegExp 不支持该语法）。
 *
 * @param {object} config - 订阅配置对象，包含 `proxies` 数组。
 * @returns {{ country: string, nodes: string[] }[]} - 每个元素对应一个地区及其节点名称列表。
 */
function parseCountries(config) {
    const proxies = config.proxies || [];

    const countryNodes = Object.create(null);

    const compiledRegex = {};
    for (const [country, meta] of Object.entries(countriesMeta)) {
        compiledRegex[country] = new RegExp(meta.pattern.replace(/^\(\?i\)/, ""));
    }

    for (const proxy of proxies) {
        const name = proxy.name || "";

        if (LANDING_REGEX.test(name)) continue;
        if (LOW_COST_REGEX.test(name)) continue;

        for (const [country, regex] of Object.entries(compiledRegex)) {
            if (regex.test(name)) {
                if (!countryNodes[country]) countryNodes[country] = [];
                countryNodes[country].push(name);
                break;
            }
        }
    }

    const result = [];
    for (const [country, nodes] of Object.entries(countryNodes)) {
        result.push({ country, nodes });
    }

    return result;
}

function buildCountryProxyGroups({ countries, landing, loadBalance, regexFilter, countryInfo }) {
    const groups = [];
    const baseExcludeFilter = "0\\.[0-5]|低倍率|省流|大流量|实验性";
    const landingExcludeFilter = LANDING_PATTERN;
    const groupType = loadBalance ? "load-balance" : "url-test";

    /**
     * 枚举模式（`regexFilter=false`）下预先建立"地区 → 节点名列表"的索引，
     * 避免在循环内反复遍历 `countryInfo`。
     * regex 模式不需要此索引，置为 null 节省开销。
     */
    const nodesByCountry = !regexFilter
        ? Object.fromEntries(countryInfo.map((item) => [item.country, item.nodes]))
        : null;

    const policy = getTestPolicy();

    for (const country of countries) {
        const meta = countriesMeta[country];
        if (!meta) continue;

        let groupConfig;

        if (!regexFilter) {
            /**
             * 枚举模式：直接列出已归类到该地区的节点名称，无需运行时正则过滤。
             */
            const nodeNames = nodesByCountry[country] || [];
            groupConfig = {
                name: `${country}${NODE_SUFFIX}`,
                icon: meta.icon,
                type: groupType,
                proxies: nodeNames,
            };
        } else {
            /**
             * regex 模式：通过 `include-all` + `filter` 让内核在运行时动态筛选节点，
             * 同时用 `exclude-filter` 排除低倍率节点；若启用了落地功能，
             * 还需一并排除落地节点，防止其混入普通地区组。
             */
            groupConfig = {
                name: `${country}${NODE_SUFFIX}`,
                icon: meta.icon,
                "include-all": true,
                filter: meta.pattern,
                "exclude-filter": landing
                    ? `${landingExcludeFilter}|${baseExcludeFilter}`
                    : baseExcludeFilter,
                type: groupType,
            };
        }

        if (!loadBalance) {
            Object.assign(groupConfig, {
                url: "https://cp.cloudflare.com/generate_204",
                lazy: true,
                ...policy.leaf,
            });
        }

        groups.push(groupConfig);
    }

    return groups;
}

function buildProxyGroups({
    landing,
    countries,
    countryProxyGroups,
    lowCostNodes,
    landingNodes,
    cleanNodes,
    defaultProxies,
    defaultProxiesDirect,
    defaultSelector,
    defaultFallback,
}) {
    /**
     * "前置代理"组的候选列表：从 `defaultSelector` 中移除"落地节点"和"故障转移"，
     * 避免前置代理与落地节点形成循环引用，以及与故障转移组相互嵌套。
     * 仅在 `landing=true` 时使用；否则置为空数组。
     */
    const frontProxySelector = landing
        ? defaultSelector.filter(
              (name) => name !== PROXY_GROUPS.LANDING && name !== PROXY_GROUPS.FALLBACK
          )
        : [];

    const policy = getTestPolicy();

    const foreignProxyGroups = countries.flatMap((country) => {
        return !["香港", "澳门", "台湾"].includes(country) ? `${country}${NODE_SUFFIX}` : [];
    });

    return [
        {
            name: PROXY_GROUPS.SELECT,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Proxy.png",
            type: "select",
            proxies: defaultSelector,
        },
        {
            name: PROXY_GROUPS.MANUAL,
            icon: "https://gcore.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
            "include-all": true,
            type: "select",
        },
        landing
            ? {
                  name: "前置代理",
                  icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Area.png",
                  type: "select",
                  /**
                   * regex 模式：`include-all` 拉取所有节点，`exclude-filter` 排除落地节点，
                   * 同时在 `proxies` 里附加手动指定的候选组名列表（各国家组等）。
                   * 枚举模式：直接列出候选组名（落地节点已在构建 `frontProxySelector` 时过滤）。
                   */
                  ...(regexFilter
                      ? {
                            "include-all": true,
                            "exclude-filter": LANDING_PATTERN,
                            proxies: frontProxySelector,
                        }
                      : { proxies: frontProxySelector }),
              }
            : null,
        landing
            ? {
                  name: PROXY_GROUPS.LANDING,
                  icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Airport.png",
                  type: "select",
                  /**
                   * regex 模式：`include-all` + `filter` 动态筛选落地节点。
                   * 枚举模式：直接列出已识别的落地节点名称。
                   */
                  ...(regexFilter
                      ? { "include-all": true, filter: LANDING_PATTERN }
                      : { proxies: landingNodes }),
              }
            : null,
        {
            name: PROXY_GROUPS.CLEAN,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Auto.png",
            type: "url-test",
            lazy: true,
            ...policy.leaf,
            proxies: cleanNodes,
        },
        {
            name: PROXY_GROUPS.FALLBACK,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Bypass.png",
            type: "fallback",
            url: "https://cp.cloudflare.com/generate_204",
            proxies: defaultFallback,
            lazy: true,
            ...policy.parent,
        },
        {
            name: "静态资源",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Cloudflare.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: "Telegram",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Telegram.png",
            type: "select",
            proxies: defaultProxies,
        },
        {
            name: PROXY_GROUPS.DIRECT,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Direct.png",
            type: "select",
            proxies: ["DIRECT", PROXY_GROUPS.SELECT],
        },
        {
            name: "广告拦截",
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/AdBlack.png",
            type: "select",
            proxies: ["REJECT", "REJECT-DROP", PROXY_GROUPS.DIRECT],
        },
        lowCostNodes.length > 0 || regexFilter
            ? {
                  name: PROXY_GROUPS.LOW_COST,
                  icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Lab.png",
                  type: "url-test",
                  url: "https://cp.cloudflare.com/generate_204",
                  lazy: true,
                  ...policy.leaf,
                  ...(!regexFilter
                      ? { proxies: lowCostNodes }
                      : { "include-all": true, filter: "(?i)0\\.[0-5]|低倍率|省流|大流量|实验性" }),
              }
            : null,
        {
            name: PROXY_GROUPS.FOREIGN,
            icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Catnet.png",
            type: "fallback",
            url: "https://cp.cloudflare.com/generate_204",
            proxies: foreignProxyGroups,
            lazy: true,
            ...policy.parent,
        },
        ...countryProxyGroups,
    ].filter(Boolean);
}

// eslint-disable-next-line no-unused-vars -- 通过 vm.runInContext 在 yaml_generator 中被调用
function main(config) {
    const resultConfig = { proxies: config.proxies };

    /**
     * 解析订阅中的节点，分别得到：地区归类信息、低倍率节点名列表、落地节点名列表，
     * 以及经过阈值过滤和权重排序后的国家组名列表与地区名列表。
     */
    const countryInfo = parseCountries(resultConfig);
    const lowCostNodes = parseLowCost(resultConfig);
    const landingNodes = landing ? parseLandingNodes(resultConfig) : [];
    const cleanNodes = parseCleanNodes(resultConfig);
    const countryGroupNames = getCountryGroupNames(countryInfo, countryThreshold);
    const countries = stripNodeSuffix(countryGroupNames);

    /**
     * 构建各类通用候选列表，供后续策略组复用。
     */
    const { defaultProxies, defaultProxiesDirect, defaultSelector, defaultFallback } =
        buildBaseLists({ landing, lowCostNodes, countryGroupNames });

    /**
     * 为每个地区生成对应的 `url-test` 或 `load-balance` 自动测速组。
     */
    const countryProxyGroups = buildCountryProxyGroups({
        countries,
        landing,
        loadBalance,
        regexFilter,
        countryInfo,
    });

    /**
     * 组装所有策略组（功能组 + 地区组）。
     */
    const proxyGroups = buildProxyGroups({
        landing,
        countries,
        countryProxyGroups,
        lowCostNodes,
        landingNodes,
        cleanNodes,
        defaultProxies,
        defaultProxiesDirect,
        defaultSelector,
        defaultFallback,
    });

    /**
     * GLOBAL 组需要枚举所有已生成的策略组名称，因此在其他组构建完成后追加，
     * 同时保留 `include-all` 以确保与各内核的兼容性。
     */
    const globalProxies = proxyGroups.map((item) => item.name);
    proxyGroups.push({
        name: "GLOBAL",
        icon: "https://gcore.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Global.png",
        "include-all": true,
        type: "select",
        proxies: globalProxies,
    });

    const finalRules = buildRules({ noQuic });

    if (fullConfig)
        Object.assign(resultConfig, {
            "mixed-port": 7890,
            "redir-port": 7892,
            "tproxy-port": 7893,
            "routing-mark": 7894,
            "allow-lan": true,
            "bind-address": "*",
            ipv6: ipv6Enabled,
            mode: "rule",
            "unified-delay": true,
            "tcp-concurrent": false,
            "find-process-mode": "off",
            "log-level": "info",
            "geodata-loader": "standard",
            "disable-keep-alive": !keepAliveEnabled,
            profile: {
                "store-selected": true,
            },
        });

    if (dashboardEnabled)
        Object.assign(resultConfig, {
            "external-controller": "127.0.0.1:9090",
            "external-ui-url":
                "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
            "external-ui": "dashboard",
            "external-ui-name": "metacubexd",
        });

    Object.assign(resultConfig, {
        "proxy-groups": proxyGroups,
        "rule-providers": ruleProviders,
        rules: finalRules,
        sniffer: snifferConfig,
        dns: noFakeIP ? dnsConfig : dnsConfigFakeIp,
        "geodata-mode": false,
        "geox-url": geoxURL,
    });

    return resultConfig;
}
