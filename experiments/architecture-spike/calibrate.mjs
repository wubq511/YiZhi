import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({
  executablePath: process.env.PROBE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto('http://127.0.0.1:8772/?mode=calibrate');
  await page.waitForFunction(()=>window.probe?.ready,{},{timeout:60000});
  const measured = await page.evaluate(()=>window.probe.measured);
  await writeFile('heights.json',JSON.stringify(measured,null,2));
  console.log(`Measured ${Object.keys(measured).length} original units.`);
} finally { await browser.close(); }
