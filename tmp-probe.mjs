// Throwaway: can we see the extension's targets in a headless Chrome?
const res = await fetch('http://127.0.0.1:9222/json/list');
const list = await res.json();
for (const t of list) console.log(`${t.type.padEnd(16)} ${t.url}`);
const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
console.log('\nbrowser:', v.Browser);
