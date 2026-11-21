import unittest

from tests import helpers  # noqa: F401  (ajusta sys.path)
from utils.markdown import parse_inline, parse_markdown_blocks


class TestInline(unittest.TestCase):
    def test_bold_italic_code_link(self):
        runs = parse_inline("Hola **mundo** y *cursiva* con `code` y [link](https://x.y)")
        self.assertEqual(
            [r["text"] for r in runs],
            ["Hola ", "mundo", " y ", "cursiva", " con ", "code", " y ", "link"],
        )
        self.assertTrue(runs[1]["bold"])
        self.assertFalse(runs[0]["bold"])
        self.assertTrue(runs[3]["italic"])
        self.assertTrue(runs[5]["code"])
        self.assertEqual(runs[7]["link"], "https://x.y")

    def test_bold_italic_combined_and_underscores(self):
        runs = parse_inline("***ambos*** y __negrita__ y _cursiva_")
        self.assertEqual(runs[0]["text"], "ambos")
        self.assertTrue(runs[0]["bold"] and runs[0]["italic"])
        self.assertEqual(runs[2]["text"], "negrita")
        self.assertTrue(runs[2]["bold"])
        self.assertEqual(runs[4]["text"], "cursiva")
        self.assertTrue(runs[4]["italic"])

    def test_snake_case_words_are_not_italic(self):
        runs = parse_inline("usa la variable mi_var_x ahora")
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["text"], "usa la variable mi_var_x ahora")

    def test_plain_text_single_run(self):
        runs = parse_inline("sin formato")
        self.assertEqual(runs, [{"text": "sin formato", "bold": False, "italic": False, "code": False, "link": None}])

    def test_unclosed_markers_stay_literal(self):
        runs = parse_inline("precio 5 * 3 = 15 y **abierto")
        self.assertEqual("".join(r["text"] for r in runs), "precio 5 * 3 = 15 y **abierto")


class TestBlocks(unittest.TestCase):
    def test_block_kinds_in_order(self):
        md = (
            "# Título\n\nPárrafo uno.\n\n- a\n  - a1\n- b\n\n1. x\n2. y\n\n"
            "| A | B |\n|---|---|\n| 1 | 2 |\n\n> cita\n\n```py\nprint(1)\n```\n\n---"
        )
        kinds = [b["type"] for b in parse_markdown_blocks(md)]
        self.assertEqual(
            kinds,
            ["heading", "paragraph", "bullets", "numbered", "table", "quote", "code", "divider"],
        )

    def test_heading_levels(self):
        blocks = parse_markdown_blocks("# Uno\n### Tres")
        self.assertEqual(blocks[0], {"type": "heading", "text": "Uno", "level": 1})
        self.assertEqual(blocks[1], {"type": "heading", "text": "Tres", "level": 3})

    def test_nested_bullets(self):
        b = parse_markdown_blocks("- a\n  - a1\n  - a2\n- b")[0]
        self.assertEqual(b["type"], "bullets")
        self.assertEqual(b["items"][0], {"text": "a", "children": ["a1", "a2"]})
        self.assertEqual(b["items"][1], "b")

    def test_numbered_items(self):
        b = parse_markdown_blocks("1. uno\n2) dos")[0]
        self.assertEqual(b, {"type": "numbered", "items": ["uno", "dos"]})

    def test_table_cells(self):
        t = parse_markdown_blocks("| Producto | Precio |\n| :--- | ---: |\n| Café | 3,5 |\n| Té | 2 |")[0]
        self.assertEqual(t["headers"], ["Producto", "Precio"])
        self.assertEqual(t["rows"], [["Café", "3,5"], ["Té", "2"]])

    def test_paragraph_lines_are_joined(self):
        b = parse_markdown_blocks("línea uno\nlínea dos\n\notro párrafo")
        self.assertEqual(b[0], {"type": "paragraph", "text": "línea uno línea dos"})
        self.assertEqual(b[1]["text"], "otro párrafo")

    def test_code_block_keeps_content_and_language(self):
        b = parse_markdown_blocks("```python\nx = 1\n\ny = 2\n```")[0]
        self.assertEqual(b, {"type": "code", "text": "x = 1\n\ny = 2", "language": "python"})

    def test_quote_multiline(self):
        b = parse_markdown_blocks("> uno\n> dos")[0]
        self.assertEqual(b, {"type": "quote", "text": "uno dos"})

    def test_empty_input(self):
        self.assertEqual(parse_markdown_blocks(""), [])
        self.assertEqual(parse_markdown_blocks("   \n\n"), [])


if __name__ == "__main__":
    unittest.main()
