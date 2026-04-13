// ---------- 助手功能 ----------

/**
 * 各地区的元数据：`weight` 决定在代理组列表中的排列顺序（值越小越靠前，未设置则排末尾）；
 * `regex` 是用于匹配节点名称的正则；`icon` 为图标。
 */
const countriesMeta = {
    日本: {
        weight: 10,
        regex: /日本|川日|东京|大阪|泉日|埼玉|沪日|深日|JP|Japan|🇯🇵/,
        icon: "🇯🇵",
    },
    新加坡: {
        weight: 20,
        regex: /新加坡|坡|狮城|SG|Singapore|🇸🇬/,
        icon: "🇸🇬",
    },
    香港: {
        weight: 30,
        regex: /香港|港|HK|hk|Hong Kong|HongKong|hongkong|🇭🇰/,
        icon: "🇨🇳",
    },
    澳门: {
        regex: /澳门|MO|Macau|🇲🇴/,
        icon: "🇨🇳",
    },
    台湾: {
        weight: 40,
        regex: /台|新北|彰化|TW|Taiwan|🇹🇼/,
        icon: "🇨🇳",
    },
    韩国: {
        regex: /KR|Korea|KOR|首尔|韩|韓|🇰🇷/,
        icon: "🇰🇷",
    },
    美国: {
        weight: 50,
        regex: /美国|美|US|United States|🇺🇸/,
        icon: "🇺🇸",
    },
    加拿大: {
        regex: /加拿大|Canada|CA|🇨🇦/,
        icon: "🇨🇦",
    },
    英国: {
        weight: 60,
        regex: /英国|United Kingdom|UK|伦敦|London|🇬🇧/,
        icon: "🇬🇧",
    },
    澳大利亚: {
        regex: /澳洲|澳大利亚|AU|Australia|🇦🇺/,
        icon: "🇦🇺",
    },
    德国: {
        weight: 70,
        regex: /德国|德|DE|Germany|🇩🇪/,
        icon: "🇩🇪",
    },
    法国: {
        weight: 80,
        regex: /法国|法|FR|France|🇫🇷/,
        icon: "🇫🇷",
    },
    俄罗斯: {
        regex: /俄罗斯|俄|RU|Russia|🇷🇺/,
        icon: "🇷🇺",
    },
    泰国: {
        regex: /泰国|泰|TH|Thailand|🇹🇭/,
        icon: "🇹🇭",
    },
    印度: {
        regex: /印度|IN|India|🇮🇳/,
        icon: "🇮🇳",
    },
    马来西亚: {
        regex: /马来西亚|马来|MY|Malaysia|🇲🇾/,
        icon: "🇲🇾",
    },
    巴西: {
        regex: /巴西|巴|BR|Brazil|🇧🇷/,
        icon: "🇧🇷",
    },
    荷兰: {
        regex: /荷兰|荷|NL|Netherlands|Holland|🇳🇱/,
        icon: "🇳🇱",
    },
};

const LOW_COST_REGEX = /(?<!\d)0\.[0-5]|低倍率|省流|大流量|实验性/;
const DIRTY_REGEX = /新加坡专线4/;

function getTag(name, icon = "") {
    return `${icon}${name}节点`;
}

function groupNodes(nodes) {
    const all = [];
    const lowCost = [];
    const premium = [];

    const countriesMap = new Map();

    for (const node of nodes) {
        if (!node.tag) continue;
        const leaf = node.tag;

        all.push(leaf);

        const isDirty = DIRTY_REGEX.test(leaf);

        if (LOW_COST_REGEX.test(leaf)) {
            lowCost.push(leaf);
        } else if (!isDirty) {
            premium.push(leaf);
        }
        if (isDirty) continue;

        for (const [name, meta] of Object.entries(countriesMeta)) {
            if (!meta.regex.test(leaf)) continue;

            let leaves = countriesMap.get(name);
            if (!leaves) {
                leaves = [];
                countriesMap.set(name, leaves);
            }
            leaves.push(leaf);
            break;
        }
    }

    const countries = [];
    const foreign = [];
    const countriesData = [...countriesMap]
        .sort((a, b) => {
            const wa = countriesMeta[a[0]]?.weight ?? Infinity;
            const wb = countriesMeta[b[0]]?.weight ?? Infinity;
            return wa - wb;
        })
        .map(([name, leaves]) => {
            const icon = countriesMeta[name]?.icon ?? "";
            const tag = getTag(name, icon);

            countries.push(tag);
            if (!["香港", "澳门", "台湾"].includes(name)) foreign.push(tag);

            return [tag, leaves];
        });

    return { all, premium, lowCost, countries, countriesData, foreign };
}

function buildOutbound(name, nodes, type = "urltest") {
    switch (type) {
        case "urltest":
            return {
                type: "urltest",
                tag: name,
                url: "https://www.gstatic.com/generate_204",
                ...hcOption.leaf,
                interrupt_exist_connections: false,
                outbounds: nodes,
            };
        case "urltest2":
            return {
                type: "urltest",
                tag: name,
                url: "https://www.gstatic.com/generate_204",
                ...hcOption.parent,
                interrupt_exist_connections: false,
                outbounds: nodes,
            };
        case "selector":
            return {
                type: "selector",
                tag: name,
                interrupt_exist_connections: false,
                outbounds: nodes,
            };
    }

    return null;
}

function isEnabled(option) {
    if (!$arguments[option]) return false;
    const v = `${$arguments[option]}`.toLowerCase();
    return v === "true" || v === "on" || v === "yes" || v === "y" || v === "1";
}

function toNumber(value, fallbackValue = 0) {
    const valueType = typeof value;

    if (valueType === "number") {
        return Number.isNaN(value) ? fallbackValue : value;
    }
    if (valueType === "string") {
        const trimmedStr = value.trim();
        if (trimmedStr === "") {
            return fallbackValue;
        }
        const parsedNum = Number(trimmedStr);
        return Number.isNaN(parsedNum) ? fallbackValue : parsedNum;
    }
    if (valueType === "bigint") {
        return Number(value);
    }

    return fallbackValue;
}

function getHealthCheck(frequency = 3) {
    switch (frequency) {
        case 1: // 1 分钟
            return {
                leaf: { interval: "67s", tolerance: 30, idle_timeout: "5m" },
                parent: { interval: "103s", tolerance: 50, idle_timeout: "5m" },
            };
        case 2: // 2 分钟
            return {
                leaf: { interval: "127s", tolerance: 50, idle_timeout: "10m" },
                parent: { interval: "193s", tolerance: 70, idle_timeout: "10m" },
            };
        case 5: // 5 分钟
            return {
                leaf: { interval: "307s", tolerance: 50, idle_timeout: "25m" },
                parent: { interval: "439s", tolerance: 70, idle_timeout: "25m" },
            };
    }
    // 3 分钟
    return {
        leaf: { interval: "193s", tolerance: 50, idle_timeout: "15m" },
        parent: { interval: "277s", tolerance: 70, idle_timeout: "15m" },
    };
}

// ---------- 脚本主体功能开始 ----------

const dashboard = isEnabled("dashboard");
const frequency = $arguments.frequency ? toNumber($arguments.frequency) : 1;

// $substore.info("---------- 111");
// $substore.info(JSON.stringify($arguments, null, 2));
// $substore.info("---------- 222");

const config = (ProxyUtils.JSON5 || JSON).parse($content ?? $files[0]);
const hcOption = getHealthCheck(frequency);

if (!dashboard) config.experimental.clash_api.external_controller = "";

for (const idx of [1, 2]) {
    Object.assign(config.outbounds[idx], hcOption.leaf);
}

const singboxNodes = await produceArtifact({
    type: "collection", // type: 'subscription' 或 'collection'
    name: "汇总", // subscription name
    platform: "sing-box", // target platform
    produceType: "internal", // 'internal' produces an Array, otherwise produces a String( JSON.parse('JSON String') )
});

const { all, premium, lowCost, countries, countriesData, foreign } = groupNodes(singboxNodes);

config.outbounds[1].outbounds.push(...premium);

let manualOutbound;
// 优选与低倍率
if (lowCost.length <= 0) {
    config.outbounds.splice(2, 1);
    config.outbounds[0].outbounds.splice(1, 1);
    config.outbounds[3].outbounds.splice(2, 1);
    config.outbounds[4].outbounds.splice(2, 1);
    manualOutbound = config.outbounds[2];
} else {
    config.outbounds[2].outbounds.push(...lowCost);
    manualOutbound = config.outbounds[3];
}

manualOutbound.outbounds.push(...all);

// 境外节点
const FOREIGN = "🚢境外节点";
let foreignOutbound;
if (foreign.length > 1) {
    foreignOutbound = buildOutbound(FOREIGN, foreign, "urltest2");
} else if (foreign.length == 1) {
    foreignOutbound = buildOutbound(FOREIGN, foreign, "selector");
}
if (foreignOutbound) {
    config.outbounds[0].outbounds.push(FOREIGN);
    config.outbounds.splice(-3, 0, foreignOutbound);
}

// 地区节点
config.outbounds[0].outbounds.push(...countries);

for (const [name, leaves] of countriesData) {
    let outbound;
    if (leaves.length >= 2) {
        outbound = buildOutbound(name, leaves);
    } else {
        outbound = buildOutbound(name, leaves, "selector");
    }
    config.outbounds.splice(-3, 0, outbound);
}

config.outbounds.push(...singboxNodes);

// https://clashparty.org/docs/guide/urlscheme#profile-update-interval
if ($options) {
    $options._res = {
        headers: {
            "profile-update-interval": 12,
        },
    };
}

$content = JSON.stringify(config, null, 2);
