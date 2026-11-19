const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const source = readFileSync(resolve(__dirname, '../src/widget.js'), 'utf8')
  .replace(/^import .*;$/gm, '').replace('export default Widget;', 'window.Widget = Widget;');
const template = readFileSync(resolve(__dirname, '../src/assets/widget.html'), 'utf8');
const css = readFileSync(resolve(__dirname, '../src/assets/styles.css'), 'utf8');
async function setup(page, { fails = false, available = true } = {}) {
  await page.setContent('<main id="target"></main>');
  await page.addScriptTag({ content: 'const widgetHtml=' + JSON.stringify(template) + ';const widgetCss=' + JSON.stringify(css) + ';const circleOpenSvg="";\n' + source });
  await page.evaluate(({ fails, available }) => {
    const handlers = {};
    window.rs = { apiKeys: { dropbox: 'test', googledrive: 'test' }, remote: { online: true }, backend: 'remotestorage',
      on(name, fn) { (handlers[name] ||= []).push(fn); },
      hasFeature() { return true; }, disconnect() {}, startSync() {}, stopSync() {},
      dropbox: { connect() {} }, googledrive: { connect() {} }, solid: { connect() {} }
    };
    if (available) window.rs.lws = { setStorageURL(value) { window.enteredStorageURL = value; }, async connect() {
      if (fails) throw new Error('The server did not expose its LWS storage Link header.');
      window.rs.remote.userAddress = 'https://pods.example/alice'; window.rs.backend = 'lws';
      for (const fn of handlers.connected || []) fn();
    } };
    window.widget = new window.Widget(window.rs, { skipInitial: true, leaveOpen: true, modalBackdrop: false });
    window.widget.attach('target');
  }, { fails, available });
}
test('existing chooser opens LWS storage URL form and reaches connected state', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.rs-box-choose')).toHaveClass(/rs-selected/);
  await page.locator('.rs-choose-lws').click();
  await expect(page.getByLabel('Storage address')).toBeVisible();
  await page.getByLabel('Storage address').fill('https://pods.example/alice/notes/');
  await page.locator('.rs-lws-form button[type=submit]').click();
  await expect(page.locator('.rs-widget')).toHaveClass(/rs-state-connected/);
  expect(await page.evaluate(() => window.enteredStorageURL)).toBe('https://pods.example/alice/notes/');
});
test('discovery failures remain in the LWS form and allow retry and back navigation', async ({ page }) => {
  await setup(page, { fails: true });
  await page.locator('.rs-choose-lws').click();
  await page.getByLabel('Storage address').fill('https://pods.example/alice/');
  await page.locator('.rs-lws-form button[type=submit]').click();
  await expect(page.locator('.rs-lws-error')).toContainText('Link header');
  await expect(page.locator('.rs-lws-form button[type=submit]')).toBeEnabled();
  await page.getByRole('button', { name: 'Other storage' }).click();
  await expect(page.locator('.rs-widget')).toHaveClass(/rs-state-choose/);
});
test('LWS is hidden with older rs.js versions', async ({ page }) => {
  await setup(page, { available: false });
  await expect(page.locator('.rs-choose-lws')).toHaveCount(0);
  await expect(page.locator('.rs-choose-rs')).toBeVisible();
});
test('storage URL form fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await setup(page);
  await page.locator('.rs-choose-lws').click();
  await expect(page.getByLabel('Storage address')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
