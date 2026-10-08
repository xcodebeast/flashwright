import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.FLASHWRIGHT_BROWSER_PATH });
const outcomes = {};
try {
 const page=await browser.newPage(); await page.goto('data:text/html,<p>Hello</p>');
 for (const source of ['undefined','null','true','-0','NaN','Infinity','42n',"'a'+String.fromCharCode(0xd800)",'({a:1})','[1,2]','new Date(0)','/hi/i','new Map([[1,2]])','new Error("oops")','Symbol("x")','(()=>1)','document.querySelector("p")','document','window']) {
  const handle=await page.evaluateHandle(source); const record=outcomes[source]={preview:handle.toString(),element:!!handle.asElement()};
  try{record.json=await handle.jsonValue();record.jsonType=typeof record.json;}catch(error){record.jsonError=error.message;}
  await handle.dispose();
 }
}finally{await browser.close();await writeFile('.cache/handles-reference-002/report.json',JSON.stringify(outcomes,(_,v)=>typeof v==='bigint'?String(v)+'n':v,2)+'\n');}
