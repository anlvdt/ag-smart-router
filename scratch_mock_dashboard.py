import os
import json
import asyncio
from playwright.async_api import async_playwright

async def generate_screenshot():
    with open('media/dashboard-v2.html', 'r', encoding='utf-8') as f:
        html = f.read()
    
    # Mock data
    patterns = ["Accept All", "Run", "Approve", "Execute", "Skip"]
    disabled = []
    stats = {"Accept All": 1420, "Run": 315, "Approve": 45, "Skip": 120}
    all_patterns = ["Accept", "Accept All", "Run", "Approve", "Execute", "Skip", "Retry", "Proceed", "Allow"]
    pattern_groups = {"Accept All": ["Accept All", "Accept"]}
    concepts = {
        "git status": {"avgConfidence": 0.95, "riskLevel": "safe", "commands": ["git status", "git diff"]},
        "npm install": {"avgConfidence": 0.88, "riskLevel": "safe", "commands": ["npm i", "npm install"]},
        "rm -rf": {"avgConfidence": 0.05, "riskLevel": "danger", "commands": ["rm -rf node_modules", "rm -rf build"]},
        "killall node": {"avgConfidence": 0.6, "riskLevel": "caution", "commands": ["killall node"]},
    }
    wiki_log = [
        {"time": "10:14:02", "op": "APPROVE", "cmd": "Accept All", "conf": 0.99},
        {"time": "10:14:15", "op": "APPROVE", "cmd": "git commit -m 'fix'", "conf": 0.85},
        {"time": "10:15:00", "op": "BLOCK", "cmd": "rm -rf src", "conf": 0.02},
    ]
    
    html = html.replace('{{LANG}}', 'en')
    html = html.replace('{{ENABLED_CHK}}', 'checked')
    html = html.replace('{{SCROLL_CHK}}', 'checked')
    html = html.replace('{{SKIP_BROWSER_CHK}}', 'checked')
    html = html.replace('{{APPROVE_MS}}', '1000')
    html = html.replace('{{SCROLL_MS}}', '1500')
    html = html.replace('{{PAUSE_MS}}', '15000')
    
    html = html.replace('{{PATTERNS_JSON}}', json.dumps(patterns))
    html = html.replace('{{DISABLED_JSON}}', json.dumps(disabled))
    html = html.replace('{{STATS_JSON}}', json.dumps(stats))
    html = html.replace('{{ALL_PATTERNS_JSON}}', json.dumps(all_patterns))
    html = html.replace('{{PATTERN_GROUPS_JSON}}', json.dumps(pattern_groups))
    html = html.replace('{{CONCEPTS_JSON}}', json.dumps(concepts))
    html = html.replace('{{WIKI_LOG_JSON}}', json.dumps(wiki_log))
    html = html.replace('{{TOTAL}}', '1900')
    html = html.replace('{{TERMINAL_WHITELIST_JSON}}', json.dumps(['git status', 'npm install', 'python', 'npm run build']))
    html = html.replace('{{TERMINAL_BLACKLIST_JSON}}', json.dumps(['rm -rf /', 'git push --force', 'DROP DATABASE']))
    
    # Inject some session mock data directly into the DOM
    mock_post_message = f"""
    <script>
    setTimeout(() => {{
        window.postMessage({{
            command: 'sessionUpdated',
            session: {{
                sessionMs: 45 * 60 * 1000 + 15 * 1000,
                msgCount: 32,
                approveCount: 18,
                avgResponseMs: 1100,
                idle: false,
                learningHealth: 'good',
                cdpConnected: true,
                cdpSessions: 2,
                toolBreakdown: {{
                    'run_command': {{count: 14, totalMs: 14000}},
                    'edit_file': {{count: 4, totalMs: 6000}}
                }}
            }}
        }}, '*');
        window.postMessage({{
            command: 'roiUpdated',
            roi: {{
                timeSavedSec: 18 * 2,
                clicks: 18,
                productivityGain: 24,
                lifetimeSavedSec: 12450,
                lifetimeClicks: 1900,
                lifetimeSessions: 42
            }}
        }}, '*');
    }}, 100);
    </script>
    """
    html = html.replace('</body>', mock_post_message + '</body>')
    
    with open('media/dashboard-mock.html', 'w', encoding='utf-8') as f:
        f.write(html)
        
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        # Set viewport to standard width
        await page.set_viewport_size({"width": 800, "height": 1300})
        # Load local HTML
        await page.goto(f'file://{os.path.abspath("media/dashboard-mock.html")}')
        # Wait a bit for setTimeout to fire and render
        await page.wait_for_timeout(500)
        
        # Save to artifacts
        artifact_path = '/Users/anle/.gemini/antigravity/brain/28f8f26c-b461-4763-83bc-10d511b04d56/artifacts/grav_dashboard.png'
        os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
        await page.screenshot(path=artifact_path, full_page=True)
        await browser.close()
        print(f"Screenshot saved to {artifact_path}")

asyncio.run(generate_screenshot())
