import { describe, expect, it } from 'vitest';
import tools, { beautifyCss, beautifyHtml, minifyCss, minifyHtml } from '../../../src/tools/web/data/html-css-format.js';
import { call } from '../../helpers.js';

const [htmlTool, cssTool] = tools;
const SAMPLE_HTML = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Demo   page</title>\n<style>body{margin:0;font:16px/1.5 system-ui}  .card{padding:1rem}</style></head>' +
  '<body><!-- main layout --><header class="top"   id=hero><h1>Hello <em>world</em></h1><nav><ul><li><a href="/">Home</a><li><a href="/about"   title="About us">About</a></ul></nav></header>' +
  '<main><p>Some <b>bold</b> and <code>code</code> text.<br>New line<img src="logo.png" alt="Logo"></p><pre>  keep   this\n    exactly  </pre>' +
  '<form><label>Name <input name="n" required></label><textarea>  untouched\n text </textarea><button type="submit">Send</button></form></main>' +
  '<script>if (a < b && c > d) { console.log("</div> stays"); }</script></body></html>';
const SAMPLE_CSS = '@charset "utf-8";\n/* theme */\n:root{--accent:#3dd6d0;--gap: 12px}\nbody,html{margin:0;padding:0;font-family:"Inter",system-ui,sans-serif}\n' +
  '.card > h2 + p,.card:hover::after{content:"} ; {";color:rgba(0, 0, 0, .5);background:url(data:image/svg+xml;utf8,<svg/>) no-repeat}\n' +
  '@media (min-width: 640px) and (max-width:1024px){.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:calc(var(--gap) + 4px)}a:not(.btn){color:var(--accent)!important}}';

// Known answers from the website's S3_SELFTEST.
describe('html-css-format self-test', () => {
  const B = (s: string) => beautifyHtml(s, '  ', false);
  it('HTML', () => {
    expect(B('<div><p>Hi <b>there</b></p><img src=x><br><ul><li>a<li>b</ul></div>')).toBe('<div>\n  <p>Hi <b>there</b></p>\n  <img src=x><br>\n  <ul>\n    <li>a\n    <li>b\n  </ul>\n</div>');
    expect(B('<a   href="x  y"\n  class=c   >t</a>')).toBe('<a href="x  y" class=c>t</a>');
    const script = '<script>\n  if (a < b) { x = "</div>"; }\n</script>';
    expect(B('<body>' + script + '</body>')).toBe('<body>\n  ' + script + '\n</body>');
    const pre = '<pre>  a\n   <b>b</b>  </pre>';
    expect(B('<div>' + pre + '</div>')).toBe('<div>\n  ' + pre + '\n</div>');
    expect(minifyHtml('<form>\n  <textarea>  x\n  y </textarea>\n</form>', true)).toBe('<form><textarea>  x\n  y </textarea></form>');
    expect(minifyHtml('<div>\n  <p> Hello   <b>big</b> world </p>\n  <!-- note -->\n</div>', true)).toBe('<div><p>Hello <b>big</b> world</p></div>');
    expect(minifyHtml('<p><b>a</b> <i>b</i></p>', true)).toBe('<p><b>a</b> <i>b</i></p>');
    expect(minifyHtml('<!--[if IE]><p>x</p><![endif]--><p>y</p>', true)).toBe('<!--[if IE]><p>x</p><![endif]--><p>y</p>');
    for (const s of [SAMPLE_HTML, '<div>a<span>b</span><div>c</div>d</div>', '<p>x<!-- c -->y</p>']) {
      const once = B(s);
      expect(B(once)).toBe(once);
      expect(minifyHtml(once, false)).toBe(minifyHtml(s, false));
    }
  });
  it('CSS', () => {
    const C = (s: string) => beautifyCss(s, '  ', false);
    expect(C('a,b{color:red;margin:0 auto}')).toBe('a,\nb {\n  color: red;\n  margin: 0 auto;\n}');
    expect(minifyCss('a::after { content : "} ; {" ; }', true)).toBe('a::after{content:"} ; {"}');
    expect(minifyCss("a{background:url(data:image/svg+xml;utf8,<svg a='1'/>) no-repeat}", true)).toBe("a{background:url(data:image/svg+xml;utf8,<svg a='1'/>) no-repeat}");
    expect(minifyCss('.x { width : calc(100% - 2px) ; }', true)).toBe('.x{width:calc(100% - 2px)}');
    expect(minifyCss('a :hover{x:y}', true)).toBe('a :hover{x:y}');
    expect(minifyCss('/* a */ /*! keep */ b{c:d}', true)).toBe('/*! keep */b{c:d}');
    for (const s of [SAMPLE_CSS, '@media screen{a{b:c}}\n.x{y:z}']) {
      const once = C(s);
      expect(C(once)).toBe(once);
      expect(minifyCss(once, true)).toBe(minifyCss(s, true));
    }
  });
});

describe('html_format / css_format tools', () => {
  it('beautify and minify', async () => {
    const h = await call<{ result: string; lines: number }>(htmlTool, { text: '<ul><li>a<li>b</ul>', indent: 4 });
    expect(h.result).toBe('<ul>\n    <li>a\n    <li>b\n</ul>');
    const m = await call<{ result: string; outputBytes: number }>(htmlTool, { text: '<div>\n  <p> x </p>\n</div>', mode: 'minify' });
    expect(m.result).toBe('<div><p>x</p></div>');
    const c = await call<{ result: string }>(cssTool, { text: '@media screen{a{b:c}}', indent: 'tab' });
    expect(c.result).toBe('@media screen {\n\ta {\n\t\tb: c;\n\t}\n}');
    const cm = await call<{ result: string }>(cssTool, { text: 'a { color : red ; } /* x */', mode: 'minify', removeComments: true });
    expect(cm.result).toBe('a{color:red}');
  });
});
