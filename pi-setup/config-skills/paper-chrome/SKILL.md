---
name: paper-chrome
description: "drive the Paper design MCP and the isolated Chrome DevTools MCP from codemode: every tool's args, response parsing and gotchas, plus recipes for pulling a site's design into a Paper brand board. load before any mcp__paper or mcp__chrome_devtools call."
---

# Paper + Chrome DevTools MCP

Both servers are **codemode-only**: call them as `tools.mcp__paper__<name>(args)` and
`tools.mcp__chrome_devtools__<name>(args)` inside a `codemode` script. They are not in the
normal tool list. Everything below was checked against the live schemas and real runs.

---

## 0. Preflight (do this every session)

1. **Paper Desktop must be running.** If a Paper call fails with `fetch failed`, the app is closed.
   Run `open -a Paper` in bash, wait about 8 s, then retry. Then call `open_file` again, because the file may not be open.
2. **Read the Paper guide once per session.** `await tools.mcp__paper__get_guide({topic:"paper-mcp-instructions"})`.
   Other topics: `"image-generation"` (needed before any `paper-gen://`), `"mobile-status-bar"`, `"figma-import"`.
3. **Codemode basics:**
   - No timers in the codemode body. `setTimeout` in the script fails with "promise that can never settle". Put waits inside Chrome's `evaluate_script`.
   - Keep state across scripts with `store(k,v)` and `load(k)`.
   - Never print whole responses. `slice` them, or parse out what you need.
   - Load big files (SVGs, fonts) with `tools.bash({cmd:"cat …"})` inside the script, so their contents never enter the chat.
4. **Error styles differ.** Paper failures **throw** (catch them with `.catch`). Chrome failures usually **return**
   `content[0].text` starting with `"Error: "` instead of throwing. Check the text.

---

## 1. Paper MCP: concepts and parsing

- IDs: file `01M5…` (26 chars), page `p-2-0`, nodes `1YK-0` / `3A7-0`. Artboard = a top-level frame.
- **Always pass `fileId`.** Tools that take `pageId` default to the page the user is *viewing*, so pass `pageId` explicitly when working on another page.
- Response shape: `content[0]` = file header `{file:{id,name}, contentHash:{tokens}}`; `content[last]` = payload JSON.
  If `contentHash.tokens` changed since you last read tokens, someone edited them; re-read with `get_tokens`.
- Parse helpers:
  ```js
  const last = r => JSON.parse(r.content.at(-1).text);
  const ids  = r => [...r.content.map(c=>c.text).join(" ").matchAll(/"id": "([^"]+)",\s*"name": "([^"]*)"/g)].map(m=>[m[1],m[2]]);
  // ids(writeHtmlResult)[0] is the file, [1] is the root element you just wrote
  ```

## 2. Paper MCP: every tool

### Files and pages
| tool | args | notes |
|---|---|---|
| `list_resources` | `{limit?}` | files and folders. `open:true` = desktop tab, `active` = foreground |
| `create_file` | `{name?, cloneFileId?}` | returns `fileId`. **Not open yet** |
| `open_file` | `{fileId, pageId?}` | required before other calls on that file. Returns basic info |
| `rename_resource` | `{resourceId, name}` | file or folder |
| `create_page` | `{fileId, name?, icon?}` | returns `pageId` (`/"pageId": "([^"]+)"/`). Icons: arrow, padlock, check, cross, info, question, design, vector, images, table, presentation, blueprint, swatches, bar-chart, line-chart, pie-chart, paper |
| `update_pages` | `{fileId, updates:[{pageId, name?, icon?}]}` | `icon:null` resets the icon. Cannot switch the user's view |
| `arrange_pages` | `{fileId, order:[pageId \| {type:"divider"}], removeDividerIds?}` | must list **every** page, or it is rejected |

### Read
| tool | args | notes |
|---|---|---|
| `get_basic_info` | `{fileId?, pageId?}` | artboards (id, name, worldX/Y, w/h), pages, fonts, tokens. Errors "Open a Paper file" if none open |
| `get_selection` | `{fileId?}` | what the user selected. Use it when they say "this" |
| `get_tree_summary` | `{fileId, nodeId, depth?}` | **cheapest way to find node ids.** `JSON.parse(r.content[1].text).summary` = indented lines like `Frame "Name" (ID) W×H`, `Text "…" (ID)`, `Rectangle "file" (ID)` (an image). `?` = size set by layout |
| `get_children` | `{fileId, nodeId}` | direct children with counts |
| `get_node_info` | `{fileId, nodeId}` | parent, children, text, position, image-generation status |
| `get_computed_styles` | `{fileId, nodeIds:[…]}` | exact CSS; image nodes show `backgroundImage:url(https://app.paper.design/file-assets/…)` |
| `get_jsx` | `{fileId, nodeId, format?:"tailwind"\|"inline-styles", includeNodeIds?, includeRootPositioning?}` | for code export use `includeNodeIds:false` |
| `get_fill_image` | `{fileId, nodeId}` | raster image data (not SVG) |
| `get_screenshot` | `{fileId, nodeId, scale?}` | `image(r.content.find(c=>c.type==="image"))`. Scale 0.4–0.5 for a whole board, 1 default, 2 for small text |
| `find_nodes` | `{fileId, textValue?, filters?:[{styleName, styleValue}], pageId?, nodeId?}` | search by copy or style. Style filters also match the same value on other properties (a `backgroundColor` filter returns `color` hits too), so check `matched` |

### Write and edit
| tool | args | notes |
|---|---|---|
| `create_artboard` | `{fileId, pageId?, name, styles:{width, height, …}}` | id = `last(r).id`. `height:"fit-content"` for long boards. Auto-placed in an empty spot |
| `write_html` | `{fileId, targetNodeId, mode:"insert-children"\|"replace", html}` | one visual group per call. Rules in §3 |
| `update_styles` | `{fileId, updates:[{nodeIds:[…], styles:{camelCase}}]}` | batch. On an artboard, `left`/`top` set its canvas position. Accepts `var(--token)` |
| `set_text_content` | `{fileId, updates:[{nodeId, textContent}]}` | Text nodes only |
| `rename_nodes` | `{fileId, updates:[{nodeId, name}]}` | layer names, 50-character max |
| `duplicate_nodes` | `{fileId, nodes:[{id, parentId?}]}` | returns `descendantIdMap`. Pair with update_styles + set_text_content to clone a card cheaply |
| `move_nodes` | `{fileId, moves:[{nodeId, before\|after:siblingId} \| {nodeId, parentId, index?}]}` | keeps ids. `parentId:"root"` = page root |
| `delete_nodes` | `{fileId, nodeIds}` | deletes descendants too. Check the parent with `get_node_info` first |
| `finish_working_on_nodes` | `{fileId, nodeIds?:[artboardIds]}` | **mandatory** at the end. Pass your artboard ids |

### Tokens and fonts
| tool | args | notes |
|---|---|---|
| `get_tokens` | `{fileId, format?:"json"\|"css"\|"tailwind", namePattern?, types?}` | |
| `create_tokens` | `{fileId, tokens:[{type, name:"--x", value, description?}]}` | types: color, fontFamily, fontSize, fontWeight, letterSpacing, lineHeight, opacity, radius, spacing, breakpoint, container. Sizes as `"8px"`, weight as a number. Alias with `var(--y)`. Order: semantic → neutral → primary → accent. Results include `result:"error"` per entry. A token *named* "error" is not an error, so confirm with `get_tokens` |
| `set_tokens` | `{fileId, tokens:[{name, newName?, value?, delete?, description?}]}` | rename, update, or delete |
| `get_font_family_info` | `{fileId, familyNames:[…]}` | **call before the first typography in a session.** Covers local + Google fonts. Payload: `JSON.parse(r.content[1].text).fontsPerFamily[name]` = `[{weight,isItalic,…}]`. Missing family = not usable (see §6) |

### Comments and export
| tool | args |
|---|---|
| `list_comment_threads` | `{fileId, status?:"open"\|"resolved"\|"all", pageId?, nodeId?, search?, limit?, …}` |
| `get_comment_thread` | `{fileId, commentThreadId}` |
| `list_comment_thread_authors` | `{fileId, pageId?}` |
| `set_comment_thread_status` | `{fileId, commentThreadId, status:"open"\|"resolved"}`. Resolve once the feedback is addressed |
| `export` | `{fileId, nodes:"nodes-with-exports-only" \| {[nodeId]:[{format:"png"\|"jpg"\|"svg"\|"pdf"\|"webp"\|"avif"\|"mp4"\|"webm", scale:"1x"…}]}, type?:"image"\|"video", pageId?}`. Don't override defaults unless asked |
| `export_combined_pdf` | `{fileId, nodeIds}`. One PDF, one page per node, ordered by canvas position |

---

## 3. Paper HTML rules (`write_html`)

Works:
- Inline `style=""` only; flexbox, `gap`, `padding`, `position:absolute`, `transform:rotate()`, `box-shadow`, `rgba`/`oklch`/`color-mix`, `overflow:hidden`, `layer-name="…"` attribute for layer names.
- **Local images:** `<img src="paper-asset:///abs/path.jpg|png|svg" style="width;height;object-fit:cover;border-radius">`. Paper **uploads the file into the file's cloud storage** (`app.paper.design/file-assets/<fileId>/…`), so deleting the local file later is safe.
- **Inline `<svg>`** becomes editable vectors. Read an SVG file with `tools.bash cat`, recolor it with `replace(/#14201E/g,…)`, and size it with `replace('<svg ','<svg width="W" height="H" ')`.
- Google + local fonts by name: `font-family:'IBM Plex Sans'` (quote multi-word names). Use px font-size, px line-height, em letter-spacing.
- Clone existing nodes: `<x-paper-clone node-id="ID" style="…"/>`.
- `paper-gen://` URLs generate AI images, **only when asked** (read the image-generation guide first).

Fails or is forbidden:
- `background-image:url(paper-asset://…)` gives **"Missing image"**. Use an absolutely-positioned `<img>`.
- `margin` (use gap, padding, or a spacer div), `display:grid`, `<table>`, `display:inline` layout.
- **Rich text.** One Text node = one style; a styled `<span>` inside text is flattened. Mixed styles in one line =
  sibling spans in `display:flex;flex-wrap:wrap;column-gap:Npx`.
- Emoji as icons. Use SVG.

Behaviour to expect:
- Screenshots **lag for images.** If a just-written group looks blank, screenshot that node again before changing anything.
- Fixed-width text inside a flex row overflows silently. Compute the free width: `contentW − fixed columns − gaps·(n−1)`.
- An n-up grid with no leftover tile needs cell width `(contentW − gap·(n−1))/n`.

---

## 4. Paper workflow and helpers

```js
const F="<fileId>", PG="<pageId>";
const W=async(id,html)=>{const r=await tools.mcp__paper__write_html({fileId:F,targetNodeId:id,mode:"insert-children",html});
  return [...r.content.map(c=>c.text).join(" ").matchAll(/"id": "([^"]+)",\s*"name": "([^"]*)"/g)].slice(1,3).map(m=>m[1]+"="+m[2]).join(", ");};
const AB=async(name,styles)=>JSON.parse((await tools.mcp__paper__create_artboard({fileId:F,pageId:PG,name,
  styles:{width:"1440px",height:"fit-content",display:"flex",flexDirection:"column",...styles}})).content.at(-1).text).id;
const tree=async(id,d=4)=>JSON.parse((await tools.mcp__paper__get_tree_summary({fileId:F,nodeId:id,depth:d})).content[1].text).summary.split("\n");
const idOf=(lines,re)=>lines.find(l=>re.test(l))?.match(/\(([^)]+)\)/)[1];
const shot=async(id,s=0.45)=>image((await tools.mcp__paper__get_screenshot({fileId:F,nodeId:id,scale:s})).content.find(c=>c.type==="image"));
```

Order of work:
1. Preflight (§0). Then `list_resources`, then `create_file` + `open_file`, or `open_file` on an existing file.
2. `get_basic_info`. **Reuse existing tokens and fonts.** Check new fonts with `get_font_family_info`.
3. For new designs, post a short brief (palette, type, direction) in chat **before** any mutation (the Paper guide requires this).
4. One `write_html` per visual group, then `shot(group)` and review:
   - overflow and overlap
   - orphan grid tiles
   - contrast (captions on dark panels must use a light tint, never `#777`)
   - alignment lanes in repeated rows (fixed-width icon and action slots)
5. Fix with targeted calls: `update_styles`, `set_text_content`, `move_nodes`. Find the id with `tree()` first. Never wipe a board to redo it.
6. Lay out artboards: `update_styles({updates:[{nodeIds:[id],styles:{left:i*1540+"px",top:"0px"}}]})`.
7. `finish_working_on_nodes({fileId, nodeIds:[all artboards]})`.
8. Verify there are no local asset references (§9).

---

## 5. Chrome DevTools MCP: every tool

**Page model:** every tool except `new_page` and `list_pages` needs `pageId:number`. Page ids **increase with each new tab**, so never assume them:
```js
await tools.mcp__chrome_devtools__new_page({url});
const lp = await tools.mcp__chrome_devtools__list_pages({});        // "## Pages\n4: about:blank\n6: Title (url) [selected]"
const pid = +[...lp.content[0].text.matchAll(/(\d+): .*<domainword>/gi)].pop()[1];
store("pid", pid);
```
The last open tab can't be closed; `about:blank` stays.

### Pages and navigation
| tool | args |
|---|---|
| `new_page` | `{url, background?, timeout?, isolatedContext?}` |
| `list_pages` | `{}` |
| `select_page` | `{pageId, bringToFront?}` |
| `navigate_page` | `{pageId, type?:"url"\|"back"\|"forward"\|"reload", url?, ignoreCache?, initScript?, timeout?}` |
| `close_page` | `{pageId}` |
| `resize_page` | `{pageId, width, height}`. Use 1440×900 for desktop measurements |
| `emulate` | `{pageId, viewport?, colorScheme?:"dark"\|"light", userAgent?, networkConditions?, cpuThrottlingRate?, geolocation?, prefersReducedMotion?, …}`. **Each call replaces all emulation**, so pass everything at once. Use `colorScheme:"dark"` to capture dark-mode tokens |
| `wait_for` | `{pageId, text:[…], timeout?}`. Returns a snapshot too |

### Inspect
| tool | args | notes |
|---|---|---|
| `evaluate_script` | `{pageId, function:"async () => {…}", args?:[uid], waitForStableDom?, format?:"function"\|"script", filePath?}` | **the workhorse.** Returns text with a json fence. Parse: `JSON.parse(t.replace(/^[\s\S]*?\`\`\`json\n/,"").replace(/\`\`\`[\s\S]*$/,""))`. The return value must be JSON-serialisable. Put sleeps inside the function |
| `take_snapshot` | `{pageId, verbose?}` | a11y tree with `uid=1_5` per element. **uids belong to the latest snapshot only**; take a new one after navigation |
| `get_css_styles` | `{pageId, uid}` | matched rules, cascade, custom props for one element. Needs a fresh uid |
| `take_screenshot` | `{pageId, fullPage?, uid?, format?:"png"\|"jpeg"\|"webp", quality?}` | viewport by default, 2× DPR. `fullPage:true` + `format:"jpeg", quality:60` is cheap for long pages. Element-only with `uid` |
| `list_network_requests` | `{pageId, resourceTypes?:["font","image","stylesheet",…], pageSize?, pageIdx?}` | the fastest way to list every font and image URL |
| `get_network_request` | `{pageId, reqid?}` | headers and body |
| `list_console_messages` / `get_console_message` | `{pageId, types?}` / `{pageId, msgid}` | |

`filePath` / `requestFilePath` / `responseFilePath` / `sourcePath` only accept paths **inside the MCP's configured workspace roots**. `/tmp` is denied with an "Access denied … not within any of the configured workspace roots" text error. Return data inline instead, and save it with bash or `tools.write`.

### Interact (uids from `take_snapshot`)
`click {pageId, uid, dblClick?}` · `hover {pageId, uid}` · `fill {pageId, uid, value}` ·
`fill_form {pageId, elements:[{uid,value}]}` (prefer it for forms) · `type_text {pageId, text, submitKey?}` ·
`press_key {pageId, key}` (e.g. `"Escape"`, `"Control+A"`) · `drag {pageId, from_uid, to_uid}` ·
`upload_file {pageId, uid, filePaths}` · `handle_dialog {pageId, action:"accept"\|"dismiss", promptText?}`.
Pass `includeSnapshot:true` to get the new state in the same call. Hover-only menus: `hover` the trigger, then read the DOM with `evaluate_script`.

### Audit and record
`lighthouse_audit {pageId, device?, mode?}` (a11y, SEO, best practices; not performance) ·
`performance_start_trace {pageId, reload?, autoStop?}` → `performance_stop_trace` → `performance_analyze_insight {pageId, insightSetId, insightName}` ·
`take_heapsnapshot {pageId, filePath}` · `screencast_start/stop {pageId}`.

**Built-in alternative:** the normal `screenshot` tool with `target:"https://url"` renders a whole page in a fresh
logged-out browser as 2000px slices. It shows layout well but costs about 25–35k tokens. Use it **once per site**; use `take_screenshot` for the rest.

---

## 6. Website design extraction (Chrome)

Remove overlays first, inside the same evaluate:
`document.querySelectorAll('#CybotCookiebotDialog,#CybotCookiebotDialogBodyUnderlay,[role=dialog],[class*=cookie]').forEach(e=>e.remove())`.
Some sites throw a bot challenge in headless mode. The page still renders, so just remove the dialog.

**A. Tokens and usage census** (run first on home):
```js
async () => { await new Promise(r=>setTimeout(r,2500));
 const vars={}; for(const sh of document.styleSheets){try{for(const r of sh.cssRules){const s=r.selectorText||'';
  if(/:root|^html$|\.dark|^body$/.test(s)) for(const p of r.style) if(p.startsWith('--')) vars[s.slice(0,14)+' '+p]=r.style.getPropertyValue(p).trim().slice(0,90);}}catch(e){}}
 const fonts={},colors={},bgs={},radii={},shadows={},sizes={};
 document.querySelectorAll('body *').forEach(el=>{const c=getComputedStyle(el);
  const k=c.fontFamily.slice(0,70)+' | '+c.fontWeight; fonts[k]=(fonts[k]||0)+1; colors[c.color]=(colors[c.color]||0)+1;
  if(c.backgroundColor!=='rgba(0, 0, 0, 0)') bgs[c.backgroundColor]=(bgs[c.backgroundColor]||0)+1;
  if(c.backgroundImage.includes('gradient')) bgs['G:'+c.backgroundImage.slice(0,200)]=1;
  if(c.borderRadius!=='0px') radii[c.borderRadius]=(radii[c.borderRadius]||0)+1;
  if(c.boxShadow!=='none') shadows[c.boxShadow.slice(0,140)]=1;
  if([...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())){const s=c.fontFamily.split(',')[0]+' '+c.fontSize+'/'+c.lineHeight+' w'+c.fontWeight+' ls'+c.letterSpacing+' '+c.textTransform+(c.fontStyle==='italic'?' ital':'');
   (sizes[s]=sizes[s]||[]).length<2 && sizes[s].push(el.textContent.trim().slice(0,40));}});
 return {title:document.title,vars,fonts,colors,bgs,radii,shadows,sizes,fontFaces:[...new Set([...document.fonts].map(f=>f.family+' '+f.weight+' '+f.style))]}; }
```
`sizes` is the real type scale with sample text. Ignore cookie-widget fonts (generic `sans-serif`). Output can exceed 25k chars, so slice it, or return sections in separate calls.

**B. Named Tailwind palette** (sites with few CSS vars). Set `PFX` to the class prefix you saw, e.g. `pangram`:
```js
() => { const o={}; for(const sh of document.styleSheets){try{for(const r of sh.cssRules){const m=(r.selectorText||'').match(/(?:bg|text|border|fill)-(PFX-[a-z0-9-]+)/);
 if(m){const s=r.style; const v=s.backgroundColor||s.color||s.borderColor||s.fill; if(v) o[m[1]]=v;}}}catch(e){}} return o; }
```
**C. Font files:** loop `CSSFontFaceRule` and return `font-family | src | weight style` (or use `list_network_requests` with `resourceTypes:["font"]`).
**D. Motion:** count `rule.style.transitionTimingFunction` and `transitionDuration`. Grep vars for `--ease`, `--duration`, `--shadow`, `--radius`, `--text-`, `--tracking`, `--leading`, `--breakpoint`, `--container`. A `linear(0, …, 1.1084, …)` value is a spring; plot its stops.
**E. Assets:** `[...document.images].map(i=>i.alt+' :: '+(i.currentSrc||i.src))`. Decode `/_next/image?url=` with
`new URL(src).searchParams.get('url')`. Look for a brand folder (`/brand/`, `…/web/brand/`) holding logos, mascot, icons, illustrations.
**F. Component specs by visible text.** Match **leaf** elements, then read the parent too (wrappers carry bg and padding, and inner `<p>` carries color). Compare lowercase, because `text-transform:capitalize` changes what you see:
```js
() => { const pick=el=>{if(!el)return null;const c=getComputedStyle(el),b=el.getBoundingClientRect();
 return {tag:el.tagName,cls:(typeof el.className==='string'?el.className:'').slice(0,100),h:Math.round(b.height),w:Math.round(b.width),pad:c.padding,bg:c.backgroundColor,color:c.color,border:c.border,radius:c.borderRadius,font:c.fontFamily.split(',')[0]+' '+c.fontSize+'/'+c.lineHeight+' '+c.fontWeight,ls:c.letterSpacing,tf:c.textTransform,shadow:c.boxShadow.slice(0,80)};};
 const find=t=>[...document.querySelectorAll('a,button,span,div,p')].filter(e=>e.children.length===0&&e.textContent.trim().toLowerCase()===t);
 const o={}; for(const t of ['start for free','login','learn more']){const e=find(t)[0]; o[t]=[pick(e),pick(e?.parentElement)];} return o; }
```
**G. Icons:**
- `viewBox="0 0 256 256"` with paths full of `6,6` arcs is **Phosphor Light**. Originals: `https://unpkg.com/@phosphor-icons/core@2.1.1/assets/light/<name>-light.svg`.
- `svg-inline--fa fa-x` is Font Awesome. Read `viewBox` + `path d` from the DOM.
- Custom glyphs: take `outerHTML`.

**H. Routes:** take them from `footer a[href]`. Never guess (guessed routes 404).
**I. Trust the computed style over your eyes.** A stat that *looks* sans can compute to a serif. Check before writing it down.

---

## 7. Assets and fonts (bash)

```bash
mkdir -p /tmp/<brand> && cd /tmp/<brand>
curl -s -A "Mozilla/5.0" -o logo.svg "<url>"; file -b logo.svg   # tiny/XML/HTML result = 404 page, not the asset
sips -s format jpeg x.webp --out x.jpg          # webp → jpg before placing
sips -g pixelWidth -g pixelHeight x.jpg         # aspect ratio before placing
grep -o 'fill="[^"]*"' logo.svg | sort | uniq -c # recolourable fills
```
- **Missing logo variants:** derive them, don't fetch. Light = swap the ink hex. Mark only = take the first N `<path>`s and compute the viewBox from the min/max of the path numbers (+ padding). Mono = replace every fill.
- **Identify an anonymous web font:** `python3 -c "from fontTools.ttLib import TTFont as T;import glob;[print(f,T(f)['name'].getDebugName(4),T(f)['OS/2'].usWeightClass) for f in glob.glob('*.woff2')]"`
- **Font missing in Paper** (commercial or self-hosted). **Never install it on the Mac.** Render outlines with the bundled script
  (needs fontTools, which is installed; it does its own GPOS kerning, so uharfbuzz isn't needed):
  ```js
  await tools.write({path:"/tmp/<brand>/jobs.json", content: JSON.stringify([
    {name:"h1-a", text:"An AI detector", font:"/tmp/<brand>/x.woff2", size:84, tracking:-0.025, lineHeight:91, color:"#14201E"}])});
  const out=(await tools.bash({cmd:"python3 ~/.config/agents/skills/paper-chrome/scripts/render_font.py /tmp/<brand>/jobs.json /tmp/<brand>/out",timeout:120})).output;
  store("sizes", out);   // [{name,w,h}] → <img src="paper-asset:///tmp/<brand>/out/h1-a.svg" style="width:Wpx;height:Hpx">
  ```
  - One SVG per line. Batch every line for a board into one job file.
  - To shrink a line, scale width and height by the same factor.
  - Tell the user these are non-editable outlines. The options are to buy and install the font (then swap to live text) or use a named free stand-in.

---

## 8. Brand board recipe (site → Paper)

1. **Research:** census (6A) on home, then palette (6B), font files (6C), motion (6D), assets (6E), component specs (6F), icons (6G). One built-in full-page `screenshot`, then 3–4 inner pages with `take_screenshot` (routes from 6H).
2. **Assets and fonts:** download to `/tmp/<brand>/`, check Paper fonts, render missing display fonts.
3. **Paper:** create a new file (or a new page per brand, and rename the pages). Add brand tokens; prefix them (`--brand-*`) when several brands share a file.
4. **Artboards** (1440 wide, `fit-content`, padding about `96px 84px 112px`, gap 64–72). Every board header is in the brand's own style: eyebrow label, a two-line display headline in the brand voice, a body paragraph on the right, and a bottom rule.

| # | board | must show |
|---|---|---|
| 00 | Cover | logo, the real hero line, hero art, key stats, primary colors |
| 01 | Logo | lockup, mark, 6 surfaces, construction + spec table, 4 misuses |
| 02 | Color | core, neutrals, accent families + roles, ramps, semantic/status, product mapping, dark mode, page section rhythm |
| 03 | Type | family cards, all weights, glyph sets, measured scale, emphasis rule, pairing |
| 04 | Icons & ornaments | product icons, named UI set, signature glyphs, doodles/ornaments, social |
| 05 | Mascot / illustration | character, tones, poses, scenes, numbered rules |
| 06 | Photography / product imagery | real collage, overlays, portraits, do/don't |
| 07 | Components | nav, menus, every button (light + dark, spec caption under each), tags, tabs, signature component, cards, FAQ, testimonials, pricing, footer. Split into 07/07b if large |
| 08 | Layout / shape / motion | grid + breakpoints, radius scale + usage, elevation, curves drawn + durations |
| 09 | Voice | tagline, positioning, mission (quoted), pillars with real quotes, headline formula, say/not-that, lexicon, proof points, client logos |

Add a board for a domain-specific visual language when the brand has one (e.g. verdict gauges and highlights for an AI detector).
Drawing recipes:
- Bezier card: `M20 120 C ${20+x1*120} ${120-y1*100}, ${20+x2*120} ${120-y2*100}, 140 20` in a 160×140 svg.
- Spring: a polyline of the `linear()` stops.
- Gauge: `A R R 0 0 1` arcs from angle `π(1−f0)` to `π(1−f1)`.

**Truth rule:** every hex, size and quote comes from the site. Anything inferred (curve usage, role names) is labelled in the final message. Never invent a swatch to fill a row.

---

## 9. Token budget and final checks

- One codemode script = one visual group (write, plus an optional screenshot). Batch font renders and tokens.
- Screenshots: whole board at scale 0.4–0.5, detail at 1. Session images add up (about 32 MB request cap), so don't re-shoot needlessly.
- Final check: no local references remain (local must be 0):
  ```js
  let cloud=0, local=0; for (const b of artboards){ const j=(await tools.mcp__paper__get_jsx({fileId:F,nodeId:b})).content.map(c=>c.text).join("");
    cloud+=(j.match(/app\.paper\.design\/file-assets/g)||[]).length; local+=(j.match(/paper-asset:|\/tmp\//g)||[]).length; }
  ```
- Close Chrome tabs you opened. Call `finish_working_on_nodes`.
- The final message should include a table of what is on each board, what was rendered as outlines, what is inferred, and what was unavailable.
