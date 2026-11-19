// Run against built apps served on localhost:8100–8109 and disposable CSS on :3000.
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const apps = ['launcher','webmarks','litewrite','inbox','hyperdraft','inspektor','savr','marco','todonna','sharesome'];
(async () => {
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH});
 const results=[];
 for(let i=0;i<apps.length;i++) {
  const app=apps[i];if(process.env.ONLY && !process.env.ONLY.split(',').includes(app))continue;
  const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(20000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='http://localhost:'+(8100+i);let reads=0;
  page.on('response',r=>{if(r.url().startsWith('http://localhost:3000/sync-test/')&&r.request().method()==='GET'&&r.ok())reads++;});
  try {
   await page.goto(base+(app==='hyperdraft'?'/write/':app==='webmarks'?'/archive':app==='inspektor'?'/connect':'/'));
   if(app==='inbox') await page.getByRole('button',{name:'User menu — disconnected',exact:true}).click();
   if(app==='hyperdraft') await page.getByRole('button',{name:'Cloud',exact:true}).click();
   if(app==='marco') {await page.getByRole('button',{name:'User Menu',exact:true}).click();await page.locator('.account-item').first().getByRole('button',{name:'Connect',exact:true}).click();}
   await page.locator('.rs-widget').waitFor({state:'visible'});
   if(await page.locator('.rs-box-initial').isVisible())await page.locator('.rs-box-initial').click();
   for(const backend of ['rs','googledrive','dropbox','solid']) assert.equal(await page.locator('.rs-choose-'+backend).isVisible(),true,backend+' offered');
   assert.equal(await page.locator('[data-pondersource-solid]').count(),0);
   await page.locator('.rs-choose-solid').click();
   await page.locator('[name=rs-provider-address]').fill('http://localhost:3000');
   await page.locator('.rs-solid-connect').click();
   await page.locator('input[type=email]').fill('solid-test@example.test');
   await page.locator('input[type=password]').fill(process.env.RS_SOLID_TEST_PASSWORD);
   await page.getByRole('button',{name:'Log in',exact:true}).click();
   await page.getByRole('button',{name:'Authorize',exact:true}).click();
   await page.waitForURL(url=>url.origin===base);
   await page.locator('.rs-widget.rs-backend-solid.rs-state-connected').waitFor({state:'attached',timeout:30000});
   await page.reload();
   // Marco attaches the widget on demand after an already-selected pod reload.
   if(app==='marco') {await page.getByRole('button',{name:'User Menu',exact:true}).click(); await page.waitForFunction(()=>document.querySelector('.account-status')?.textContent.includes('http://localhost:3000/'));}
   else await page.locator('.rs-widget.rs-backend-solid.rs-state-connected').waitFor({state:'attached',timeout:30000});
   assert.ok(reads>0,'actual pod reads');
   results.push({app,status:'passed',podReads:reads,errors});
  } catch(e) {results.push({app,status:'failed',error:e.message.split('\n')[0],debug:app==='marco'?await page.evaluate(()=>({backend:remoteStorage.backend,loaded:remoteStorage._allLoaded,pods:remoteStorage.solid?.getPodURLs(),selected:remoteStorage.solid?.getPodURL(),connected:remoteStorage.connected})):null,errors,url:new URL(page.url()).origin+new URL(page.url()).pathname});await page.screenshot({path:'/tmp/widget-solid-'+app+'-failure.png'}).catch(()=>{});}
  console.log(JSON.stringify(results.at(-1)));await context.close();
 }
 fs.writeFileSync('/tmp/widget-solid-app-results'+(process.env.ONLY?'-retry':'')+'.json',JSON.stringify(results,null,2));
 await browser.close();if(results.some(r=>r.status==='failed'))process.exitCode=1;
})();
