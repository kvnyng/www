import os
import markdown
from markdown.extensions.codehilite import CodeHiliteExtension
import yaml
from string import Template

SRC_DIR = "../blog/posts_src"
OUT_DIR = "../blog/posts"
TEMPLATE_PATH = "../blog/posts_src/template.html"

def parse_markdown(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    if content.startswith('---'):
        _, front_matter, body = content.split('---', 2)
        metadata = yaml.safe_load(front_matter)
        return metadata, body.strip()
    return {}, content

def convert_to_html(body_md):
    return markdown.markdown(
        body_md,
        extensions=[
            'extra',
            'fenced_code',
            'tables',
            'sane_lists',
            'toc',
            'nl2br',
            CodeHiliteExtension(linenums=False)
        ]
    )

def render_html(metadata, body_html):
    with open(TEMPLATE_PATH, 'r') as f:
        raw = f.read()
        template = Template(raw)
        full_html = template.safe_substitute(**metadata, content=body_html)

    # Inject meta date tag into <head> if not present
    if 'date' in metadata:
        insert_index = full_html.find('<head>') + len('<head>')
        meta_tag = f'\n    <meta name="date" content="{metadata["date"]}">'
        full_html = full_html[:insert_index] + meta_tag + full_html[insert_index:]

    if 'subtitle' in metadata:
        subtitle_tag = f'\n    <meta name="subtitle" content="{metadata["subtitle"]}">'
        full_html = full_html[:insert_index] + subtitle_tag + full_html[insert_index:]

    return full_html

def build():
    os.makedirs(OUT_DIR, exist_ok=True)

    for filename in os.listdir(SRC_DIR):
        if not filename.endswith('.md'):
            continue
        filepath = os.path.join(SRC_DIR, filename)
        metadata, body_md = parse_markdown(filepath)
        if 'slug' not in metadata:
            print(f"Skipping {filename}: missing 'slug'")
            continue
        html_body = convert_to_html(body_md)
        full_html = render_html(metadata, html_body)

        output_path = os.path.join(OUT_DIR, f"{metadata['slug']}.html")
        with open(output_path, 'w', encoding='utf-8') as out_file:
            out_file.write(full_html)
        print(f"Generated {output_path}")

if __name__ == "__main__":
    build()