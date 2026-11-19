const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { chromium } = require('playwright');
const issuer = 'http://localhost:3000';
const base = 'http://localhost:8018';
const source = process.env.RS_SOLID_SOURCE;
if (!source || !process.env.RS_SOLID_TEST_PASSWORD) {
  throw new Error('Set RS_SOLID_SOURCE and RS_SOLID_TEST_PASSWORD; see README.md');
}
const app = `<!doctype html><div id="widget"></div>
<script src="/rs.js"></script><script src="/widget.js"></script><script>
window.rs = new RemoteStorage({modules:[{name:'widgettest',builder(client){client.declareType('record',{type:'object',properties:{title:{type:'string'}},required:['title']});return {exports:{
read:()=>client.getObject('record'),write:value=>client.storeObject('record','record',value),remove:()=>client.remove('record')
}}}}]});
rs.access.claim('widgettest','rw');rs.caching.enable('/widgettest/');
window.widget=new Widget(rs,{solidProviders:{allowAnyProvider:true},skipInitial:true,leaveOpen:true});widget.attach('widget');
</script>`;
async function login(page) {
  await page.goto(base);
  await page.locator('.rs-choose-solid').click();
  await page.locator('[name=rs-provider-address]').fill(issuer);
  await page.locator('.rs-solid-connect').click();
  await page.locator('input[type=email]').fill('solid-test@example.test');
  await page.locator('input[type=password]').fill(process.env.RS_SOLID_TEST_PASSWORD);
  await page.getByRole('button',{name:'Log in',exact:true}).click();
  await page.getByRole('button',{name:'Authorize',exact:true}).click();
  await page.waitForURL(base+'/');
  await page.waitForFunction(()=>window.rs?.connected);
  assert.equal(await page.locator('.rs-box-connected').isVisible(),true);
}
test('real Solid OAuth, private module storage, reload, fresh browser and disconnect', {timeout:120000}, async t=>{
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':'text/html');
    res.end(req.url==='/rs.js'?readFileSync(resolve(source,'release/remotestorage-solid.js')):
      req.url==='/widget.js'?readFileSync(resolve(__dirname,'../build/widget.js')):app);
  });
  await new Promise(resolve=>server.listen(8018,resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
  t.after(()=>browser.close());
  const first=await browser.newPage();
  await login(first);
  const url=issuer+'/sync-test/widgettest/record';
  const stored=first.waitForResponse(r=>r.url()===url&&r.request().method()==='PUT'&&r.ok());
  await first.evaluate(()=>rs.widgettest.write({title:'Widget integration test'}));
  await stored;
  assert.ok([401,403,404].includes((await fetch(url)).status));
  await first.reload();
  await first.waitForFunction(()=>window.rs?.connected);
  assert.equal(await first.evaluate(async()=>(await rs.widgettest.read()).title),'Widget integration test');
  const second=await browser.newPage();
  await login(second);
  await second.waitForFunction(async()=> (await rs.widgettest.read())?.title==='Widget integration test');
  const deleted=second.waitForResponse(r=>r.url()===url&&r.request().method()==='DELETE'&&r.ok());
  await second.evaluate(()=>rs.widgettest.remove());
  await deleted;
  await second.locator('.rs-box-connected .rs-disconnect').click();
  await second.locator('.rs-choose-solid:visible').waitFor();
});
