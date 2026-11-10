/**
 * CH-20: the passcode page. Self-contained HTML (no app bundle, no third-party requests, no analytics) that reuses
 * the app's colors, type and focus style. One real input carries the value; the four cells only mirror it.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function gatePage(projectName: string): string {
  const name = esc(projectName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${name}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7z' fill='%231f5fbf'/%3E%3Cpath d='m11 16 4 4 7-8' stroke='white' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E" />
<style>
:root{--bg:#f4f6fa;--surface:#fff;--border:#d8dee9;--border-strong:#b8c2d1;--text:#111827;--text-2:#3b4656;--text-3:#5f6b7c;--accent:#1f5fbf;--accent-hover:#194d9b;--danger:#991b1b;--focus:#2563eb;--on-accent:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--surface:#111a2b;--border:#243147;--border-strong:#33435e;--text:#e6ebf3;--text-2:#c3ccda;--text-3:#93a0b4;--accent:#5b9bf0;--accent-hover:#7ab0f5;--danger:#fca5a5;--focus:#7ab0f5;--on-accent:#0b1220;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.45 'Segoe UI',Inter,system-ui,-apple-system,Roboto,Arial,sans-serif}
main{min-height:100vh;display:grid;place-items:center;padding:24px 16px}
.card{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px 28px 26px;box-shadow:0 1px 2px rgba(15,23,42,.05)}
.mark{width:36px;height:36px;display:block;margin-bottom:18px}
h1{font-size:20px;line-height:1.25;margin:0 0 6px}
p.lead{margin:0 0 22px;color:var(--text-2)}
label{display:block;font-weight:600;font-size:13px;margin-bottom:10px}
.pin{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:8px}
.cell{height:56px;border:1px solid var(--border-strong);border-radius:9px;background:var(--surface);display:grid;place-items:center;font-size:24px;color:var(--text)}
.cell.next{border-color:var(--accent)}
.pin:focus-within .cell.next{outline:2px solid var(--focus);outline-offset:2px}
.pin[data-invalid="true"] .cell{border-color:var(--danger)}
#pin{position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:16px;border:0;caret-color:transparent;cursor:text}
.hint{color:var(--text-3);font-size:12.5px;margin:0 0 18px;min-height:18px}
.err{color:var(--danger);font-size:13px;margin:0 0 14px;min-height:19px}
button{width:100%;height:42px;border:0;border-radius:9px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}
button:hover{background:var(--accent-hover)}
button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button[disabled]{opacity:.6;cursor:default}
.foot{margin:18px 0 0;color:var(--text-3);font-size:12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
</style>
</head>
<body>
<main>
<form class="card" id="f" novalidate>
<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7z" fill="#1f5fbf"/><path d="m11 16 4 4 7-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1>${name}</h1>
<p class="lead">This demo is private. Enter the four-digit passcode you were given.</p>
<label for="pin">Passcode</label>
<div class="pin" id="cells" data-invalid="false">
<span class="cell" aria-hidden="true"></span><span class="cell" aria-hidden="true"></span><span class="cell" aria-hidden="true"></span><span class="cell" aria-hidden="true"></span>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" aria-describedby="hint err" autofocus />
</div>
<p class="hint" id="hint">Four digits. You can paste them.</p>
<p class="err" id="err" role="alert" aria-live="assertive"></p>
<button type="submit" id="go">Enter ${name}</button>
<p class="foot">All records in this demo are synthetic.</p>
</form>
</main>
<script>
(function(){
  var f=document.getElementById('f'),i=document.getElementById('pin'),cells=document.getElementById('cells'),c=cells.querySelectorAll('.cell'),err=document.getElementById('err'),go=document.getElementById('go'),label=go.textContent,timer=null;
  function paint(){var v=i.value;for(var k=0;k<4;k++){c[k].textContent=k<v.length?'\\u2022':'';c[k].className='cell'+(k===Math.min(v.length,3)?' next':'');}}
  function invalid(on){cells.setAttribute('data-invalid',on?'true':'false');i.setAttribute('aria-invalid',on?'true':'false');}
  i.addEventListener('input',function(){var d=i.value.replace(/\\D/g,'').slice(0,4);if(d!==i.value)i.value=d;invalid(false);err.textContent='';paint();});
  function wait(s){go.disabled=true;var left=s;err.textContent='Too many attempts. Try again in '+left+' seconds.';clearInterval(timer);timer=setInterval(function(){left--;if(left<=0){clearInterval(timer);go.disabled=false;err.textContent='';}else{err.textContent='Too many attempts. Try again in '+left+' seconds.';}},1000);}
  f.addEventListener('submit',function(e){
    e.preventDefault();
    if(go.disabled)return;
    if(!/^\\d{4}$/.test(i.value)){invalid(true);err.textContent='Enter all four digits.';i.focus();return;}
    go.disabled=true;go.textContent='Checking\\u2026';
    fetch('/api/access/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({pin:i.value})})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {s:r.status,j:j};});})
      .then(function(x){
        go.textContent=label;
        if(x.s===200){go.textContent='Opening\\u2026';location.reload();return;}
        i.value='';paint();invalid(true);i.focus();
        if(x.s===429){wait((x.j.error&&x.j.error.retryAfterSeconds)||30);return;}
        go.disabled=false;err.textContent='That passcode did not work. Try again.';
      })
      .catch(function(){go.disabled=false;go.textContent=label;err.textContent='Could not reach the server. Check your connection and try again.';});
  });
  paint();
})();
</script>
</body>
</html>`;
}
