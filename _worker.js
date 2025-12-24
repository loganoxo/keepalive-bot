/**
 * 定义环境变量的结构
 * @typedef {Object} Env
 * @property {string} TG_BOT_TOKEN - Telegram 机器人的 Token
 * @property {string} TG_CHAT_ID - 接收消息的 Chat ID
 * @property {KVNamespace} KV - Cloudflare KV 存储空间
 */

/**
 * @typedef {Object} ExecutionContext
 * @property {function} waitUntil
 */

const HELP_TEXT = `
📌 使用说明：
直接发送一个 https:// 开头的链接 → 添加保活站点

命令：
/list   查看当前所有保活站点
/remove <url>  删除指定站点
/check  手动立即检测一次
/help   查看帮助
`;

// === 配置常量 ===
const MAX_RETRIES = 3;    // 最大重试次数
const RETRY_DELAY = 5000; // 重试间隔 (毫秒)
const TIMEOUT_MS = 10000; // 单次请求超时时间 (毫秒)

/**
 * 校验 URL 格式
 */
function isValidUrl(text) {
    return /^https?:\/\/\S+$/i.test(text);
}

/**
 * 发送 Telegram 消息
 * @param {Env} env
 * @param {string} text
 */
async function sendTG(env, text) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                chat_id: env.TG_CHAT_ID,
                disable_web_page_preview: true, // 禁用网页预览，让消息更清爽
                text
            })
        });
        if (!res.ok) {
            console.error(`TG 发送失败: ${res.status} ${await res.text()}`);
        }
    } catch (e) {
        console.error(`TG 网络错误: ${e.message}`);
    }
}

/**
 * 单个 URL 检测函数 (带超时控制,重试机制)
 * @param {string} url
 */
async function checkSingleUrl(url) {
    let lastError = '';
    let lastStatus = 0;

    // 循环重试逻辑
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            //构建防缓存 URL
            const timestamp = Date.now();
            const random = Math.floor(Math.random() * 1000);
            const separator = url.includes('?') ? '&' : '?';
            const noCacheUrl = `${url}${separator}_nocache=${timestamp}${random}`;

            const res = await fetch(noCacheUrl, {
                method: 'GET',
                headers: {
                    //设置防缓存请求头
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
                },
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (res.ok) {
                // ✅ 成功：直接返回结果，结束循环
                return {
                    url,
                    ok: true,
                    msg: `${res.status}`
                };
            } else {
                // ❌ 状态码非 200：记录状态，准备重试
                lastStatus = res.status;
                lastError = `Status ${res.status}`;
            }

        } catch (e) {
            clearTimeout(timeoutId);
            // ❌ 网络错误：记录错误，准备重试
            lastError = e.name === 'AbortError' ? '超时' : e.message;
        }

        // 如果不是最后一次尝试,则等待一段时间再(循环)重试
        if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
    }

    // ⛔️ 所有重试都失败了：返回最后的错误信息
    return {
        url,
        ok: false,
        msg: lastError || (lastStatus ? `${lastStatus}` : '未知错误')
    };
}

/**
 * 核心检测逻辑
 * @param {Env} env
 * @param {boolean} isManual 是否为手动触发
 */
async function runCheck(env, isManual = false) {
    // 1. 获取列表
    const list = await env.KV.list();
    if (list.keys.length === 0) {
        if (isManual) {
            await sendTG(env, '📭 当前没有任何保活站点');
        }
        return;
    }

    // 2. 并发检测所有站点
    const tasks = list.keys.map(k => checkSingleUrl(k.name));
    const results = await Promise.all(tasks);

    // 3. 分类结果
    const okList = results.filter(r => r.ok);
    const failedList = results.filter(r => !r.ok);

    // 4. 构建当前时间（北京时间）
    const timeStr = new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});

    // 5. 汇报所有结果
    let msg = ""
    if (isManual) {
        msg = failedList.length === 0
            ? '🟢 手动检测完成（全部正常）\n\n'
            : '🔴 手动检测完成（发现问题）\n\n';
    } else {
        msg = failedList.length === 0
            ? '🟢 定时检测完成（全部正常）\n\n'
            : '🔴 定时检测完成（发现问题）\n\n';
    }
    okList.forEach(v => msg += `✅ ${v.url} → ${v.msg}\n`);
    failedList.forEach(v => msg += `❌ ${v.url} → ${v.msg}\n`);

    msg += `\n⏱ 检测时间：${timeStr}`;
    await sendTG(env, msg);
}

export default {
    /**
     * @param {Request} req
     * @param {Env} env
     * @param {ExecutionContext} ctx
     */
    async fetch(req, env, ctx) {
        if (req.method !== 'POST') return new Response('OK');

        try {
            const params = await req.json();
            if (!params.message || !params.message.text) return new Response('OK');

            const chatId = params.message.chat.id.toString();
            if (chatId !== env.TG_CHAT_ID) return new Response('OK');

            const text = params.message.text.trim();

            // === 命令处理 ===

            if (text === '/help') {
                ctx.waitUntil(sendTG(env, HELP_TEXT));
                return new Response('OK');
            }

            if (text === '/list') {
                ctx.waitUntil((async () => {
                    const list = await env.KV.list();
                    if (list.keys.length === 0) {
                        await sendTG(env, '📭 当前没有任何保活站点');
                    } else {
                        let msg = '📌 当前保活站点：\n\n';
                        list.keys.forEach((k, i) => msg += `${i + 1}. ${k.name}\n`);
                        await sendTG(env, msg);
                    }
                })());
                return new Response('OK');
            }

            if (text.startsWith('/remove')) {
                const url = text.replace('/remove', '').trim();
                ctx.waitUntil((async () => {
                    if (!isValidUrl(url)) {
                        await sendTG(env, '❌ URL 格式不正确');
                    } else {
                        await env.KV.delete(url);
                        await sendTG(env, `🗑 已删除：\n${url}`);
                    }
                })());
                return new Response('OK');
            }

            if (text === '/check') {
                // 将多步操作封装在一个异步函数中，放入 waitUntil
                ctx.waitUntil((async () => {
                    // 1. 先回复提示信息
                    await sendTG(env, '🚀 正在立即检测所有站点，请稍候...');
                    // 2. 再执行检测（检测函数内部会发送最终结果）
                    await runCheck(env, true);
                })());

                // 立即返回，防止 TG 界面转圈或超时
                return new Response('OK');
            }

            if (isValidUrl(text)) {
                ctx.waitUntil((async () => {
                    await env.KV.put(text, '1');
                    await sendTG(env, `✅ 已添加保活站点：\n${text}`);
                })());
                return new Response('OK');
            }

            ctx.waitUntil(sendTG(env, HELP_TEXT));
            return new Response('OK');

        } catch (e) {
            console.error(e);
            return new Response('OK');
        }
    },

    /**
     * @param {ScheduledEvent} event
     * @param {Env} env
     * @param {ExecutionContext} ctx
     */
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runCheck(env, false));
    }
};
