const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH }); });
after(async () => { await browser?.close(); });
async function open(t, options = { solidProviders: { allowAnyProvider: true } }) {
  const page = await browser.newPage(); t.after(() => page.close());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setContent('<div id="widget"></div>');
  await page.addScriptTag({ path: require.resolve('../build/widget.js') });
  await page.evaluate(options => {
    const events = {}; window.calls = []; window.pods = [];
    window.rs = {
      apiKeys: { dropbox: 'test', googledrive: 'test' }, backend: 'remotestorage',
      remote: { userAddress: '<img src=x onerror=alert(1)>' }, connected: false,
      on(n, f) { (events[n] ||= []).push(f); },
      removeEventListener(n,f) { events[n] = events[n].filter(x => x !== f); },
      emit(n, data) { for (const f of events[n] || []) f(data); },
      hasFeature() { return true; }, connect(a) { calls.push(['rs', a]); },
      disconnect() { calls.push(['disconnect']); this.emit('disconnected'); },
      reconnect() { calls.push(['reconnect']); }, startSync() {}, stopSync() {},
      dropbox: { connect() { calls.push(['dropbox']); } },
      googledrive: { connect() { calls.push(['googledrive']); } },
      solid: {
        setAuthURL(u) { if (!u.startsWith('https://')) throw Error('Use HTTPS'); calls.push(['issuer',u]); },
        async connect() { if (window.failLogin) rs.emit('error', Error('Login failed')); else calls.push(['solid']); },
        getPodURLs() { return window.pods; },
        setPodURL(u) { calls.push(['pod', u]); rs.backend='solid'; rs.connected=true; rs.emit('connected'); }
      }
    };
    window.widget = new Widget(rs, { ...options, skipInitial:true, leaveOpen:true }); widget.attach('widget');
  }, options);
  return page;
}
test('four backends, login validation, async failure and retry', async t => {
 const p=await open(t);
 for (const backend of ['dropbox','googledrive']) await p.locator('.rs-choose-'+backend).click();
 await p.locator('.rs-choose-rs').click(); await p.locator('[name=rs-user-address]').fill('alice@example.test'); await p.locator('.rs-connect').click();
 await p.evaluate(()=>widget.showChooseOrSignIn()); await p.locator('.rs-choose-solid').click();
 await p.locator('[name=rs-provider-address]').fill('http://example.test'); await p.locator('.rs-solid-connect').click();
 assert.match(await p.locator('.rs-box-solid').innerText(), /Use HTTPS/);
 await p.evaluate(()=>window.failLogin=true); await p.locator('[name=rs-provider-address]').fill('https://example.test'); await p.locator('.rs-solid-connect').click();
 assert.match(await p.locator('.rs-box-solid').innerText(), /Login failed/);
 assert.equal(await p.locator('.rs-solid-connect').isEnabled(),true);
 await p.evaluate(()=>window.failLogin=false); await p.locator('.rs-solid-connect').click();
 assert.deepEqual((await p.evaluate(()=>calls)).filter(x=>['dropbox','googledrive','rs','solid'].includes(x[0])),[['dropbox'],['googledrive'],['rs','alice@example.test'],['solid']]);
});
test('multiple pods render and repeated discovery replaces choices', async t => {
 const p=await open(t);
 await p.evaluate(()=>{pods=['https://one.test/','https://two.test/','https://three.test/'];rs.emit('pod-not-selected');});
 assert.equal(await p.locator('.rs-choose-pod').count(),3);
 await p.evaluate(()=>{pods=['https://new.test/','https://two.test/'];rs.emit('pod-not-selected');});
 assert.equal(await p.locator('.rs-choose-pod').count(),2);
 await p.getByRole('button',{name:'https://new.test/',exact:true}).click();
 assert.equal(await p.locator('.rs-user img').count(),0);
 assert.equal(await p.locator('.rs-user').textContent(),'<img src=x onerror=alert(1)>');
 await p.locator('.rs-box-connected .rs-disconnect').click();
 assert.equal(await p.locator('.rs-choose-solid').isVisible(),true);
});
test('single pod auto-select, no pods recovery, reconnect and destroy', async t => {
 const p=await open(t);
 await p.evaluate(()=>{pods=['https://one.test/'];rs.emit('pod-not-selected');});
 assert.deepEqual(await p.evaluate(()=>calls[0]),['pod','https://one.test/']);
 await p.evaluate(()=>rs.emit('error',{name:'Unauthorized',message:'Please reconnect'}));
 await p.locator('.rs-reconnect').click();
 await p.evaluate(()=>{rs.connected=false;pods=[];rs.emit('pod-not-selected');});
 assert.match(await p.locator('.rs-box-error').innerText(),/no pods/);
 await p.locator('.rs-box-error .rs-disconnect').click();
 await p.evaluate(()=>{widget.destroy();rs.emit('connected');});
 assert.equal(await p.locator('.rs-widget').count(),0);
});
test('three named providers and optional Solid configuration', async t => {
 const p=await open(t,{solidProviders:{providers:[1,2,3].map(n=>({name:'Provider '+n,authURL:'https://provider'+n+'.test'}))}});
 await p.locator('.rs-choose-solid').click();
 assert.equal(await p.locator('.rs-option-solid').count(),3);
 await p.getByRole('button',{name:'Provider 3'}).click();
 assert.deepEqual(await p.evaluate(()=>calls),[['issuer','https://provider3.test'],['solid']]);
 const q=await open(t,{});assert.equal(await q.locator('.rs-choose-solid').isVisible(),false);
});

test('remount after route replacement and destroy does not duplicate handlers', async t => {
 const p = await open(t);
 await p.evaluate(() => { document.querySelector('#widget').replaceChildren(); widget.attach('widget'); });
 await p.locator('.rs-choose-dropbox').click();
 await p.evaluate(() => { widget.destroy(); widget.attach('widget'); });
 await p.locator('.rs-choose-googledrive').click();
 assert.deepEqual(await p.evaluate(() => calls), [['dropbox'], ['googledrive']]);
 assert.equal(await p.locator('.rs-widget').count(), 1);
});
test('late attachment recovers discovered pods without waiting for another event', async t => {
 const p = await open(t);
 await p.evaluate(() => {
   widget.destroy(); rs.backend='solid'; pods=['https://one.test/', 'https://two.test/'];
   widget.attach('widget');
 });
 assert.equal(await p.locator('.rs-choose-pod:visible').count(), 2);
 await p.getByRole('button', {name:'https://two.test/',exact:true}).click();
 await p.evaluate(() => rs.emit('features-loaded'));
 assert.deepEqual(await p.evaluate(() => calls), [['pod','https://two.test/']]);
});
test('preset-only provider failure leaves arbitrary issuer input hidden', async t => {
 const p = await open(t, {solidProviders:{providers:[{name:'Example',authURL:'https://example.test'}]}});
 await p.evaluate(() => window.failLogin=true);
 await p.locator('.rs-choose-solid').click();
 await p.getByRole('button', {name:'Example',exact:true}).click();
 assert.equal(await p.locator('.rs-box-solid [role=alert]').innerText(), 'Login failed');
 assert.equal(await p.locator('[name=rs-provider-address]').isVisible(), false);
 await p.evaluate(() => window.failLogin=false);
 await p.getByRole('button', {name:'Example',exact:true}).click();
 assert.equal(await p.locator('.rs-box-solid [role=alert]').isVisible(), false);
});
