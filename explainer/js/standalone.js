/* ============================================
   STANDALONE — Export self-contained HTML viewer
   Builds complete HTML with CSS from CSSOM and
   an inline viewer script. No fetch() needed.
   ============================================ */

const Standalone = (() => {

    function gatherCSS() {
        var css = '';
        for (var i = 0; i < document.styleSheets.length; i++) {
            try {
                var rules = document.styleSheets[i].cssRules;
                for (var j = 0; j < rules.length; j++) {
                    css += rules[j].cssText + '\n';
                }
            } catch (e) {}
        }
        return css;
    }

    function exportToHtml(data, toastFn) {
        var css = gatherCSS();
        var safeData = JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>');
        var title = (data.meta.title || 'EntropyExplainer')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        var html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
            + '<meta charset="UTF-8">\n'
            + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            + '<title>' + title + ' — EntropyExplainer</title>\n'
            + '<style>\n' + css + '\n</style>\n'
            + '</head>\n'
            + '<body class="theme-clean" role="application" aria-label="EntropyExplainer Textbook Reader">\n'
            + BODY_TEMPLATE
            + '<script>\nvar DATA = ' + safeData + ';\n'
            + VIEWER_SCRIPT
            + '\n<\/script>\n'
            + '</body>\n</html>';

        var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (data.meta.title || 'viewer').replace(/[^a-zA-Z0-9 _-]/g, '') + '.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (toastFn) toastFn('Standalone file downloaded');
    }

    var BODY_TEMPLATE = ''
        + '<a href="#main-content" class="skip-link">Skip to content</a>\n'
        + '<header class="explainer-header" role="banner">\n'
        + '  <div class="header-left">\n'
        + '    <button id="sidebar-toggle" class="icon-btn" aria-label="Toggle navigation" aria-expanded="true">\n'
        + '      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>\n'
        + '    </button>\n'
        + '    <h1 class="book-title" id="book-title">EntropyExplainer</h1>\n'
        + '  </div>\n'
        + '  <div class="header-right">\n'
        + '    <div class="breadcrumb" id="breadcrumb" aria-label="Breadcrumb navigation"></div>\n'
        + '    <button id="theme-btn" class="icon-btn" aria-label="Change theme" title="Change theme">\n'
        + '      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.93 4.93l1.41 1.41M13.66 13.66l1.41 1.41M4.93 15.07l1.41-1.41M13.66 6.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>\n'
        + '    </button>\n'
        + '    <button id="font-btn" class="icon-btn" aria-label="Font settings" title="Adjust font size">\n'
        + '      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><text x="3" y="15" font-size="12" fill="currentColor" font-family="serif">A</text><text x="12" y="15" font-size="8" fill="currentColor" font-family="serif">A</text></svg>\n'
        + '    </button>\n'
        + '    <button id="progress-btn" class="icon-btn" aria-label="Reading progress" title="View progress">\n'
        + '      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5" opacity="0.3"/><path id="progress-arc" d="" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>\n'
        + '    </button>\n'
        + '  </div>\n'
        + '</header>\n'
        + '<div id="theme-modal" class="modal" role="dialog" aria-label="Theme selection" aria-hidden="true">\n'
        + '  <div class="modal-backdrop"></div>\n'
        + '  <div class="modal-content">\n'
        + '    <h2>Choose Theme</h2>\n'
        + '    <div class="theme-grid" id="theme-grid"></div>\n'
        + '    <button class="modal-close" aria-label="Close">Close</button>\n'
        + '  </div>\n'
        + '</div>\n'
        + '<div id="font-modal" class="modal" role="dialog" aria-label="Font settings" aria-hidden="true">\n'
        + '  <div class="modal-backdrop"></div>\n'
        + '  <div class="modal-content">\n'
        + '    <h2>Reading Settings</h2>\n'
        + '    <div class="setting-row"><label for="font-size-slider">Font Size</label><input type="range" id="font-size-slider" min="14" max="24" value="17"><span id="font-size-display">17px</span></div>\n'
        + '    <div class="setting-row"><label for="line-height-slider">Line Spacing</label><input type="range" id="line-height-slider" min="1.4" max="2.2" step="0.1" value="1.7"><span id="line-height-display">1.7</span></div>\n'
        + '    <div class="setting-row"><label for="content-width-slider">Content Width</label><input type="range" id="content-width-slider" min="500" max="900" step="50" value="700"><span id="content-width-display">700px</span></div>\n'
        + '    <button class="modal-close" aria-label="Close">Close</button>\n'
        + '  </div>\n'
        + '</div>\n'
        + '<div class="layout">\n'
        + '  <nav class="sidebar" id="sidebar" role="navigation" aria-label="Table of contents">\n'
        + '    <div class="sidebar-header"><h2>Contents</h2><div class="sidebar-search"><input type="search" id="nav-search" placeholder="Search sections..." aria-label="Search sections"></div></div>\n'
        + '    <ul class="nav-tree" id="nav-tree" role="tree"></ul>\n'
        + '  </nav>\n'
        + '  <main id="main-content" class="content-area" role="main" aria-live="polite">\n'
        + '    <div class="landing" id="landing" hidden>\n'
        + '      <div class="landing-content">\n'
        + '        <h2>EntropyExplainer</h2>\n'
        + '        <p>Interactive textbook reader with expandable, linked content.</p>\n'
        + '        <label class="file-upload-label" for="file-input"><span>Load a different .entropy.json file</span><input type="file" id="file-input" accept=".json,.entropy.json" aria-label="Upload content file"></label>\n'
        + '      </div>\n'
        + '    </div>\n'
        + '    <div class="reader" id="reader">\n'
        + '      <article class="node-content" id="node-content">\n'
        + '        <header class="node-header"><div class="node-meta" id="node-meta"></div><h2 class="node-title" id="node-title"></h2><p class="node-summary" id="node-summary"></p></header>\n'
        + '        <div class="node-body" id="node-body"></div>\n'
        + '        <div class="node-media" id="node-media"></div>\n'
        + '      </article>\n'
        + '      <section class="children-section" id="children-section" aria-label="Sub-sections"><h3 class="children-heading">Explore Further</h3><div class="children-list" id="children-list"></div></section>\n'
        + '      <section class="connections-section" id="connections-section" aria-label="Related sections"><h3 class="connections-heading">Connected Topics</h3><div class="connections-list" id="connections-list"></div></section>\n'
        + '      <nav class="node-nav" id="node-nav" aria-label="Section navigation">\n'
        + '        <div class="nav-group-left">\n'
        + '          <button id="back-btn" class="nav-btn" aria-label="Go back"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Back</button>\n'
        + '          <button id="home-btn" class="nav-btn" aria-label="Return to start">Home</button>\n'
        + '        </div>\n'
        + '        <div class="nav-group-right">\n'
        + '          <button id="prev-btn" class="nav-btn" aria-label="Previous section" disabled><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 12L6 8l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Prev</button>\n'
        + '          <button id="next-btn" class="nav-btn" aria-label="Next section" disabled>Next <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>\n'
        + '        </div>\n'
        + '      </nav>\n'
        + '    </div>\n'
        + '  </main>\n'
        + '</div>\n';

    var VIEWER_SCRIPT = ''
        // --- Markdown parser ---
        + 'function escHtml(t){var m={"&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;","\\\'":"&#039;"};return t.replace(/[&<>"\']/g,function(c){return m[c]})}\n'
        + 'function mdInline(t){return t.replace(/\\*\\*(.+?)\\*\\*/g,"<strong>$1</strong>").replace(/\\*(.+?)\\*/g,"<em>$1</em>").replace(/`(.+?)`/g,"<code>$1</code>").replace(/\\[(.+?)\\]\\((.+?)\\)/g,\'<a href="$2" target="_blank" rel="noopener">$1</a>\').replace(/~~(.+?)~~/g,"<del>$1</del>")}\n'
        + 'function mdParse(md){\n'
        + '  if(!md)return"";\n'
        + '  var lines=md.split("\\n"),html="",inList=false,lt="",inBq=false,inCode=false,inEx=false;\n'
        + '  for(var i=0;i<lines.length;i++){\n'
        + '    var l=lines[i];\n'
        + '    if(l.indexOf("```")===0){if(inList){html+=lt==="ul"?"</ul>":"</ol>";inList=false}if(inBq){html+="</blockquote>";inBq=false}if(inCode){html+="</code></pre>";inCode=false}else{inCode=true;html+="<pre><code>"}continue}\n'
        + '    if(inCode){html+=escHtml(l)+"\\n";continue}\n'
        + '    if(/^:::example\\s*$/i.test(l)){if(inList){html+=lt==="ul"?"</ul>":"</ol>";inList=false}if(inBq){html+="</blockquote>";inBq=false}inEx=true;html+=\'<div class="example-block"><span class="example-label"></span>\';continue}\n'
        + '    if(inEx&&/^:::\\s*$/.test(l)){html+="</div>";inEx=false;continue}\n'
        + '    if(inEx){var tr=l.trim();if(tr)html+="<p>"+mdInline(tr)+"</p>";continue}\n'
        + '    if(inList&&!/^(\\s*[-*+]|\\s*\\d+\\.)\\s/.test(l)){html+=lt==="ul"?"</ul>":"</ol>";inList=false}\n'
        + '    if(inBq&&l.charAt(0)!==">"){html+="</blockquote>";inBq=false}\n'
        + '    var hm=l.match(/^(#{1,6})\\s+(.+)/);\n'
        + '    if(hm){var lv=hm[1].length;html+="<h"+lv+">"+mdInline(hm[2])+"</h"+lv+">";continue}\n'
        + '    if(l.charAt(0)===">"){var c=l.replace(/^>\\s?/,"").trim();if(!inBq){html+="<blockquote>";inBq=true}if(c)html+="<p>"+mdInline(c)+"</p>";continue}\n'
        + '    var um=l.match(/^\\s*[-*+]\\s+(.+)/);\n'
        + '    if(um){if(!inList||lt!=="ul"){if(inList)html+=lt==="ul"?"</ul>":"</ol>";html+="<ul>";inList=true;lt="ul"}html+="<li>"+mdInline(um[1])+"</li>";continue}\n'
        + '    var om=l.match(/^\\s*\\d+\\.\\s+(.+)/);\n'
        + '    if(om){if(!inList||lt!=="ol"){if(inList)html+=lt==="ul"?"</ul>":"</ol>";html+="<ol>";inList=true;lt="ol"}html+="<li>"+mdInline(om[1])+"</li>";continue}\n'
        + '    if(/^(-{3,}|\\*{3,}|_{3,})$/.test(l)){html+="<hr>";continue}\n'
        + '    if(!l.trim())continue;\n'
        + '    html+="<p>"+mdInline(l)+"</p>";\n'
        + '  }\n'
        + '  if(inList)html+=lt==="ul"?"</ul>":"</ol>";\n'
        + '  if(inBq)html+="</blockquote>";\n'
        + '  if(inEx)html+="</div>";\n'
        + '  if(inCode)html+="</code></pre>";\n'
        + '  return html;\n'
        + '}\n'

        // --- State ---
        + 'var current=DATA.root,hist=[DATA.root],visited={},sidebarOpen=true,theme="clean";\n'
        + 'visited[DATA.root]=true;\n'

        // --- Navigation ---
        + 'function getOrder(){\n'
        + '  var order=[],seen={};\n'
        + '  function walk(id){if(seen[id]||!DATA.nodes[id])return;seen[id]=true;order.push(id);(DATA.nodes[id].children||[]).forEach(walk)}\n'
        + '  walk(DATA.root);\n'
        + '  Object.keys(DATA.nodes).forEach(function(id){if(!seen[id])order.push(id)});\n'
        + '  return order;\n'
        + '}\n'
        + 'function go(id){if(!DATA.nodes[id])return;current=id;hist.push(id);visited[id]=true;render(id);window.scrollTo(0,0)}\n'
        + 'function goBack(){if(hist.length>1){hist.pop();current=hist[hist.length-1];render(current);window.scrollTo(0,0)}}\n'
        + 'function goHome(){current=DATA.root;hist=[DATA.root];render(DATA.root);window.scrollTo(0,0)}\n'

        // --- Render ---
        + 'function render(id){\n'
        + '  var node=DATA.nodes[id];if(!node)return;\n'
        + '  var content=document.getElementById("node-content");content.classList.remove("fade-in");void content.offsetWidth;content.classList.add("fade-in");\n'
        + '  var metaH="";\n'
        + '  if(node.difficulty)metaH+=\'<span class="difficulty-badge difficulty-\'+node.difficulty+\'">\'+node.difficulty+"</span>";\n'
        + '  if(node.estimatedTime)metaH+=\'<span class="time-estimate">\'+node.estimatedTime+"</span>";\n'
        + '  if(node.tags&&node.tags.length)metaH+=node.tags.map(function(t){return\'<span class="meta-tag">\'+escHtml(t)+"</span>"}).join("");\n'
        + '  document.getElementById("node-meta").innerHTML=metaH;\n'
        + '  document.getElementById("node-title").textContent=node.title;\n'
        + '  var sumEl=document.getElementById("node-summary");\n'
        + '  if(node.summary){sumEl.textContent=node.summary;sumEl.hidden=false}else{sumEl.hidden=true}\n'
        + '  document.getElementById("node-body").innerHTML=mdParse(node.content);\n'
        + '  document.getElementById("node-media").innerHTML="";\n'

        // Children
        + '  var cs=document.getElementById("children-section"),cl=document.getElementById("children-list");\n'
        + '  if(!node.children||!node.children.length){cs.hidden=true}else{\n'
        + '    cs.hidden=false;cl.innerHTML="";\n'
        + '    node.children.forEach(function(cid){\n'
        + '      var ch=DATA.nodes[cid];if(!ch)return;\n'
        + '      var card=document.createElement("div");card.className="child-card";card.setAttribute("tabindex","0");\n'
        + '      if(visited[cid])card.setAttribute("data-visited","true");\n'
        + '      card.innerHTML=\'<div class="child-card-title">\'+escHtml(ch.title)+"</div>"+(ch.summary?\'<div class="child-card-summary">\'+escHtml(ch.summary)+"</div>":"");\n'
        + '      card.onclick=function(){go(cid)};card.onkeydown=function(e){if(e.key==="Enter")go(cid)};\n'
        + '      cl.appendChild(card);\n'
        + '    });\n'
        + '  }\n'

        // Connections
        + '  var xs=document.getElementById("connections-section"),xl=document.getElementById("connections-list");\n'
        + '  if(!node.connections||!node.connections.length){xs.hidden=true}else{\n'
        + '    xs.hidden=false;xl.innerHTML="";\n'
        + '    node.connections.forEach(function(conn){\n'
        + '      var tgt=DATA.nodes[conn.to];if(!tgt)return;\n'
        + '      var btn=document.createElement("button");btn.className="connection-link";\n'
        + '      if(conn.type)btn.className+=" conn-type-"+conn.type;\n'
        + '      var h="";if(conn.type)h+=\'<span class="connection-type">\'+conn.type+"</span>";\n'
        + '      h+="<span>"+escHtml(conn.label||tgt.title)+"</span>";\n'
        + '      btn.innerHTML=h;btn.onclick=function(){go(conn.to)};\n'
        + '      xl.appendChild(btn);\n'
        + '    });\n'
        + '  }\n'

        // Nav buttons
        + '  document.getElementById("back-btn").disabled=hist.length<=1;\n'
        + '  var order=getOrder(),idx=order.indexOf(current);\n'
        + '  var prevBtn=document.getElementById("prev-btn"),nextBtn=document.getElementById("next-btn");\n'
        + '  prevBtn.disabled=idx<=0;nextBtn.disabled=idx>=order.length-1;\n'
        + '  prevBtn.onclick=function(){if(idx>0)go(order[idx-1])};\n'
        + '  nextBtn.onclick=function(){if(idx<order.length-1)go(order[idx+1])};\n'

        // Sidebar active state
        + '  document.querySelectorAll(".nav-item-btn").forEach(function(b){\n'
        + '    b.classList.toggle("active",b.getAttribute("data-id")===id);\n'
        + '    if(visited[b.getAttribute("data-id")]){var d=b.querySelector(".nav-dot");if(d)d.classList.add("visited")}\n'
        + '  });\n'

        // Breadcrumb
        + '  updateBread(id);\n'

        // Progress arc
        + '  var total=Object.keys(DATA.nodes).length,pct=Object.keys(visited).length/total;\n'
        + '  var arc=document.getElementById("progress-arc"),angle=pct*360,rad=angle*Math.PI/180;\n'
        + '  if(angle===0)arc.setAttribute("d","");\n'
        + '  else if(angle>=360)arc.setAttribute("d","M10 2 A8 8 0 1 1 9.99 2");\n'
        + '  else{var x=10+8*Math.sin(rad),y=10-8*Math.cos(rad);arc.setAttribute("d","M10 2 A8 8 0 "+(angle>180?1:0)+" 1 "+x+" "+y)}\n'
        + '  document.getElementById("progress-btn").title="Progress: "+Math.round(pct*100)+"% ("+Object.keys(visited).length+"/"+total+")";\n'
        + '}\n'

        // --- Sidebar tree ---
        + 'function buildTree(){\n'
        + '  var tree=document.getElementById("nav-tree");tree.innerHTML="";\n'
        + '  function addNode(id,depth){\n'
        + '    var n=DATA.nodes[id];if(!n)return;\n'
        + '    var li=document.createElement("li");li.className="nav-item";\n'
        + '    var btn=document.createElement("button");btn.className="nav-item-btn";btn.setAttribute("data-id",id);\n'
        + '    if(depth>0){var sp=document.createElement("span");sp.className="nav-indent";sp.style.width=depth*12+"px";btn.appendChild(sp)}\n'
        + '    var dot=document.createElement("span");dot.className="nav-dot";if(visited[id])dot.classList.add("visited");btn.appendChild(dot);\n'
        + '    var txt=document.createElement("span");txt.textContent=n.title;btn.appendChild(txt);\n'
        + '    btn.onclick=function(){go(id)};\n'
        + '    li.appendChild(btn);tree.appendChild(li);\n'
        + '    (n.children||[]).forEach(function(c){addNode(c,depth+1)});\n'
        + '  }\n'
        + '  addNode(DATA.root,0);\n'
        + '}\n'

        // --- Breadcrumb ---
        + 'function updateBread(targetId){\n'
        + '  var bc=document.getElementById("breadcrumb");bc.innerHTML="";\n'
        + '  var path=[];\n'
        + '  function find(id,p){p=p.concat(id);if(id===targetId){path=p;return true}var n=DATA.nodes[id];if(n&&n.children){for(var i=0;i<n.children.length;i++){if(find(n.children[i],p))return true}}return false}\n'
        + '  find(DATA.root,[]);if(!path.length)path=[targetId];\n'
        + '  path.forEach(function(id,i){\n'
        + '    if(i>0){var sep=document.createElement("span");sep.className="breadcrumb-sep";sep.textContent="/";bc.appendChild(sep)}\n'
        + '    var item=document.createElement("span");item.className="breadcrumb-item";item.textContent=DATA.nodes[id]?DATA.nodes[id].title:id;\n'
        + '    item.onclick=function(){go(id)};bc.appendChild(item);\n'
        + '  });\n'
        + '}\n'

        // --- Toast ---
        + 'function showToast(msg){var old=document.querySelector(".toast");if(old)old.remove();var t=document.createElement("div");t.className="toast";t.textContent=msg;t.setAttribute("role","alert");document.body.appendChild(t);requestAnimationFrame(function(){t.classList.add("visible")});setTimeout(function(){t.classList.remove("visible");setTimeout(function(){t.remove()},300)},3000)}\n'

        // --- Themes ---
        + 'var themeMap={"clean":"Clean","academic":"Academic","dark":"Dark","high-contrast":"High Contrast"};\n'
        + 'function setTheme(t){theme=t;document.body.className="theme-"+t;try{localStorage.setItem("entropy-theme",t)}catch(e){}}\n'
        + 'try{var st=localStorage.getItem("entropy-theme");if(st&&themeMap[st])setTheme(st)}catch(e){}\n'
        + 'var tGrid=document.getElementById("theme-grid");\n'
        + 'Object.keys(themeMap).forEach(function(k){\n'
        + '  var opt=document.createElement("button");opt.className="theme-option";if(k===theme)opt.classList.add("active");\n'
        + '  opt.textContent=themeMap[k];\n'
        + '  opt.onclick=function(){tGrid.querySelectorAll(".theme-option").forEach(function(o){o.classList.remove("active")});opt.classList.add("active");setTheme(k)};\n'
        + '  tGrid.appendChild(opt);\n'
        + '});\n'

        // --- Modals ---
        + 'function toggleModal(m){m.classList.toggle("visible");m.setAttribute("aria-hidden",String(!m.classList.contains("visible")))}\n'
        + 'document.getElementById("theme-btn").onclick=function(){toggleModal(document.getElementById("theme-modal"))};\n'
        + 'document.getElementById("font-btn").onclick=function(){toggleModal(document.getElementById("font-modal"))};\n'
        + 'document.querySelectorAll(".modal-close").forEach(function(b){b.onclick=function(){var m=b.closest(".modal");m.classList.remove("visible");m.setAttribute("aria-hidden","true")}});\n'
        + 'document.querySelectorAll(".modal").forEach(function(m){m.onclick=function(e){if(e.target===m||e.target.classList.contains("modal-backdrop")){m.classList.remove("visible");m.setAttribute("aria-hidden","true")}}});\n'

        // --- Font settings ---
        + 'var fSize=17,lHeight=1.7,cWidth=700;\n'
        + 'try{var s=localStorage.getItem("entropy-font-size");if(s)fSize=parseInt(s);s=localStorage.getItem("entropy-line-height");if(s)lHeight=parseFloat(s);s=localStorage.getItem("entropy-content-width");if(s)cWidth=parseInt(s)}catch(e){}\n'
        + 'function applySettings(){document.documentElement.style.setProperty("--font-size",fSize+"px");document.documentElement.style.setProperty("--line-height",String(lHeight));document.documentElement.style.setProperty("--content-width",cWidth+"px")}\n'
        + 'applySettings();\n'
        + 'var fsSlider=document.getElementById("font-size-slider"),lhSlider=document.getElementById("line-height-slider"),cwSlider=document.getElementById("content-width-slider");\n'
        + 'fsSlider.value=fSize;lhSlider.value=lHeight;cwSlider.value=cWidth;\n'
        + 'document.getElementById("font-size-display").textContent=fSize+"px";\n'
        + 'document.getElementById("line-height-display").textContent=String(lHeight);\n'
        + 'document.getElementById("content-width-display").textContent=cWidth+"px";\n'
        + 'fsSlider.oninput=function(){fSize=parseInt(this.value);document.getElementById("font-size-display").textContent=fSize+"px";applySettings();try{localStorage.setItem("entropy-font-size",fSize)}catch(e){}};\n'
        + 'lhSlider.oninput=function(){lHeight=parseFloat(this.value);document.getElementById("line-height-display").textContent=lHeight.toFixed(1);applySettings();try{localStorage.setItem("entropy-line-height",lHeight)}catch(e){}};\n'
        + 'cwSlider.oninput=function(){cWidth=parseInt(this.value);document.getElementById("content-width-display").textContent=cWidth+"px";applySettings();try{localStorage.setItem("entropy-content-width",cWidth)}catch(e){}};\n'

        // --- Sidebar toggle ---
        + 'var sidebar=document.getElementById("sidebar"),contentArea=document.getElementById("main-content"),sToggle=document.getElementById("sidebar-toggle");\n'
        + 'sToggle.onclick=function(){sidebarOpen=!sidebarOpen;sidebar.classList.toggle("collapsed",!sidebarOpen);sidebar.classList.toggle("open",sidebarOpen);contentArea.classList.toggle("full-width",!sidebarOpen);sToggle.setAttribute("aria-expanded",String(sidebarOpen))};\n'

        // --- Search ---
        + 'document.getElementById("nav-search").oninput=function(){var q=this.value.toLowerCase().trim();document.querySelectorAll(".nav-item").forEach(function(item){var txt=item.querySelector(".nav-item-btn").textContent.toLowerCase();item.style.display=(!q||txt.indexOf(q)>=0)?"":"none"})};\n'

        // --- Keyboard shortcuts ---
        + 'document.addEventListener("keydown",function(e){\n'
        + '  if(e.key==="Escape")document.querySelectorAll(".modal.visible").forEach(function(m){m.classList.remove("visible");m.setAttribute("aria-hidden","true")});\n'
        + '  if(e.altKey&&e.key==="ArrowLeft"){e.preventDefault();goBack()}\n'
        + '  if(e.altKey&&e.key==="Home"){e.preventDefault();goHome()}\n'
        + '  if(e.ctrlKey&&e.key==="/"){e.preventDefault();sToggle.click()}\n'
        + '  var ae=document.activeElement;if(e.key==="/"&&ae&&ae.tagName!=="INPUT"&&!ae.isContentEditable){e.preventDefault();document.getElementById("nav-search").focus()}\n'
        + '});\n'

        // --- Nav button wiring ---
        + 'document.getElementById("back-btn").onclick=goBack;\n'
        + 'document.getElementById("home-btn").onclick=goHome;\n'

        // --- File loading (load different file into standalone) ---
        + 'var fileInput=document.getElementById("file-input");\n'
        + 'if(fileInput){fileInput.onchange=function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(ev){try{var d=JSON.parse(ev.target.result);if(!d.nodes||!d.root||!d.meta){showToast("Invalid file: missing nodes, root, or meta");return}DATA=d;current=d.root;hist=[d.root];visited={};visited[d.root]=true;document.getElementById("book-title").textContent=d.meta.title;document.title=d.meta.title+" — EntropyExplainer";document.getElementById("landing").hidden=true;document.getElementById("reader").hidden=false;buildTree();render(d.root)}catch(err){showToast("Error: "+err.message)}};r.readAsText(f)}}\n'

        // --- Drag and drop ---
        + 'var dragCount=0,overlay=document.createElement("div");overlay.className="drag-overlay";overlay.innerHTML=\'<span class="drag-overlay-text">Drop .entropy.json file here</span>\';document.body.appendChild(overlay);\n'
        + 'document.addEventListener("dragenter",function(e){e.preventDefault();dragCount++;overlay.classList.add("visible")});\n'
        + 'document.addEventListener("dragleave",function(e){e.preventDefault();dragCount--;if(dragCount<=0){dragCount=0;overlay.classList.remove("visible")}});\n'
        + 'document.addEventListener("dragover",function(e){e.preventDefault()});\n'
        + 'document.addEventListener("drop",function(e){e.preventDefault();dragCount=0;overlay.classList.remove("visible");var f=e.dataTransfer.files[0];if(f&&f.name.indexOf(".json")>=0){var r=new FileReader();r.onload=function(ev){try{var d=JSON.parse(ev.target.result);if(!d.nodes||!d.root||!d.meta){showToast("Invalid file");return}DATA=d;current=d.root;hist=[d.root];visited={};visited[d.root]=true;document.getElementById("book-title").textContent=d.meta.title;document.title=d.meta.title+" — EntropyExplainer";document.getElementById("landing").hidden=true;document.getElementById("reader").hidden=false;buildTree();render(d.root)}catch(err){showToast("Error: "+err.message)}};r.readAsText(f)}else{showToast("Please drop a .entropy.json file")}});\n'

        // --- Accessibility announcer ---
        + 'var announcer=document.createElement("div");announcer.setAttribute("role","status");announcer.setAttribute("aria-live","polite");announcer.setAttribute("aria-atomic","true");announcer.className="sr-only";document.body.appendChild(announcer);\n'

        // --- Init ---
        + 'document.getElementById("book-title").textContent=DATA.meta.title;\n'
        + 'document.title=DATA.meta.title+" — EntropyExplainer";\n'
        + 'document.getElementById("landing").hidden=true;\n'
        + 'document.getElementById("reader").hidden=false;\n'
        + 'buildTree();\n'
        + 'render(DATA.root);\n';

    return { exportToHtml };
})();
