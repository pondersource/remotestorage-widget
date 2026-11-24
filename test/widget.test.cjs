const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH }); });
after(async () => { await browser?.close(); });
async function connectNextGraph(page) {
  if (await page.locator('.rs-box-nextgraph').getAttribute('aria-hidden') === 'true') await page.locator('.rs-choose-nextgraph').click();
  await page.locator('.rs-nextgraph-connect').click();
}
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

test('LWS connection, retry and navigation use the shared widget',async t=>{
 const p=await open(t);
 await p.evaluate(()=>{
   rs.lws={setStorageURL(url){calls.push(['lws-address',url]);},async connect(){if(window.failLWS)throw Error('LWS failed');calls.push(['lws-connect']);}};
   widget.attach('widget'); // already mounted; remount explicitly below
   widget.destroy();widget.attach('widget');
 });
 await p.locator('.rs-choose-lws').click();
 await p.locator('[name=rs-lws-address]').fill('https://storage.example.test/');
 await p.evaluate(()=>window.failLWS=true);await p.locator('.rs-lws-connect').click();
 assert.match(await p.locator('.rs-box-lws').innerText(),/LWS failed/);
 assert.equal(await p.locator('.rs-lws-connect').isEnabled(),true);
 await p.evaluate(()=>window.failLWS=false);await p.locator('.rs-lws-connect').click();
 assert.ok((await p.evaluate(()=>calls)).some(call=>call[0]==='lws-connect'));
 await p.locator('.rs-lws-back').click();assert.equal(await p.locator('.rs-choose-lws').isVisible(),true);
});

test('OneDrive popup errors remain recoverable in the provider chooser',async t=>{
 const p=await open(t);
 await p.evaluate(()=>{
   rs.apiKeys.onedrive={clientId:'test'};
   rs.onedrive={async connect(){if(window.failOneDrive)throw Error('Popup cancelled');calls.push(['onedrive']);}};
   widget.destroy();widget.attach('widget');window.failOneDrive=true;
 });
 await p.locator('.rs-choose-onedrive').click();assert.match(await p.locator('.rs-storage-error').innerText(),/Popup cancelled/);
 assert.equal(await p.locator('.rs-choose-onedrive').isEnabled(),true);
 await p.evaluate(()=>window.failOneDrive=false);await p.locator('.rs-choose-onedrive').click();
 assert.ok((await p.evaluate(()=>calls)).some(call=>call[0]==='onedrive'));
 await p.setViewportSize({width:320,height:568});
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
});

test('Atomic uses discovery and consent; Nextgraph uses its native connection and explicit import',async t=>{
 const p=await open(t);
 await p.evaluate(()=>{
   rs.constructor={AtomicPlugin:true};
   rs.nextgraph={deliveryState:'local',async connect(){if(window.failNG)throw Error('Wallet cancelled');calls.push(['nextgraph']);rs.backend='nextgraph';rs.connected=true;rs.emit('connected');},
     async importSnapshot(data){calls.push(['import',data.version]);return data.records.map(r=>({path:r.path,statusCode:201}));}};
   widget.destroy();widget.attach('widget');
 });
 await p.locator('.rs-choose-atomic').click();
 assert.match(await p.locator('.rs-atomic-help').innerText(),/installation/);
 await p.locator('[name=rs-user-address]').fill('alice@installation.example.test');await p.locator('.rs-connect').click();
 assert.deepEqual((await p.evaluate(()=>calls))[0],['rs','alice@installation.example.test']);
 await p.evaluate(()=>{widget.showChooseOrSignIn();window.failNG=true;});
 await connectNextGraph(p);assert.match(await p.locator('.rs-nextgraph-error').innerText(),/Wallet cancelled/);
 assert.equal(await p.locator('.rs-choose-nextgraph').isEnabled(),true);
 await p.evaluate(()=>window.failNG=false);await connectNextGraph(p);
 assert.equal(await p.locator('.rs-nextgraph-import').isVisible(),true);
 await p.evaluate(()=>rs.emit('sync-done',{completed:true}));
 assert.equal(await p.locator('.rs-box-connected .rs-sub-headline').textContent(),'Saved on this device');
 await p.locator('.rs-nextgraph-import input').setInputFiles({name:'guest.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,records:[{path:'/notes/a'}]}))});
 await p.waitForFunction(()=>document.querySelector('.rs-nextgraph-import [role=status]').textContent.startsWith('Imported'));
 assert.match(await p.locator('.rs-nextgraph-import [role=status]').innerText(),/Imported 1 of 1/);
 await p.evaluate(()=>{rs.nextgraph.deliveryState='needs-attention';rs.emit('sync-done',{completed:true});});
 assert.equal(await p.locator('.rs-box-connected .rs-sub-headline').textContent(),'Needs attention');
 await p.evaluate(()=>{rs.nextgraph.requiresReload=true;rs.emit('error',Error('Local save failed'));});
 assert.match(await p.locator('.rs-nextgraph-import [role=status]').innerText(),/Reload this app/);
 assert.equal(await p.locator('.rs-nextgraph-import input').isEnabled(),false);
 await p.setViewportSize({width:320,height:568});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
});


test('OneDrive native reconnect failures keep the retry link and show the error',async t=>{
 const p=await open(t);
 await p.evaluate(()=>{rs.backend='onedrive';rs.emit('error',{name:'Unauthorized',message:'Reconnect OneDrive'});});
 assert.equal(await p.locator('.rs-box-error .rs-reconnect').isVisible(),true);
 await p.evaluate(()=>rs.emit('error',Error('Popup cancelled')));
 assert.match(await p.locator('.rs-box-error').innerText(),/Popup cancelled/);
 assert.equal(await p.locator('.rs-box-error .rs-reconnect').isVisible(),true);
});

test('app guest handoff exports complete app bytes and imports the original file', async t => {
 const p = await open(t);
 await p.evaluate(() => {
   widget.destroy();
   rs.nextgraph = {
     async connect() { rs.backend='nextgraph'; rs.connected=true; rs.emit('connected'); },
     async exportSnapshot() { throw Error('The app must not export the RS cache'); },
     async importSnapshot() { throw Error('The app must not import the RS cache'); }
   };
   rs.startSync = () => { throw Error('The app owns its import sync'); };
   widget = new Widget(rs, {skipInitial:true,leaveOpen:true,guestData:{
     accept:'.zip,application/zip',
     async export() { return {filename:'all-projects.zip',type:'application/zip',body:new Uint8Array([80,75,0,255])}; },
     async import(file) {
       calls.push(['app-import',file instanceof File,file.name,file.type,file.size,Array.from(new Uint8Array(await file.arrayBuffer()))]);
       return {message:'Imported <projects> locally'};
     }
   }});
   widget.attach('widget');
 });
 const downloaded = p.waitForEvent('download');
 await p.locator('.rs-export-guest').click();
 const file = await downloaded;
 assert.equal(file.suggestedFilename(), 'all-projects.zip');
 assert.deepEqual(await require('node:fs/promises').readFile(await file.path()), Buffer.from([80,75,0,255]));
 await connectNextGraph(p);
 const input = p.locator('.rs-nextgraph-import input');
 assert.equal(await input.getAttribute('accept'), '.zip,application/zip');
 await input.setInputFiles({name:'projects.zip',mimeType:'application/zip',buffer:Buffer.from([80,75,0,255])});
 await p.waitForFunction(() => document.querySelector('.rs-nextgraph-import [role=status]').textContent === 'Imported <projects> locally');
 assert.deepEqual(await p.evaluate(() => calls), [['app-import',true,'projects.zip','application/zip',4,[80,75,0,255]]]);
 assert.equal(await p.locator('.rs-nextgraph-import [role=status] projects').count(), 0);
 assert.equal(await input.isEnabled(), true);
});

test('guest handoff waits for preflight, cancellation and failure preserve retry', async t => {
 const p = await open(t);
 await p.evaluate(() => {
   widget.destroy();
   rs.nextgraph = {async connect() { calls.push(['connect']); }};
   widget = new Widget(rs, {skipInitial:true,leaveOpen:true,guestData:{
     async export() { throw Error('Guest database unavailable'); }, async import() {},
     beforeConnect() { return new Promise((resolve,reject) => {window.finishPreflight=resolve;window.failPreflight=reject;}); }
   }});
   widget.attach('widget');
 });
 await p.locator('.rs-choose-nextgraph').click();
 const button = p.locator('.rs-nextgraph-connect');
 await button.click();
 assert.equal(await button.isDisabled(), true);
 assert.deepEqual(await p.evaluate(() => calls), []);
 await p.evaluate(() => finishPreflight(false));
 await p.waitForFunction(() => !document.querySelector('.rs-nextgraph-connect').disabled);
 assert.deepEqual(await p.evaluate(() => calls), []);
 await button.click();
 await p.evaluate(() => failPreflight(Error('Save your guest backup first')));
 await p.waitForFunction(() => !document.querySelector('.rs-nextgraph-connect').disabled);
 assert.match(await p.locator('.rs-nextgraph-error').innerText(), /Save your guest backup first/);
 await button.click(); await p.evaluate(() => finishPreflight());
 await p.waitForFunction(() => calls.length === 1);
 await p.locator('.rs-nextgraph-back').click();
 await p.locator('.rs-export-guest').click();
 assert.match(await p.locator('.rs-storage-error').innerText(), /Guest database unavailable/);
 assert.equal(await p.locator('.rs-export-guest').isEnabled(), true);
 assert.equal(await p.evaluate(() => {
   try { new Widget(rs,{guestData:{export(){}}}); return false; }
   catch(error) { return error instanceof TypeError; }
 }), true);
});

test('app import owns size validation and reports persistence failures without syncing', async t => {
 const p = await open(t);
 await p.evaluate(() => {
   widget.destroy();
   rs.nextgraph = {async connect() { rs.backend='nextgraph';rs.connected=true;rs.emit('connected'); }};
   rs.startSync = () => calls.push(['unexpected-sync']);
   widget = new Widget(rs,{skipInitial:true,leaveOpen:true,guestData:{
     async export() {}, async import(file) {
       calls.push(['size',file.size]);
       if (window.failImport) throw Error('Local transaction aborted');
     }
   }});
   widget.attach('widget');
 });
 await connectNextGraph(p);
 await p.evaluate(() => {
   const transfer=new DataTransfer();
   transfer.items.add(new File([new Uint8Array(50*1024*1024+1)],'large.zip'));
   const input=document.querySelector('.rs-nextgraph-import input');
   input.files=transfer.files;input.dispatchEvent(new Event('change'));
 });
 await p.waitForFunction(() => document.querySelector('.rs-nextgraph-import [role=status]').textContent.startsWith('Imported guest'));
 assert.deepEqual(await p.evaluate(() => calls), [['size',50*1024*1024+1]]);
 await p.evaluate(() => window.failImport=true);
 await p.locator('.rs-nextgraph-import input').setInputFiles({name:'retry.zip',mimeType:'application/zip',buffer:Buffer.from('retry')});
 await p.waitForFunction(() => document.querySelector('.rs-nextgraph-import [role=status]').textContent === 'Local transaction aborted');
 assert.equal(await p.locator('.rs-nextgraph-import input').isEnabled(), true);
 assert.equal(await p.locator('.rs-nextgraph-import input').inputValue(), '');
});

test('NextGraph wallet form defaults to nextgraph.net and submits the chosen server only after consent', async t => {
 const p = await open(t);
 await p.evaluate(() => {
   rs.nextgraph = {getWalletURL: () => 'https://nextgraph.net', async connect(url) { calls.push(['wallet',url]); }};
   widget.destroy(); widget.attach('widget');
 });
 await p.locator('.rs-choose-nextgraph').click();
 assert.deepEqual(await p.evaluate(() => calls), []);
 assert.equal(await p.locator('[name=rs-nextgraph-wallet]').inputValue(),'https://nextgraph.net');
 await p.locator('[name=rs-nextgraph-wallet]').fill('https://wallet.example.test');
 await p.locator('.rs-nextgraph-connect').click();
 assert.deepEqual(await p.evaluate(() => calls), [['wallet','https://wallet.example.test']]);
 await p.locator('.rs-nextgraph-back').click();
 await p.locator('.rs-choose-nextgraph').click();
 assert.equal(await p.locator('[name=rs-nextgraph-wallet]').inputValue(),'https://wallet.example.test');
 await p.evaluate(() => { rs.nextgraph.getWalletURL = () => 'https://remembered.example.test'; widget.destroy(); widget.attach('widget'); });
 await p.locator('.rs-choose-nextgraph').click();
 assert.equal(await p.locator('[name=rs-nextgraph-wallet]').inputValue(),'https://remembered.example.test');
 await p.setViewportSize({width:320,height:568});
 const field = await p.locator('[name=rs-nextgraph-wallet]').boundingBox();
 assert.ok(field.x >= 0 && field.x + field.width <= 320);
 assert.ok(await p.locator('[name=rs-nextgraph-wallet]').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
});
