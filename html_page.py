"""Server-rendered page frame and the shared card markup of the local review page and the boards."""
import html

STYLE = """
*{box-sizing:border-box}body{margin:0;background:#f3f3ed;color:#1d332d;font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:820px;margin:0 auto;padding:42px 24px 80px}header{border-bottom:2px solid #1e4439;padding-bottom:18px}
nav,header,footer,.actions{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
h1{font-size:clamp(30px,5vw,48px);letter-spacing:-.06em;margin:10px 0}h2{font-size:20px;margin:0}small,summary{color:#456357}
article{background:#fffefa;border:1px solid #c6d3c7;border-radius:12px;padding:22px;margin:16px 0}
blockquote{border-left:3px solid #8ea496;margin:10px 0;padding:4px 12px}a{color:#225941}
button{background:#215440;color:white;border:0;border-radius:7px;padding:9px 15px;font:inherit;cursor:pointer}
textarea,select,input{font:inherit;border:1px solid #8ea295;border-radius:6px;padding:8px;width:100%;color:inherit;background:white}
textarea{min-height:68px}label{display:block;font-size:14px;font-weight:600;margin:10px 0}
.state{font-size:14px;background:#e2ebdf;padding:6px 10px;border-radius:5px}.note{color:#4e5d52}
"""
# Server-rendered lists arrive with the document. Poll only while the user is idle.
IDLE_REFRESH = """<script>let edited=false;document.addEventListener('input',()=>edited=true);
    setInterval(()=>{if(!edited && !document.hidden && document.activeElement===document.body && !document.querySelector('details[open]'))location.reload()},6000)</script>"""


def esc(s):
    return html.escape(str(s), quote=True)


def page(title, body, refresh=False):
    script = IDLE_REFRESH if refresh else ""
    return (f'<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title} · 싱크업</title><style>{STYLE}</style><main>{body}</main>{script}</html>')


def card_html(packet):
    """One approved card as the boards show it."""
    return (f'<article><small>{esc(packet["label"])}</small><h2>{esc(packet["text"])}</h2>'
            f'<blockquote>{esc(packet["quote"])}</blockquote><small>근거 · {esc(packet["speaker"])}</small></article>')
