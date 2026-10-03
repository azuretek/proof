import {chromium} from "playwright";
import {createServer} from "vite";
import {execFileSync,spawn} from "node:child_process";
import fs from "node:fs";
import {randomBytes} from "node:crypto";
const home=process.env.HOME, root=process.cwd(), out=process.env.PROOF_OUT || root+"/proof-output";fs.mkdirSync(out,{recursive:true});
const token=randomBytes(24).toString("hex");
const log=fs.openSync(out+"/gateway.log","w");
const gw=spawn(process.env.PROOF_GATEWAY_BIN || "openclaw",["gateway","run","--dev","--allow-unconfigured","--bind","loopback","--port","19143","--auth","token"],{env:{...process.env,OPENCLAW_STATE_DIR:process.env.PROOF_STATE || root+"/proof-state",OPENCLAW_SUPERVISOR_MODE:"external",OPENCLAW_SKIP_CHANNELS:"1",OPENCLAW_GATEWAY_TOKEN:token},stdio:["ignore",log,log]});
let browser,server,page;
const variant=process.env.PROOF_VARIANT||"after", route=process.env.PROOF_ROUTE||"new",kind=process.env.PROOF_KIND||"delete", caseName=[variant,route,kind].join("-");
try{
 await new Promise((resolve,reject)=>{const deadline=Date.now()+90000;const check=()=>{if(fs.readFileSync(out+"/gateway.log","utf8").includes("http server listening"))return resolve();if(Date.now()>deadline)return reject(new Error("Gateway readiness timeout"));setTimeout(check,500)};check()});
 process.env.OPENCLAW_UI_DEV_GATEWAY_URL="http://127.0.0.1:19143";

 const base="daa9ee37ade523ed085b28429ee6bd4dbd46a6bc", head="3cb04ea6d88926c7a43d4db6406c4b415bde0da4", ref=variant==="before"?base:head;
 const baseline={}, served=new Set();baseline[root+"/ui/src/pages/new-session/gateway-name-discovery.ts"]='export async function discoverGatewayName(){return "Demo Gateway";}'; for(const f of execFileSync("git",["diff","--name-only",base,head],{encoding:"utf8"}).trim().split("\n").filter(f=>!f.endsWith(".test.ts"))){ baseline[root+"/"+f]=execFileSync("git",["show",ref+":"+f],{encoding:"utf8"}); console.log("EXPECTED_SOURCE",f,execFileSync("git",["rev-parse",ref+":"+f],{encoding:"utf8"}).trim()); }
 server=await createServer({plugins:[{name:"proof-baseline",enforce:"pre",load(id){const key=id.split("?")[0];if(Object.hasOwn(baseline,key)){served.add(key); console.log("SERVED_SOURCE",key.slice(root.length+1),execFileSync("git",["hash-object","--stdin"],{input:baseline[key],encoding:"utf8"}).trim());return baseline[key];}}}],root:root+"/ui",server:{host:"127.0.0.1",port:19144},logLevel:"error"});await server.listen();
 browser=await chromium.launchPersistentContext(fs.mkdtempSync(out+"/profile-"),{headless:true,viewport:{width:1360,height:1000}});page=await browser.newPage();console.log("BROWSER",browser.browser().version(),"persistent");
 await page.addInitScript(()=>localStorage.setItem("openclaw:control-ui:community-invite:v2",JSON.stringify({dismissedAtMs:1770000000000})));
 await page.addInitScript(() => {window.proofEvents=[]; const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(v){const r=put.apply(this,arguments);if(this.name==="composerDrafts"&&v?.attachments?.length){r.addEventListener("error",()=>window.proofEvents.push("error:"+r.error?.name));this.transaction.addEventListener("complete",()=>window.proofEvents.push("commit:"+v.attachments.length));this.transaction.addEventListener("abort",()=>window.proofEvents.push("abort:"+this.transaction.error?.name+":"+this.transaction.error?.message));window.proofEvents.push("put:"+v.attachments.length+":"+performance.now());}return r;};});

 await page.goto("http://127.0.0.1:19144/"+(route==="new"?"new":"chat/dev"));
 await page.locator("#login-gate-credential").waitFor({timeout:60000});
 await page.locator("#login-gate-url").fill("ws://127.0.0.1:19143");
 await page.locator("#login-gate-credential").fill(token);
 await page.locator(".login-gate__connect").first().click();
 try{await page.locator("textarea:visible").first().waitFor({timeout:60000});console.log("NORMAL_LOGIN_READY")}catch(e){console.log("LOGIN_RESULT "+(await page.locator("body").innerText()).slice(0,6000));throw e}
 await page.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue("--openclaw-css-ok").trim()==="1");
 if((await page.locator("body").innerText()).includes("Styles failed to load"))throw new Error("stylesheet warning remains");
 console.log("STYLES_READY",await page.evaluate(()=>document.styleSheets.length));
await page.goto("http://127.0.0.1:19144/settings/profile");const nameInput=page.getByRole("textbox",{name:"Display name",exact:true});await nameInput.waitFor();if(await nameInput.inputValue()!=="Demo User"){await nameInput.fill("Demo User");await page.locator(".identity-name-control button").click();await page.waitForFunction(()=>document.querySelector(".identity-name-control button")?.disabled);}await page.goto("http://127.0.0.1:19144/"+(route==="new"?"new":"chat/dev"));await page.locator("textarea:visible").first().waitFor();
 const fixture=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");
 const n=kind==="limit"?5:3,size=kind==="limit"?5.5*1024*1024:3*1024*1024;
 const files=[];for(let i=0;i<n;i++){const f=out+"/sample-"+i+".png";const bytes=Buffer.alloc(size);fixture.copy(bytes);fs.writeFileSync(f,bytes);files.push(f);}
 await page.locator("input[type=file]").first().setInputFiles(files);
 await page.waitForFunction(n=>document.querySelectorAll(".chat-attachment-thumb:not(.chat-attachment-thumb--error)").length>=n,n,{timeout:30000});
 if(kind==="delete"){for(const f of files)fs.unlinkSync(f);await page.evaluate(()=>window.proofEvents.push("source-deleted:"+performance.now()));}
 console.log("UPLOAD_READ",{variant,route,kind,n,sourceDeleted:kind==="delete"});
 await page.locator("textarea:visible").last().fill("Image draft proof");
 await page.waitForFunction(({variant,kind})=>kind==="limit"?document.body.innerText.includes(variant==="before"?"Could not store the previous draft":"These attachments exceed the draft storage limit"):window.proofEvents.some(e=>variant==="before"?(e.startsWith("error:")||e.startsWith("abort:")):e==="commit:3"),{variant,kind},{timeout:30000});
 if(!served.has(root+"/ui/src/pages/chat/attachment-payload-store.ts"))throw new Error("snapshot source not observed served");
 console.log("RESULT",JSON.stringify(await page.evaluate(()=>({events:window.proofEvents,text:document.body.innerText}))));
 await page.screenshot({path:out+"/"+[variant,route,kind].join("-")+".png"});
 fs.writeFileSync(out+"/state","done: "+[variant,route,kind].join("-"));
}catch(e){if(page){console.log("FAILURE_DIAGNOSTIC",JSON.stringify(await page.evaluate(()=>({events:window.proofEvents,text:document.body.innerText})).catch(()=>null)));await page.screenshot({path:out+"/failed-"+caseName+".png"}).catch(()=>{});}fs.writeFileSync(out+"/state","failed: "+e.message);throw e}finally{await browser?.close();await server?.close();gw.kill("SIGTERM");fs.closeSync(log)}
