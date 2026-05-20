import os
import asyncio
from playwright.async_api import async_playwright

async def generate_screenshot():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.set_viewport_size({"width": 1280, "height": 1000})
        await page.goto("https://marketplace.visualstudio.com/items?itemName=ANLE.grav")
        await page.wait_for_timeout(4000)
        
        desktop_path = os.path.expanduser('~/Desktop/grav_marketplace.png')
        await page.screenshot(path=desktop_path, full_page=False)
        await browser.close()
        print(f"Screenshot saved to {desktop_path}")

asyncio.run(generate_screenshot())
