"""Apply the "drafting sheet" UI system to an arabic-transcribe HTML player.

The pipeline (run_pipeline.py) emits a functional but plain player. This script
retrofits the skill's house UI onto it — warm paper + 40 px grid, hard ink rules,
mono technical labels, Archivo/Cairo type, and a key-moments rail on the audio
timeline. It is idempotent: run it again (after add_summary.py, or with new
moments) and it rebuilds the chrome in place without touching transcript text.

Usage:
    py -3.12 apply_ui.py "<base or html>" \
        --title "تفريغ|المكالمة." \
        --kicker "RECORDING 04 — TRANSCRIPT INDEX" \
        --note "..." \
        --project "MEETING NOTES" --date "01·11·2026" \
        --moments moments.json \
        [--summary "summary.md"] [--no-fonts]

<base> is the transcript path without the " - arabic transcript.*" suffix;
a direct .html path is also accepted. Key moments come from --moments (JSON:
[{"t": 0, "label": "..."}] — t in seconds or "mm:ss") or, when omitted, are
extracted from the summary markdown's "(mm:ss–mm:ss)" section headings.

The UI system lives in references/ui-system.md; the fonts are shipped in
assets/fonts and inlined as base64 so the file stays offline-capable.
"""
import argparse
import base64
import json
import os
import re
import sys
from html import unescape

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
FONTS = os.path.join(SKILL, "assets", "fonts")

# Speaker colours are the only per-clause marker in the transcript, so they have
# to survive being printed on warm paper *and* be told apart at a glance. The
# first five are the ones a normal recording uses: blue, teal, purple, magenta,
# amber. Every one of them clears 4.5:1 against the sheet (#f7f6f2).
PALETTE = {
    "A": "#1d4ed8",
    "B": "#0f766e",
    "C": "#7e22ce",
    "D": "#be185d",
    "E": "#a16207",
    "F": "#15803d",
    "G": "#0e7490",
    "H": "#475569",
}
THEME_ID = "ui-theme"
PLAYER_JS_ID = "ui-player-js"
MOMENTS_ID = "ui-moments"
NAMES_ID = "ui-speaker-names"
HEAD_ID = "ui-transcript-head"
FOOT_ID = "ui-colophon"


def die(msg):
    print("ERROR:", msg, flush=True)
    sys.exit(1)


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def num(n):
    return f"{n:,}"


def ts(sec):
    sec = max(0, int(round(float(sec))))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def sec_of(stamp):
    parts = [int(p) for p in str(stamp).split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def stamp_of(sec):
    sec = max(0, int(round(float(sec))))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# ---------------------------------------------------------------- fonts
def fonts_css(embed=True):
    if not embed:
        return ""
    files = [
        ("Archivo", "archivo-latin-wght.woff2", "100 900", None),
        ("JetBrains Mono", "jetbrains-mono-latin-wght.woff2", "100 800", None),
        ("Cairo", "cairo-arabic.woff2", "200 1000",
         "U+0600-06FF,U+0750-077F,U+0870-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,"
         "U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC,U+102E0-102FB,"
         "U+10E60-10E7E,U+10EC2-10EC7,U+10EC9-10EEE,U+10EF0-10EFF,U+1EE00-1EE03,"
         "U+1EE05-1EE1F,U+1EE21-1EE22,U+1EE24,U+1EE27,U+1EE29-1EE32,U+1EE34-1EE37,"
         "U+1EE39,U+1EE3B,U+1EE42,U+1EE47,U+1EE49,U+1EE4B,U+1EE4D-1EE4F,U+1EE51-1EE52,"
         "U+1EE54,U+1EE57,U+1EE59,U+1EE5B,U+1EE5D,U+1EE5F,U+1EE61-1EE62,U+1EE64,"
         "U+1EE67-1EE6A,U+1EE6C-1EE72,U+1EE74-1EE77,U+1EE79-1EE7C,U+1EE7E,U+1EE80-1EE89,"
         "U+1EE8B-1EE9B,U+1EEA1-1EEA3,U+1EEA5-1EEA9,U+1EEAB-1EEBB,U+1EEF0-1EEF1"),
        ("Cairo", "cairo-latin.woff2", "200 1000",
         "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,"
         "U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"),
    ]
    out = []
    for family, name, weight, urange in files:
        path = os.path.join(FONTS, name)
        if not os.path.exists(path):
            die(f"font not found: {path}")
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        rng = f"unicode-range:{urange};" if urange else ""
        out.append(
            f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weight};'
            f'font-display:swap;src:url(data:font/woff2;base64,{b64}) format("woff2");{rng}}}'
        )
    return "\n".join(out)


# ---------------------------------------------------------------- css
CSS = r"""
:root{
  --paper:#eceae4; --sheet:#f7f6f2; --ink:#141414; --body:#3a3833;
  --muted:#5e5b55; --rule:#8a867d;
  --accent:#c8321e; --accent-dark:#a02614;
  --hair:rgba(20,20,20,.24); --hair-soft:rgba(20,20,20,.12); --grid:rgba(20,20,20,.055);
  --sans:"Archivo","Cairo","Helvetica Neue",Helvetica,Arial,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;
  --gut:clamp(20px,4vw,40px); --maxw:1180px; --ease:cubic-bezier(.2,.7,.2,1);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{
  margin:0;background-color:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased;
  background-image:linear-gradient(var(--grid) 1px,transparent 0),
                   linear-gradient(90deg,var(--grid) 1px,transparent 0);
  background-size:40px 40px;
}
h1,h2,h3,p,ul,ol,dl,dd,dt,figure{margin:0}
::selection{background:var(--accent);color:#fff}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.pp:focus-visible,.rate:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.tech{font-family:var(--mono);font-weight:500;font-size:11px;line-height:1.4;
      letter-spacing:.08em;text-transform:uppercase}
.tech b{font-weight:700}
.muted{color:var(--muted)} .accent{color:var(--accent)}

/* ---------------------------------------------------------------- title block */
.titleblock{display:flex;align-items:stretch;justify-content:space-between;flex-wrap:wrap;
  background:var(--paper);border-bottom:2px solid var(--ink);position:relative;z-index:2}
.tb-brand{display:flex;align-items:center;gap:14px;padding:14px var(--gut);
  border-inline-end:1px solid var(--ink)}
.tb-brand svg{width:30px;height:36px;flex:none;color:var(--ink)}
.logo-draw path{stroke-dasharray:1;stroke-dashoffset:1px;
  animation:draw .8s cubic-bezier(.5,0,.2,1) forwards;animation-delay:calc(.1s + var(--i) * .2s)}
.logo-draw path.fill-accent{fill-opacity:0;animation:draw .8s cubic-bezier(.5,0,.2,1) forwards,
  fold-in .4s ease-out .7s forwards;animation-delay:calc(.1s + var(--i) * .2s)}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fold-in{to{fill-opacity:1}}
.tb-wordmark{font-family:var(--mono);font-size:12.5px;font-weight:700;letter-spacing:.09em;
  text-transform:uppercase;line-height:1.2}
.tb-wordmark small{display:block;font-size:9.5px;font-weight:500;letter-spacing:.16em;color:var(--muted)}
html[lang="ar"] .tb-wordmark{font-family:var(--sans);font-size:22px;letter-spacing:0;text-transform:none}
html[lang="ar"] .tb-wordmark small{font-family:var(--sans);font-size:10.5px;letter-spacing:0;text-transform:none}
html[lang="ar"] .tech,html[lang="ar"] .tb-cell dt,html[lang="ar"] .facts dt{letter-spacing:0;text-transform:none}
html[lang="ar"] .tb-cell dt,html[lang="ar"] .facts dt{font-family:var(--sans);font-size:11px;font-weight:700}
.tb-cells{display:flex;flex-wrap:wrap;align-items:stretch}
.tb-cell{display:flex;flex-direction:column;justify-content:center;gap:3px;
  padding:9px 18px;border-inline-start:1px solid var(--ink);min-width:104px}
.tb-cell:first-child{border-inline-start:0}
.tb-cell dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.tb-cell dd{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;margin:0;color:var(--ink);white-space:nowrap}

/* ---------------------------------------------------------------- hero */
.hero{max-width:var(--maxw);margin:0 auto;padding:clamp(26px,4.6vw,58px) var(--gut) clamp(18px,2.6vw,32px);
  display:grid;grid-template-columns:minmax(0,1fr);gap:clamp(22px,3.4vw,44px)}
@media (min-width:900px){.hero{grid-template-columns:minmax(0,1.6fr) minmax(0,.85fr);align-items:end}}
.hero-kicker{margin-bottom:14px;text-align:right}
.hero h1{font-size:clamp(44px,8.6vw,118px);line-height:.94;font-weight:900;letter-spacing:0;
  text-wrap:balance;overflow-wrap:anywhere}
.hero h1 .dot{color:var(--accent)}
.hero .lede{max-width:58ch;margin-top:16px;font-size:clamp(15px,1.35vw,18px);
  line-height:1.85;color:var(--body)}
.facts{border:1px solid var(--ink);background:var(--paper)}
.facts>div{display:flex;align-items:baseline;justify-content:space-between;gap:14px;
  padding:9px 13px;border-bottom:1px solid var(--ink)}
.facts>div:last-child{border-bottom:0}
.facts dt{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);flex:none}
.facts dd{margin:0;font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;text-align:end;
  overflow:hidden;text-overflow:ellipsis}
.speakers{display:flex;gap:7px;align-items:center;flex-wrap:wrap;justify-content:flex-start;
  min-width:0;flex:1 1 auto}
.sp{display:inline-flex;align-items:center;gap:4px;font-family:var(--mono);font-size:10px;letter-spacing:.06em}
.sp i{width:9px;height:9px;display:inline-block;background:var(--c)}

/* speaker strip: pinned with the player, names are editable in place */
.pb-speakers{display:flex;align-items:flex-start;gap:10px;margin-top:7px;padding-top:7px;
  border-top:1px solid var(--hair-soft)}
.pb-speakers__label{flex:none;color:var(--muted);padding-top:5px}
.spk{display:inline-flex;align-items:center;gap:7px;min-height:30px;max-width:100%;
  padding:3px 9px 3px 7px;border:1px solid var(--hair);background:var(--sheet);
  font-family:var(--sans);font-size:12.5px;line-height:1.45;font-weight:600;color:var(--ink);
  cursor:text;border-radius:0;
  transition:border-color .16s var(--ease),background .16s var(--ease)}
.spk:hover{border-color:var(--c);background:#fff}
.spk:focus-visible{outline:2px solid var(--c);outline-offset:2px}
.spk:hover .spk__pen,.spk:focus-visible .spk__pen{opacity:1}
.spk__dot{width:10px;height:10px;flex:none;background:var(--c)}
/* One line per chip: a long name truncates with the full value on hover, and
   the strip wraps so its neighbours move instead of the text colliding. */
.spk__name{min-width:0;max-width:22ch;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.spk__pen{width:12px;height:12px;flex:none;opacity:0;color:var(--c);transition:opacity .16s var(--ease)}
.spk.is-editing{border-color:var(--c);background:#fff;padding-inline-end:7px}
.spk__input{width:14ch;max-width:100%;min-width:5ch;border:0;background:transparent;padding:0;
  font:inherit;color:inherit;outline:0}
.spk.is-editing .spk__pen,.spk.is-editing .spk__dot{display:none}
.spk__hint{flex:none;color:var(--muted);padding-top:8px}
@media (pointer:coarse){
  .spk{min-height:44px;padding-inline:12px}
  .spk__pen{opacity:1}
}
@media (max-width:640px){
  .pb-speakers{flex-wrap:wrap;gap:6px}
  .pb-speakers__label{width:100%;padding-top:0}
  .spk__hint{display:none}
}

/* ---------------------------------------------------------------- player */
.playerbar{position:sticky;top:0;z-index:30;background:var(--paper);
  border-block:2px solid var(--ink)}
.pb-inner{max-width:var(--maxw);margin:0 auto;padding:9px var(--gut) 10px}
.pb-top{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:1px}
.pb-src{max-width:44ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);
  text-transform:none;letter-spacing:.02em}
.transport{display:flex;align-items:center;gap:12px}
.pp{width:46px;height:46px;flex:none;border:2px solid var(--ink);background:var(--ink);color:var(--paper);
  display:grid;place-items:center;padding:0;cursor:pointer;border-radius:0;
  transition:background .16s var(--ease),border-color .16s var(--ease),color .16s var(--ease)}
.pp:hover{background:var(--accent);border-color:var(--accent);color:#fff}
.pp svg{width:18px;height:18px;fill:currentColor;display:block}
.pp .i-pause{display:none}
.pp.playing .i-play{display:none}
.pp.playing .i-pause{display:block}
.time{display:flex;align-items:baseline;gap:5px;min-width:112px;font-family:var(--mono);
  font-size:12.5px;letter-spacing:.02em;font-variant-numeric:tabular-nums;white-space:nowrap}
.time .sep{color:var(--rule)}
.rate{height:30px;min-width:46px;flex:none;border:1px solid var(--ink);background:var(--sheet);
  font-family:var(--mono);font-size:11px;letter-spacing:.05em;color:var(--ink);cursor:pointer;
  border-radius:0;transition:background .16s var(--ease),color .16s var(--ease)}
.rate:hover{background:var(--ink);color:var(--paper)}
.railwrap{flex:1 1 auto;min-width:0}
.rail{position:relative;height:46px;cursor:pointer;touch-action:none;user-select:none}
.rail-line,.rail-fill{position:absolute;left:0;right:0;top:25px;height:2px}
.rail-line{background:var(--hair)}
.rail-fill{background:var(--accent);width:0}
.rail-head{position:absolute;top:19px;left:0;width:2px;height:15px;background:var(--ink);
  pointer-events:none;transform:translateX(-1px)}
.mk{position:absolute;top:0;left:var(--p);transform:translateX(-50%);width:26px;height:46px;
  padding:0;border:0;background:none;cursor:pointer;color:var(--muted)}
.mk::before{content:"";position:absolute;left:50%;top:23px;width:2px;height:7px;background:var(--ink);
  transform:translateX(-50%);transition:height .16s var(--ease),background .16s var(--ease)}
.mk:hover::before,.mk:focus-visible::before{height:13px;background:var(--accent)}
.mk.past::before{background:var(--accent)}
.mk.on::before{height:15px;background:var(--accent)}
.mk .n{position:absolute;top:2px;left:50%;transform:translateX(-50%);font-family:var(--mono);
  font-size:9px;letter-spacing:.06em;white-space:nowrap;color:var(--muted)}
.mk.low .n{top:12px}
.mk.past .n{color:var(--body)}
.mk.on .n{color:var(--accent);font-weight:700}
.mk:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.nowline{display:flex;align-items:baseline;gap:9px;margin-top:-2px;min-height:17px;
  white-space:nowrap;overflow:hidden}
.nowlabel{flex:1 1 auto;min-width:0;font-size:13.5px;color:var(--body);overflow:hidden;text-overflow:ellipsis}
.nowline .tech{flex:none}
.rail-foot{display:flex;justify-content:space-between;margin-top:1px;color:var(--muted)}

/* ---------------------------------------------------------------- summary */
.summary{max-width:min(1000px,calc(100% - 2 * var(--gut)));
  margin:clamp(22px,3vw,38px) auto 0;direction:rtl;
  padding:clamp(20px,2.8vw,34px);background:var(--sheet);border:2px solid var(--ink)}
.summary::before{content:"03 / الملخص";display:block;font-family:var(--mono);font-size:11px;
  font-weight:500;letter-spacing:0;color:var(--muted);margin-bottom:9px;
  direction:rtl;unicode-bidi:plaintext;text-align:right}
body.summary-first .summary::before{content:"02 / الملخص"}
.summary h2{font-size:clamp(24px,3vw,34px);font-weight:900;line-height:1.2;letter-spacing:0;
  padding-bottom:13px;border-bottom:1px solid var(--ink);margin-bottom:4px}
.summary p,.summary li{font-size:clamp(16px,1.3vw,18.5px);line-height:2.05;color:var(--body)}
.summary p{margin-top:13px}
.summary strong{color:var(--ink);font-weight:700}
.summary ul{margin:9px 0 0;padding-inline-start:20px}
.summary ul li{margin:2px 0}
.summary ul li::marker{color:var(--accent)}
.chk{display:flex;align-items:flex-start;gap:10px;padding:9px 0;cursor:pointer;
  border-bottom:1px solid var(--hair-soft);font-size:clamp(16px,1.3vw,18.5px)}
.chk:last-of-type{border-bottom:0}
.chk span{line-height:1.85}
.chk bdi{flex:1;line-height:1.85;text-align:right}
.chk input{appearance:none;-webkit-appearance:none;flex:none;width:17px;height:17px;margin:5px 0 0;
  border:1.5px solid var(--ink);background:var(--paper);position:relative;cursor:pointer;
  border-radius:0;transition:background .15s var(--ease),border-color .15s var(--ease)}
.chk input:checked{background:var(--accent);border-color:var(--accent)}
.chk input:checked::after{content:"";position:absolute;left:4.5px;top:1.5px;width:4.5px;height:9px;
  border-right:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(40deg)}
.chk input:checked + span{text-decoration:line-through;color:var(--muted)}
.chk input:checked + bdi{text-decoration:line-through;color:var(--muted)}

/* ---------------------------------------------------------------- transcript */
.sec-head{max-width:var(--maxw);margin:clamp(36px,5.5vw,68px) auto 0;padding:0 var(--gut)}
.sec-head h2{font-size:clamp(30px,4.6vw,52px);font-weight:900;line-height:1.05;letter-spacing:0;margin-top:5px}
.sec-head::after{content:"";display:block;height:2px;background:var(--ink);margin-top:16px}
main{max-width:var(--maxw);margin:0 auto;padding:0 var(--gut) clamp(32px,5vw,64px);counter-reset:win}
.win{display:grid;grid-template-columns:108px minmax(0,1fr);gap:clamp(10px,2vw,22px);
  padding:13px 0;border-bottom:1px solid var(--hair-soft);position:relative;counter-increment:win;
  /* the player + speaker strip are sticky: keep a scrolled line clear of them */
  scroll-margin-top:180px}
.win:first-child{border-top:1px solid var(--hair-soft)}
.win.on{background:rgba(20,20,20,.035)}
.win.on::before{content:"";position:absolute;inset-block:0;inset-inline-start:0;width:2px;background:var(--accent)}
.meta{font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;line-height:1.7;color:var(--muted);
  padding-top:5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.meta::before{content:"W" counter(win,decimal-leading-zero);display:block;font-size:9.5px;color:var(--rule)}
.txt{font-size:clamp(16px,1.35vw,19.5px);line-height:2.1;color:var(--body);text-wrap:pretty}
.chunk{cursor:pointer;padding:1px 1px;border-bottom:2px solid var(--sp);border-radius:0;unicode-bidi:isolate;
  transition:background .15s var(--ease);-webkit-box-decoration-break:clone;box-decoration-break:clone}
.chunk:hover{background:rgba(20,20,20,.06)}
.chunk.on{background:rgba(200,50,30,.11);box-shadow:inset 0 -2px 0 var(--accent)}
@supports (color:color-mix(in srgb,red,blue)){
  .chunk{border-bottom-color:color-mix(in srgb,var(--sp) 55%,transparent)}
}
.sA{--sp:#2f5d3a} .sB{--sp:#2c5a7d} .sC{--sp:#964a1f} .sD{--sp:#5f4376} .sE{--sp:#6f5c1c}

/* ---------------------------------------------------------------- footer */
.colophon{max-width:var(--maxw);margin:0 auto;border-top:2px solid var(--ink);
  padding:14px var(--gut) 30px;display:flex;flex-wrap:wrap;gap:8px 26px;align-items:center;
  justify-content:space-between;color:var(--body)}
.colophon span,.colophon a{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}
html[lang="ar"] .colophon span,html[lang="ar"] .colophon a{letter-spacing:0;text-transform:none}
.colophon a{color:var(--ink);text-underline-offset:4px}

/* ---------------------------------------------------------------- motion */
@media (prefers-reduced-motion:no-preference){
  .tb-brand,.tb-cells,.hero-kicker,.hero h1,.hero .lede,.facts{
    animation:rise .7s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--d,0s)}
  .hero h1{--d:.06s} .hero .lede{--d:.18s} .facts{--d:.26s}
  .draw-rule{position:relative}
  .draw-rule::after{content:"";position:absolute;inset:auto 0 0;height:2px;background:var(--ink);
    transform-origin:0;animation:rule 1.1s cubic-bezier(.5,0,.2,1) .25s both}
}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@keyframes rule{from{transform:scaleX(0)}}

/* ---------------------------------------------------------------- responsive */
@media (max-width:720px){
  .tb-brand{border-inline-end:0;width:100%}
  .tb-cells{width:100%;border-top:1px solid var(--ink)}
  .tb-cell{flex:1 1 50%;border-inline-start:0;border-inline-end:1px solid var(--ink);
    border-bottom:1px solid var(--ink);min-width:0;padding:7px 14px}
  .tb-cell:nth-child(2n){border-inline-end:0}
  .tb-cell:last-child,.tb-cell:nth-last-child(2){border-bottom:0}
  .win{grid-template-columns:1fr;gap:3px;padding:11px 0 13px}
  .meta{display:flex;gap:9px;align-items:baseline;padding-top:0}
  .meta::before{display:inline}
  .pb-top{display:none}
  .transport{flex-wrap:wrap;row-gap:6px}
  .railwrap{order:3;flex:1 0 100%}
  .time{flex:1 1 auto;justify-content:flex-end;min-width:0;font-size:12px}
  .pp{width:44px;height:44px}
  .rate{display:none}
  .mk .n{display:none}
  .nowlabel{font-size:12.5px}
  .rail-foot{display:none}
}
@media print{
  .playerbar{position:static;background:var(--paper)}
  .pp,.rate,.rail,.mk{display:none}
}
"""


# ---------------------------------------------------------------- helpers
def extract_info(html, prologue):
    """Read what we need to rebuild the chrome from the pipeline's own output."""
    src = ""
    m = re.search(r'<audio[^>]*?src="([^"]*)"', prologue)
    if m:
        src = m.group(1)

    # on a re-run our own data-* attributes are the source of truth
    saved_src = re.search(r'data-source="([^"]*)"', prologue)
    saved_start = re.search(r'data-start="([\d.]+)"', prologue)
    saved_end = re.search(r'data-end="([\d.]+)"', prologue)
    saved_title = re.search(r'data-recording="([^"]*)"', prologue)

    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", prologue, re.S)
    title = re.sub(r"<[^>]+>", "", h1.group(1)).strip() if h1 else ""
    if not title:
        t = re.search(r"<title>(.*?)</title>", html, re.S)
        title = re.sub(r"\s*[—-]\s*(?:transcript|تفريغ).*$", "", t.group(1)).strip() if t else "تفريغ"
    if saved_title:
        title = unescape(saved_title.group(1))

    sub = re.search(r'<div class="sub"[^>]*>(.*?)</div>', prologue, re.S)
    sub = re.sub(r"<[^>]+>", "", sub.group(1)).strip() if sub else ""
    sub = unescape(sub)
    sub = sub.replace("\u2013", "-").replace("\u2014", "-")

    speech = re.search(r"(?:speech|الكلام)\s+([\d:]+)\s*-\s*([\d:]+)", sub)
    a = sec_of(speech.group(1)) if speech else 0
    b = sec_of(speech.group(2)) if speech else 0
    if not speech:
        cell = re.search(r"<dt>Speech</dt><dd>([\d:]+)[–-]([\d:]+)</dd>", prologue)
        if cell:
            a, b = sec_of(cell.group(1)), sec_of(cell.group(2))
    if not b:
        # recover the speech end from any timestamp range in the document
        # (the summary's section headings are the most reliable source)
        ranges = [sec_of(m.group(2)) for m in
                  re.finditer(r"(\d{1,3}:\d{2})\s*[–—-]\s*(\d{1,3}:\d{2})", html)]
        if ranges:
            b = max(ranges)
            a = a or 0
    if not a:
        first = re.search(r'class="chunk s[A-Z]" data-start="([\d.]+)"', html)
        if first:
            a = float(first.group(1))
    if saved_start and float(saved_start.group(1)) > 0:
        a = float(saved_start.group(1))
    if saved_end and float(saved_end.group(1)) > 0:
        b = float(saved_end.group(1))

    speakers = re.findall(r'data-spk="([A-Z])"', prologue)
    if not speakers:
        for sm in re.finditer(r'Speaker ([A-Z])', prologue):
            if sm.group(1) not in speakers:
                speakers.append(sm.group(1))
    if not speakers:
        speakers = re.findall(r'<span class="sp"[^>]*><i></i>([A-Z])</span>', prologue)

    wins = len(re.findall(r'<div class="win"', html))
    chunks = len(re.findall(r'class="chunk s', html))
    return {"src": unescape(saved_src.group(1)) if saved_src else src, "title": title, "sub": sub,
            "start": a, "end": b, "speakers": speakers, "wins": wins, "chunks": chunks}


def parse_moments_file(path):
    with open(path, encoding="utf-8-sig") as f:
        raw = json.load(f)
    out = []
    for item in raw:
        t = item.get("t", item.get("time", 0))
        if isinstance(t, str):
            t = sec_of(t)
        out.append({"t": float(t), "label": str(item.get("label", "")).strip()})
    return sorted(out, key=lambda x: x["t"])


def parse_names_file(path):
    """Load {A: 'name'} from a JSON file; invalid shapes are ignored."""
    try:
        with open(path, encoding="utf-8-sig") as f:
            raw = json.load(f)
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v).strip()[:40] for k, v in raw.items()
            if str(k) and str(v).strip()}


def moments_from_summary(md):
    """Pull key moments from the summary's bold section headings."""
    out = []
    for raw in md.splitlines():
        line = raw.strip()
        m = re.match(r"\*\*(.+?)\s*\((\d{1,3}:\d{2})[–-](\d{1,3}:\d{2})[^)]*\)\s*:?\*\*", line)
        if not m:
            continue
        label = re.sub(r"\*\*", "", m.group(1)).strip(" —-:")
        if re.search(r"نظرة عامة|overview|action points|بنود التنفيذ", label, re.I):
            continue
        out.append({"t": float(sec_of(m.group(2))), "label": label})
    # de-duplicate by start time, keep the shortest label
    seen = {}
    for item in out:
        k = int(item["t"])
        if k not in seen or len(item["label"]) < len(seen[k]["label"]):
            seen[k] = item
    return sorted(seen.values(), key=lambda x: x["t"])


def build_prologue(info, moments, opts):
    total = info["end"] or 0
    end_sec = max(total, 1)
    speakers = info["speakers"] or ["A", "B"]
    sp_ar = {"A": "أ", "B": "ب", "C": "ج", "D": "د", "E": "هـ", "F": "و", "G": "ز", "H": "ح"}
    names = {k: str(v).strip() for k, v in (getattr(opts, "speaker_names", None) or {}).items()
             if str(v).strip()}
    spk_html = "".join(
        f'<span class="spk" role="button" tabindex="0" data-spk="{s}" data-default="{sp_ar.get(s, s)}"'
        f' style="--c:{PALETTE.get(s, "#141414")}"'
        f' aria-label="تغيير اسم المتحدث {sp_ar.get(s, s)}" title="{sp_ar.get(s, s)} — انقر لتغيير الاسم">'
        f'<i class="spk__dot"></i>'
        f'<span class="spk__name">{esc(names.get(s) or sp_ar.get(s, s))}</span>'
        f'<svg class="spk__pen" viewBox="0 0 12 12" aria-hidden="true">'
        f'<path d="M1 11h3L11 4a1.4 1.4 0 0 0-2-2L2 9z" fill="none" stroke="currentColor" '
        f'stroke-width="1.3"/></svg>'
        f'</span>'
        for s in speakers
    )
    names_json = json.dumps(names, ensure_ascii=False).replace("</", "<\\/")

    proj = opts.project or info["title"]
    date = opts.date or "—"
    title_html = esc(opts.title or info["title"])
    if "|" in title_html:
        title_html = "<br>".join(title_html.split("|"))
    if title_html and not title_html.rstrip().endswith("."):
        title_html = title_html.rstrip() + '<span class="dot">.</span>'

    kicker = esc(opts.kicker or "تسجيل — فهرس التفريغ")
    note = esc(opts.note or info["sub"] or "تفريغ صوتي مع تشغيل متزامن.")
    model = esc(opts.model or "Jais-ASR 4-bit · NVIDIA Nemotron-3-Diarization")

    mk_html = []
    rows = [-100.0, -100.0]
    for i, mom in enumerate(moments, 1):
        pct = mom["t"] / end_sec * 100
        r = 0 if pct - rows[0] >= 3.2 else 1
        if pct - rows[r] < 3.2:
            r = 0
        rows[r] = pct
        cls = "mk low" if r else "mk"
        mk_html.append(
            f'<button class="{cls}" type="button" data-t="{mom["t"]:.2f}" style="--p:{pct:.4f}%"'
            f' title="{esc(mom["label"])} — {stamp_of(mom["t"])}"'
            f' aria-label="{i:02d} · {esc(mom["label"])} — {stamp_of(mom["t"])}">'
            f'<span class="n">{i:02d}</span></button>'
        )
    if not mk_html:
        mk_html.append('<span class="tech muted" style="position:absolute;top:22px;left:0">لا توجد لحظات مفتاحية</span>')

    mom_json = json.dumps(moments, ensure_ascii=False).replace("</", "<\\/")

    return f"""<!-- ui:chrome:start -->
<header class="titleblock" dir="rtl">
  <div class="tb-brand">
    <svg class="logo-draw" width="30" height="36" viewBox="0 0 34 40" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path pathLength="1" style="--i:0" d="M1 1 H23 L33 11 V39 H1 Z"></path>
      <path pathLength="1" style="--i:1" class="fill-accent" d="M23 1 V11 H33"></path>
      <path pathLength="1" style="--i:2" d="M11 16 L22 24 L11 32 Z"></path>
      <path pathLength="1" style="--i:3" d="M7 35 H20"></path>
    </svg>
    <span class="tb-wordmark">تفريغ<small>نص متزامن مع الصوت</small></span>
  </div>
  <dl class="tb-cells">
    <div class="tb-cell"><dt>المشروع</dt><dd>{esc(proj)}</dd></div>
    <div class="tb-cell"><dt>التاريخ</dt><dd>{esc(date)}</dd></div>
    <div class="tb-cell"><dt>الكلام</dt><dd>{stamp_of(info["start"])}–{stamp_of(info["end"])}</dd></div>
    <div class="tb-cell"><dt>المقاطع</dt><dd>{num(info["chunks"])}</dd></div>
  </dl>
</header>

<section class="hero" dir="rtl" data-kicker="{esc(kicker)}" data-note="{note}"
         data-project="{esc(proj)}" data-date="{esc(date)}" data-heading="{esc(opts.heading or "التفريغ.")}">
  <div>
    <p class="tech accent hero-kicker" dir="rtl">{kicker}</p>
    <h1 dir="auto">{title_html}</h1>
    <p class="lede" dir="auto">{note}</p>
  </div>
  <dl class="facts" dir="rtl">
    <div><dt>المصدر</dt><dd title="{esc(info["title"])}">{esc(info["title"])}</dd></div>
    <div><dt>النموذج</dt><dd>{model}</dd></div>
    <div><dt>المقاطع</dt><dd>{num(info["wins"])} · {num(info["chunks"])} جملة</dd></div>
  </dl>
</section>

<section class="playerbar" aria-label="مشغل التسجيل"
         data-source="{esc(info["src"])}" data-start="{info["start"]:.2f}" data-end="{info["end"]:.2f}"
         data-recording="{esc(info["title"])}">
  <div class="pb-inner" dir="ltr">
    <div class="pb-top" dir="rtl">
      <span class="tech accent">01 / التسجيل</span>
      <span class="tech pb-src">{esc(info["title"])}</span>
      <span class="tech muted"><b>{len(moments):02d}</b> لحظات مفتاحية</span>
    </div>
    <div class="transport">
      <button class="pp" id="pp" type="button" aria-label="تشغيل" aria-pressed="false">
        <svg class="i-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5 L13.5 8 L3 14.5 Z"></path></svg>
        <svg class="i-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5 H6.5 V14.5 H3 Z M9.5 1.5 H13 V14.5 H9.5 Z"></path></svg>
      </button>
      <div class="time"><span id="tcur">00:00</span><span class="sep">/</span><span id="tdur">--:--</span></div>
      <div class="railwrap">
        <div class="rail" id="rail" role="slider" tabindex="0" aria-label="التنقل في التسجيل"
             aria-valuemin="0" aria-valuemax="{end_sec}" aria-valuenow="0" aria-valuetext="00:00">
          <div class="rail-line"></div>
          <div class="rail-fill" id="railfill"></div>
          {''.join(mk_html)}
          <div class="rail-head" id="railhead"></div>
        </div>
        <div class="nowline" dir="rtl">
          <span class="tech accent" id="nowcount">لحظة —</span>
          <span class="nowlabel" id="nowlabel" dir="auto">تظهر اللحظات المفتاحية على الخط أعلاه</span>
          <span class="tech muted" id="nowtime">00:00</span>
        </div>
      </div>
      <button class="rate" id="rate" type="button" aria-label="سرعة التشغيل 1x">1×</button>
    </div>
    <div class="rail-foot">
      <span class="tech">00:00</span>
      <span class="tech" id="foot-end">{ts(end_sec)}</span>
    </div>
    <div class="pb-speakers" dir="rtl">
      <span class="tech pb-speakers__label">المتحدثون</span>
      <div class="speakers" id="spkbar">{spk_html}</div>
      <span class="tech spk__hint">انقر الاسم لتغييره</span>
    </div>
    <audio id="au" preload="auto" src="{esc(info["src"])}"></audio>
  </div>
  <script type="application/json" id="{NAMES_ID}">{names_json}</script>
  <script type="application/json" id="{MOMENTS_ID}">{mom_json}</script>
</section>
<!-- ui:chrome:end -->"""


PLAYER_JS = r"""<script id="ui-player-js">
(() => {
  const $ = (id) => document.getElementById(id);
  const au = $('au'), rail = $('rail'), fill = $('railfill'), head = $('railhead');
  const pp = $('pp'), tcur = $('tcur'), tdur = $('tdur'), rate = $('rate');
  const nowCount = $('nowcount'), nowLabel = $('nowlabel'), nowTime = $('nowtime'), footEnd = $('foot-end');
  if (!au || !rail) return;
  const chunks = Array.from(document.querySelectorAll('.chunk'));
  const wins = Array.from(document.querySelectorAll('.win'));
  const mks = Array.from(document.querySelectorAll('.mk'));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let MOM = [];
  try { MOM = JSON.parse(($('ui-moments') || {}).textContent || '[]'); } catch (e) { MOM = []; }

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? pad(h) + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
  };
  const dur = () => (isFinite(au.duration) && au.duration > 0) ? au.duration : FALLBACK_END;

  function place() {
    const d = dur() || 1;
    mks.forEach((b) => {
      const t = parseFloat(b.dataset.t) || 0;
      b.style.setProperty('--p', (t / d * 100).toFixed(4) + '%');
    });
    tdur.textContent = fmt(d);
    footEnd.textContent = fmt(d);
    rail.setAttribute('aria-valuemax', String(Math.round(d)));
  }

  let activeChunk = null, activeWin = null, activeMk = null, preview = null;

  function renderNow(mi) {
    if (mi >= 0) {
      nowCount.textContent = 'لحظة ' + pad(mi + 1);
      nowLabel.textContent = MOM[mi].label;
      nowTime.textContent = fmt(MOM[mi].t);
    } else {
      nowCount.textContent = 'لحظة —';
      nowLabel.textContent = 'قبل أول لحظة مفتاحية';
      nowTime.textContent = '00:00';
    }
  }

  function paint() {
    const t = au.currentTime || 0, d = dur() || 1;
    const pct = Math.max(0, Math.min(1, t / d)) * 100;
    fill.style.width = pct + '%';
    head.style.left = pct + '%';
    tcur.textContent = fmt(t);
    rail.setAttribute('aria-valuenow', String(Math.round(t)));
    rail.setAttribute('aria-valuetext', fmt(t) + ' / ' + fmt(d));

    let mi = -1;
    for (let i = 0; i < MOM.length; i++) if (t >= MOM[i].t - 0.06) mi = i;
    renderNow(preview !== null ? preview : mi);
    mks.forEach((b, i) => {
      b.classList.toggle('past', MOM[i] && t >= MOM[i].t);
      b.classList.toggle('on', i === mi);
    });

    let hit = null;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const s = parseFloat(c.dataset.start), e = parseFloat(c.dataset.end);
      const on = t >= s && t < e;
      if (on !== c.classList.contains('on')) c.classList.toggle('on', on);
      if (on) hit = c;
    }
    if (hit && hit !== activeChunk) {
      activeChunk = hit;
      const w = hit.closest('.win');
      if (w !== activeWin) {
        if (activeWin) activeWin.classList.remove('on');
        activeWin = w;
        if (w) w.classList.add('on');
      }
      if (w && !au.paused) w.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
  }

  const clamp = (t) => Math.max(0, Math.min(t, dur() || t));
  function seek(t) { au.currentTime = clamp(t); paint(); }
  function play() { au.play().catch(() => {}); }
  function toggle() { au.paused ? play() : au.pause(); }

  pp.addEventListener('click', toggle);
  au.addEventListener('play', () => {
    pp.classList.add('playing');
    pp.setAttribute('aria-pressed', 'true');
    pp.setAttribute('aria-label', 'إيقاف مؤقت');
  });
  au.addEventListener('pause', () => {
    pp.classList.remove('playing');
    pp.setAttribute('aria-pressed', 'false');
    pp.setAttribute('aria-label', 'تشغيل');
  });

  // rail scrubbing
  rail.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mk')) return;
    const r = rail.getBoundingClientRect();
    const move = (ev) => seek((Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))) * dur());
    move(e);
    try { rail.setPointerCapture(e.pointerId); } catch (err) {}
    const up = () => {
      rail.removeEventListener('pointermove', move);
      rail.removeEventListener('pointerup', up);
      rail.removeEventListener('pointercancel', up);
    };
    rail.addEventListener('pointermove', move);
    rail.addEventListener('pointerup', up);
    rail.addEventListener('pointercancel', up);
  });

  rail.addEventListener('keydown', (e) => {
    const t = au.currentTime;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': seek(t + (e.shiftKey ? 30 : 5)); break;
      case 'ArrowLeft': case 'ArrowDown': seek(t - (e.shiftKey ? 30 : 5)); break;
      case 'PageUp': seek(t + 60); break;
      case 'PageDown': seek(t - 60); break;
      case 'Home': seek(0); break;
      case 'End': seek(dur() - 1); break;
      case ' ': toggle(); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });

  mks.forEach((b, i) => {
    const show = () => { preview = i; renderNow(i); };
    const hide = () => { preview = null; paint(); };
    b.addEventListener('mouseenter', show);
    b.addEventListener('focus', show);
    b.addEventListener('mouseleave', hide);
    b.addEventListener('blur', hide);
  });

  mks.forEach((b) => b.addEventListener('click', () => {
    preview = null;
    const t = parseFloat(b.dataset.t) || 0;
    seek(t + 0.01);
    if (au.paused) play();
  }));

  const speeds = [1, 1.25, 1.5, 0.75];
  let si = 0;
  rate.addEventListener('click', () => {
    si = (si + 1) % speeds.length;
    au.playbackRate = speeds[si];
    rate.textContent = speeds[si] + '×';
    rate.setAttribute('aria-label', 'سرعة التشغيل ' + speeds[si] + 'x');
  });

  chunks.forEach((c) => c.addEventListener('click', () => {
    seek(parseFloat(c.dataset.start) + 0.01);
    if (au.paused) play();
  }));

  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input,textarea,select,button,a,[contenteditable]')) return;
    e.preventDefault();
    toggle();
  });

  au.addEventListener('loadedmetadata', () => { place(); paint(); });
  au.addEventListener('timeupdate', paint);
  au.addEventListener('seeked', paint);
  au.addEventListener('durationchange', place);

  if (window.navigator.mediaSession) {
    window.navigator.mediaSession.setActionHandler('play', play);
    window.navigator.mediaSession.setActionHandler('pause', () => au.pause());
  }

  // ---- speaker names: click the chip, type, Enter. The shell persists them.
  const spkbar = $('spkbar');
  const namesEl = $('ui-speaker-names');
  let NAMES = {};
  try { NAMES = JSON.parse((namesEl || {}).textContent || '{}') || {}; } catch (e) { NAMES = {}; }

  function setChip(chip, name) {
    const label = chip.querySelector('.spk__name');
    if (label) label.textContent = name;
    chip.setAttribute('aria-label', 'تغيير اسم المتحدث ' + name);
    chip.title = name + ' — انقر لتغيير الاسم';
  }

  // Colour is no longer the only cue: a named speaker is disclosed on hover.
  function tagChunks() {
    chunks.forEach((c) => {
      const m = /(?:^|\s)s([A-H])(?:\s|$)/.exec(c.className);
      if (!m) return;
      const name = NAMES[m[1]];
      if (name) c.title = 'المتحدث ' + name; else c.removeAttribute('title');
    });
  }

  function saveNames() {
    const json = JSON.stringify(NAMES);
    if (namesEl) namesEl.textContent = json;
    tagChunks();
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage({ source: 'tafreegh', type: 'speaker-names', names: NAMES }, '*'); } catch (e) {}
    }
  }

  function editChip(chip) {
    if (chip.classList.contains('is-editing')) return;
    const spk = chip.dataset.spk;
    const fallback = chip.dataset.default || spk;
    const label = chip.querySelector('.spk__name');
    const input = document.createElement('input');
    input.className = 'spk__input';
    input.type = 'text';
    input.maxLength = 40;
    input.value = (NAMES[spk] || label.textContent || '').trim();
    input.setAttribute('aria-label', 'اسم المتحدث');
    chip.classList.add('is-editing');
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const close = (commit) => {
      if (done) return;
      done = true;
      const value = input.value.replace(/\s+/g, ' ').trim().slice(0, 40);
      chip.classList.remove('is-editing');
      const span = document.createElement('span');
      span.className = 'spk__name';
      input.replaceWith(span);
      if (commit) {
        if (!value || value === fallback) delete NAMES[spk]; else NAMES[spk] = value;
        setChip(chip, NAMES[spk] || fallback);
        saveNames();
      } else {
        setChip(chip, NAMES[spk] || fallback);
      }
    };
    input.addEventListener('keydown', (e) => {
      // The chip itself listens for Enter; without this the commit would reopen
      // the editor on the same keypress.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
        chip.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
        chip.focus();
      }
    });
    input.addEventListener('blur', () => close(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  if (spkbar) {
    Array.from(spkbar.querySelectorAll('.spk')).forEach((chip) => {
      const spk = chip.dataset.spk;
      if (NAMES[spk]) setChip(chip, NAMES[spk]);
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        editChip(chip);
      });
      chip.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        editChip(chip);
      });
    });
  }
  tagChunks();

  place();
  paint();
})();
</script>"""


def build_transcript_head(info, opts):
    total = info["end"]
    dur = ts(total) if total else "—"
    n = "03" if getattr(opts, "summary_first", True) else "02"
    return (f'<section class="sec-head" id="{HEAD_ID}" dir="rtl">\n'
            f'<p class="tech" dir="rtl">{n} / التفريغ · {num(info["wins"])} مقطع · {dur}</p>\n'
            f'<h2 dir="auto">{esc(opts.heading or "التفريغ.")}</h2>\n'
            f'</section>\n')


def build_footer(info, opts):
    return (f'<footer class="colophon" id="{FOOT_ID}" dir="rtl">\n'
            f'<span>تفريغ — {num(info["wins"])} مقطع · {num(info["chunks"])} جملة</span>\n'
            f'<span dir="ltr">{esc(opts.model or "Jais-ASR 4-bit · NVIDIA Nemotron-3-Diarization")}</span>\n'
            f'<span>انقر أي جملة للانتقال · المسافة للتشغيل والإيقاف</span>\n'
            f'</footer>\n')


# ---------------------------------------------------------------- apply
def apply(html_path, opts):
    with open(html_path, encoding="utf-8") as f:
        html = f.read()

    if "<audio" not in html:
        die(f"{html_path} has no <audio> element — not a pipeline player")

    # --- existing chrome values survive a re-run (idempotency)
    info_probe = re.search(r'<section class="hero".*?</section>', html, re.S)
    if info_probe:
        hero = info_probe.group(0)
        from html import unescape

        def saved(attr):
            m = re.search(r'%s="([^"]*)"' % attr, hero)
            return unescape(m.group(1)) if m else None

        if not opts.title:
            m = re.search(r'<h1[^>]*>(.*?)</h1>', hero, re.S)
            if m:
                raw = re.sub(r"<br\s*/?>", "|", m.group(1), flags=re.I)
                opts.title = unescape(re.sub(r"<[^>]+>", "", raw)).strip().rstrip(".")
        opts.kicker = opts.kicker or saved("data-kicker")
        opts.note = opts.note or saved("data-note")
        opts.project = opts.project or saved("data-project")
        opts.date = opts.date or saved("data-date")
        opts.heading = opts.heading or saved("data-heading")
    stored = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % MOMENTS_ID, html, re.S)
    if not opts.moments and stored:
        try:
            opts.moments = json.loads(stored.group(1).replace("<\\/", "</"))
        except Exception:
            opts.moments = None
    # A re-render without --speaker-names (e.g. a summary retry) must not drop
    # the names the user typed into the page.
    if getattr(opts, "speaker_names", None) in (None, {}):
        kept = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % NAMES_ID,
                         html, re.S)
        if kept:
            try:
                opts.speaker_names = json.loads(kept.group(1).replace("<\\/", "</"))
            except Exception:
                opts.speaker_names = None

    # --- replace the old prologue (body head: player + hdr + legend)
    bm = re.search(r"<body([^>]*)>", html)
    if not bm:
        die("cannot find <body>")
    i = bm.end()
    js = [x for x in (html.find('<section class="summary"', i), html.find("<main>", i)) if x != -1]
    if not js:
        die("cannot find the summary or <main> block")
    j = min(js)
    prologue = html[i:j]
    info = extract_info(html, prologue)
    if getattr(opts, "end", None):
        info["end"] = sec_of(opts.end)
    sum_pos = html.find('<section class="summary"')
    main_pos = html.find("<main>")
    opts.summary_first = sum_pos != -1 and main_pos != -1 and sum_pos < main_pos

    moments = opts.moments
    if not moments and opts.summary and os.path.exists(opts.summary):
        with open(opts.summary, encoding="utf-8-sig") as f:
            moments = moments_from_summary(f.read())
    if not moments and opts.summary is None:
        md = os.path.join(os.path.dirname(html_path), "summary.md")
        if os.path.exists(md):
            with open(md, encoding="utf-8-sig") as f:
                moments = moments_from_summary(f.read())
    if not moments:
        moments = [{"t": info["start"] or 0, "label": "بداية التسجيل"}]
    opts.moments = moments

    chrome = build_prologue(info, moments, opts)
    html = html[:i] + "\n" + chrome + "\n" + html[j:]

    # --- stylesheet: the theme owns the whole <style> block
    css = fonts_css(not opts.no_fonts) + "\n" + CSS
    style_re = re.compile(r"<style[^>]*>.*?</style>", re.S)
    if style_re.search(html):
        html = style_re.sub(lambda m: '<style id="%s">\n%s\n</style>' % (THEME_ID, css), html, count=1)
    else:
        html = html.replace("</head>", '<style id="%s">\n%s\n</style>\n</head>' % (THEME_ID, css), 1)

    # --- player script
    script = PLAYER_JS.replace("FALLBACK_END", f"{max(info['end'], 1)}")
    old = re.search(r'<script id="%s">.*?</script>' % PLAYER_JS_ID, html, re.S)
    if old:
        html = html[:old.start()] + script + html[old.end():]
    else:
        legacy = re.search(r"<script>\s*const au = document\.getElementById\('au'\);.*?</script>", html, re.S)
        if not legacy:
            die("cannot find the player script to replace")
        html = html[:legacy.start()] + script + html[legacy.end():]

    # --- transcript section heading
    th = re.search(r'<section class="sec-head" id="%s".*?</section>\n?' % HEAD_ID, html, re.S)
    if th:
        html = html[:th.start()] + build_transcript_head(info, opts) + html[th.end():]
    else:
        html = html.replace("<main>", build_transcript_head(info, opts) + "<main>", 1)

    # --- footer
    ft = re.search(r'<footer class="colophon" id="%s".*?</footer>\n?' % FOOT_ID, html, re.S)
    if ft:
        html = html[:ft.start()] + build_footer(info, opts) + html[ft.end():]
    else:
        html = html.replace("</body>", build_footer(info, opts) + "</body>", 1)

    # --- RTL document + summary-first numbering + clean title
    def set_body(m):
        attrs = m.group(1)
        has = re.search(r'class="([^"]*)"', attrs)
        if opts.summary_first:
            if has:
                if "summary-first" not in has.group(1).split():
                    attrs = attrs.replace(has.group(0), 'class="%s summary-first"' % has.group(1).strip())
            else:
                attrs += ' class="summary-first"'
        elif has and "summary-first" in has.group(1).split():
            rest = " ".join(c for c in has.group(1).split() if c != "summary-first")
            attrs = attrs.replace(has.group(0), ('class="%s"' % rest) if rest else "")
        return "<body" + attrs + ">"

    html = re.sub(r"<body([^>]*)>", set_body, html, count=1)
    html = re.sub(r"<html([^>]*?)>", lambda m: "<html" + (m.group(1) if "dir=" in m.group(1) else m.group(1) + ' dir="rtl"') + ">", html, count=1)
    html = re.sub(r"<title>(.*?)</title>", lambda m: "<title>" + esc(re.sub(r"\s*[—-]\s*(?:transcript|تفريغ).*$", "", m.group(1)).strip() + " — تفريغ") + "</title>", html, count=1, flags=re.S)

    with open(html_path, "w", encoding="utf-8", newline="") as f:
        f.write(html)
    return info, moments


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Apply the drafting-sheet UI + key-moments rail.")
    ap.add_argument("target", help="transcript base path or the .html file itself")
    ap.add_argument("--title", help="hero headline; use | for a line break")
    ap.add_argument("--kicker", help="mono eyebrow above the headline")
    ap.add_argument("--note", help="lede paragraph")
    ap.add_argument("--project", help="title-block Project value (default: source name)")
    ap.add_argument("--date", help="title-block Date value, e.g. 25·10·2026")
    ap.add_argument("--model", help="model line for facts/footer")
    ap.add_argument("--heading", help="transcript section heading (default: التفريغ.)")
    ap.add_argument("--end", help="speech end timestamp (mm:ss) to override detection")
    ap.add_argument("--moments", help="JSON file: [{t: seconds|mm:ss, label: ...}]")
    ap.add_argument("--summary", help="summary .md to derive key moments from")
    ap.add_argument("--no-fonts", action="store_true", help="skip embedded webfonts")
    ap.add_argument("--speaker-names", help="JSON file: {A: 'name', ...}")
    args = ap.parse_args(argv)

    path = args.target
    if not path.lower().endswith(".html"):
        path = path + " - arabic transcript.html"
    if not os.path.exists(path):
        die(f"HTML player not found: {path}")

    opts = argparse.Namespace(
        title=args.title, kicker=args.kicker, note=args.note, project=args.project,
        date=args.date, model=args.model, heading=args.heading, end=args.end,
        moments=parse_moments_file(args.moments) if args.moments else None,
        summary=args.summary, no_fonts=args.no_fonts,
        speaker_names=parse_names_file(args.speaker_names) if args.speaker_names else None,
    )
    return path, opts


def main(argv=None):
    path, opts = parse_args(argv)
    info, moments = apply(path, opts)
    print("SAVED", path, flush=True)
    print(f"  windows {info['wins']} · clauses {info['chunks']} · moments {len(moments)}", flush=True)
    print("  audio:", info["src"] or "(none)", flush=True)


if __name__ == "__main__":
    main()
