const http = require('http');
const https = require('https');

const PORT = 3399;
const TARGET_HOST = 'openrouter.ai';

const DYNAMIC_MODELS = {
    "data": [
        { type: "model", id: "anthropic/claude-3.7-sonnet", display_name: "Claude 3.7 Sonnet (Code & Reasoning)" },
        { type: "model", id: "openai/gpt-4.5-preview", display_name: "GPT 5.5/4.5 (Mới nhất)" },
        { type: "model", id: "google/gemini-2.5-pro", display_name: "Gemini 2.5 Pro (Trùm Context 2M)" },
        { type: "model", id: "google/gemini-2.5-flash", display_name: "Gemini 2.5 Flash (Siêu nhanh, rẻ)" },
        { type: "model", id: "deepseek/deepseek-r1", display_name: "DeepSeek R1 (Tối ưu Reasoning)" },
        { type: "model", id: "deepseek/deepseek-chat", display_name: "DeepSeek V3 (Code - Rẻ vô địch)" },
        { type: "model", id: "qwen/qwen-2.5-coder-32b-instruct", display_name: "Qwen 2.5 Coder 32B (Siêu rẻ)" }
    ]
};

http.createServer((req, res) => {
    // 1. Phục kích API load model của IDE để nhét list tùy chọn
    if (req.method === 'GET' && req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(DYNAMIC_MODELS));
    }

    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
        let reqBody = Buffer.concat(body).toString();

        // 2. Chặn lỗi context 32k & Tự động nén context
        try {
            if (req.method === 'POST' && reqBody) {
                let json = JSON.parse(reqBody);

                const isAnthropic = json.model && typeof json.model === 'string' && json.model.includes('anthropic');

                // Hàm đệ quy an toàn xóa các trường dư thừa gây lỗi
                const sanitizePayload = (obj) => {
                    if (!obj) return;
                    if (Array.isArray(obj)) {
                        for (let i = 0; i < obj.length; i++) sanitizePayload(obj[i]);
                    } else if (typeof obj === 'object') {
                        // Nếu là model không phải Anthropic, xóa sạch cache_control
                        if (!isAnthropic && 'cache_control' in obj) {
                            delete obj.cache_control;
                        }
                        if (!isAnthropic && 'cacheControl' in obj) {
                            delete obj.cacheControl;
                        }

                        // Nếu là Anthropic, OpenRouter / Google Vertex có thể vẫn lỗi với trường ttl.
                        // Ta xóa trường ttl nhưng giữ lại { type: "ephemeral" }
                        if (isAnthropic && obj.cache_control && obj.cache_control.ephemeral && obj.cache_control.ephemeral.ttl !== undefined) {
                            delete obj.cache_control.ephemeral.ttl;
                        }

                        let keys = Object.keys(obj);
                        for (let i = 0; i < keys.length; i++) {
                            sanitizePayload(obj[keys[i]]);
                        }
                    }
                };

                sanitizePayload(json);

                // Đối với Anthropic, Google Vertex backend thường hay lỗi, ta ép OpenRouter bỏ qua Google config
                if (isAnthropic) {
                    json.provider = json.provider || {};
                    json.provider.ignore = json.provider.ignore || [];
                    if (!json.provider.ignore.includes("Google")) {
                        json.provider.ignore.push("Google");
                    }
                }

                const isDeepseek = json.model && typeof json.model === 'string' && json.model.includes('deepseek');

                // Khống chế max_tokens
                let allowedMaxTokens = isDeepseek ? 4096 : 8192;
                if (json.max_tokens && json.max_tokens > allowedMaxTokens) {
                    json.max_tokens = allowedMaxTokens;
                }

                json.plugins = json.plugins || [];
                if (!json.plugins.some(p => p.id === 'context-compression')) {
                    json.plugins.push({ id: 'context-compression' });
                }

                if (json.messages && Array.isArray(json.messages)) {
                    let maxChars = isDeepseek ? 70000 : 150000;

                    // Giới hạn maxChars an toàn
                    try {
                        while (JSON.stringify(json.messages).length > maxChars && json.messages.length > 3) {
                            let sysIdx = json.messages.findIndex(m => m.role === 'system');
                            let removeIdx = sysIdx === 0 ? 1 : 0;
                            json.messages.splice(removeIdx, 1);
                        }

                        if (JSON.stringify(json.messages).length > maxChars) {
                            json.messages.forEach(m => {
                                let limit = isDeepseek ? 15000 : 40000;
                                if (m && typeof m.content === 'string' && m.content.length > limit) {
                                    m.content = m.content.substring(0, limit) + '...[TRUNCATED]';
                                } else if (m && Array.isArray(m.content)) {
                                    m.content.forEach(c => {
                                        if (c && c.type === 'text' && c.text && typeof c.text === 'string' && c.text.length > limit) {
                                            c.text = c.text.substring(0, limit) + '...[TRUNCATED]';
                                        }
                                    });
                                }
                            });
                        }
                    } catch (truncErr) {
                        console.error('Truncation error:', truncErr);
                    }
                }

                reqBody = JSON.stringify(json);
            }
        } catch (e) { 
            console.error('Proxy payload manipulation error:', e);
        }

        const targetPath = req.url.startsWith('/api') ? req.url : `/api${req.url}`;
        const options = {
            hostname: TARGET_HOST,
            path: targetPath,
            method: req.method,
            headers: {
                ...req.headers,
                host: TARGET_HOST,
                'content-length': Buffer.byteLength(reqBody)
            }
        };

        const proxyReq = https.request(options, proxyRes => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', err => {
            res.writeHead(502).end();
        });

        proxyReq.write(reqBody);
        proxyReq.end();
    });
}).listen(PORT, () => console.log(`Proxy Interceptor active on http://127.0.0.1:${PORT}`));
