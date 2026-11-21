import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../src/context/html-md.js';

describe('htmlToMarkdown', () => {
  it('escapa barras dentro de celdas y completa filas cortas', () => {
    const md = htmlToMarkdown('<table><tr><td><p>A|B</p></td><td><p>C</p></td></tr><tr><td><p>1</p></td></tr></table>');
    assert.equal(md, '| A\\|B | C |\n| ---: | --- |\n| 1 |  |');
  });

  it('listas anidadas y numeradas', () => {
    const md = htmlToMarkdown('<ol><li><p>Uno</p><ul><li><p>a</p></li></ul></li><li><p>Dos</p></li></ol>');
    assert.equal(md, '1. Uno\n   - a\n2. Dos');
  });

  it('links externos se conservan; anclas internas quedan como texto', () => {
    const md = htmlToMarkdown('<p>Ver <a href="https://ejemplo.com">sitio</a> y <a href="#nota">nota</a></p>');
    assert.equal(md, 'Ver [sitio](https://ejemplo.com) y nota');
  });

  it('texto que empieza como markdown no se convierte en otra cosa', () => {
    assert.equal(htmlToMarkdown('<p># no es título</p><p>1. no es lista</p>'), '\\# no es título\n\n1\\. no es lista');
    assert.equal(htmlToMarkdown('<p>5 * 3 = 15 y [x]</p>'), '5 \\* 3 = 15 y \\[x\\]');
  });

  it('decodifica entidades e ignora imágenes', () => {
    // "<" escapado: react-markdown descarta HTML crudo y el texto desaparecería.
    assert.equal(htmlToMarkdown('<p>Q&amp;A &lt;ok&gt;<img src="" /></p>'), 'Q&A \\<ok>');
  });
});
