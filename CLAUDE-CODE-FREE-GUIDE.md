# 🆓 Hướng dẫn cài đặt Claude Code Free

Sử dụng Claude Code miễn phí thông qua NVIDIA NIM proxy (40 requests/phút).

## 📋 Yêu cầu

- macOS / Linux / Windows
- Node.js 18+
- Python 3.10+

---

## 🔑 Bước 1: Lấy NVIDIA API Key (Miễn phí)

1. Truy cập: https://build.nvidia.com/settings/api-keys
2. Đăng ký tài khoản (miễn phí)
3. Click "Generate API Key"
4. Copy key (bắt đầu bằng `nvapi-...`)

---

## 📦 Bước 2: Cài đặt Free Claude Code Proxy

```bash
# Clone repo
git clone https://github.com/Alishahryar1/free-claude-code.git ~/free-claude-code

# Cài uv (Python package manager)
pip install uv

# Cài dependencies
cd ~/free-claude-code
uv sync
```

---

## ⚙️ Bước 3: Cấu hình

Tạo file `~/free-claude-code/.env`:

```bash
cat > ~/free-claude-code/.env << 'EOF'
# Thay YOUR_API_KEY bằng key từ Bước 1
NVIDIA_NIM_API_KEY="nvapi-YOUR_API_KEY_HERE"

# Model mapping
MODEL_OPUS="nvidia_nim/deepseek-ai/deepseek-r1"
MODEL_SONNET="nvidia_nim/moonshotai/kimi-k2-thinking"
MODEL_HAIKU="nvidia_nim/stepfun-ai/step-3.5-flash"
MODEL="nvidia_nim/z-ai/glm4.7"

# Settings
ENABLE_THINKING=true
PROVIDER_RATE_LIMIT=40
PROVIDER_RATE_WINDOW=60
EOF
```

### Models có sẵn (miễn phí):

| Model | Mô tả |
|-------|-------|
| `nvidia_nim/deepseek-ai/deepseek-r1` | Mạnh nhất, reasoning tốt |
| `nvidia_nim/moonshotai/kimi-k2-thinking` | Coding tốt, có thinking |
| `nvidia_nim/z-ai/glm4.7` | Nhanh, đa năng |
| `nvidia_nim/stepfun-ai/step-3.5-flash` | Rất nhanh |
| `nvidia_nim/minimaxai/minimax-m2.5` | Complex tasks |

---

## 🚀 Bước 4: Chạy Proxy

```bash
cd ~/free-claude-code
uv run uvicorn server:app --host 0.0.0.0 --port 8082
```

Proxy sẽ chạy tại `http://localhost:8082`

### Chạy nền (background):

```bash
cd ~/free-claude-code && uv run uvicorn server:app --host 0.0.0.0 --port 8082 &
```

---

## 💻 Bước 5: Sử dụng

### A. Claude Code CLI (Terminal)

```bash
# Cài Claude Code CLI (nếu chưa có)
npm install -g @anthropic-ai/claude-code

# Chạy với proxy
ANTHROPIC_BASE_URL="http://localhost:8082" ANTHROPIC_AUTH_TOKEN="freecc" claude
```

#### Thêm alias tiện lợi:

```bash
echo 'alias claude-free="ANTHROPIC_BASE_URL=http://localhost:8082 ANTHROPIC_AUTH_TOKEN=freecc claude"' >> ~/.zshrc
source ~/.zshrc

# Sau đó chỉ cần:
claude-free
```

---

### B. VSCode / Antigravity IDE

1. Cài extension "Claude Code" từ marketplace

2. Mở Settings (`Cmd+,` hoặc `Ctrl+,`)

3. Tìm `claudeCode.environmentVariables`

4. Thêm vào `settings.json`:

```json
"claudeCode.environmentVariables": [
    {"name": "ANTHROPIC_BASE_URL", "value": "http://localhost:8082"},
    {"name": "ANTHROPIC_AUTH_TOKEN", "value": "freecc"}
]
```

5. Reload Window (`Cmd+Shift+P` → "Reload Window")

6. Mở Claude Code panel, nếu thấy login → click "Anthropic Console" → authorize (bỏ qua trang mua credits)

---

## 🖥️ Script khởi động nhanh (macOS)

Tạo file `~/Desktop/start-claude-free.command`:

```bash
#!/bin/bash
echo "🚀 Starting Free Claude Code..."

if curl -s http://localhost:8082/v1/models > /dev/null 2>&1; then
    echo "✅ Proxy already running"
else
    echo "⏳ Starting proxy..."
    cd ~/free-claude-code
    uv run uvicorn server:app --host 0.0.0.0 --port 8082 &
    sleep 3
fi

ANTHROPIC_BASE_URL="http://localhost:8082" ANTHROPIC_AUTH_TOKEN="freecc" claude
```

```bash
chmod +x ~/Desktop/start-claude-free.command
```

Double-click để chạy!

---

## ⚠️ Lưu ý quan trọng

1. **Proxy phải chạy trước** khi dùng Claude Code
2. **Rate limit**: 40 requests/phút (miễn phí)
3. **Model không phải Claude thật** - là Kimi K2, DeepSeek R1, GLM, etc.
4. **Chất lượng có thể khác** so với Claude gốc
5. **Không hoạt động với**: Claude Desktop app, Kiro IDE

---

## 🔧 Troubleshooting

### Lỗi "ECONNREFUSED"
→ Proxy chưa chạy. Start lại:
```bash
cd ~/free-claude-code && uv run uvicorn server:app --host 0.0.0.0 --port 8082
```

### Lỗi "Error editing file"
→ Model không hỗ trợ tool use tốt. Đổi sang DeepSeek R1:
```
MODEL_SONNET="nvidia_nim/deepseek-ai/deepseek-r1"
```

### Kiểm tra proxy hoạt động:
```bash
curl http://localhost:8082/v1/models
```

---

## 📚 Tham khảo

- Repo: https://github.com/Alishahryar1/free-claude-code
- NVIDIA NIM: https://build.nvidia.com
- Claude Code: https://github.com/anthropics/claude-code
